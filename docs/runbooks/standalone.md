# Runbook — `standalone` (pilot / single account)

**When:** proof-of-value, or a customer with no AWS Organization. All hub features collapse into one
account; graduates to hub+spoke later with no re-architecture.

**Target:** one account (new or existing). **Stacks:** `Baseline`, `AgentPlatform`, `Controls`, `Hub` (collapsed).

## Prerequisites
See [README — shared prerequisites](README.md). Plus: this account may host public-facing agents — confirm
data classification in config (`dataClassification`) drives guardrail strength + log retention.

## Config
`config/<customer>.json` with `environment`, `region`, `partition` (`aws`), `dataClassification`, the
`governance.guardrail` block, `agentcore` (protocol/multiAgent/cedarMode), and `controls`
(budget, killSwitch, humanInTheLoop, perUserGovernance).

## Deploy
```
# 1. validate
npm run build && npm run synth:standalone -c configFile=config/<customer>.json -c nag=true && npm test
# 2. bootstrap (once per account/region)
npx cdk bootstrap aws://<account>/<region> --profile <target>
# 3. deploy (review the diff first)
npx cdk diff  --all -c mode=standalone -c configFile=config/<customer>.json --profile <target>
npx cdk deploy --all -c mode=standalone -c configFile=config/<customer>.json --profile <target>
```

## Verify
- `aws ssm get-parameters-by-path --path /governed-ai/<customer>/<env> --recursive --profile <target>`.
- Guardrail + **version** exists; Bedrock invocation logging enabled (S3 + CW destinations).
- CloudTrail trail with AgentCore data events; WORM evidence bucket present.
- Gateway + PolicyEngine (Cedar) in `ENFORCE` (or `LOG_ONLY` for first run); Runtime endpoint healthy.
- Invoke the 311 harness end-to-end; confirm a trace (session→spans) in CloudWatch GenAI Observability.

## Rollback / kill switch
Agent-level forbid-all + endpoint disable (`controls.killSwitch`); `npx cdk destroy --all` to tear down
(evidence/log buckets are `RETAIN` in prod — remove manually with sign-off).

## Graduate to hub+spoke
Stand up a `hub` account, redeploy this account as `spoke`, add `org` controls. No code changes — only
the `-c mode=` and the hub account wiring in config.
