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
 * NOTE: UNVALIDATED on live AWS — Agent Registry is a newer service. `installLatestAwsSdk` pulls a
 * current SDK (the Lambda runtime's bundled SDK may predate the control-plane client). Confirm the
 * CreateRegistry/DeleteRegistry parameter shape and run once before relying on it in production.
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
        physicalResourceId: PhysicalResourceId.fromResponse('registryId'),
      },
      onDelete: {
        service: 'bedrock-agentcore-control',
        action: 'DeleteRegistry',
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
