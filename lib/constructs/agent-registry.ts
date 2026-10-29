import * as iam from 'aws-cdk-lib/aws-iam';
import * as ram from 'aws-cdk-lib/aws-ram';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface AgentRegistryProps {
  config: PlatformConfig;
}

/**
 * AWS Agent Registry for governed discovery (hub). Agent Registry has no CloudFormation type, so the
 * registry is created with an `AwsCustomResource` (bedrock-agentcore-control CreateRegistry); agents
 * publish records into it at runtime (`multiAgent.publishToRegistry`). When an organization ID is
 * configured, the registry is RAM-shared to the org so spoke accounts can discover agents.
 *
 * NOTE: NOT YET LIVE-VALIDATED — Agent Registry is a newer service. `installLatestAwsSdk` pulls a
 * current SDK (the Lambda runtime's bundled SDK may predate the control-plane client). API contract
 * grounded against AWS docs (2026-10-29): CreateRegistry returns `registryArn` (HTTP 202, async —
 * status goes CREATING→READY), and DeleteRegistry's `registryId` URI param accepts the ARN and
 * requires an empty registry. The create does NOT wait for READY here; if a consumer (e.g. the RAM
 * share) needs a READY registry, add a GetRegistry waiter before relying on it in production.
 */
export class AgentRegistry extends Construct {
  readonly registryArn: string;

  constructor(scope: Construct, id: string, props: AgentRegistryProps) {
    super(scope, id);
    const { config } = props;
    const name = `govai-${config.customerName}-${config.environment}`;

    const registry = new AwsCustomResource(this, 'Registry', {
      resourceType: 'Custom::AgentRegistry',
      installLatestAwsSdk: true,
      onCreate: {
        service: 'bedrock-agentcore-control',
        action: 'CreateRegistry',
        parameters: { name },
        // CreateRegistry returns `registryArn` (not `registryId`); DeleteRegistry accepts the ARN.
        physicalResourceId: PhysicalResourceId.fromResponse('registryArn'),
      },
      onDelete: {
        service: 'bedrock-agentcore-control',
        action: 'DeleteRegistry',
        // DeleteRegistry requires an empty registry; its `registryId` URI param accepts the ARN,
        // which is the physical id captured from CreateRegistry's `registryArn`.
        parameters: { registryId: new PhysicalResourceIdReference() },
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:CreateRegistry',
            'bedrock-agentcore:DeleteRegistry',
            'bedrock-agentcore:GetRegistry',
            'bedrock-agentcore:UpdateRegistry',
          ],
          resources: ['*'],
        }),
      ]),
    });
    this.registryArn = registry.getResponseField('registryArn');

    // Share the registry to the org for cross-account discovery.
    if (config.hub?.organizationId) {
      new ram.CfnResourceShare(this, 'Share', {
        name: `${name}-agent-registry`,
        resourceArns: [this.registryArn],
        principals: [`arn:${config.partition ?? 'aws'}:organizations::${config.hub.accountId}:organization/${config.hub.organizationId}`],
        allowExternalPrincipals: false,
      });
    }
  }
}
