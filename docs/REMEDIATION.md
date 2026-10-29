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
| F07 | Hub/spoke connectivity is mostly intent | 🟡 | Relabelled **partial**; OAM sink now org-scoped (no open sink). OAM links, evidence delivery, catalog/registry sharing remain (Gate 3) |
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

## Still required before each gate closes

- **Gate 2 (standalone):** re-run the full citizen-311 workflow from a clean checkout post-fix — an
  authorized action succeeds, unauthorized tools/models/identities are denied, approval executes the
  reviewed action exactly once, kill-switch engage/release work, logging survives deploy+teardown.
- **Gate 3 (hub/spoke):** OAM links, cross-account evidence delivery with KMS grants, registry/catalog
  consumer access; validate from two real accounts.
- **Gate 4 (org):** deploy into a test OU; prove governed inference/upgrades/incident controls work
  while SCPs are active; fix SCP principal alignment; management-account-owned floor guardrail.
- **Gate 5 (optional):** implement/test A2A orchestration, Omni live telemetry, private networking.
