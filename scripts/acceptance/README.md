# Standalone acceptance harness

Scripts that turn the manual runbook procedures (`docs/runbooks/DEPLOYMENT.md` §12b / §15 / §15b) into
**runnable, report-emitting** checks, so an SA validates a standalone deployment with a few commands
instead of error-prone copy-paste. Output (a `report.txt` plus raw per-check evidence) lands under
`scripts/acceptance/acceptance-out/<timestamp>/`.

> **Status:** these scripts *encode* the runbook; their first live shakeout is the pending
> second-operator acceptance run. Until that run passes, treat a `FAIL` as *either* a real platform
> defect *or* a harness/environment bug, and triage before drawing conclusions. The manual §15b block
> in the runbook remains the source of truth for the procedures.

## What it is NOT
A substitute for understanding the platform. Read `docs/CONCEPTS.md` (control model) and the runbook
first. This harness proves behaviour; it does not teach it.

## Prerequisites
- A **deployed standalone platform** with a use case active (Runtime up) in the acceptance account.
- Two provisioned humans (`scripts/create-human-user.sh`): `csr-alice` in group `csr-agents`,
  `viewer-bob` in **no** group. You supply their passwords via env (never hard-code them).
- Tools: `aws`, `jq`, `python`, `curl`, `bash` (4.3+). `docker`/`node` only for build/test, not a read-only run.

## Environment
```bash
export PROFILE=<named-profile>        # MUST resolve to the acceptance account
export EXPECT_ACCOUNT=663898937974    # the intended account; every script aborts if the profile differs
export R=us-east-1
export CUST=<customerName-from-config>
export ENV=dev
export CSR_PASSWORD=...               # csr-alice (authorized)
export VIEWER_PASSWORD=...            # viewer-bob (unauthorized)
# optional: GOVERNED_ROLE_PREFIX (default govai-$CUST-governed), ACC_MODEL_ID
```

## Run order
```bash
cd scripts/acceptance
./preflight.sh                        # env + account guard + platform-deployed checks (read-only)
./run-acceptance.sh                   # full matrix; or: ./run-acceptance.sh --only hitl-approve,killswitch
# ... after you cdk destroy --all:
./teardown-verify.sh                  # proves nothing governed remains; invocation-logging restored
```

## Checks (run-acceptance.sh)
| key | proves |
|---|---|
| `unauthorized` | a no-group identity is denied by default (soft check on the response + zero tools) |
| `hitl-approve` | authorized workflow pauses for sign-off; approve → ledger `COMPLETED` |
| `hitl-reject` | reject → ledger `REJECTED`, nothing filed |
| `hitl-replay` | re-resolving a closed token is a no-op; the single `COMPLETED` row is the exactly-once evidence |
| `backend-fail` | `CHAOS_MODE=fail` → ledger `FAILED` (no false success) |
| `backend-unknown` | `CHAOS_MODE=malformed` → ledger `UNKNOWN` (reconcilable, never stuck `EXECUTING`) |
| `missing-guardrail` | runtime role calling Bedrock with no guardrail → `AccessDenied` |
| `wrong-guardrail` | runtime role calling Bedrock with a different guardrail → `AccessDenied` |
| `killswitch` | engage reports engaged; release restores (flag `normal`). Fail-closed path stays manual (§15b path 5) |

## How approvals are captured
`hitl-*` checks subscribe a throwaway SQS queue to the approval SNS topic, drive one workflow run, pull
the task token + action digest from the delivered message, then resolve it by assuming the supervisor
role and invoking the approval Lambda. The queue/subscription are deleted after each check.

## Interpreting the report
`PASS` / `FAIL` / `SKIP` (precondition absent, e.g. no runtime or a missing password) / `WARN` (needs
human confirmation, e.g. "is this the customer's original logging config?"). The run's exit code is
non-zero if any check `FAIL`ed. Keep the whole `acceptance-out/<timestamp>/` directory as sign-off
evidence (per runbook §15): it has the report plus every raw response and Lambda result.

## Chaos safety
`backend-fail` / `backend-unknown` toggle the reference tool's `CHAOS_MODE` and clear it afterward.
Confirm the consequential-target Lambda has **no** `CHAOS_MODE` set before sign-off — it must never be
set in a customer deployment.
