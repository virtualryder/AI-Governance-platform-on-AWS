import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as bac from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';
import { InboundIdentity } from '../constructs/identity';
import { AgentGateway } from '../constructs/agent-gateway';
import { AgentMemory } from '../constructs/agent-memory';
import { AgentTools } from '../constructs/agent-tools';
import { AgentRuntime } from '../constructs/agent-runtime';
import { GatewayInterceptor } from '../constructs/gateway-interceptor';
import { Observability } from '../constructs/observability';
import { applyAgentPlatformNagSuppressions } from './agent-platform-nag-suppressions';

/**
 * AgentCore layer (Task 3): inbound identity, workload identity, Gateway + Cedar PolicyEngine,
 * Memory, Browser/CodeInterpreter, observability, and (when an image is configured) Runtime. Reads
 * the evidence CMK published by the GovernanceBaseline stack via SSM. Deployed in standalone/spoke.
 */
export class AgentPlatformStack extends PlatformStack {
  readonly identity: InboundIdentity;
  readonly gateway: AgentGateway;
  readonly memory?: AgentMemory;
  readonly tools: AgentTools;
  readonly runtime?: AgentRuntime;
  readonly interceptor?: GatewayInterceptor;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    const ac = this.config.agentcore;

    // Evidence CMK ARN from the baseline stack (resolved at deploy; baseline is a stack dependency).
    const kmsKeyArn = ssm.StringParameter.valueForStringParameter(this, `${this.paramPrefix}/baseline/evidence-key-arn`);

    this.identity = new InboundIdentity(this, 'Identity', { config: this.config });

    // Agent workload identity (AgentCore Identity) — the agent's own identity for OBO/token exchange.
    const workloadIdentity = new bac.CfnWorkloadIdentity(this, 'WorkloadIdentity', {
      name: `govai-${this.config.customerName}-${this.config.environment}`,
    });

    // Per-user governance interceptor (attached to the gateway at creation when enabled).
    if (this.config.controls.perUserGovernance?.enabled) {
      this.interceptor = new GatewayInterceptor(this, 'Interceptor', {
        config: this.config,
        encryptionKey: kms.Key.fromKeyArn(this, 'InterceptorKey', kmsKeyArn),
      });
    }

    this.gateway = new AgentGateway(this, 'Gateway', {
      config: this.config,
      identity: this.identity,
      kmsKeyArn,
      interceptorLambdaArn: this.interceptor?.fn.functionArn,
    });

    if (ac.enableMemory) {
      this.memory = new AgentMemory(this, 'Memory', { config: this.config, kmsKeyArn });
    }

    this.tools = new AgentTools(this, 'Tools', { config: this.config });

    if (ac.enableObservability ?? true) {
      new Observability(this, 'Observability', { config: this.config });
    }

    if (ac.runtimeImageUri) {
      this.runtime = new AgentRuntime(this, 'Runtime', {
        config: this.config,
        identity: this.identity,
        kmsKeyArn,
        imageUri: ac.runtimeImageUri,
        environment: {
          GATEWAY_URL: this.gateway.gatewayUrl,
          ...(this.memory ? { MEMORY_ID: this.memory.memoryId } : {}),
          WORKLOAD_IDENTITY_ARN: workloadIdentity.attrWorkloadIdentityArn,
        },
      });
    }

    // Discovery metadata for the harness, controls stack, and operators.
    this.publish('agent-platform/gateway-arn', this.gateway.gatewayArn, 'AgentCore gateway ARN');
    this.publish('agent-platform/gateway-url', this.gateway.gatewayUrl, 'AgentCore gateway MCP URL');
    this.publish('agent-platform/policy-engine-arn', this.gateway.policyEngine.attrPolicyEngineArn, 'Cedar policy engine ARN');
    this.publish('agent-platform/workload-identity-arn', workloadIdentity.attrWorkloadIdentityArn, 'Agent workload identity ARN');
    this.publish('agent-platform/idp-discovery-url', this.identity.discoveryUrl, 'Inbound IdP OIDC discovery URL');
    if (this.memory) this.publish('agent-platform/memory-id', this.memory.memoryId, 'AgentCore memory ID');
    if (this.interceptor) {
      this.publish('agent-platform/interceptor-ledger', this.interceptor.ledger.tableName, 'Per-user governance ledger table');
    }
    if (this.runtime) this.publish('agent-platform/runtime-arn', this.runtime.runtimeArn, 'AgentCore runtime ARN');
    this.publish('agent-platform/version', '0.2.0', 'AgentPlatform stack version');

    applyAgentPlatformNagSuppressions(this, { hasInterceptor: !!this.interceptor });
  }
}
