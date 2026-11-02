#!/usr/bin/env bash
# Preflight: verify the operator's environment and that the platform is deployed BEFORE running the
# acceptance matrix. Catches the hour-wasting mistakes (wrong account, Docker down, not bootstrapped,
# platform not deployed) up front. Read-only — no mutations.
#
#   PROFILE=<p> EXPECT_ACCOUNT=<id> R=<region> CUST=<customer> ENV=<env> ./preflight.sh
set -euo pipefail
cd "$(dirname "$0")"
# shellcheck source=lib.sh
. ./lib.sh

_log "== Preflight =="

# 1. Required CLIs present.
for bin in aws jq python curl docker node npx; do
  if command -v "$bin" >/dev/null 2>&1; then pass "tool present: $bin"; else fail "tool MISSING: $bin"; fi
done

# 2. Docker daemon up (the kill-switch Lambda bundles boto3 at synth/test time).
if docker info >/dev/null 2>&1; then pass "docker daemon running"; else warn "docker not running (needed for build/test, not for a read-only acceptance run)"; fi

# 3. Credentials resolve AND point at the intended account.
if aws_ sts get-caller-identity >/dev/null 2>&1; then
  guard_account
  pass "credentials resolve for profile '$PROFILE'"
else
  fail "cannot authenticate with profile '$PROFILE'"
fi

# 4. CDK bootstrap stack present (asset bucket/role exist for this account/region).
if aws_ cloudformation describe-stacks --stack-name CDKToolkit >/dev/null 2>&1; then
  pass "CDK bootstrap (CDKToolkit) present"
else
  fail "CDK bootstrap missing — run: npx cdk bootstrap aws://$EXPECT_ACCOUNT/$R --profile $PROFILE"
fi

# 5. Platform discovery params. BEFORE the first deploy these don't exist yet — that is EXPECTED and
#    not a failure (this is the first script a new SA runs). Anchor on the gateway param: if it's
#    absent the platform simply isn't deployed; if it's present, a missing sibling IS a real
#    (partial-deploy) failure.
anchor="$(ssm agent-platform/gateway-arn)"
if [ -z "$anchor" ] || [ "$anchor" = "None" ]; then
  note "platform not deployed yet for $CUST/$ENV (no gateway param) — EXPECTED before your first"
  note "deploy. Deploy per runbook §12b, then re-run preflight; these become PASS."
else
  need=(agent-platform/human-client-id controls/hitl-approvals-table controls/hitl-approval-fn-arn \
        controls/hitl-approver-role-arn controls/kill-switch-fn-arn baseline/guardrail-id)
  pass "discovered: agent-platform/gateway-arn"
  for p in "${need[@]}"; do
    v="$(ssm "$p")"
    if [ -n "$v" ] && [ "$v" != "None" ]; then pass "discovered: $p"; else fail "missing SSM param: /governed-ai/$CUST/$ENV/$p (partial deploy?)"; fi
  done
  # Runtime activated (a use case is deployed). Not fatal — governance can be validated without it.
  rt="$(ssm agent-platform/runtime-arn)"
  if [ -n "$rt" ] && [ "$rt" != "None" ]; then pass "runtime active (use case deployed)"; else warn "no runtime-arn — runtime-dependent checks (authorized/HITL) will SKIP; build the image + redeploy (runbook §12b)"; fi
fi

summary
