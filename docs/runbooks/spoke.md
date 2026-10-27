# Runbook — `spoke` (govern an existing workload account)

**When:** established customer; bring governance to a workload account **without migrating workloads**.
**Target:** each workload account, enrolled into the Agentic OU. **Stacks:** `Baseline`, `AgentPlatform`, `Controls`.

## Prerequisites
See [README — shared prerequisites](README.md). Plus:
- A `hub` account already deployed (Registry, OAM sink, log archive, Service Catalog) — see [hub](hub.md).
- Account enrolled in the Agentic OU (Control Tower "Enroll account" if CT present; else added to the OU).
- `hub.accountId` (and `organizationId`) set in `config/<customer>.json`; cross-account roles/KMS grants
  for the OAM link and central log archive.

## Config
As standalone, plus `hub` block and (if applicable) `deployment.strategy` (`distributed`/`federated`) with
`deployment.workloadAccountIds` / `federation`.

## Deploy
```
npm run build && npm run synth:spoke -c configFile=config/<customer>.json -c nag=true && npm test
npx cdk bootstrap aws://<account>/<region> --profile <target>   # once
npx cdk diff  --all -c mode=spoke -c configFile=config/<customer>.json --profile <target>
npx cdk deploy --all -c mode=spoke -c configFile=config/<customer>.json --profile <target>
```

## Verify
- SSM discovery path present; guardrail+version; invocation logging; CloudTrail data events.
- **OAM link** to the hub sink established — telemetry visible in the hub monitoring account / Omni Space.
- Gateway Cedar policies rendered against this account's Gateway ARN; per-user interceptor active if enabled.
- A2A collaborators (if any) reachable; `inter_agent.invoke_allowlist` present on the Runtime IAM role.

## Rollback / kill switch
Agent-level forbid-all + endpoint disable; broad stop via `org` SCP on this OU; `cdk destroy` to remove
(central log archive in the hub retains evidence).
