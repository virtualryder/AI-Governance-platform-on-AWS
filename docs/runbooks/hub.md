# Runbook — `hub` (dedicated AI-governance account)

**When:** stand up the shared-services governance account for an established customer (maps to the AWS SRA
Security-Tooling / delegated-admin account). **Target:** the governance account. **Stacks:** `GovernanceHub`.

## Prerequisites
See [README — shared prerequisites](README.md). Plus:
- Account designated as **delegated administrator** for the relevant org services (RAM, CloudWatch/OAM,
  Service Catalog) via the management account.
- Organization ID known (for OAM sink policy scoped by `aws:PrincipalOrgID` and RAM shares).

## Config
`config/<customer>.json` with `hub.accountId` = this account and `hub.organizationId`.

## Deploy
```
npm run build && npm run synth:hub -c configFile=config/<customer>.json -c nag=true && npm test
npx cdk bootstrap aws://<account>/<region> --profile <hub>   # once
npx cdk diff  --all -c mode=hub -c configFile=config/<customer>.json --profile <hub>
npx cdk deploy --all -c mode=hub -c configFile=config/<customer>.json --profile <hub>
```

## Verify
- **OAM Sink** created with an org-scoped sink policy; spokes can create links.
- Central **log archive** bucket (WORM) present; RAM share for the Agent Registry active.
- **Service Catalog portfolio** shared to the org/OU with both products (platform + first use case).
- CloudWatch **Omni Space** visible, aggregating cross-account telemetry.

## Rollback
`cdk destroy` removes hub constructs; the log archive bucket is `RETAIN` — delete manually with sign-off.
Revoke RAM shares and the OAM sink policy if decommissioning.
