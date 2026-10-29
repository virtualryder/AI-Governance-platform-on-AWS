import * as path from 'path';
import { CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { PlatformConfig, governedRolePrefix } from '../config/platform-config';

export interface InvocationLoggingProps {
  config: PlatformConfig;
  /** CMK encrypting the invocation-log group. */
  encryptionKey: kms.Key;
  retention: logs.RetentionDays;
}

/**
 * Bedrock model-invocation logging (full prompt/response capture). There is no CloudFormation
 * resource for this account+Region-SINGLETON setting (CLAUDE.md rule 1), so it is applied with a
 * Lambda-backed custom resource that reads the existing configuration first and honours an explicit
 * ownership mode ('create' refuses to overwrite a pre-existing config, 'adopt' leaves it alone,
 * 'manage' takes over and restores the prior config on teardown). This prevents a pilot in a shared
 * account from silently redirecting or disabling another application's logging (F11). Logs land in a
 * CMK-encrypted CloudWatch Logs group written by a Bedrock-assumed delivery role.
 */
export class InvocationLogging extends Construct {
  readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: InvocationLoggingProps) {
    super(scope, id);
    const { config, encryptionKey, retention } = props;
    const stack = Stack.of(this);

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/governed-ai/${config.customerName}/${config.environment}/bedrock-invocations`,
      retention,
      encryptionKey,
      removalPolicy: config.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Role Bedrock assumes to deliver logs. Trust is scoped to this account + the Bedrock service
    // source ARN (AWS-recommended confused-deputy guard for model-invocation logging).
    const deliveryRole = new iam.Role(this, 'DeliveryRole', {
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': stack.account },
          ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:*` },
        },
      }),
    });
    deliveryRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [this.logGroup.logGroupArn, `${this.logGroup.logGroupArn}:log-stream:*`],
      }),
    );

    const loggingConfig = {
      cloudWatchConfig: {
        logGroupName: this.logGroup.logGroupName,
        roleArn: deliveryRole.roleArn,
      },
      textDataDeliveryEnabled: true,
      imageDataDeliveryEnabled: true,
      embeddingDataDeliveryEnabled: true,
      videoDataDeliveryEnabled: true,
    };

    const ownership = config.governance.invocationLoggingOwnership ?? 'create';
    const stashKey = `${config.customerName}-${config.environment}`;
    const stashPrefix = '/governed-ai/_internal/invocation-logging';

    // Lambda that reads the existing config and conditionally Puts/Deletes/restores it.
    const onEvent = new lambda.Function(this, 'OnEvent', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'invocation-logging')),
      timeout: Duration.seconds(60),
      description: 'Bedrock model-invocation logging with safe ownership (adopt/create/manage).',
      environment: { STASH_PREFIX: stashPrefix },
    });
    // Name under the governed control prefix so the org control-plane SCP exempts it (it calls
    // Put/DeleteModelInvocationLoggingConfiguration, which that SCP otherwise denies). F03.
    (onEvent.role!.node.defaultChild as iam.CfnRole).addPropertyOverride(
      'RoleName',
      `${governedRolePrefix(config)}-invlog-${config.environment}`,
    );
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock:PutModelInvocationLoggingConfiguration',
          'bedrock:DeleteModelInvocationLoggingConfiguration',
          'bedrock:GetModelInvocationLoggingConfiguration',
        ],
        resources: ['*'], // account-level setting; no resource ARN
      }),
    );
    onEvent.addToRolePolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [deliveryRole.roleArn] }));
    onEvent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter', 'ssm:DeleteParameter'],
        resources: [`arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${stashPrefix}/*`],
      }),
    );

    const provider = new Provider(this, 'Provider', { onEventHandler: onEvent });

    // The onEvent handler and the CDK Provider framework Lambda carry the usual managed-execution-role
    // and account-level-API wildcards; justify them here, co-located with the resource (robust to the
    // framework's internal construct-path naming). HIPAA Lambda rules are suppressed stack-wide.
    NagSuppressions.addResourceSuppressions(
      onEvent,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole grants only CloudWatch Logs write for this provisioning Lambda.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Get/Put/DeleteModelInvocationLoggingConfiguration are account-level Bedrock settings that take ' +
            'no resource ARN (requires "*"); SSM is scoped to the internal stash path prefix; PassRole is ' +
            'scoped to the delivery role.',
        },
        {
          id: 'HIPAA.Security-IAMNoInlinePolicy',
          reason: 'Inline policy generated by Function.addToRolePolicy; scoped to this stack, not shared.',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Runtime is Python 3.13 (current); the pinned cdk-nag predates it in its latest-runtime list.',
        },
      ],
      true,
    );
    NagSuppressions.addResourceSuppressions(
      provider,
      [
        { id: 'AwsSolutions-IAM4', reason: 'CDK Provider framework Lambda execution role (AWSLambdaBasicExecutionRole).' },
        { id: 'AwsSolutions-IAM5', reason: 'CDK Provider framework grants invoke on its own onEvent handler; not customer-authored.' },
        { id: 'AwsSolutions-L1', reason: 'The CDK Provider framework Lambda runtime is pinned by aws-cdk-lib; not customer-controllable.' },
        { id: 'HIPAA.Security-IAMNoInlinePolicy', reason: 'CDK Provider framework-generated inline policy; not customer-controllable.' },
      ],
      true,
    );

    new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::BedrockInvocationLogging',
      properties: {
        LogGroupName: this.logGroup.logGroupName,
        LoggingConfig: JSON.stringify(loggingConfig),
        OwnershipMode: ownership,
        StashKey: stashKey,
        PhysicalId: `bedrock-invocation-logging-${stack.account}-${stack.region}`,
      },
    });
  }
}
