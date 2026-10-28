# CLAUDE.md — Governed AI Agent Platform (AgentCore)

Steering file for any coding agent (Claude Code, Kiro) working in this repo. Read fully before changing anything.

## What this repo is
A repeatable, CDK-deployable **AI governance platform** for SLG and HCLS customers, built on
Amazon Bedrock AgentCore. It ships three deployable units plus a single-account mode:

| Mode | Where it deploys | Stacks |
|---|---|---|
| `standalone` | One existing or new account (pilot path) | GovernanceBaseline + AgentPlatform + Controls (hub features collapsed in) |
| `hub` | Dedicated AI governance account | GovernanceHub |
| `spoke` | Each workload/agent account (new or existing) | GovernanceBaseline + AgentPlatform + Controls |
| `org` | Management or delegated-admin account | OrgFoundation (Bedrock org policy, SCPs, Guard hooks via StackSets) |

See `docs/ARCHITECTURE.md` for the decision record and `docs/CONTROLS.md` for the control matrix.

## Non-negotiable rules
1. **Ground every AWS resource in current AWS documentation.** Before adding or changing a resource,
   confirm the property names against the installed `aws-cdk-lib` typings
   (`node_modules/aws-cdk-lib/aws-<svc>/lib/*.generated.d.ts`) and the AWS docs. Do not invent properties.
   If a capability has no CloudFormation resource, implement it as an `AwsCustomResource` and say so in a
   comment. Grounded 2026-10-27: **only AWS Agent Registry and Bedrock model-invocation-logging still lack a
   CFN type.** AgentCore **Policy/PolicyEngine/Gateway/Runtime/Memory/WorkloadIdentity now DO have native L1**
   (`aws-cdk-lib/aws-bedrockagentcore`) — use them, not a custom resource. CloudWatch Omni is GA (API/CFN
   accessible); AgentCore Observability is convention-based (ADOT + Transaction Search via
   `AWS::XRay::TransactionSearchConfig`).
2. **Iterate in small steps.** After every change: `npm run build` → `npm run synth:<mode>` → `npm test`.
   Fix before moving on. Never deliver a large untested batch.
3. **No deployments from this machine without explicit approval.** The default AWS CLI profile is
   David's *personal* account. Synth and test only unless the user names a target account/profile.
4. **Prefer L1 (`aws-cdk-lib/aws-bedrockagentcore`) for anything a customer will run in production.**
   The `@aws-cdk/aws-bedrock-agentcore-alpha` L2s are allowed for convenience but are alpha — keep versions
   pinned exactly (no `^`) and isolate alpha usage inside `lib/constructs/` so it can be swapped.
5. **Everything is config-driven.** Customer differences live in `config/<customer>.json`
   (schema: `lib/config/platform-config.ts`). No customer names or account IDs in code.
6. **Security defaults:** customer-managed KMS on every store that supports it, S3 block public access +
   TLS-only + versioning, least-privilege IAM (no `*` actions on `*` resources without a nag suppression
   that explains why), cdk-nag `AwsSolutions` + `HIPAASecurity` packs must pass or carry justified suppressions.
7. **Cedar policies live in `policies/cedar/`**, not inline strings. `baseline/` applies to every customer;
   `customer/` is per-customer. Remember: Cedar has no wildcard actions, and policies naming specific tool
   actions must name a specific Gateway ARN — so baseline policies are templates rendered per gateway.
8. Tag every resource: `Platform=governed-ai`, `Customer`, `Environment`, `DataClassification`, `CostCenter`.

## Layout
```
bin/platform.ts            entry point; selects stacks by -c mode=
lib/config/                config schema + loader
lib/constructs/            reusable constructs (one concern each)
lib/stacks/                stacks composed from constructs
policies/cedar/            baseline + customer Cedar policies
policies/guard/            CloudFormation Guard rules (used by Guard hooks)
use-cases/                 first-use-case templates built on the harness
config/                    customer config files (*.example.json committed)
test/                      jest assertions on synthesized templates
docs/                      architecture, controls matrix, runbooks
```

## Build approach: consolidate, don't greenfield
This repo is the clean consolidation point for the prior **Aegis** work. Build steps 2–6 by **harvesting**
proven assets per **`docs/PORT-MAP.md`** (exact source-file → target → treatment for the private Aegis
lineage under `C:\Users\daryd\Projects-DR\` and the AWS-public clones under `C:\DRyder\_aws-public-reference\`).
Runtime = Python (reuse `governed-core` Strands harness); infra = CDK TypeScript. See `docs/ARCHITECTURE.md`
(ADR, incl. multi-agent + AWS provenance) and `docs/CONTROLS.md` (control matrix).

## Build plan (keep TaskList in sync)
1. ✅ Scaffold, decision record, config schema, empty synth — + grounded ADR/CONTROLS/PORT-MAP, extended config
2. ✅ Governance baseline: KMS, log bucket, CloudTrail (incl. AgentCore data events), Bedrock invocation logging (custom resource), guardrail **+ version**, account-level enforcement + `Null:{bedrock:GuardrailIdentifier}` ungoverned-inference deny
3. ✅ AgentCore layer (native L1): Cognito/IdP (short-lived tokens), Gateway + PolicyEngine + baseline Cedar (per-gateway), Memory, Runtime/RuntimeEndpoint (image-gated), Browser, CodeInterpreter, A2A protocol (config-driven; multi-agent *collaboration harness* lands in step 6), observability config
4. ✅ Controls (standalone/spoke): Cedar forbid-all kill switch, HITL Step Functions waitForTaskToken, Budgets + alerts, **per-user interceptor + ledger** (block / model-allowlist-by-group / rate limit; token+USD budget + auto-downgrade are RESPONSE-side follow-ups). Service Catalog, Guard hooks, Budgets SCP action moved to step 5 (hub/org); `CfnGatewayRateLimit` is per-use-case (per-dimension).
5. 🚧 Hub + org — slice A ✅ (OrgFoundation: lifted+parameterized AI-inference-perimeter + control-plane-integrity SCPs attached to Agentic OU, SCP-exempt deployer role). Remaining: Bedrock declarative policy, Guard hooks via StackSets, GovernanceHub (Registry+RAM, OAM cross-account sink + CloudWatch Omni, central log archive, Service Catalog product), Budgets→SCP cost action, SRA detective Config rules
6. use-cases/_harness + citizen-311 manifest; then verify all modes, cdk-nag, tests, per-mode runbooks (`docs/runbooks/`)
