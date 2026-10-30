import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';
import { toRetentionDays } from './retention';

export interface AuditTrailProps {
  config: PlatformConfig;
  /** Evidence/log bucket the trail writes to (WORM). */
  bucket: s3.IBucket;
  /** CMK for trail SSE-KMS and the CloudWatch Logs group. */
  encryptionKey: kms.Key;
}

/**
 * CloudTrail data-event `resources.type` values for Bedrock AgentCore, grounded against AWS docs
 * (2026-10-27). Each type is logged by a distinct advanced event selector.
 *  - AWS::BedrockAgentCore::Gateway  -> InvokeGateway (MCP tool calls; identity is JWT `sub`, not SigV4)
 *  - AWS::BedrockAgentCore::Runtime  -> InvokeAgentRuntime / ...Command / ...CommandShell
 *  - AWS::Bedrock::Guardrail         -> ApplyGuardrail (guardrail evaluations, incl. during inference)
 * Agent Registry (InvokeRegistryMcp) has no documented resources.type yet; add when published.
 */
const AGENTCORE_DATA_EVENT_RESOURCE_TYPES = [
  'AWS::BedrockAgentCore::Gateway',
  'AWS::BedrockAgentCore::Runtime',
  'AWS::Bedrock::Guardrail',
] as const;

/**
 * Multi-region CloudTrail landing in the WORM evidence bucket and mirrored to CloudWatch Logs.
 * Management events are always captured; AgentCore/Bedrock data events are added as advanced event
 * selectors when `governance.cloudTrailDataEvents` is true. Uses advanced (not basic) selectors
 * because AgentCore resource types aren't in the L2 `DataResourceType` enum.
 */
export class AuditTrail extends Construct {
  readonly trail: cloudtrail.Trail;

  constructor(scope: Construct, id: string, props: AuditTrailProps) {
    super(scope, id);
    const { config, bucket, encryptionKey } = props;
    const stack = Stack.of(this);

    // Own the CloudWatch log group so it is CMK-encrypted (the L2 default group is unencrypted).
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      retention: toRetentionDays(config.governance.logRetentionDays),
      encryptionKey,
      removalPolicy: config.environment === 'prod' ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.trail = new cloudtrail.Trail(this, 'Trail', {
      bucket,
      encryptionKey,
      sendToCloudWatchLogs: true,
      cloudWatchLogGroup: logGroup,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
    });

    // CloudTrail needs the CMK to encrypt log files (SSE-KMS). The L2 doesn't touch the key policy,
    // so grant it here, scoped to trails in this account via the CloudTrail encryption context.
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudTrailEncrypt',
        principals: [new iam.ServicePrincipal('cloudtrail.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringLike: {
            'kms:EncryptionContext:aws:cloudtrail:arn': `arn:${stack.partition}:cloudtrail:*:${stack.account}:trail/*`,
          },
        },
      }),
    );

    // Build advanced event selectors: always management events; data events per config.
    const selectors: cloudtrail.CfnTrail.AdvancedEventSelectorProperty[] = [
      {
        name: 'Management events',
        fieldSelectors: [{ field: 'eventCategory', equalTo: ['Management'] }],
      },
    ];

    if (config.governance.cloudTrailDataEvents) {
      for (const resourceType of AGENTCORE_DATA_EVENT_RESOURCE_TYPES) {
        selectors.push({
          name: `Data events: ${resourceType}`,
          fieldSelectors: [
            { field: 'eventCategory', equalTo: ['Data'] },
            { field: 'resources.type', equalTo: [resourceType] },
          ],
        });
      }

      // The HITL approval is performed by invoking the approval Lambda — an AWS::Lambda::Function DATA
      // event, which the management-event selector does NOT capture. Without this, the approval-audit
      // story rests only on the AssumeRole (management) event, not the invoke itself (review #2). Scope
      // the selector to the deterministically-named approval function so we capture that invoke WITHOUT
      // logging (and paying for) every Lambda data event in the account. Matched by ARN prefix so a
      // version/alias qualifier still matches. Only added when HITL is deployed.
      if (config.controls.humanInTheLoop) {
        const approvalFnArn = `arn:${stack.partition}:lambda:${stack.region}:${stack.account}:function:govai-${config.customerName}-${config.environment}-hitl-approval`;
        selectors.push({
          name: 'Data events: HITL approval Lambda',
          fieldSelectors: [
            { field: 'eventCategory', equalTo: ['Data'] },
            { field: 'resources.type', equalTo: ['AWS::Lambda::Function'] },
            { field: 'resources.ARN', startsWith: [approvalFnArn] },
          ],
        });
      }
    }

    // Swap the L2's (empty) basic EventSelectors for advanced ones — CloudFormation forbids both.
    const cfnTrail = this.trail.node.defaultChild as cloudtrail.CfnTrail;
    cfnTrail.addPropertyDeletionOverride('EventSelectors');
    cfnTrail.advancedEventSelectors = selectors;
  }
}
