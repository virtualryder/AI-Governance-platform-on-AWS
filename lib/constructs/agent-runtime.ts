import { Stack } from 'aws-cdk-lib';
import * as bac from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig, governedRolePrefix } from '../config/platform-config';
import { InboundIdentity } from './identity';

export interface AgentRuntimeProps {
  config: PlatformConfig;
  identity: InboundIdentity;
  kmsKeyArn: string;
  /** Container image URI in ECR. Required — the caller only instantiates this when it is set. */
  imageUri: string;
  /** Optional wiring passed to the container as environment variables. */
  environment?: Record<string, string>;
}

/**
 * AgentCore Runtime + endpoint. Only instantiated when `agentcore.runtimeImageUri` is set, because
 * a Runtime requires a built container image in ECR — produced by the use-case harness (step 6).
 * Inbound protocol comes from `agentcore.protocol` (HTTP default; A2A enables agent-to-agent).
 *
 * NOTE: `protocolConfiguration` is a plain string in the L1; confirm the exact serverProtocol literal
 * against AWS docs before the first Runtime deploy.
 */
export class AgentRuntime extends Construct {
  readonly runtime: bac.CfnRuntime;
  readonly endpoint: bac.CfnRuntimeEndpoint;
  readonly role: iam.Role;
  /** Deterministic HITL state-machine ARN the runtime may StartExecution on (when HITL is enabled). */
  readonly hitlStateMachineArn?: string;

  constructor(scope: Construct, id: string, props: AgentRuntimeProps) {
    super(scope, id);
    const { config, identity, kmsKeyArn, imageUri, environment } = props;
    const stack = Stack.of(this);
    const name = `govai_${config.customerName.replace(/-/g, '_')}_${config.environment}`;

    this.role = new iam.Role(this, 'Role', {
      // Named under the governed prefix so the org inference-perimeter SCP admits this role's
      // inference (otherwise a spoke under the SCP would deny its own agent). F03 principal alignment.
      roleName: `${governedRolePrefix(config)}-runtime-${config.environment}`,
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: `AgentCore runtime execution role for ${config.customerName}`,
    });
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EcrPull',
        actions: ['ecr:GetAuthorizationToken', 'ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer'],
        resources: ['*'],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Logs',
        actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`arn:${stack.partition}:logs:${stack.region}:${stack.account}:log-group:/aws/bedrock-agentcore/*`],
      }),
    );
    // Scope inference to the configured allowlist (F09): foundation-model ARNs for each allowed id,
    // plus the matching cross-region inference profiles (the agent's MODEL_ID is typically a profile
    // like us.anthropic.*). Falls back to a broad grant ONLY if no models are configured (which the
    // schema disallows — allowedModelIds is required). This replaces the previous foundation-model/*.
    const modelIds = config.agentcore.allowedModelIds ?? [];
    const modelResources = modelIds.length
      ? modelIds.flatMap((id) => [
          `arn:${stack.partition}:bedrock:*::foundation-model/${id}`,
          // `*` prefix covers the geo-prefixed cross-region profile ids (us./eu./apac.<id>).
          `arn:${stack.partition}:bedrock:*:${stack.account}:inference-profile/*${id}`,
        ])
      : [
          `arn:${stack.partition}:bedrock:*::foundation-model/*`,
          `arn:${stack.partition}:bedrock:*:${stack.account}:inference-profile/*`,
        ];
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GovernedInference',
        actions: [
          'bedrock:InvokeModel',
          'bedrock:InvokeModelWithResponseStream',
          'bedrock:Converse',
          'bedrock:ConverseStream',
          'bedrock:ApplyGuardrail',
        ],
        resources: [
          ...modelResources,
          // Customer-created application inference profiles are account-local, arbitrarily named
          // resources; account-scope them rather than enumerate.
          `arn:${stack.partition}:bedrock:*:${stack.account}:application-inference-profile/*`,
          `arn:${stack.partition}:bedrock:${stack.region}:${stack.account}:guardrail/*`,
        ],
      }),
    );
    this.role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'Cmk',
        actions: ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:DescribeKey'],
        resources: [kmsKeyArn],
      }),
    );

    // Human-in-the-loop: the agent starts the approval state machine for consequential actions instead
    // of performing them. The SM name is deterministic, so this grants StartExecution without a
    // cross-stack reference (Controls, which owns the SM, deploys after AgentPlatform).
    if (config.controls.humanInTheLoop) {
      this.hitlStateMachineArn = `arn:${stack.partition}:states:${stack.region}:${stack.account}:stateMachine:govai-${config.customerName}-${config.environment}-hitl`;
      this.role.addToPolicy(
        new iam.PolicyStatement({
          sid: 'StartHitlApproval',
          actions: ['states:StartExecution'],
          resources: [this.hitlStateMachineArn],
        }),
      );
    }

    // Multi-agent A2A collaboration: inter-agent invoke authz for allow-listed remote collaborators,
    // OBO token exchange, registry publish, and config passed to the Strands harness (which builds the
    // in-process Swarm/Graph and wraps each remote collaborator as an A2AAgent from MULTI_AGENT).
    // Cedar governs the invoked agent's TOOLS at its gateway — not the A2A invoke itself.
    const ma = config.agentcore.multiAgent;
    const maEnv: Record<string, string> = {};
    if (ma?.enabled) {
      maEnv.MULTI_AGENT = JSON.stringify(ma);
      maEnv.PROTOCOL = config.agentcore.protocol ?? 'HTTP';
      if (ma.sharedMemoryNamespace) maEnv.SHARED_MEMORY_NAMESPACE = ma.sharedMemoryNamespace;

      const invokeArns = (ma.remoteCollaborators ?? [])
        .map((c) => c.runtimeArn)
        .filter((a): a is string => !!a);
      if (invokeArns.length) {
        this.role.addToPolicy(
          new iam.PolicyStatement({
            sid: 'A2AInvoke',
            actions: ['bedrock-agentcore:InvokeAgentRuntime'],
            resources: invokeArns.flatMap((a) => [a, `${a}/runtime-endpoint/*`]),
          }),
        );
      }
      if ((ma.remoteCollaborators ?? []).some((c) => c.auth === 'obo')) {
        this.role.addToPolicy(
          new iam.PolicyStatement({
            sid: 'A2AOboTokenExchange',
            actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetResourceOauth2Token'],
            resources: ['*'],
          }),
        );
      }
      if (ma.publishToRegistry) {
        this.role.addToPolicy(
          new iam.PolicyStatement({
            sid: 'A2ARegistryPublish',
            actions: ['bedrock-agentcore:CreateRegistryRecord', 'bedrock-agentcore:UpdateRegistryRecord'],
            resources: ['*'],
          }),
        );
      }
    }
    const envVars = { ...(environment ?? {}), ...maEnv };

    const allowedClients = identity.allowedClients.length ? identity.allowedClients : undefined;
    this.runtime = new bac.CfnRuntime(this, 'Runtime', {
      agentRuntimeName: name,
      description: `Governed agent runtime for ${config.customerName}`,
      roleArn: this.role.roleArn,
      agentRuntimeArtifact: { containerConfiguration: { containerUri: imageUri } },
      networkConfiguration: { networkMode: 'PUBLIC' },
      protocolConfiguration: config.agentcore.protocol ?? 'HTTP',
      environmentVariables: Object.keys(envVars).length ? envVars : undefined,
      authorizerConfiguration: {
        customJwtAuthorizer: { discoveryUrl: identity.discoveryUrl, allowedClients },
      },
    });

    this.endpoint = new bac.CfnRuntimeEndpoint(this, 'Endpoint', {
      agentRuntimeId: this.runtime.attrAgentRuntimeId,
      name: `${name}_default`,
      description: 'Default runtime endpoint',
    });
    this.endpoint.addDependency(this.runtime);
  }

  get runtimeArn(): string {
    return this.runtime.attrAgentRuntimeArn;
  }
}
