import * as bac from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';
import { InboundIdentity } from './identity';
import { renderCedarPolicy } from './cedar';

export interface AgentGatewayProps {
  config: PlatformConfig;
  /** Inbound IdP supplying the CUSTOM_JWT discovery URL + allowed clients. */
  identity: InboundIdentity;
  /** Evidence CMK ARN (imported from the baseline stack) for gateway + policy-engine encryption. */
  kmsKeyArn: string;
}

/**
 * AgentCore Gateway (MCP, CUSTOM_JWT inbound) fronted by a Cedar PolicyEngine. The engine starts in
 * LOG_ONLY by default so a first deploy observes decisions without blocking (flip to ENFORCE via
 * `agentcore.cedarMode` once tool-specific policies are validated). Baseline Cedar is rendered from
 * files per gateway (rule 7); tool-specific policies are added by the use-case once the gateway's
 * tool schema exists.
 */
export class AgentGateway extends Construct {
  readonly gateway: bac.CfnGateway;
  readonly policyEngine: bac.CfnPolicyEngine;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: AgentGatewayProps) {
    super(scope, id);
    const { config, identity, kmsKeyArn } = props;
    const name = `govai-${config.customerName}-${config.environment}`;

    // Gateway execution role: AgentCore assumes it to reach targets and use the CMK.
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: `AgentCore gateway execution role for ${config.customerName}`,
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
        resources: [kmsKeyArn],
      }),
    );

    this.policyEngine = new bac.CfnPolicyEngine(this, 'PolicyEngine', {
      name: `${name}-engine`,
      description: `Cedar policy engine for ${config.customerName} gateway`,
      encryptionKeyArn: kmsKeyArn,
    });

    const allowedClients = identity.allowedClients.length ? identity.allowedClients : undefined;
    this.gateway = new bac.CfnGateway(this, 'Gateway', {
      name: `${name}-gw`,
      description: `Governed MCP gateway for ${config.customerName}`,
      roleArn: this.role.roleArn,
      kmsKeyArn,
      authorizerType: 'CUSTOM_JWT',
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: identity.discoveryUrl,
          allowedClients,
        },
      },
      protocolType: 'MCP',
      policyEngineConfiguration: {
        arn: this.policyEngine.attrPolicyEngineArn,
        mode: config.agentcore.cedarMode ?? 'LOG_ONLY',
      },
    });
    this.gateway.addDependency(this.policyEngine);

    // Render + attach baseline Cedar (gateway-scoped; tool-specific policies come with the use-case).
    if (config.agentcore.attachBaselineCedarPolicies ?? true) {
      const statement = renderCedarPolicy('baseline/10-permit-authenticated.cedar', {
        gatewayArn: this.gateway.attrGatewayArn,
      });
      const baseline = new bac.CfnPolicy(this, 'BaselineAuthenticatedPolicy', {
        name: `${name}-baseline-authenticated`,
        description: 'Baseline: authenticated OAuth users may reach this gateway (refined by customer forbids).',
        policyEngineId: this.policyEngine.attrPolicyEngineId,
        definition: { cedar: { statement } },
        enforcementMode: 'ACTIVE',
      });
      baseline.addDependency(this.gateway);
    }
  }

  get gatewayArn(): string {
    return this.gateway.attrGatewayArn;
  }
  get gatewayUrl(): string {
    return this.gateway.attrGatewayUrl;
  }
}
