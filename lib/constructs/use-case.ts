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
  /** The consequential action's tool name (manifest workflow.consequential_action), if any. */
  readonly consequentialTool?: string;
  /** ARN of the tool Lambda hosting the consequential action — the HITL executor's wired target. */
  readonly consequentialTargetArn?: string;
  /** Runtime model id from the manifest (passed to the runtime as MODEL_ID). */
  readonly runtimeModelId?: string;
  /** System prompt compiled from the manifest workflow (passed to the runtime as SYSTEM_PROMPT). */
  readonly systemPrompt?: string;

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

    const targetToFn: Record<string, lambda.Function> = {};
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
      targetToFn[t.target] = fn;

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

    // The consequential action (owned by the HITL gate, Cedar-forbidden to the agent). Expose the
    // Lambda hosting it so the Controls stack can wire it as the HITL executor's target.
    const consequential: string | undefined = manifest.workflow?.consequential_action;
    if (consequential && toolToTarget[consequential]) {
      this.consequentialTool = consequential;
      this.consequentialTargetArn = targetToFn[toolToTarget[consequential]]?.functionArn;
    }

    // Compile the runtime model + system prompt from the manifest so the Runtime is wired to the SAME
    // source of truth as the tools and policies (F16: one compiler, not drift between render.py and CDK).
    this.runtimeModelId = manifest.model?.runtime_model_id;
    const wf = manifest.workflow;
    if (wf?.steps) {
      // Single line: AgentCore Runtime environment variables reject control characters (incl. newlines).
      const steps = (wf.steps as string[]).map((s, i) => `(${i + 1}) ${s}`).join('; ');
      const raw =
        `You are the ${manifest.agent.title} agent. Run this governed workflow end to end: ${steps}. ` +
        (consequential
          ? `You must NEVER perform the consequential action "${consequential}" directly; when the ` +
            'workflow reaches it, call request_human_signoff with the required fields and STOP — a human ' +
            'approver files it through the sign-off gate. '
          : '') +
        'Use only the governed tools available to you at the gateway.';
      this.systemPrompt = raw.split('').map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim();
    }
  }
}
