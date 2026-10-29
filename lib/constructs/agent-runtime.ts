import { Stack } from 'aws-cdk-lib';
import * as bac from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';
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

  constructor(scope: Construct, id: string, props: AgentRuntimeProps) {
    super(scope, id);
    const { config, identity, kmsKeyArn, imageUri, environment } = props;
    const stack = Stack.of(this);
    const name = `govai_${config.customerName.replace(/-/g, '_')}_${config.environment}`;

    this.role = new iam.Role(this, 'Role', {
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
          `arn:${stack.partition}:bedrock:*::foundation-model/*`,
          // Cross-region inference profiles (e.g. us.anthropic.*) are account-scoped per region; the
          // agent's configured MODEL_ID is a profile, so InvokeModel needs the profile ARN too.
          `arn:${stack.partition}:bedrock:*:${stack.account}:inference-profile/*`,
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
