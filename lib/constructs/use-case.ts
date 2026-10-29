import * as fs from 'fs';
import * as path from 'path';
import { Duration } from 'aws-cdk-lib';
import * as bac from 'aws-cdk-lib/aws-bedrockagentcore';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

// js-yaml is present transitively; no @types, so require() keeps it untyped (any).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const yaml = require('js-yaml');

export interface UseCaseProps {
  /** Repo-relative path to the manifest (e.g. use-cases/citizen-311/manifest.yaml). */
  manifestPath: string;
  gateway: bac.CfnGateway;
  policyEngine: bac.CfnPolicyEngine;
  /** Gateway execution role — granted lambda:InvokeFunction on each tool Lambda. */
  gatewayRole: iam.IRole;
}

/**
 * Deploys a use case onto the live gateway from its manifest: the tool Lambda(s), the gateway
 * target(s) that expose their MCP tools, and the tool-scoped Cedar policies (permit by Cognito group
 * + forbid the consequential action). This is the CDK-native equivalent of render.py's output —
 * it turns the manifest into real gateway targets + policies so the agent can run the full workflow.
 *
 * Policies use IGNORE_ALL_FINDINGS: the group-scoped permit is intentionally broad (narrowed by the
 * forbid), which AgentCore's automated reasoning would otherwise flag. The forbid names a specific
 * tool action, so it (and the policies) depend on the target that defines that action's schema.
 */
export class UseCase extends Construct {
  readonly toolLambdas: lambda.Function[] = [];
  readonly targets: bac.CfnGatewayTarget[] = [];
  readonly targetNames: string[] = [];
  readonly policies: bac.CfnPolicy[] = [];

  constructor(scope: Construct, id: string, props: UseCaseProps) {
    super(scope, id);
    const root = path.join(__dirname, '..', '..');
    const manifestAbs = path.join(root, props.manifestPath);
    const manifest = yaml.load(fs.readFileSync(manifestAbs, 'utf-8'));
    const prefix: string = manifest.agent.prefix;
    const reviewerGroup: string = manifest.identity.reviewer_group;
    const toolsDir = path.join(path.dirname(manifestAbs), 'tools');

    // Map each MCP tool name to its target, for Cedar action ids (<target>___<tool>).
    const toolToTarget: Record<string, string> = {};
    for (const t of manifest.tools) for (const mt of t.mcp_tools ?? []) toolToTarget[mt.name] = t.target;

    for (const t of manifest.tools) {
      const fn = new lambda.Function(this, `Tool-${t.target}`, {
        runtime: lambda.Runtime.PYTHON_3_13,
        handler: t.handler ?? 'index.handler',
        code: lambda.Code.fromAsset(toolsDir),
        timeout: Duration.seconds(30),
        description: `Tool Lambda for gateway target ${t.target}`,
      });
      fn.grantInvoke(props.gatewayRole);
      this.toolLambdas.push(fn);

      const inlinePayload = (t.mcp_tools ?? []).map((mt: any) => ({
        name: mt.name,
        description: mt.description ?? mt.name,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(mt.input ?? {}).map(([k, v]: [string, any]) => [
              k,
              { type: v.type, description: v.description ?? '' },
            ]),
          ),
          required: mt.required ?? [],
        },
      }));

      const target = new bac.CfnGatewayTarget(this, `Target-${t.target}`, {
        gatewayIdentifier: props.gateway.attrGatewayIdentifier,
        name: t.target,
        credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
        targetConfiguration: { mcp: { lambda: { lambdaArn: fn.functionArn, toolSchema: { inlinePayload } } } },
      });
      target.addDependency(props.gateway);
      this.targets.push(target);
      this.targetNames.push(t.target);
    }

    for (const p of manifest.policies ?? []) {
      let statement: string;
      if (p.kind === 'permit') {
        const grp = p.role_group ?? reviewerGroup;
        statement =
          'permit(principal is AgentCore::OAuthUser, action, resource is AgentCore::Gateway) when { ' +
          `principal.hasTag("cognito:groups") && principal.getTag("cognito:groups") like "*${grp}*" };`;
      } else {
        const aid = `${toolToTarget[p.action]}___${p.action}`;
        statement =
          `forbid(principal, action == AgentCore::Action::"${aid}", ` +
          `resource == AgentCore::Gateway::"${props.gateway.attrGatewayArn}")` +
          (p.unless_deidentified ? ' unless { context.input.deidentified == true };' : ';');
      }
      const policy = new bac.CfnPolicy(this, `Policy-${p.name}`, {
        name: `${prefix}_${p.name}`,
        description: `Use-case Cedar policy ${p.name} (${p.kind})`,
        policyEngineId: props.policyEngine.attrPolicyEngineId,
        definition: { cedar: { statement } },
        enforcementMode: 'ACTIVE',
        validationMode: 'IGNORE_ALL_FINDINGS',
      });
      // Targets define the action schema the forbid references; create policies after them.
      for (const target of this.targets) policy.addDependency(target);
      this.policies.push(policy);
    }
  }
}
