import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface InvocationLoggingProps {
  config: PlatformConfig;
  /** CMK encrypting the invocation-log group. */
  encryptionKey: kms.Key;
  retention: logs.RetentionDays;
}

/**
 * Bedrock model-invocation logging (full prompt/response capture). There is no CloudFormation
 * resource for this account-level setting (CLAUDE.md rule 1), so it is applied with an
 * `AwsCustomResource` calling Put/DeleteModelInvocationLoggingConfiguration. Logs land in a
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

    new AwsCustomResource(this, 'Resource', {
      resourceType: 'Custom::BedrockInvocationLogging',
      // Use the provider runtime's bundled AWS SDK v3 (no npm install at deploy): faster, cheaper,
      // deterministic. The bundled SDK includes the bedrock logging-config APIs.
      installLatestAwsSdk: false,
      onCreate: {
        service: 'bedrock',
        action: 'PutModelInvocationLoggingConfiguration',
        parameters: { loggingConfig },
        physicalResourceId: PhysicalResourceId.of(`bedrock-invocation-logging-${stack.account}-${stack.region}`),
      },
      onUpdate: {
        service: 'bedrock',
        action: 'PutModelInvocationLoggingConfiguration',
        parameters: { loggingConfig },
        physicalResourceId: PhysicalResourceId.of(`bedrock-invocation-logging-${stack.account}-${stack.region}`),
      },
      onDelete: {
        service: 'bedrock',
        action: 'DeleteModelInvocationLoggingConfiguration',
      },
      // The custom-resource Lambda needs the bedrock logging-config APIs plus PassRole on the
      // delivery role (so Bedrock can assume it). PassRole is granted as an explicit statement.
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock:PutModelInvocationLoggingConfiguration',
            'bedrock:DeleteModelInvocationLoggingConfiguration',
            'bedrock:GetModelInvocationLoggingConfiguration',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [deliveryRole.roleArn],
        }),
      ]),
    });
  }
}
