# Deployment Runbooks

One runbook per deployment method. Pick by the customer's situation:

| Method | When | Target account | Stacks |
|---|---|---|---|
| [standalone](standalone.md) | Pilot / PoV; customer with no Organization; fastest value | one account | Baseline + AgentPlatform + Controls + Hub (collapsed) |
| [spoke](spoke.md) | Established customer; govern an existing workload account | each workload account (enrolled in Agentic OU) | Baseline + AgentPlatform + Controls |
| [hub](hub.md) | Dedicated AI-governance account (shared services) | governance/delegated-admin account | GovernanceHub |
| [org](org.md) | Mandatory org-wide controls | management or delegated-admin account | OrgFoundation |

Typical rollout for an established customer: **hub** once → **spoke** per workload account → **org** once.
Greenfield/pilot: **standalone**, then graduate to hub + spoke with no re-architecture.

## Shared prerequisites (all methods)
- Node 22+, repo deps installed (`npm ci`), CDK via `npx` (pinned in `package.json`).
- AWS credentials for the **target** account/region. **No deploys from a personal profile** — name the
  target explicitly (`--profile <name>`), per CLAUDE.md rule #3.
- Region/partition: commercial-first (`partition: "aws"`). GovCloud (`aws-us-gov`) is gated on per-service
  availability — confirm AgentCore/Omni/declarative-policy before deploying there.
- A customer config file: copy `config/platform.example.json` → `config/<customer>.json` and edit
  (schema: `lib/config/platform-config.ts`). Pass it with `-c configFile=config/<customer>.json`.
- One-time per account/region: `npx cdk bootstrap aws://<account>/<region> --profile <name>`.

## Build/verify loop (before any deploy)
```
npm run build && npm run synth:<mode> -c configFile=config/<customer>.json && npm test
```
Add cdk-nag: append `-c nag=true` to synth; resolve or justify every AwsSolutions/HIPAASecurity finding.

## Common verification
- `aws ssm get-parameters-by-path --path /governed-ai/<customer>/<env> --recursive` — platform discovery
  metadata published by each stack.
- CloudTrail (incl. AgentCore data events), Bedrock invocation logging destinations, and guardrail version
  present (see per-method runbook).

## Common rollback / kill switch
- **Fast (agent-level):** flip Cedar policy engine to forbid-all and/or disable the Runtime endpoint
  (Controls stack; `controls.killSwitch`). Fans out across every agent in a multi-agent graph.
- **Broad (account/OU):** SCP deny on `bedrock:InvokeModel*` / `bedrock-agentcore:InvokeAgentRuntime*`
  (org mode).
- **Cost:** Budgets SCP action trips at threshold.
- **Stack rollback:** `npx cdk destroy <StackId> -c mode=<mode> -c configFile=... --profile <name>`
  (WORM evidence buckets + retained log archives are `RETAIN` in prod — delete manually only with sign-off).
