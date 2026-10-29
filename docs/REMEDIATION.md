# Readiness-review remediation (findings → fixes)

An independent readiness review of commit `13e7edb` (29 Oct 2026) identified 16 findings. Each was
re-validated against the source before any change. This table tracks what was fixed, what was
deliberately relabelled/descoped, and what remains for later hardening gates. Fixes are
synth/nag/unit-verified locally; items needing multi-account or live AWS validation are marked.

**Legend:** ✅ fixed & verified · 🟡 partial / relabelled honestly · ⬜ tracked for a later gate.

| # | Finding | Status | What changed |
|---|---|---|---|
| F01 | Default Cedar observes (LOG_ONLY), not enforces | ✅ | Gateway defaults to `ENFORCE`; loader rejects `LOG_ONLY` unless `agentcore.acknowledgeNonEnforcingCedar:true` |
| F02 | Guardrail created but enforcement not wired | ✅ | Deny policy attached to the runtime role; covers inference-profile ARNs; harness pins approved `GUARDRAIL_ID`/`VERSION`; account-level option documented |
| F03 | Org SCPs conflict with the platform's own roles | 🟡 | Documented as a known org-mode gap; principal alignment + exemptions need a test-OU pass (Gate 4) |
| F04 | Registry reads a nonexistent response field | ✅ | Uses `registryArn` (CreateRegistry's real field); DeleteRegistry takes the ARN; grounded against the API ref |
| F05 | HITL is a detached primitive | ✅ | End-to-end: agent `request_human_signoff` → state machine (propose/approve/reject/timeout) → **exactly-once** executor (separate role) → audit ledger; replay-guarded |
| F06 | Kill-switch release reports success without removing the deny | ✅ | Reads `policies` (not `items`), paginates, validates an explicit action enum, and verifies the policy is gone before flipping to `normal` |
| F07 | Hub/spoke connectivity is mostly intent | 🟡→built | OAM sink org-scoped; **now built (Gate 3): spoke `AWS::Oam::Link` to the hub sink, cross-account S3 evidence replication (spoke→hub archive, with replication role + hub inbound bucket/KMS policy), Service Catalog portfolio shares, and per-spoke dashboard widgets.** Synth/nag/test-verified; **not yet live-validated across two accounts** (needs a hub+spoke in one Org) |
| F08 | Human identity setup missing from the reproducible path | ✅ | `identity.humanAuth` provisions groups + a human app client; `scripts/create-human-user.sh`; audit identity derived from the verified JWT subject |
| F09 | Model allowlist broad/ineffective | ✅ | Interceptor gates only on an exact model-id key (opt-in), exact match, explicit unmapped-group handling; runtime IAM scoped to `allowedModelIds` |
| F10 | Multi-agent not implemented in the harness | 🟡 | Relabelled **IAM scaffolding, not orchestration** in README/CONTROLS; harness orchestration tracked (Gate 5) |
| F11 | Existing-account logging overwritten/deleted | ✅ | Ownership modes (create/adopt/manage): refuses to overwrite a pre-existing config, restores it on teardown |
| F12 | Fresh-account observability incomplete | ✅ | Adds the X-Ray→CloudWatch Logs resource policy and honors `observabilityIndexingPercentage` (UpdateIndexingRule) |
| F13 | Org prerequisites / delegated admin not executable | ⬜ | Management-account-first documented; delegated-admin (`DELEGATED_ADMIN`/CfCT) + guardrail ownership tracked (Gate 4) |
| F14 | Budget action broader than its name | 🟡 | Documented: unfiltered budgets measure account-wide spend; cost-filter scoping tracked; request-side rate limit is the immediate containment |
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
- **Gate 4 (org):** deploy into a test OU; prove governed inference/upgrades/incident controls work
  while SCPs are active; fix SCP principal alignment; management-account-owned floor guardrail.
- **Gate 5 (optional):** implement/test A2A orchestration, Omni live telemetry, private networking.
