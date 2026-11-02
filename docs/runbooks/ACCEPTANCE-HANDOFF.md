# Acceptance run — reviewer handoff

A self-contained, ordered procedure for the **independent second operator** to take the standalone MVP
from a clean checkout to a signed acceptance, in a scratch account, on synthetic data. Passing this is
the **release-accepted** bar *and* the reference run that validates the runbook, the harness, and the
teaching/customer docs against reality.

## This run

| | |
|---|---|
| **Account** | `663898937974` (scratch sandbox — **NOT** the author's personal `864217980669`) |
| **Profile** | `daviryde-personal-sandbox` *(must resolve to the account above — the guard aborts otherwise)* |
| **Region** | `us-east-1` |
| **CUST / ENV** | `acme-mvp` / `dev` *(must match the deployed config's `customerName`/`environment`)* |
| **Mode** | `standalone`, synthetic data, one use case (citizen-311), frozen image + config |
| **Operator** | the reviewer (independent). The author/agent does **not** run this. |

## Ground rules

- **Synthetic data only.** No real PII/PHI/CJIS in the sandbox.
- **You are the independent operator.** Reproduce from a clean checkout; don't take the author's word.
- **A `FAIL`/`WARN` is a real defect *or* a harness/doc bug** — this is the first live shakeout of the
  scripts and the fourth-review fixes. Triage before concluding; note which it was.
- **Capture everything.** Keep the whole `scripts/acceptance/acceptance-out/<timestamp>/` directory and
  your filled sign-off (template at the bottom).

---

## Step 0 — environment + account guard

```bash
export PROFILE=daviryde-personal-sandbox
export EXPECT_ACCOUNT=663898937974
export R=us-east-1
export CUST=acme-mvp
export ENV=dev
# passwords you choose for the two test humans (needed by the harness later)
export CSR_PASSWORD='<choose-strong-pw>'
export VIEWER_PASSWORD='<choose-strong-pw>'

# HARD GUARD — abort immediately if the profile is not the intended account.
ACC=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text)
[ "$ACC" = "$EXPECT_ACCOUNT" ] || { echo "ABORT: $PROFILE -> $ACC, expected $EXPECT_ACCOUNT"; }
```

If that prints `ABORT`, stop — the profile points at the wrong account. Do not proceed.

## Step 1 — clean checkout + local gate

Full machine setup is [`docs/SA-SETUP.md`](../SA-SETUP.md); the condensed gate:

```bash
git clone <repo-url> && cd AI-Governance-platform-on-AWS
npm ci && npm run build
python -m venv .venv && . .venv/bin/activate && python -m pip install -r requirements-dev.txt
docker info >/dev/null && echo "docker OK"          # synth/test bundle a Lambda via public ECR
npm test && npm run test:lambda                      # expect 48 jest + 28 pytest green
npx cdk synth --quiet -c mode=standalone -c configFile=config/acme-mvp.json -c nag=true --profile "$PROFILE"
```

Expected: build clean, 48 jest + 28 pytest green, **0** cdk-nag findings. (Create `config/acme-mvp.json`
in the next step before the synth, or synth with `config/standalone.example.json` first just to confirm
the toolchain.)

## Step 2 — config + pre-deploy capture

```bash
cp config/standalone.example.json config/acme-mvp.json
# edit config/acme-mvp.json: set customerName="acme-mvp", region="us-east-1". Leave
# runtimeImageUri as the placeholder for now (the Runtime is skipped until you set a digest).

# Capture the account's PRE-EXISTING Bedrock invocation-logging state (for the teardown comparison).
aws bedrock get-model-invocation-logging-configuration --region "$R" --profile "$PROFILE" \
  --query loggingConfig --output json > invlog-before.json 2>/dev/null || echo 'null' > invlog-before.json
cat invlog-before.json   # for a clean sandbox this should be null/empty
```

## Step 3 — bootstrap

```bash
npx cdk bootstrap aws://$EXPECT_ACCOUNT/$R --profile "$PROFILE"
```

## Step 4 — build the image, then deploy once

Build-first (single deploy): the Runtime activates on this deploy because the digest is set. See
runbook [§12b](DEPLOYMENT.md).

```bash
./use-cases/_harness/build-image.sh --profile "$PROFILE" --region "$R" --repo govai-acme-mvp --tag v1
#   -> copy the printed IMAGE_DIGEST_URI (…@sha256:…) into config/acme-mvp.json agentcore.runtimeImageUri

npx cdk deploy --all -c mode=standalone -c configFile=config/acme-mvp.json --profile "$PROFILE" --require-approval broadening
```

## Step 5 — provision the two test humans

```bash
POOL=$(aws ssm get-parameter --region "$R" --profile "$PROFILE" \
  --name /governed-ai/$CUST/$ENV/agent-platform/user-pool-id --query Parameter.Value --output text)

# authorized caseworker (group csr-agents)
./scripts/create-human-user.sh --pool-id "$POOL" --username csr-alice --group csr-agents \
  --profile "$PROFILE" --region "$R" --password "$CSR_PASSWORD"
# unauthorized viewer (NO group) — must be denied by deny-by-default
./scripts/create-human-user.sh --pool-id "$POOL" --username viewer-bob --group "" \
  --profile "$PROFILE" --region "$R" --password "$VIEWER_PASSWORD"
```

## Step 6 — preflight (read-only)

```bash
cd scripts/acceptance
./preflight.sh        # env + account guard + CDK bootstrap + platform-deployed checks; expect all PASS
```

## Step 7 — run the acceptance matrix

```bash
./run-acceptance.sh   # full §15/§15b matrix; emits acceptance-out/<timestamp>/report.txt + raw evidence
```

Expected `PASS` for: `unauthorized`, `hitl-approve` (ledger COMPLETED), `hitl-reject` (REJECTED),
`hitl-replay` (still COMPLETED, no re-execution), `backend-fail` (FAILED), `backend-unknown` (UNKNOWN),
`missing-guardrail` (AccessDenied), `wrong-guardrail` (AccessDenied), `killswitch` (engage/release).
The run exits non-zero if anything `FAIL`ed. `SKIP` = a precondition was missing (e.g. a password not
set); fix and re-run that check with `--only <name>`.

## Step 8 — kill-switch fail-closed (manual; the one the harness can't automate)

Runbook [§15b path 5](DEPLOYMENT.md). Break the kill-switch role's `CreatePolicy` /
`ManageResourceScopedPolicy` permission (or point it at a non-existent gateway), invoke `engage`, and
confirm it **raises / does NOT report engaged** — the control fails closed rather than claiming
containment it didn't achieve. **Restore the permission afterward.**

## Step 9 — capture evidence + sign off

- Keep `scripts/acceptance/acceptance-out/<timestamp>/` (report + raw responses + Lambda results).
- Record: commit SHA, CDK + CLI versions, the **image digest**, account/region, and each row's result.
- Confirm the consequential-target Lambda has **no** `CHAOS_MODE` set (the harness clears it; verify).
- Fill the sign-off template below.

## Step 10 — teardown + verify `$0`

```bash
npx cdk destroy --all -c mode=standalone -c configFile=config/acme-mvp.json --profile "$PROFILE"
# WORM gotcha: the evidence bucket has Object Lock — if destroy fails, empty all versions with
#   aws s3api delete-objects ... --bypass-governance-retention   then destroy the Baseline again.
cd scripts/acceptance && ./teardown-verify.sh
# Compare the restored invocation-logging state to invlog-before.json from Step 2 (should match: empty for a clean sandbox).
```

---

## What to report back

1. **Verdict:** release-accepted or not, with the `report.txt`.
2. **Any `FAIL`/`WARN`**, and for each: real platform defect vs harness/doc bug (with the raw evidence).
3. **Runbook/doc friction** — anything that was wrong, ambiguous, or assumed author-knowledge (this run
   is also the doc's acceptance test).
4. **The evidence folder** + filled sign-off.

Report it the way the earlier reviews came in (a dated `.md`); the author will remediate findings, not
re-run the live gate (separation of operator from author is the point).

---

## Sign-off template (copy into your evidence folder)

```
GOVERNED AI — STANDALONE MVP ACCEPTANCE SIGN-OFF
Operator:            <name>              Date (UTC): <>
Commit SHA:          <>                  CDK: <>   AWS CLI: <>
Account / Region:    663898937974 / us-east-1
Config:              config/acme-mvp.json   Image digest: <…@sha256:…>

Local gate:          build [ ]  48 jest [ ]  28 pytest [ ]  nag 0 [ ]
Preflight:           PASS [ ]

Acceptance matrix (scripts/acceptance/report.txt attached):
  unauthorized deny ....................... PASS / FAIL [ ]
  HITL approve  -> COMPLETED .............. PASS / FAIL [ ]
  HITL reject   -> REJECTED ............... PASS / FAIL [ ]
  HITL replay   -> no re-execution ........ PASS / FAIL [ ]
  backend-fail  -> FAILED ................. PASS / FAIL [ ]
  backend-unknown -> UNKNOWN .............. PASS / FAIL [ ]
  missing guardrail -> AccessDenied ....... PASS / FAIL [ ]
  wrong guardrail   -> AccessDenied ....... PASS / FAIL [ ]
  kill switch engage/release .............. PASS / FAIL [ ]
  kill switch FAIL-CLOSED (manual §15b.5) . PASS / FAIL [ ]

Teardown:            stacks gone [ ]  runtime gone [ ]  invlog restored==before [ ]  CHAOS_MODE unset [ ]

Findings (defect vs harness/doc bug):
  <...>

VERDICT:  RELEASE-ACCEPTED  [ ]      NOT ACCEPTED  [ ]
```
