# shellcheck shell=bash
# Shared helpers for the standalone acceptance harness. Source this; do not execute it.
#
# Required environment (set by the caller):
#   PROFILE         named AWS CLI profile for the acceptance account
#   EXPECT_ACCOUNT  the account id the run MUST target (guards against a mis-named profile)
#   R               region (e.g. us-east-1)
#   CUST            customerName from the deployed config
#   ENV             environment (e.g. dev)
# Optional:
#   OUTDIR          evidence directory (default: ./acceptance-out/<timestamp> — timestamp from caller)
#
# This file has NO side effects on load beyond defining functions and validating required vars.

set -euo pipefail

# ---- required-variable guard -----------------------------------------------------------------
: "${PROFILE:?set PROFILE to the named CLI profile for the acceptance account}"
: "${EXPECT_ACCOUNT:?set EXPECT_ACCOUNT to the intended acceptance account id}"
: "${R:?set R to the region}"
: "${CUST:?set CUST to the deployed config customerName}"
: "${ENV:?set ENV to the environment (e.g. dev)}"
OUTDIR="${OUTDIR:-./acceptance-out}"
mkdir -p "$OUTDIR"
REPORT="$OUTDIR/report.txt"

# ---- reporting -------------------------------------------------------------------------------
# Counters are kept in files so they survive subshells/pipes.
_C="$OUTDIR/.counters"; : >"$REPORT"; printf 'pass=0\nfail=0\nskip=0\nwarn=0\n' >"$_C"
_bump() { awk -F= -v k="$1" 'BEGIN{OFS="="} $1==k{$2=$2+1} {print}' "$_C" >"$_C.t" && mv "$_C.t" "$_C"; }
_log()  { printf '%s\n' "$*" | tee -a "$REPORT" >&2; }
pass()  { _bump pass; _log "PASS  $*"; }
fail()  { _bump fail; _log "FAIL  $*"; }
skip()  { _bump skip; _log "SKIP  $*"; }
warn()  { _bump warn; _log "WARN  $*"; }
note()  { _log "      $*"; }

# assert_eq <actual> <expected> <label>
assert_eq() { if [ "$1" = "$2" ]; then pass "$3 (= $2)"; else fail "$3 (got '$1', expected '$2')"; fi; }
# assert_contains <haystack> <needle> <label>  (case-insensitive)
assert_contains() {
  if printf '%s' "$1" | grep -qi -- "$2"; then pass "$3"; else fail "$3 (did not find '$2')"; fi
}

summary() {
  # shellcheck disable=SC1090
  . "$_C"
  _log "----------------------------------------------------------------"
  _log "RESULT  pass=$pass fail=$fail skip=$skip warn=$warn   (evidence: $OUTDIR)"
  [ "$fail" -eq 0 ]
}

# ---- AWS plumbing ----------------------------------------------------------------------------
aws_() { aws --profile "$PROFILE" --region "$R" "$@"; }

guard_account() {
  local got
  got="$(aws_ sts get-caller-identity --query Account --output text)"
  if [ "$got" != "$EXPECT_ACCOUNT" ]; then
    _log "ABORT  profile '$PROFILE' resolves to account $got, expected $EXPECT_ACCOUNT"
    exit 2
  fi
  note "account guard OK ($got)"
}

# ssm <name-suffix-after-/governed-ai/$CUST/$ENV/>  -> parameter value (empty string if absent)
ssm() {
  aws_ ssm get-parameter --name "/governed-ai/$CUST/$ENV/$1" \
    --query Parameter.Value --output text 2>/dev/null || true
}

# ---- domain helpers --------------------------------------------------------------------------
# ledger_status <actionDigest>  -> the HITL approvals row status (NONE if missing)
ledger_status() {
  local t; t="$(ssm controls/hitl-approvals-table)"
  aws_ dynamodb get-item --table-name "$t" --key "{\"pk\":{\"S\":\"$1\"}}" \
    --query 'Item.status.S' --output text 2>/dev/null || echo NONE
}

# chaos <fail|malformed|"">  -> toggle the reference tool's fault injection (no redeploy)
chaos() {
  local tool; tool="$(ssm agent-platform/consequential-target-arn)"
  [ -n "$tool" ] && [ "$tool" != "None" ] || { warn "no consequential-target-arn; skipping chaos $1"; return; }
  aws_ lambda update-function-configuration --function-name "$tool" \
    --environment "Variables={CHAOS_MODE=$1}" >/dev/null
  sleep 3
  note "CHAOS_MODE='$1' on $tool"
}

# cognito_access_token <username> <password>  -> ACCESS token (empty on failure)
cognito_access_token() {
  local client; client="$(ssm agent-platform/human-client-id)"
  aws_ cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id "$client" \
    --auth-parameters "USERNAME=$1,PASSWORD=$2" \
    --query 'AuthenticationResult.AccessToken' --output text 2>/dev/null || true
}

# invoke_runtime <access-token> <session-suffix> <json-payload>  -> raw agent response body
# (writes the body to $OUTDIR/<session-suffix>.json too, for evidence). Uses the HTTPS invocation
# endpoint with a Bearer ACCESS token — SigV4 invoke-agent-runtime is rejected (see runbook §A/§12b).
invoke_runtime() {
  local token="$1" suffix="$2" payload="$3" rt enc url
  rt="$(ssm agent-platform/runtime-arn)"
  [ -n "$rt" ] && [ "$rt" != "None" ] || { echo ""; return; }
  enc="$(python -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=""))' "$rt")"
  url="https://bedrock-agentcore.$R.amazonaws.com/runtimes/$enc/invocations?qualifier=DEFAULT"
  curl -sS -X POST "$url" \
    -H "Authorization: Bearer $token" \
    -H "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: acc-$suffix-$(printf '%012d' "${RANDOM}${RANDOM}" | cut -c1-12)" \
    -H "Content-Type: application/json" \
    -d "$payload" | tee "$OUTDIR/$suffix.json"
}

# newest_pending_digest  -> the actionDigest of the most-recent PENDING approvals row (empty if none)
# Used to correlate a workflow run with its HITL proposal.
newest_pending_digest() {
  local t; t="$(ssm controls/hitl-approvals-table)"
  aws_ dynamodb scan --table-name "$t" \
    --filter-expression '#s = :p' \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values '{":p":{"S":"PENDING"}}' \
    --query 'Items[0].pk.S' --output text 2>/dev/null || true
}
