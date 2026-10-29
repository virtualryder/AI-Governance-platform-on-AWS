import { Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface ObservabilityProps {
  config: PlatformConfig;
}

/**
 * AgentCore Observability relies on CloudWatch Transaction Search: agent OTel spans land in
 * CloudWatch Logs, indexed into X-Ray for the GenAI trace map. Grounded against AWS's "Enable
 * Transaction Search" recipe (2026-10-29), which has THREE parts — all now implemented:
 *   1. A CloudWatch Logs resource policy letting X-Ray (`xray.amazonaws.com`) PutLogEvents to the
 *      `aws/spans` + `/aws/application-signals/data` groups (without it, spans never arrive).
 *   2. UpdateTraceSegmentDestination -> CloudWatchLogs.
 *   3. UpdateIndexingRule -> the configured sampling percentage (`observabilityIndexingPercentage`).
 *
 * Transaction Search is an account/region singleton; the custom resources are idempotent and do NOT
 * revert on delete (tearing this stack down must not disable an account-wide setting other workloads
 * may depend on).
 */
export class Observability extends Construct {
  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    const { config } = props;
    const stack = Stack.of(this);
    const indexPct = config.agentcore.observabilityIndexingPercentage ?? 5;

    // 1. Resource policy: X-Ray may ingest spans into the CloudWatch Logs span groups (scoped to this
    // account by SourceArn/SourceAccount). Declarative — no custom resource needed.
    const spanGroup = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:aws/spans:*`;
    const appSignalsGroup = `arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:/aws/application-signals/data:*`;
    const resourcePolicy = new logs.CfnResourcePolicy(this, 'TransactionSearchAccess', {
      policyName: `govai-${config.customerName}-${config.environment}-xray-spans`,
      policyDocument: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'TransactionSearchXRayAccess',
            Effect: 'Allow',
            Principal: { Service: 'xray.amazonaws.com' },
            Action: 'logs:PutLogEvents',
            Resource: [spanGroup, appSignalsGroup],
            Condition: {
              ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:xray:${stack.region}:${stack.account}:*` },
              StringEquals: { 'aws:SourceAccount': stack.account },
            },
          },
        ],
      }),
    });

    // 2 + 3. Enable ingestion to CloudWatch Logs and set the indexing percentage (idempotent).
    const transactionSearch = new AwsCustomResource(this, 'TransactionSearch', {
      resourceType: 'Custom::XRayTransactionSearch',
      installLatestAwsSdk: false,
      onUpdate: {
        service: 'xray',
        action: 'UpdateTraceSegmentDestination',
        parameters: { Destination: 'CloudWatchLogs' },
        physicalResourceId: PhysicalResourceId.of('xray-transaction-search'),
      },
      // No onDelete: Transaction Search is account/region-wide; leave it enabled on teardown.
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'xray:UpdateTraceSegmentDestination',
            'xray:GetTraceSegmentDestination',
            'xray:UpdateIndexingRule',
            'xray:GetIndexingRules',
          ],
          resources: ['*'],
        }),
      ]),
    });
    transactionSearch.node.addDependency(resourcePolicy);

    const indexingRule = new AwsCustomResource(this, 'IndexingRule', {
      resourceType: 'Custom::XRayIndexingRule',
      installLatestAwsSdk: false,
      onUpdate: {
        service: 'xray',
        action: 'UpdateIndexingRule',
        parameters: { Name: 'Default', Rule: { Probabilistic: { DesiredSamplingPercentage: indexPct } } },
        physicalResourceId: PhysicalResourceId.of(`xray-indexing-${indexPct}`),
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({ actions: ['xray:UpdateIndexingRule', 'xray:GetIndexingRules'], resources: ['*'] }),
      ]),
    });
    indexingRule.node.addDependency(transactionSearch);
  }
}
