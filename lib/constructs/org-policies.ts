import * as fs from 'fs';
import * as path from 'path';
import * as organizations from 'aws-cdk-lib/aws-organizations';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { PlatformConfig } from '../config/platform-config';

export interface OrgPoliciesProps {
  config: PlatformConfig;
}

const POLICY_ROOT = path.join(__dirname, '..', '..', 'policies');

function renderPolicy(relativePath: string, vars: Record<string, string>): object {
  let text = fs.readFileSync(path.join(POLICY_ROOT, relativePath), 'utf-8');
  for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
  return JSON.parse(text);
}

/**
 * Organization SCPs (lifted from the Aegis WOGplatform baseline, parameterized per rule 5) plus the
 * SCP-exempt platform deployer role. The inference-perimeter SCP denies Bedrock inference to any
 * principal outside the governed-role prefix; the control-plane-integrity SCP protects invocation
 * logging, the AgentCore/guardrail control plane, and evidence vaults. Every SCP exempts the deployer
 * role (the kingpin — without it the SCPs would lock the platform out of its own account).
 *
 * NOTE: governed agent execution roles (gateway/runtime, step 3) must be named with the governed
 * prefix for the inference-perimeter exemption to admit them — tracked as a role-naming alignment.
 */
export class OrgPolicies extends Construct {
  readonly deployerRole: iam.Role;
  readonly scps: organizations.CfnPolicy[];
  /** Bedrock org declarative policy (BEDROCK_POLICY), pinning the org guardrail floor. */
  readonly bedrockPolicy?: organizations.CfnPolicy;

  constructor(scope: Construct, id: string, props: OrgPoliciesProps) {
    super(scope, id);
    const { config } = props;
    const org = config.org ?? {};
    const region = config.region;
    const deployerRole = org.deployerRoleName ?? `govai-${config.customerName}-platform-deployer`;
    const governedPrefix = org.governedRolePrefix ?? `govai-${config.customerName}-governed`;
    const evidencePrefix = org.evidenceBucketPrefix ?? `govai-${config.customerName}`;
    const vars = { GOVERNED_PREFIX: governedPrefix, DEPLOYER_ROLE: deployerRole, EVIDENCE_PREFIX: evidencePrefix };
    const targetIds = org.agenticOuId ? [org.agenticOuId] : undefined;

    this.scps = [
      new organizations.CfnPolicy(this, 'InferencePerimeter', {
        name: `govai-${config.customerName}-ai-inference-perimeter`,
        description: 'Deny Bedrock inference outside governed roles; protect governed roles.',
        type: 'SERVICE_CONTROL_POLICY',
        content: renderPolicy('scp/ai-inference-perimeter.json', vars),
        targetIds,
      }),
      new organizations.CfnPolicy(this, 'ControlPlaneIntegrity', {
        name: `govai-${config.customerName}-ai-control-plane-integrity`,
        description: 'Protect invocation logging, AgentCore/guardrail control plane, and evidence vaults.',
        type: 'SERVICE_CONTROL_POLICY',
        content: renderPolicy('scp/ai-control-plane-integrity.json', vars),
        targetIds,
      }),
    ];

    // Bedrock org declarative policy (BEDROCK_POLICY) — pins a guardrail floor + comprehensive content
    // guarding org-wide. Only when the customer supplies the org guardrail ARN to enforce.
    if (org.orgGuardrailArn) {
      this.bedrockPolicy = new organizations.CfnPolicy(this, 'BedrockFloor', {
        name: `govai-${config.customerName}-bedrock-floor`,
        description: 'Org Bedrock guardrail floor (declarative policy): required guardrail + comprehensive guarding.',
        type: 'BEDROCK_POLICY',
        content: renderPolicy('bedrock-org/floor-policy.json', {
          REGION: region,
          GUARDRAIL_ARN: org.orgGuardrailArn,
        }),
        targetIds,
      });
    }

    // The SCP-exempt deployer role: assumed within the account; empowered over exactly the governance
    // control plane the SCPs protect (so it can deploy/repair the platform while everyone else is denied).
    this.deployerRole = new iam.Role(this, 'DeployerRole', {
      roleName: deployerRole,
      assumedBy: new iam.AccountRootPrincipal(),
      description: 'SCP-exempt governed-AI platform deployer role.',
    });
    this.deployerRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'GovernanceControlPlane',
        actions: [
          'bedrock:*',
          'bedrock-agentcore:*',
          'cloudformation:*',
          'cloudtrail:*',
          'kms:*',
          's3:*',
          'logs:*',
          'iam:*',
          'organizations:DescribePolicy',
          'organizations:ListPolicies',
        ],
        resources: ['*'],
      }),
    );
  }
}
