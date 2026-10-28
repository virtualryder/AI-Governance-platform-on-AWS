import { Construct } from 'constructs';
import { PlatformStack, PlatformStackProps } from './platform-stack';
import { OrgPolicies } from '../constructs/org-policies';
import { GuardHooks } from '../constructs/guard-hooks';
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

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    this.orgPolicies = new OrgPolicies(this, 'OrgPolicies', { config: this.config });
    this.guardHooks = new GuardHooks(this, 'GuardHooks', { config: this.config });

    this.publish('org-foundation/deployer-role', this.orgPolicies.deployerRole.roleName, 'SCP-exempt deployer role name');
    this.publish('org-foundation/guard-hook-alias', this.guardHooks.hook.alias, 'Baseline Guard Hook alias');
    this.publish('org-foundation/version', '0.3.0', 'OrgFoundation stack version');

    applyOrgNagSuppressions(this);
  }
}
