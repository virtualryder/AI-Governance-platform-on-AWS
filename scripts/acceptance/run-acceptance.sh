#!/usr/bin/env bash
# Standalone acceptance harness — runs the §15 / §15b matrix and emits a pass/fail report plus raw
# evidence under ./acceptance-out/. Each check is independent; use --only to run a subset while
# shaking things out. Synthetic data only, in the acceptance account.
#
#   PROFILE=<p> EXPECT_ACCOUNT=<id> R=<region> CUST=<customer> ENV=<env> \
#   CSR_PASSWORD=<pw> VIEWER_PASSWORD=<pw> \
#   ./run-acceptance.sh [--only unauthorized,hitl-approve,hitl-reject,hitl-replay,backend-fail,backend-unknown,missing-guardrail,wrong-guardrail,killswitch]
#
# Identities (create with scripts/create-human-user.sh): csr-alice (group csr-agents), viewer-bob (no group).
# NOTE: these scripts encode the runbook procedures; their first live shakeout is the second-operator
# acceptance run. Treat a FAIL as either a real defect OR a harness/environment bug until triaged.
set -euo pipefail
cd "$(dirname "$0")"
TS="$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo run)"
export OUTDIR="./acceptance-out/$TS"
# shellcheck source=lib.sh
. ./lib.sh

ONLY=""
[ "${1:-}" = "--only" ] && ONLY="${2:-}"
want() { [ -z "$ONLY" ] || printf '%s' ",$ONLY," | grep -qi -- ",$1,"; }

CSR_USER="${CSR_USER:-csr-alice}"; VIEWER_USER="${VIEWER_USER:-viewer-bob}"
PROMPT='{"access_token":"__T__","case_id":"CASE-ACC","prompt":"Pothole at 100 Main St; run the workflow and request sign-off."}'
ROLE_PREFIX="${GOVERNED_ROLE_PREFIX:-govai-$CUST-governed}"

guard_account

# capture_approval <username> <password> <session>
#   drives one workflow run, captures the HITL task token + actionDigest from the approval SNS topic
#   via a throwaway SQS subscription. Echoes "<taskToken>\t<actionDigest>" (empty fields on failure).
capture_approval() {
  local user="$1" pass="$2" sess="$3" tok q url arn subs body inner tt dg
  tok="$(cognito_access_token "$user" "$pass")"
  [ -n "$tok" ] && [ "$tok" != "None" ] || { note "no token for $user"; echo; return; }

  local topic; topic="$(ssm controls/hitl-approval-topic-arn)"
  q="acc-$sess-$$"
  url="$(aws_ sqs create-queue --queue-name "$q" --query QueueUrl --output text)"
  arn="$(aws_ sqs get-queue-attributes --queue-url "$url" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
  # allow the approval topic to deliver to this queue
  aws_ sqs set-queue-attributes --queue-url "$url" --attributes "$(jq -nc --arg a "$arn" --arg t "$topic" \
    '{Policy:({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{Service:"sns.amazonaws.com"},Action:"sqs:SendMessage",Resource:$a,Condition:{ArnEquals:{"aws:SourceArn":$t}}}]}|tostring)}')" >/dev/null
  subs="$(aws_ sns subscribe --topic-arn "$topic" --protocol sqs --notification-endpoint "$arn" --query SubscriptionArn --output text)"

  invoke_runtime "$tok" "$sess" "${PROMPT/__T__/$tok}" >/dev/null 2>&1 || true

  # poll up to ~120s for the task-token message
  tt=""; dg=""
  for _ in $(seq 1 24); do
    body="$(aws_ sqs receive-message --queue-url "$url" --wait-time-seconds 5 --max-number-of-messages 1 --query 'Messages[0].Body' --output text 2>/dev/null || true)"
    if [ -n "$body" ] && [ "$body" != "None" ]; then
      inner="$(printf '%s' "$body" | jq -r '.Message' 2>/dev/null || echo '')"
      tt="$(printf '%s' "$inner" | jq -r '.taskToken // empty' 2>/dev/null || echo '')"
      dg="$(printf '%s' "$inner" | jq -r '.actionDigest // empty' 2>/dev/null || echo '')"
      [ -n "$tt" ] && break
    fi
  done
  aws_ sns unsubscribe --subscription-arn "$subs" >/dev/null 2>&1 || true
  aws_ sqs delete-queue --queue-url "$url" >/dev/null 2>&1 || true
  printf '%s\t%s\n' "$tt" "$dg"
}

# approver_resolve <taskToken> <approve|reject>
approver_resolve() {
  local token="$1" decision="$2" role fn creds
  role="$(ssm controls/hitl-approver-role-arn)"; fn="$(ssm controls/hitl-approval-fn-arn)"
  creds="$(aws_ sts assume-role --role-arn "$role" --role-session-name acc-approver --query Credentials --output json)"
  AWS_ACCESS_KEY_ID="$(printf '%s' "$creds" | jq -r .AccessKeyId)" \
  AWS_SECRET_ACCESS_KEY="$(printf '%s' "$creds" | jq -r .SecretAccessKey)" \
  AWS_SESSION_TOKEN="$(printf '%s' "$creds" | jq -r .SessionToken)" \
  aws --region "$R" lambda invoke --function-name "$fn" \
    --payload "$(jq -nc --arg t "$token" --arg d "$decision" '{taskToken:$t,decision:$d,approver:"acceptance-supervisor"}')" \
    "$OUTDIR/approve-$decision.json" >/dev/null 2>&1
}

# wait_status <digest> <expected> <label>  — poll the ledger up to ~30s for a terminal status
wait_status() {
  local dg="$1" want="$2" label="$3" s=""
  for _ in $(seq 1 15); do s="$(ledger_status "$dg")"; [ "$s" = "$want" ] && break; sleep 2; done
  assert_eq "$s" "$want" "$label"
}

# -------- checks ------------------------------------------------------------------------------
check_unauthorized() {
  _log "== unauthorized identity (no group) =="
  [ -n "${VIEWER_PASSWORD:-}" ] || { skip "unauthorized: set VIEWER_PASSWORD"; return; }
  [ -n "$(ssm agent-platform/runtime-arn)" ] || { skip "unauthorized: no runtime"; return; }
  local tok resp
  tok="$(cognito_access_token "$VIEWER_USER" "$VIEWER_PASSWORD")"
  [ -n "$tok" ] && [ "$tok" != "None" ] || { fail "unauthorized: could not get a token for $VIEWER_USER"; return; }
  resp="$(invoke_runtime "$tok" unauthorized "${PROMPT/__T__/$tok}")"
  assert_contains "$resp" "den" "unauthorized: response signals denial (deny-by-default)"
  note "full response saved to $OUTDIR/unauthorized.json (eyeball: zero governed tools listed)"
}

_hitl_case() { # <chaos> <decision> <expected-status> <session> <label>
  local chaos_mode="$1" decision="$2" expect="$3" sess="$4" label="$5" out tt dg
  [ -n "${CSR_PASSWORD:-}" ] || { skip "$label: set CSR_PASSWORD"; return; }
  [ -n "$(ssm agent-platform/runtime-arn)" ] || { skip "$label: no runtime"; return; }
  [ -n "$chaos_mode" ] && chaos "$chaos_mode"
  out="$(capture_approval "$CSR_USER" "$CSR_PASSWORD" "$sess")"
  tt="$(printf '%s' "$out" | cut -f1)"; dg="$(printf '%s' "$out" | cut -f2)"
  if [ -z "$tt" ] || [ -z "$dg" ]; then fail "$label: workflow did not reach the sign-off gate (no task token captured)"; [ -n "$chaos_mode" ] && chaos ""; return; fi
  pass "$label: consequential action paused for human sign-off (digest ${dg:0:12}…)"
  approver_resolve "$tt" "$decision" || true
  wait_status "$dg" "$expect" "$label: ledger status"
  [ -n "$chaos_mode" ] && chaos ""
  LAST_TOKEN="$tt"; LAST_DIGEST="$dg"
}

check_hitl_approve()  { _log "== HITL approve -> COMPLETED =="; _hitl_case "" approve COMPLETED approve "HITL approve"; }
check_hitl_reject()   { _log "== HITL reject -> REJECTED ==";  _hitl_case "" reject  REJECTED  reject  "HITL reject"; }
check_backend_fail()  { _log "== backend error -> FAILED ==";  _hitl_case fail approve FAILED  bfail   "backend-fail"; }
check_backend_unknown(){ _log "== uncertain -> UNKNOWN ==";    _hitl_case malformed approve UNKNOWN bunknown "backend-unknown"; }

check_hitl_replay() {
  _log "== HITL replay -> no second execution =="
  check_hitl_approve   # establishes LAST_TOKEN/LAST_DIGEST on a COMPLETED row
  [ -n "${LAST_TOKEN:-}" ] || { skip "replay: no prior approval to replay"; return; }
  approver_resolve "$LAST_TOKEN" approve || true   # second resolve of the SAME token
  local s; s="$(ledger_status "$LAST_DIGEST")"
  assert_eq "$s" "COMPLETED" "replay: ledger still COMPLETED (not re-executed)"
  note "a second approval of a closed token is a no-op; the single COMPLETED row is the exactly-once evidence"
}

_invoke_model_as_runtime() { # <extra-args...> -> echoes stderr (expect AccessDenied)
  local role creds; role="$ROLE_PREFIX-runtime-$ENV"
  local arn; arn="$(aws_ iam get-role --role-name "$role" --query Role.Arn --output text 2>/dev/null || true)"
  [ -n "$arn" ] || { echo "NO_ROLE"; return; }
  creds="$(aws_ sts assume-role --role-arn "$arn" --role-session-name acc-gr --query Credentials --output json 2>/dev/null || true)"
  [ -n "$creds" ] || { echo "ASSUME_FAILED"; return; }
  # Model id defaults to the standalone profile's allowlisted model; override with ACC_MODEL_ID.
  AWS_ACCESS_KEY_ID="$(printf '%s' "$creds" | jq -r .AccessKeyId)" \
  AWS_SECRET_ACCESS_KEY="$(printf '%s' "$creds" | jq -r .SecretAccessKey)" \
  AWS_SESSION_TOKEN="$(printf '%s' "$creds" | jq -r .SessionToken)" \
  aws --region "$R" bedrock-runtime invoke-model \
    --model-id "${ACC_MODEL_ID:-anthropic.claude-sonnet-4-5-20250929-v1:0}" \
    --body '{"anthropic_version":"bedrock-2023-05-31","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}' \
    "$@" /dev/stdout 2>&1 || true
}

check_missing_guardrail() {
  _log "== missing guardrail -> AccessDenied =="
  local out; out="$(_invoke_model_as_runtime)"
  case "$out" in
    NO_ROLE)       skip "missing-guardrail: runtime role not found ($ROLE_PREFIX-runtime-$ENV)";;
    ASSUME_FAILED) skip "missing-guardrail: could not assume the runtime role (trust/permission)";;
    *)             assert_contains "$out" "AccessDenied" "missing-guardrail: ungoverned inference denied";;
  esac
}

check_wrong_guardrail() {
  _log "== wrong guardrail -> AccessDenied =="
  local out; out="$(_invoke_model_as_runtime --guardrail-identifier "gr-wrong000000" --guardrail-version 1)"
  case "$out" in
    NO_ROLE|ASSUME_FAILED) skip "wrong-guardrail: runtime role unavailable";;
    *) assert_contains "$out" "AccessDenied" "wrong-guardrail: unapproved guardrail denied";;
  esac
}

check_killswitch() {
  _log "== kill switch engage/release =="
  local fn out; fn="$(ssm controls/kill-switch-fn-arn)"
  [ -n "$fn" ] && [ "$fn" != "None" ] || { skip "killswitch: no kill-switch fn"; return; }
  aws_ lambda invoke --function-name "$fn" --payload "$(printf '%s' '{"action":"engage"}')" "$OUTDIR/ks-engage.json" >/dev/null 2>&1 || true
  out="$(cat "$OUTDIR/ks-engage.json" 2>/dev/null || echo '')"
  assert_contains "$out" "engaged" "killswitch: engage reports engaged"
  aws_ lambda invoke --function-name "$fn" --payload "$(printf '%s' '{"action":"release"}')" "$OUTDIR/ks-release.json" >/dev/null 2>&1 || true
  out="$(cat "$OUTDIR/ks-release.json" 2>/dev/null || echo '')"
  assert_contains "$out" "normal" "killswitch: release restores (flag normal)"
  note "fail-closed path (break CreatePolicy perm -> engage must NOT report engaged) is manual — see runbook §15b path 5"
}

# -------- run ---------------------------------------------------------------------------------
_log "== Acceptance run $TS  (CUST=$CUST ENV=$ENV account=$EXPECT_ACCOUNT) =="
want unauthorized      && check_unauthorized
want hitl-approve      && check_hitl_approve
want hitl-reject       && check_hitl_reject
want hitl-replay       && check_hitl_replay
want backend-fail      && check_backend_fail
want backend-unknown   && check_backend_unknown
want missing-guardrail && check_missing_guardrail
want wrong-guardrail   && check_wrong_guardrail
want killswitch        && check_killswitch

summary
