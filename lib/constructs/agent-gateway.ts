import { Stack } from 'aws-cdk-lib';
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
    // PolicyEngine/Policy names must match ^[A-Za-z][A-Za-z0-9_]*$ (underscores, no hyphens).
    const safe = `govai_${config.customerName.replace(/-/g, '_')}_${config.environment}`;

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
      name: `${safe}_engine`,
      description: `Cedar policy engine for ${config.customerName} gateway`,
      encryptionKeyArn: kmsKeyArn,
    });

    // The gateway binds to the policy engine using THIS role. At bind time AgentCore runs a
    // "GenesisPolicyEngineCheck" that calls GetPolicyEngine (engine metadata) and AuthorizeAction
    // (a Cedar evaluation) against BOTH the engine and the gateway, then AuthorizeAction on every
    // governed tool call. The gateway ARN carries a service-generated suffix unknown before create,
    // so AuthorizeAction is scoped to this platform's gateway-name prefix in this account/region.
    const stack = Stack.of(this);
    const gatewayArnPrefix = `arn:${stack.partition}:bedrock-agentcore:${stack.region}:${stack.account}:gateway/${name}-gw-*`;
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PolicyEngineRead',
        actions: ['bedrock-agentcore:GetPolicyEngine'],
        resources: [this.policyEngine.attrPolicyEngineArn],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PolicyEngineAuthorize',
        // Exact action set from the AWS "Gateway and Policy in AgentCore IAM Permissions" doc.
        actions: ['bedrock-agentcore:AuthorizeAction', 'bedrock-agentcore:PartiallyAuthorizeActions'],
        resources: [this.policyEngine.attrPolicyEngineArn, gatewayArnPrefix],
      }),
    );

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
    // Ensure the role AND its inline policy exist before the gateway (which assumes the role to call
    // GetPolicyEngine during creation) — avoids an AccessDenied race.
    this.gateway.node.addDependency(this.role);

    // Baseline Cedar is NOT attached by default: AgentCore's automated reasoning rejects a blanket
    // permit over "any future tools" as overly permissive, and deny-by-default already governs an
    // empty gateway. The use-case attaches tool-scoped permits once the gateway's tool schema exists.
    // Opt in only with a gateway that already has tools and a policy AgentCore will accept.
    if (config.agentcore.attachBaselineCedarPolicies ?? false) {
      const statement = renderCedarPolicy('baseline/10-permit-authenticated.cedar', {
        gatewayArn: this.gateway.attrGatewayArn,
      });
      const baseline = new bac.CfnPolicy(this, 'BaselineAuthenticatedPolicy', {
        name: `${safe}_baseline_authenticated`,
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
