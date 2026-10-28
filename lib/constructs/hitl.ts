import * as path from 'path';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';
import { toRetentionDays } from './retention';

export interface HumanInTheLoopProps {
  config: PlatformConfig;
  /** CMK for the approval SNS topic + state machine logs. */
  encryptionKey: kms.IKey;
}

/**
 * Human-in-the-loop approval gate. A consequential action starts this state machine, which publishes
 * an approval request to SNS with a Step Functions task token and WAITS (waitForTaskToken). An
 * approver resolves it by invoking the approval Lambda with the token — success routes to Approved,
 * failure (or the 24h timeout) routes to Rejected. The agent harness starts/awaits this per manifest.
 */
export class HumanInTheLoop extends Construct {
  readonly stateMachine: sfn.StateMachine;
  readonly approvalTopic: sns.Topic;
  readonly approvalFn: lambda.Function;

  constructor(scope: Construct, id: string, props: HumanInTheLoopProps) {
    super(scope, id);
    const { config, encryptionKey } = props;

    this.approvalTopic = new sns.Topic(this, 'Topic', {
      displayName: `Governed AI approvals (${config.customerName})`,
      masterKey: encryptionKey,
    });
    for (const email of config.controls.budgetAlertEmails) {
      this.approvalTopic.addSubscription(new subs.EmailSubscription(email));
    }

    const requestApproval = new tasks.SnsPublish(this, 'RequestApproval', {
      topic: this.approvalTopic,
      integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      subject: 'Governed AI: human approval required',
      message: sfn.TaskInput.fromObject({
        taskToken: sfn.JsonPath.taskToken,
        action: sfn.JsonPath.entirePayload,
      }),
      taskTimeout: sfn.Timeout.duration(Duration.hours(24)),
    });
    requestApproval.addCatch(new sfn.Fail(this, 'Rejected', { error: 'Rejected' }), {
      errors: ['States.ALL'],
    });

    const logGroup = new logs.LogGroup(this, 'Logs', {
      encryptionKey,
      retention: toRetentionDays(config.governance.logRetentionDays),
      removalPolicy: config.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.stateMachine = new sfn.StateMachine(this, 'Approval', {
      stateMachineName: `govai-${config.customerName}-${config.environment}-hitl`,
      definitionBody: sfn.DefinitionBody.fromChainable(
        requestApproval.next(new sfn.Succeed(this, 'Approved')),
      ),
      timeout: Duration.hours(25),
      tracingEnabled: true,
      // Full audit of approval decisions (includes the action payload under evaluation).
      logs: { destination: logGroup, level: sfn.LogLevel.ALL, includeExecutionData: true },
    });

    this.approvalFn = new lambda.Function(this, 'ApprovalFn', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'hitl-approval')),
      timeout: Duration.seconds(30),
      description: 'Resolve a waiting HITL approval (send task success/failure).',
    });
    this.stateMachine.grantTaskResponse(this.approvalFn);
  }
}
