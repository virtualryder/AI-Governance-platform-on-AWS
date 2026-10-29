import * as fs from 'fs';
import * as path from 'path';
import * as organizations from 'aws-cdk-lib/aws-organizations';
import * as budgets from 'aws-cdk-lib/aws-budgets';
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
 * Role alignment (F03): the platform's execution roles are named under the governed prefix so these
 * SCPs admit them — the runtime role `<prefix>-runtime-*` (inference-perimeter allow), the kill-switch
 * role `<prefix>-killswitch-*` and the invocation-logging role `<prefix>-invlog-*` (control-plane
 * exemptions), plus the CDK CloudFormation execution role (`cdk-*-cfn-exec-role-*`) for deploys.
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

    // Cost kill switch: a detached "freeze" SCP that denies ALL Bedrock inference, attached to the
    // Agentic OU automatically by a Budgets action when monthly spend crosses 100%. The SCP exempts
    // the deployer role so remediation is still possible.
    const freezeScp = new organizations.CfnPolicy(this, 'CostFreezeScp', {
      name: `govai-${config.customerName}-cost-freeze`,
      description: 'Budget-triggered freeze: deny all Bedrock inference org-wide until lifted.',
      type: 'SERVICE_CONTROL_POLICY',
      content: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'FreezeBedrockInference',
            Effect: 'Deny',
            Action: ['bedrock:InvokeModel*', 'bedrock:Converse*', 'bedrock:InvokeAgent', 'bedrock:InvokeFlow'],
            Resource: '*',
            Condition: { ArnNotLike: { 'aws:PrincipalArn': [`arn:aws:iam::*:role/${deployerRole}`] } },
          },
        ],
      },
    });

    if (org.agenticOuId) {
      const budget = new budgets.CfnBudget(this, 'CostBudget', {
        budget: {
          budgetName: `govai-${config.customerName}-org`,
          budgetType: 'COST',
          timeUnit: 'MONTHLY',
          budgetLimit: { amount: config.controls.monthlyBudgetUsd, unit: 'USD' },
          // Scope the budget to Bedrock spend (F14) so it measures AI inference cost, not all account
          // cost. NOTE: this is still management-account billing data; it is not a per-OU attribution
          // and the freeze SCP it triggers only denies Bedrock inference, not other costs.
          costFilters: { Service: ['Amazon Bedrock'] },
        },
      });
      const actionRole = new iam.Role(this, 'BudgetActionRole', {
        assumedBy: new iam.ServicePrincipal('budgets.amazonaws.com'),
        description: 'Budgets assumes this to attach the cost-freeze SCP at threshold.',
      });
      actionRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['organizations:AttachPolicy', 'organizations:DetachPolicy'],
          resources: ['*'],
        }),
      );
      const action = new budgets.CfnBudgetsAction(this, 'CostFreezeAction', {
        budgetName: `govai-${config.customerName}-org`,
        notificationType: 'ACTUAL',
        actionType: 'APPLY_SCP_POLICY',
        actionThreshold: { value: 100, type: 'PERCENTAGE' },
        approvalModel: 'AUTOMATIC',
        executionRoleArn: actionRole.roleArn,
        definition: { scpActionDefinition: { policyId: freezeScp.attrId, targetIds: [org.agenticOuId] } },
        subscribers: config.controls.budgetAlertEmails.map((address) => ({ type: 'EMAIL', address })),
      });
      action.addDependency(budget);
    }
  }
}
