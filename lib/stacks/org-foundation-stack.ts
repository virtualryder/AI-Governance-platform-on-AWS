import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';
import { OrgPolicies } from '../constructs/org-policies';
import { GuardHooks } from '../constructs/guard-hooks';
import { GuardHookStackSet } from '../constructs/guard-hook-stackset';
import { applyOrgNagSuppressions } from './org-foundation-nag-suppressions';

/**
 * Org foundation (Task 5, slice A): organization SCPs (AI inference perimeter + control-plane
 * integrity) attached to the Agentic OU, plus the SCP-exempt platform deployer role. Deployed in the
 * management or delegated-admin account. Slice B adds the Bedrock org declarative policy, Guard hooks
 * via StackSets, and SRA detective Config rules. Targets an AWS Organization — synth/nag-verifiable
 * anywhere, but deploy requires Organizations management/delegated-admin.
 */
export class OrgFoundationStack extends PlatformStack {
  readonly orgPolicies: OrgPolicies;
  readonly guardHooks: GuardHooks;
  readonly guardHookStackSet?: GuardHookStackSet;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    this.orgPolicies = new OrgPolicies(this, 'OrgPolicies', { config: this.config });
    this.guardHooks = new GuardHooks(this, 'GuardHooks', { config: this.config });

    // Org-wide rollout of the baseline Guard hook to the Agentic OU (auto-deploys to new accounts).
    // Needs both the OU to target and the org ID to scope cross-account read of the central rules.
    const org = this.config.org;
    if (org?.agenticOuId && org.organizationId) {
      this.guardHookStackSet = new GuardHookStackSet(this, 'GuardHookStackSet', {
        config: this.config,
        rulesBucket: this.guardHooks.rulesBucket,
        rulesKey: 'rules/baseline.guard',
        organizationId: org.organizationId,
        agenticOuId: org.agenticOuId,
      });
    }

    this.publish('org-foundation/deployer-role', this.orgPolicies.deployerRole.roleName, 'SCP-exempt deployer role name');
    this.publish('org-foundation/guard-hook-alias', this.guardHooks.hook.alias, 'Baseline Guard Hook alias');
    if (this.guardHookStackSet) {
      this.publish('org-foundation/guard-hook-stackset', this.guardHookStackSet.stackSet.stackSetName, 'Org-wide Guard hook StackSet');
    }
    this.publish('org-foundation/version', '0.4.0', 'OrgFoundation stack version');

    applyOrgNagSuppressions(this);
  }
}
