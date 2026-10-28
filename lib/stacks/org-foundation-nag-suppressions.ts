import { NagSuppressions } from 'cdk-nag';
import { Stack } from 'aws-cdk-lib';

/**
 * Justified cdk-nag suppressions for OrgFoundation (CLAUDE.md rule 6). The deployer role is
 * deliberately the most privileged principal in the org — it is the single role every SCP exempts so
 * the platform can be deployed and repaired while all other principals are denied. Its breadth is the
 * design, not an oversight; it is scoped to the governance control plane and assumable only within
 * the account.
 */
export function applyOrgNagSuppressions(stack: Stack): void {
  const sid = stack.stackName;
  NagSuppressions.addResourceSuppressionsByPath(stack, `${sid}/OrgPolicies/DeployerRole/Resource`, [
    {
      id: 'HIPAA.Security-IAMNoInlinePolicy',
      reason: 'The SCP-exempt deployer role carries its governance-control-plane permissions inline; it is a single, named, non-shared break-glass role.',
    },
  ]);
  NagSuppressions.addResourceSuppressionsByPath(stack, `${sid}/OrgPolicies/DeployerRole/DefaultPolicy/Resource`, [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        'The platform deployer is intentionally the privileged SCP-exempt role: it must retain full control ' +
        'of the governance services (bedrock, bedrock-agentcore, kms, s3, logs, iam, cloudformation, cloudtrail) ' +
        'that the SCPs lock everyone else out of, otherwise the platform cannot be deployed or repaired. ' +
        'Assumable only within the account (AccountRootPrincipal).',
    },
    {
      id: 'HIPAA.Security-IAMNoInlinePolicy',
      reason: 'Inline policy on the single named break-glass deployer role; not a shared/reusable policy.',
    },
    {
      id: 'HIPAA.Security-IAMPolicyNoStatementsWithFullAccess',
      reason:
        'Full-access on the governance services is intentional for the SCP-exempt deployer: it is the only ' +
        'principal permitted to administer the control plane the SCPs protect, so it can deploy/repair the ' +
        'platform. Breadth is the design of a break-glass role assumable only within the account.',
    },
  ]);
}
