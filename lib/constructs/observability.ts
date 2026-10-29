import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface ObservabilityProps {
  config: PlatformConfig;
}

/**
 * AgentCore Observability relies on CloudWatch Transaction Search: agent OTel spans land in
 * CloudWatch Logs, indexed into X-Ray for the GenAI trace map.
 *
 * Transaction Search is an account/region singleton. The CloudFormation resource
 * (`AWS::XRay::TransactionSearchConfig`) FAILS with AlreadyExists when the account already has it on —
 * which breaks any deploy into such an account. So this uses an idempotent `AwsCustomResource` that
 * sets the trace-segment destination to CloudWatchLogs (a no-op if already set) and, deliberately,
 * does NOT revert on delete — tearing this stack down must not disable an account-wide setting that
 * other workloads may depend on.
 */
export class Observability extends Construct {
  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);
    void props;

    new AwsCustomResource(this, 'TransactionSearch', {
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
  }
}
