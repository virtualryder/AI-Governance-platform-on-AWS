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
   If a capability has no CloudFormation resource (today: AgentCore Registry, CloudWatch Omni,
   Bedrock model invocation logging), implement it as an `AwsCustomResource` and say so in a comment.
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

## Build plan (keep TaskList in sync)
1. ✅ Scaffold, decision record, config schema, empty synth
2. Governance baseline: KMS, log bucket, CloudTrail (incl. AgentCore data events), Bedrock invocation logging, guardrail + version, account-level guardrail enforcement
3. AgentCore layer: Cognito (short-lived tokens), Gateway + Policy engine + baseline Cedar, Memory, Runtime/Harness, Browser, observability config
4. Controls: kill switch (Cedar forbid-all / endpoint disable / SCP), HITL Step Functions (InvokeHarness + waitForTaskToken), Budgets + actions, Gateway rate limits, Guard hooks, Service Catalog product
5. Hub + org: Registry (custom resource, RAM share), cross-account observability sink, central log archive, Bedrock org policy, Agentic-OU SCPs
6. Verify all modes, nag, tests, docs
