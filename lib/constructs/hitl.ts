import * as path from 'path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';
import { toRetentionDays } from './retention';

export interface HumanInTheLoopProps {
  config: PlatformConfig;
  /** CMK for the approval SNS topic, approvals table, and state machine logs. */
  encryptionKey: kms.IKey;
  /** The single Lambda ARN the executor invokes to perform the approved action (the use-case submit
   * tool). Platform-wired, never supplied by the agent. Empty => the executor records the decision but
   * performs no side effect. */
  executorTargetArn?: string;
  /** The platform-pinned consequential tool name the executor invokes (never from the SM input). */
  executorToolName?: string;
}

/**
 * Human-in-the-loop approval gate — a COMPLETE control, not just a primitive (F05). A consequential
 * action starts this state machine, which:
 *   1. RecordProposed  — writes the proposal keyed by an action digest (dedupe: a second proposal of
 *      the same digest is rejected, the replay guard at propose time).
 *   2. RequestApproval — SNS waitForTaskToken; an authorized approver resolves it (approve/reject),
 *      binding their identity. 24h timeout => rejected.
 *   3. Execute         — on approval, a SEPARATELY-SCOPED executor Lambda performs the action exactly
 *      once (claims PENDING->EXECUTING->COMPLETED), through a role the agent does not have (the agent
 *      is Cedar-forbidden from the action — separation of duties).
 *   4. Record outcome  — approver, actor, decision, timestamps and result are persisted for audit.
 *
 * The agent harness starts this state machine at the consequential step (StartExecution granted on the
 * deterministic SM name) instead of performing the action itself.
 */
export class HumanInTheLoop extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly approvalTopic: sns.Topic;
  readonly approvalFn: lambda.Function;
  readonly executorFn: lambda.Function;
  readonly approvals: dynamodb.Table;
  /** Dedicated supervisor role — the only principal permitted to resolve HITL approvals. */
  readonly approverRole: iam.Role;

  constructor(scope: Construct, id: string, props: HumanInTheLoopProps) {
    super(scope, id);
    const { config, encryptionKey, executorTargetArn, executorToolName } = props;
    const isProd = config.environment === 'prod';

    this.approvalTopic = new sns.Topic(this, 'Topic', {
      displayName: `Governed AI approvals (${config.customerName})`,
      masterKey: encryptionKey,
    });
    for (const email of config.controls.budgetAlertEmails) {
      this.approvalTopic.addSubscription(new subs.EmailSubscription(email));
    }

    // Approval ledger: one item per action digest. Idempotency, replay protection, and audit.
    this.approvals = new dynamodb.Table(this, 'Approvals', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, // pk = actionDigest
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.executorFn = new lambda.Function(this, 'ExecutorFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'hitl-executor')),
      timeout: Duration.seconds(60),
      description: 'Performs the approved consequential action exactly once (separation of duties).',
      environment: {
        APPROVALS_TABLE: this.approvals.tableName,
        TARGET_ARN: executorTargetArn ?? '',
        CONSEQUENTIAL_TOOL: executorToolName ?? '',
      },
    });
    this.approvals.grantReadWriteData(this.executorFn);
    if (executorTargetArn) {
      this.executorFn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [executorTargetArn] }),
      );
    }

    // --- State machine definition ---
    const recordProposed = new tasks.DynamoPutItem(this, 'RecordProposed', {
      table: this.approvals,
      item: {
        pk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.actionDigest')),
        status: tasks.DynamoAttributeValue.fromString('PENDING'),
        actor: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.actor')),
        action: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.action')),
        caseId: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.caseId')),
        argsJson: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.jsonToString(sfn.JsonPath.objectAt('$.args'))),
      },
      conditionExpression: 'attribute_not_exists(pk)', // dedupe: reject a duplicate digest (replay)
      resultPath: sfn.JsonPath.DISCARD,
    });
    recordProposed.addCatch(new sfn.Fail(this, 'DuplicateProposal', { error: 'DuplicateProposal' }), {
      errors: ['DynamoDB.ConditionalCheckFailedException'],
    });

    const requestApproval = new tasks.SnsPublish(this, 'RequestApproval', {
      topic: this.approvalTopic,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      subject: 'Governed AI: human approval required',
      // NOTE: the action ARGUMENTS are deliberately NOT in the notification (review #9) — they can
      // carry PHI/CJIS data and the SNS topic may fan out to a broad distribution list. The approver
      // reviews the full proposal (incl. args) in the approvals ledger / console by action digest.
      message: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        actionDigest: sfn.JsonPath.stringAt('$.actionDigest'),
        action: sfn.JsonPath.stringAt('$.action'),
        actor: sfn.JsonPath.stringAt('$.actor'),
        caseId: sfn.JsonPath.stringAt('$.caseId'),
      }),
      taskTimeout: sfn.Timeout.duration(Duration.hours(24)),
      resultPath: '$.approval', // {approved, approver, approvedAt}
    });

    const execute = new tasks.LambdaInvoke(this, 'Execute', {
      lambdaFunction: this.executorFn,
      payload: sfn.TaskInput.fromObject({
        actionDigest: sfn.JsonPath.stringAt('$.actionDigest'),
        action: sfn.JsonPath.stringAt('$.action'),
        args: sfn.JsonPath.objectAt('$.args'),
        actor: sfn.JsonPath.stringAt('$.actor'),
        caseId: sfn.JsonPath.stringAt('$.caseId'),
        approver: sfn.JsonPath.stringAt('$.approval.approver'),
        approvedAt: sfn.JsonPath.stringAt('$.approval.approvedAt'),
      }),
      resultPath: '$.execution',
    });

    // On reject/timeout/error, record the terminal state for audit, then end as failed. The Catch MUST
    // set resultPath so the original input (incl. $.actionDigest) is PRESERVED — the default replaces
    // the whole input with the error object, which would strand RecordRejected's key lookup (B3a).
    const recordRejected = new tasks.DynamoUpdateItem(this, 'RecordRejected', {
      table: this.approvals,
      key: { pk: tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.actionDigest')) },
      // REJECTED on an approver 'no'; a timeout or operational error is also caught here — the error
      // detail is retained under $.approvalError for the operator to distinguish.
      updateExpression: 'SET #s = :rejected, #e = :err',
      expressionAttributeNames: { '#s': 'status', '#e': 'terminalError' },
      expressionAttributeValues: {
        ':rejected': tasks.DynamoAttributeValue.fromString('REJECTED'),
        ':err': tasks.DynamoAttributeValue.fromString(sfn.JsonPath.stringAt('$.approvalError.Error')),
      },
      resultPath: sfn.JsonPath.DISCARD,
    });
    requestApproval.addCatch(recordRejected.next(new sfn.Fail(this, 'Rejected', { error: 'Rejected' })), {
      errors: ['States.ALL'],
      resultPath: '$.approvalError',
    });

    // The execution is only a SUCCESS if the executor returned status 'completed' (review #5). A
    // 'failed'/'rejected'/'unknown' result, or a Lambda error/timeout, must NOT end as Succeeded.
    const executionFailed = new sfn.Fail(this, 'ExecutionFailed', {
      error: 'ExecutionNotCompleted',
      cause: 'Executor did not report status=completed (see the approvals ledger for FAILED/UNKNOWN).',
    });
    // A Lambda timeout after the executor claimed the row leaves it EXECUTING; surface it (the ledger
    // row is the reconciliation anchor via the idempotency key) rather than silently succeeding.
    execute.addCatch(executionFailed, { errors: ['States.ALL'], resultPath: '$.executeError' });

    const resultChoice = new sfn.Choice(this, 'ExecutionSucceeded?')
      .when(
        sfn.Condition.stringEquals('$.execution.Payload.status', 'completed'),
        new sfn.Succeed(this, 'Completed'),
      )
      .otherwise(executionFailed);

    const definition = recordProposed
      .next(requestApproval)
      .next(execute)
      .next(resultChoice);

    const logGroup = new logs.LogGroup(this, 'Logs', {
      encryptionKey,
      retention: toRetentionDays(config.governance.logRetentionDays),
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, 'Approval', {
      stateMachineName: `govai-${config.customerName}-${config.environment}-hitl`,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: Duration.hours(25),
      tracingEnabled: true,
      logs: { destination: logGroup, level: sfn.LogLevel.ALL, includeExecutionData: true },
    });
    // The DynamoPutItem/UpdateItem tasks and the SNS publish target the CMK-encrypted approvals table
    // and topic; the state-machine role needs KMS on the evidence key or those steps fail with
    // AccessDenied (the DynamoDB/SNS task auto-grants don't include the key).
    encryptionKey.grantEncryptDecrypt(this.stateMachine.role);

    this.approvalFn = new lambda.Function(this, 'ApprovalFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'hitl-approval')),
      timeout: Duration.seconds(30),
      description: 'Resolve a waiting HITL approval (send task success/failure, binding the approver).',
    });
    this.stateMachine.grantTaskResponse(this.approvalFn);

    // Bind approval authority to a dedicated supervisor role: ONLY this role may invoke the approval
    // function, so the approver is a controlled, auditable principal — not merely a typed-in name
    // (B3d). An approver assumes this role (restrict its trust to your approver group at rollout),
    // then invokes the function. CloudTrail records the assumed-role principal.
    this.approverRole = new iam.Role(this, 'ApproverRole', {
      roleName: `govai-${config.customerName}-${config.environment}-hitl-approver`,
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'HITL supervisor role - the only principal permitted to resolve approvals.',
    });
    this.approvalFn.grantInvoke(this.approverRole);
  }
}
