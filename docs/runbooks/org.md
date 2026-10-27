# Runbook — `org` (mandatory org-wide controls)

**When:** apply the non-negotiable, org-wide layer. **Target:** management account or (preferred)
delegated administrator. **Stacks:** `OrgFoundation`. **Highest blast radius — deploy with care.**

## Prerequisites
See [README — shared prerequisites](README.md). Plus:
- Run from the **management or delegated-admin** account; SCPs and declarative policies enabled in the Org.
- `org.controlTower` set: `enabled` → ship via CfCT + **service-managed** StackSets; `disabled` → plain
  **self-managed** StackSets; `auto` → detect.
- The **`aegis-platform-deployer`** SCP-exempt role name decided (config) — the lifted SCPs exempt only it,
  `AWSControlTowerExecution`, and the StackSet exec roles. **Verify this role exists before attaching SCPs
  or you will lock out governance administration.**
- `org.agenticOuId` = the OU that holds enrolled agent/workload accounts.

## Deploy (staged — do NOT attach deny SCPs blind)
```
npm run build && npm run synth:org -c configFile=config/<customer>.json -c nag=true && npm test
npx cdk diff --all -c mode=org -c configFile=config/<customer>.json --profile <mgmt-or-deladmin>
# Stage 1: deploy in LOG/report mode (Guard hooks warn-only; SCPs to a test OU first)
# Stage 2: promote SCPs/declarative policy to the Agentic OU after validating the deployer-role exemption
npx cdk deploy --all -c mode=org -c configFile=config/<customer>.json --profile <mgmt-or-deladmin>
```

## Verify
- SCPs attached to the Agentic OU: inference perimeter + control-plane integrity. Confirm the deployer role
  can still manage governance resources (exemption works).
- Bedrock **declarative policy** effective — `aws bedrock ... ` / `DescribeEffectivePolicy` shows the org
  guardrail floor on the OU.
- Guard hooks active across accounts (service-managed StackSet auto-deploys to new accounts).
- `bedrock:GuardrailIdentifier` SCP backstop in place (deny ungoverned inference).

## Rollback / kill switch
Detach SCPs from the OU (fastest broad stop is *adding* an invoke-deny SCP; rollback is *removing* the
restrictive SCPs). `cdk destroy` removes the StackSet/hook definitions. Keep the org trail intact.
