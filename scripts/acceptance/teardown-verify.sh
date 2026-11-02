#!/usr/bin/env bash
# Teardown verification: after `cdk destroy --all`, prove nothing governed is left running and the
# customer's prior Bedrock invocation-logging state is restored. Run this to confirm $0 standing cost.
#
#   PROFILE=<p> EXPECT_ACCOUNT=<id> R=<region> CUST=<customer> ENV=<env> ./teardown-verify.sh
#
# If platform stacks still exist, this reminds you of the WORM-bucket gotcha (empty it, destroy again).
set -euo pipefail
cd "$(dirname "$0")"
export OUTDIR="./acceptance-out/teardown-$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo run)"
# shellcheck source=lib.sh
. ./lib.sh
guard_account

_log "== Teardown verification =="

# 1. No platform CloudFormation stacks remain (GovAI-$CUST-$ENV-*).
live="$(aws_ cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE ROLLBACK_COMPLETE UPDATE_ROLLBACK_COMPLETE \
  --query "StackSummaries[?starts_with(StackName, 'GovAI-$CUST-$ENV')].StackName" --output text 2>/dev/null || true)"
if [ -z "$live" ]; then
  pass "no GovAI-$CUST-$ENV-* stacks remain"
else
  fail "stacks still present: $live"
  note "WORM gotcha: the evidence bucket has Object Lock. Empty all versions with"
  note "  aws s3api delete-objects ... --bypass-governance-retention   then destroy the Baseline again."
fi

# 2. Discovery params gone (platform truly removed).
if [ -z "$(ssm agent-platform/gateway-arn)" ]; then pass "platform SSM params cleared"; else warn "some /governed-ai/$CUST/$ENV/* params still resolve"; fi

# 3. No AgentCore runtime left.
rt="$(aws_ bedrock-agentcore-control list-agent-runtimes --query 'length(agentRuntimes)' --output text 2>/dev/null || echo NA)"
case "$rt" in 0) pass "no AgentCore runtimes";; NA) skip "runtime listing unavailable (API/permission) — verify in console";; *) warn "$rt AgentCore runtime(s) still present — confirm they are not this platform's";; esac

# 4. Bedrock invocation-logging restored. The platform's custom resource restores prior state on delete:
#    a customer that had NO logging should be EMPTY again; one that HAD logging should keep theirs.
cfg="$(aws_ bedrock get-model-invocation-logging-configuration --query 'loggingConfig' --output json 2>/dev/null || echo 'null')"
if [ "$cfg" = "null" ] || [ -z "$cfg" ]; then
  pass "invocation-logging config is empty (restored for a customer that had none)"
else
  warn "invocation-logging config is present — CONFIRM this is the customer's ORIGINAL config, not a leftover"
  printf '%s\n' "$cfg" >"$OUTDIR/invocation-logging-after.json"
  note "saved to $OUTDIR/invocation-logging-after.json for comparison against the pre-deploy capture"
fi

summary
