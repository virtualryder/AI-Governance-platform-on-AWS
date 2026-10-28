# Governed AI Agent Platform (Amazon Bedrock AgentCore)

A repeatable, **config-driven, CDK-deployable AI governance platform** built on Amazon Bedrock
AgentCore. It targets regulated workloads — US State & Local Government (SLG) and Healthcare & Life
Sciences (HCLS) — and ships as four deployment modes so it can meet a customer where they already
are, from a single-account pilot to an organization-wide control plane.

**Start here:** `docs/ARCHITECTURE.md` (decision record) · `docs/CONTROLS.md` (control matrix) ·
`CLAUDE.md` (build rules and plan).

## Deployment modes
Pick the smallest mode that fits — reuse an existing landing zone rather than rebuilding one.

| Mode | Use when | Stacks |
|---|---|---|
| `standalone` | Pilot in one existing or new account (thin first slice) | Baseline + AgentPlatform + Controls (+ collapsed hub) |
| `spoke` | Add governed agents to an existing account / landing zone | Baseline + AgentPlatform + Controls |
| `hub` | Dedicated AI governance account (central telemetry, registry) | GovernanceHub |
| `org` | Management / delegated-admin account | OrgFoundation (Bedrock org policy, SCPs, Guard hooks via StackSets) |

```powershell
npx cdk deploy --all -c mode=standalone -c configFile=config/<customer>.json
```

## What's built

- **Governance baseline** (per account): customer-managed KMS, WORM evidence/log bucket (S3 Object
  Lock, TLS-only, versioned), multi-region CloudTrail with **AgentCore data events** (Gateway /
  Runtime) + CMK-encrypted CloudWatch Logs, **Bedrock model-invocation logging**, and a **versioned
  Bedrock Guardrail** with an ungoverned-inference deny (`Null:{bedrock:GuardrailIdentifier}`).
- **Security defaults everywhere:** customer-managed KMS on every store that supports it, S3 block
  public access, least-privilege IAM, and `cdk-nag` (`AwsSolutions` + `HIPAASecurity`) passing with
  justified, documented suppressions.
- **Config-driven:** all customer differences live in `config/<customer>.json`
  (schema: `lib/config/platform-config.ts`). No customer names or account IDs in code.

AgentCore runtime/gateway/identity, layered controls (kill switch, HITL, budgets, per-user
governance), hub/org foundation, and a first use-case harness are built in subsequent phases — see
the build plan in `CLAUDE.md`.

## Develop
```powershell
npm install
npm run build              # type-check
npm test                   # template assertions
npm run synth:standalone   # (also :hub :spoke :org)
npm run nag                # cdk-nag AwsSolutions + HIPAA packs
```
Copy `config/platform.example.json` to `config/<customer>.json` for each customer.

> **Deployment is intentionally not run from arbitrary machines.** Synth and test freely; deploy only
> against an explicitly named target account/profile.

## Status
Steps 1–3 complete and **deployed + verified on live AWS** (governance baseline + AgentCore layer:
Cognito JWT, MCP gateway + Cedar policy engine, memory, tools, observability). Step 4 (controls) done
for standalone/spoke — Cedar forbid-all kill switch, HITL `waitForTaskToken`, budgets + alerts, and a
per-user Gateway interceptor + DynamoDB ledger (block / model-allowlist-by-group / rate limit). All
four modes synth, 12 tests green, cdk-nag clean (both the default and interceptor-enabled paths).
Step 5 (hub/org) in progress — org SCPs + SCP-exempt deployer role, and the governance hub's central
WORM log archive + OAM cross-account sink are in; remaining: Bedrock org declarative policy, Guard
hooks (StackSets), Agent Registry, Service Catalog. Step 6 (Strands harness + citizen-311) in progress — the reusable `use-cases/_harness/` (Strands
`agent.py` + `render.py` manifest compiler + ARM64 Dockerfile) and the citizen-311 manifest are in and
render-verified (Cedar permit-by-group + forbid the consequential submit, MCP targets, guardrail).
See `CLAUDE.md` and `use-cases/README.md`.
