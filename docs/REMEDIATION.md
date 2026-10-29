# Readiness-review remediation (findings → fixes)

**Final status (two reviews + live re-validation).** All findings from both reviews are remediated in
code (43 jest + 20 pytest green; cdk-nag clean across standalone/spoke/hub/org). Validation maturity:

- **Standalone** — **live verified** post-fix in a real account (acceptance matrix below): authorized /
  unauthorized / lookalike access, guarded inference, HITL approve + reject + replay, kill-switch
  engage/release, no standalone hub leak, logging create+restore. *Release accepted* still needs a
  second-operator run of the §15 gate.
- **Hub/spoke, Org, optional (A2A / VPC / Memory / Omni)** — **built + synth/nag/test-verified**, not
  yet live-validated (need multi-account / test-OU / VPC / second-agent / Omni-domain environments).
- **Not live-exercised anywhere (unit-tested only):** executor FunctionError→FAILED and
  transport→UNKNOWN, kill-switch CREATE_FAILED→not-engaged, expired/wrong-client tokens.

Avoid describing the platform as production-ready, universally deployable, exactly-once, or fully
A2A-enabled on the current evidence.

---

## Second review (commit `c18c586`, 29 Oct 2026) — standalone MVP blockers

A second review focused on the standalone MVP + SA handoff. Maturity labels: **implemented** (builds,
nag-clean) · **locally verified** (npm test / pytest) · **live verified** (run on AWS) · **release
accepted** (reproduced by a second operator via the §15 gate). Fixes landed:

| # | Second-review blocker | Fix | Label |
|---|---|---|---|
| B1 | Standalone config leaked remote hub integrations (OAM link + evidence replication to placeholders) | Remote integration gated on **spoke mode** (not field presence); dedicated `config/standalone.example.json` with no hub/org + optional capabilities off; structural test that standalone emits no `Oam::Link`/`ReplicationConfiguration` | locally verified |
| B2 | Runbook used the Cognito **ID token** vs the client_id authorizer | Runbook uses the **access token**; LOG_ONLY references removed (ENFORCE is the sole governed-MVP path) | implemented |
| B3 | HITL: reject/timeout dropped the digest; Lambda FunctionError counted as success; stranded EXECUTING | Catch `resultPath` preserves input; executor honours **FunctionError** + app error (→ FAILED), transport failure → **UNKNOWN** (reconcile via idempotency key); approval bound to a dedicated supervisor role | locally verified |
| B4 | Kill-switch **engage** reported success on `CREATE_FAILED` | Engage now requires a successful terminal (ACTIVE) state + ACTIVE enforcement; raises + keeps a conservative `engaging` state otherwise; policy-engine IAM scoped to this platform's engine | locally verified |
| B5 | Empty model allowlist failed open; model/group matching not exact | `allowedModelIds` non-empty enforced (fail closed); interceptor uses **exact** model equality; **Cedar group match now uses a quoted-token pattern (`*"grp"*`) so a lookalike group no longer satisfies the permit** | **live verified** (lookalike `csr-agents-readonly` denied; exact `csr-agents` authorized) |
| B6 | Runbook/scripts not a clean handoff | Scripts marked executable; `create-human-user.sh` skips empty group; `--cli-binary-format`/`fileb://` approval example; copy-paste authenticated invoke; Docker-for-synth prereq; pinned `requirements-dev.txt`; boto3 pinned in bundling | implemented |
| — | Optional-capability SDK defects (memory `eventTimestamp`, OBO `workloadName`, registry client) | Memory `eventTimestamp` added; memory/browser/A2A/registry/VPC **off in the MVP profile**; OBO/registry calls remain best-effort + labeled not-live-validated | implemented |

**Live re-validation (2026-10-29, post-fix, account 864217980669).** The standalone MVP profile was
deployed and the acceptance matrix run against real AWS:

| Test | Result |
|---|---|
| Standalone synth | ✅ no external OAM link / no remote replication (B1) |
| Authorized `csr-alice` (csr-agents) | ✅ 4 governed tools; `submit_service_request` absent (Cedar forbid) |
| Unauthorized `viewer-bob` (no group) | ✅ denied, empty tool list |
| **Lookalike `csr-readonly` (csr-agents-readonly)** | ✅ **denied** after the quoted-token fix (was authorized before) |
| HITL approve → execute | ✅ exactly once (`SR-DEMO-0001`), ledger `COMPLETED`, approver bound |
| HITL reject | ✅ execution FAILED, ledger `REJECTED`, no submit (B3a resultPath fix) |
| Replay (re-run approved digest) | ✅ `already_handled, executed:false` |
| Kill-switch engage / release | ✅ engage reached `ACTIVE` → tools `[]`; release restored 4 tools (fail-closed engage) |
| Existing invocation logging | ✅ none pre-existing; `create` mode set it cleanly |

**Not live-exercised here (unit-tested only):** Lambda FunctionError→FAILED and transport→UNKNOWN
(require injecting a tool failure), kill-switch CREATE_FAILED→not-engaged, expired/wrong-client token.
**Remaining to reach *release accepted*:** a **second operator** reproduces the §15 matrix (incl. those
failure paths) from a clean checkout. Real-backend integration and existing-account logging
adoption/restore remain qualified.

---

## First review (commit `13e7edb`, 29 Oct 2026) — 16 findings

An independent readiness review of commit `13e7edb` (29 Oct 2026) identified 16 findings. Each was
re-validated against the source before any change. This table tracks what was fixed, what was
deliberately relabelled/descoped, and what remains for later hardening gates. Fixes are
synth/nag/unit-verified locally; items needing multi-account or live AWS validation are marked.

**Legend:** ✅ fixed & verified · 🟡 partial / relabelled honestly · ⬜ tracked for a later gate.

| # | Finding | Status | What changed |
|---|---|---|---|
| F01 | Default Cedar observes (LOG_ONLY), not enforces | ✅ | Gateway defaults to `ENFORCE`; loader rejects `LOG_ONLY` unless `agentcore.acknowledgeNonEnforcingCedar:true` |
| F02 | Guardrail created but enforcement not wired | ✅ | Deny policy attached to the runtime role; covers inference-profile ARNs; harness pins approved `GUARDRAIL_ID`/`VERSION`; account-level option documented |
| F03 | Org SCPs conflict with the platform's own roles | 🟡→built | **Fixed (Gate 4): platform execution roles named under the governed prefix (`-runtime-*`, `-killswitch-*`, `-invlog-*`) so the inference-perimeter admits the runtime and the control-plane SCPs exempt the specific control roles; added the CDK CFN exec role + deployer to the exemptions.** Synth/test-verified; needs a test OU to live-validate under active SCPs |
| F04 | Registry reads a nonexistent response field | ✅ | Uses `registryArn` (CreateRegistry's real field); DeleteRegistry takes the ARN; grounded against the API ref |
| F05 | HITL is a detached primitive | ✅ | End-to-end: agent `request_human_signoff` → state machine (propose/approve/reject/timeout) → **exactly-once** executor (separate role) → audit ledger; replay-guarded |
| F06 | Kill-switch release reports success without removing the deny | ✅ | Reads `policies` (not `items`), paginates, validates an explicit action enum, and verifies the policy is gone before flipping to `normal` |
| F07 | Hub/spoke connectivity is mostly intent | 🟡→built | OAM sink org-scoped; **now built (Gate 3): spoke `AWS::Oam::Link` to the hub sink, cross-account S3 evidence replication (spoke→hub archive, with replication role + hub inbound bucket/KMS policy), Service Catalog portfolio shares, and per-spoke dashboard widgets.** Synth/nag/test-verified; **not yet live-validated across two accounts** (needs a hub+spoke in one Org) |
| F08 | Human identity setup missing from the reproducible path | ✅ | `identity.humanAuth` provisions groups + a human app client; `scripts/create-human-user.sh`; audit identity derived from the verified JWT subject |
| F09 | Model allowlist broad/ineffective | ✅ | Interceptor gates only on an exact model-id key (opt-in), exact match, explicit unmapped-group handling; runtime IAM scoped to `allowedModelIds` |
| F10 | Multi-agent not implemented in the harness | 🟡→built | **Gate 5: the harness now consumes MULTI_AGENT — supervisor orchestration builds a delegation tool per remote collaborator (InvokeAgentRuntime), OBO token exchange (GetWorkloadAccessToken) for `auth:'obo'`, best-effort registry publish, and a correlation id propagated across A2A hops.** Implemented but **not live-validated** (needs a second deployed collaborator agent); newer API param/response shapes must be confirmed live |
| F11 | Existing-account logging overwritten/deleted | ✅ | Ownership modes (create/adopt/manage): refuses to overwrite a pre-existing config, restores it on teardown |
| F12 | Fresh-account observability incomplete | ✅ | Adds the X-Ray→CloudWatch Logs resource policy and honors `observabilityIndexingPercentage` (UpdateIndexingRule) |
| F13 | Org prerequisites / delegated admin not executable | 🟡→built | `org.delegatedAdmin` switches the Guard-hook StackSet to `CallAs: DELEGATED_ADMIN` (else `SELF`, management-account-first); the loader warns if the org floor guardrail is not management-account-owned. Management-account path is the supported default; delegated-admin still needs live validation |
| F14 | Budget action broader than its name | 🟡→built | Org budget now carries a Bedrock-service cost filter (measures AI spend, not all cost); documented that it is still management-account billing data and the freeze SCP denies only Bedrock inference. Request-side rate limit remains the immediate containment |
| F15 | Optional flags / example values create false expectations | ✅ | Kill switch gated on its flag; Omni placeholder removed; unused alpha dep removed; LICENSE added; LOG_ONLY rejected |
| F16 | Build + manifest not one pipeline | ✅ | `build-image.sh` requires named profile/region, creates ECR (scan + immutable), deploys by digest; runtime wired to the manifest model + compiled system prompt |

## Behavioral evidence added

- `test/lambda/` (pytest, `npm run test:lambda`): kill-switch release/replay/enum, interceptor exact
  model gating + unmapped-group handling, invocation-logging ownership modes, HITL exactly-once/replay.
- `test/platform.test.ts` (jest): ENFORCE default, LOG_ONLY rejection, registry ARN contract, guardrail
  pinned + deny attached on the runtime, human client + group, HITL approvals ledger + executor +
  `states:StartExecution`, kill-switch gating.

## Gate 2 — standalone, validated live (2026-10-29)

Re-deployed standalone to a real account (`864217980669`, us-east-1) from the post-fix source and ran
the full citizen-311 workflow end to end. All acceptance scenarios passed:

| Scenario | Result |
|---|---|
| Authorized human (`csr-alice` ∈ `csr-agents`) + allowed tools | ✅ 4 governed tools listed; workflow ran |
| Consequential action (`submit_service_request`) | ✅ absent from the agent's tools (Cedar forbid); agent called `request_human_signoff` instead |
| Guardrail-governed inference | ✅ inference ran with the pinned guardrail; the ungoverned-inference deny did not block |
| Unauthorized identity (`viewer-bob`, no group) | ✅ `ACCESS DENIED`, zero tools (deny-by-default) |
| HITL approve → execute | ✅ executor filed the request exactly once (`SR-DEMO-0001`); ledger recorded actor=`csr-alice` sub, approver=`supervisor-sam` |
| HITL replay | ✅ re-invoking the executor with the same digest returned `already_handled, executed:false` |
| Kill switch engage | ✅ forbid-all policy `ACTIVE`; agent tools → `[]` (blocked) |
| Kill switch release | ✅ policy deleted, SSM → `normal`, tools restored; release verified the deny was gone first |
| Existing-logging ownership | ✅ `create` mode set logging where none existed (no overwrite of an existing config) |

**Real bugs the live run caught and fixed (none visible to synth/unit tests):**
1. Runtime `SYSTEM_PROMPT` env rejected control characters (compiled prompt had newlines) → single-line.
2. HITL state-machine role lacked `kms:Decrypt`/`GenerateDataKey` on the evidence CMK (CMK-encrypted
   approvals table + SNS topic) → granted.
3. HITL executor invoked the tool Lambda with the wrong event shape → now passes args as the payload
   and the tool name via Lambda `ClientContext` (`bedrockAgentCoreToolName`).
4. Kill-switch Lambda's bundled boto3 was too old for `ListPolicySummaries` + `create_policy`
   `enforcementMode` → bundle a current boto3; use `ListPolicySummaries` (no KMS decrypt) for release.
5. Kill-switch role was missing gateway/engine permissions (`ManageResourceScopedPolicy`, `GetGateway`,
   `ListGatewayTargets`, policy-validation gateway calls) → granted `bedrock-agentcore:*` scoped to the
   platform's own gateway + policy-engine ARNs, plus KMS on the engine's CMK.
6. The blanket forbid needed `validationMode: IGNORE_ALL_FINDINGS`; Create/DeletePolicy are async → the
   handler now polls to completion (and tolerated IAM-propagation lag on first engage).

## Still required before each gate closes

- **Gate 2 (standalone):** ✅ validated live (above). Fixes committed; re-validation reproducible from a
  clean checkout following `docs/runbooks/DEPLOYMENT.md` §12b.
- **Gate 3 (hub/spoke):** integration **built** — spoke OAM link, cross-account evidence replication
  (+ hub inbound bucket/KMS policy), catalog portfolio shares, per-spoke dashboard widgets, config
  fields (`hub.oamSinkArn` / `logArchiveBucketArn` / `logArchiveKmsKeyArn` / `monitoredAccountIds`).
  Synth/nag/test-verified. **Still required to CLOSE the gate:** live validation across two real
  accounts in one Organization — a real workload trace + retained evidence reaching the hub, and
  denied cross-account access. Blocked here on having only one account; reproduce per runbook once a
  second account/Org exists. Registry async-readiness polling (GetRegistry) also remains a follow-up.
- **Gate 4 (org):** SCP principal alignment, delegated-admin switch, guardrail-ownership warning, and
  budget cost-scoping are **built** (synth/test-verified). **Still required to CLOSE:** deploy into a
  real **test OU** (not a single standalone account — attaching deny-SCPs to your only account would
  self-lockout) and prove governed inference, upgrades, incident controls, and rollback work while the
  SCPs are active; test account remove/re-add, StackSet failures, hook WARN→FAIL, and budget-action
  recovery. Blocked here: the test account is not in an Organization.
- **Gate 5 (optional capabilities):** **built** — private VPC networking for Runtime + Browser
  (`agentcore.network`), A2A supervisor orchestration in the harness (collaborator invoke + OBO +
  registry publish + correlation id), and Memory read/write use in the harness. Synth/nag/test-verified.
  **Still required to CLOSE:** live validation — a second deployed collaborator agent for A2A (real
  remote call + identity propagation + trace continuity), actual VPC egress/PrivateLink behaviour, and
  Omni live telemetry. These need environments not available here (second agent, VPC, Omni domain).
