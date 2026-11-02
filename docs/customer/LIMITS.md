# Honest limits & scope

*Share this with the customer. Its job is to set expectations precisely — what the pilot is, what it
deliberately excludes, and how each exclusion closes on the way to production. This honesty is a
feature: regulated buyers trust a vendor who states limits up front. Mirrors the engineering record in
[`../REMEDIATION.md`](../REMEDIATION.md).*

## What the pilot is

- **One AWS account, one region, one use case, synthetic data, a frozen image + config.** The
  **standalone** deployment mode.
- Its purpose is to **prove the governance envelope** and get your risk owners comfortable — not to
  process production transactions or connect to real systems of record.
- The controls it demonstrates are real and enforced (authorization deny-by-default, IAM-enforced
  guardrail + model allowlist, human-in-the-loop, kill switch, WORM audit, customer-managed KMS).

## What the pilot does NOT claim

- **Not production-ready.** It is a validated reference, not a certified product.
- **Not "exactly-once" against a real backend.** The human gate executes once and records an idempotency
  key, but true end-to-end exactly-once depends on the integrated system of record honoring that key.
- **Not full multi-agent (A2A).** Agent-to-agent is IAM scaffolding, not orchestrated collaboration.
- **Not multi-account-validated.** Hub/spoke and org-wide SCP enforcement are built and test-verified
  but not yet exercised live across real accounts.
- **Observability is off in the minimal profile** — evidence comes from the audit trail, the approval
  ledger, and the workflow history rather than distributed traces.
- **Guardrail / model-allowlist denial is scoped to the governed runtime role, not account-wide.** In
  standalone/spoke the IAM deny binds the agent's execution role — it governs *this agent*, not every
  principal in the account. Denying ungoverned inference account-/org-wide is the **org mode** SCP. Do
  not represent standalone as account-wide ungoverned-inference enforcement.

## Explicit exclusions → production path

| Exclusion (pilot) | Why it's acceptable for a synthetic-data pilot | What production adds |
|---|---|---|
| **Approver identity is role-gated but caller-named** — the human gate restricts *who can approve* to a supervisor role and records the decision, but the approver's name is supplied by the caller, not yet an authenticated principal | The pilot proves the *workflow* (pause → approve → execute-once → audit) and separation of the executing role from the agent; binding identity is orthogonal | An authenticated approval channel (e.g. API Gateway authorizer / verified console principal) so the recorded approver is cryptographically the person |
| **Reference backend, no real-backend idempotency** — the "submit" tool is a stand-in | Lets you see the governed flow end-to-end without touching a real system of record | Integrate the customer's system of record behind the gate, honoring the idempotency key for true exactly-once + reconciliation |
| **Single account** | The envelope is fully demonstrable in one account | Hub/spoke rollout + org-level SCP enforcement, validated in the customer's Organization (start in a test OU) |
| **Multi-agent A2A is scaffolding** | Not needed to prove single-agent governance | Orchestrated delegation with per-collaborator identity and correlation |
| **Observability off (minimal profile)** | Audit + ledger + workflow history prove every pilot scenario | Turn on telemetry (traces/metrics) + operational dashboards for production run/alerting |
| **PUBLIC network mode** | Acceptable for a synthetic-data pilot | Private networking (VPC/PrivateLink) placement for the Runtime/Browser, validated against the customer's egress boundary |
| **Shared-account logging restoration is scoped** | The platform preserves a pre-existing Bedrock invocation-logging config for the account it owns, through deploy and teardown | Broader restoration semantics if logging is centrally managed org-wide |

## Data boundary — decide these explicitly with the customer

These are not defaults to assume; agree them before deploying (runbook §4):

- Approved models and inference regions; **data residency**.
- Whether full **prompt/response payload logging** is permitted — invocation logs capture content, and
  redaction in a *response* does not sanitize the *input* log.
- **Data classification** (`public`/`internal`/`confidential`/`phi`/`cjis`) — drives retention floors
  (≥365 days for PHI/CJIS) and guardrail strength.
- Evidence-key ownership, and whether private connectivity (VPC/PrivateLink) is required.

## How maturity is labeled

Every capability carries one of four honest labels, tracked in [`../REMEDIATION.md`](../REMEDIATION.md):
*implemented* (builds, nag-clean) · *locally verified* (automated tests) · *live verified* (exercised
against real AWS) · *release accepted* (reproduced from a clean checkout by an independent operator via
the acceptance gate). The **standalone MVP is live-verified**; *release accepted* is the independent
second-operator acceptance run. Hub/spoke, org, and optional capabilities are *implemented / locally
verified*, pending their multi-account / VPC environments.

## The honest one-liner for the customer

> This is a governance envelope you can put a real agent inside, proven live on synthetic data in your
> own account. It enforces the controls your security team asks about today; the remaining work is
> fitting it to your identity, your systems, and your accounts — and we've written down exactly what
> that is.
