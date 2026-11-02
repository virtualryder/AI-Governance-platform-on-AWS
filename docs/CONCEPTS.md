# The control model in 10 minutes

**Who this is for:** an SA who will deploy or demo this platform and has not worked with Bedrock
AgentCore or Cedar before. After this you'll understand *what* each control is, *why* it exists, and
*how* the pieces interlock — enough to read the runbook with comprehension instead of just following
steps. New terms are defined in [`GLOSSARY.md`](../GLOSSARY.md). For the design rationale see
[`ARCHITECTURE.md`](ARCHITECTURE.md); for the control-by-control matrix see [`CONTROLS.md`](CONTROLS.md).

## The one idea

A "governed AI agent" here is a **normal Amazon Bedrock AgentCore agent wrapped in an enforcement
envelope**, where every control is designed to **fail closed** — if a check can't be satisfied or
can't even be evaluated, the answer is *no*, not *maybe*. The agent itself is not trusted; the envelope
around it is what a security team signs off on.

Nothing here is a new AI model. It's AWS-native guardrails, authorization, IAM, human approval, audit,
and encryption composed so that an agent *cannot* do an ungoverned thing even if the prompt, the model,
or a bug tries to make it.

## The lifecycle of one request

Follow a single tool call from a human through the envelope (this is the flow validated live, and the
same diagram is in runbook §3):

```
Human (CSR)  ──JWT access token──▶  Agent Runtime  ──MCP tools/call (Bearer JWT)──▶  Gateway
                                                                                       │
                                            ┌──────────────────────────────────────────┤
                                            ▼                                           ▼
                                    REQUEST interceptor                          Cedar PolicyEngine
                                 (per-user block / model                       (principal, action, resource)
                                  allowlist / rate limit)                        → permit or FORBID (default deny)
                                            │                                           │
                                            └───────────────── allow ──────────────────▶ Tool (Lambda)
                                                                                         │
                                        Consequential action?  ── the agent is FORBIDDEN it ──▶ HITL sign-off gate
```

1. **The human authenticates.** They sign in to the identity provider (Cognito by default, or the
   customer's Entra/Okta). They get a short-lived JWT **access token** carrying their `client_id` and
   their `cognito:groups`. (Use the *access* token, not the ID token — the authorizer matches on
   `client_id`, which the ID token puts somewhere else. This trips up everyone once; see GLOSSARY.)
2. **The agent calls a tool over MCP**, forwarding the human's Bearer token — so the *human's* identity
   and groups drive every downstream decision, not a shared service identity.
3. **The interceptor runs first** (per-user): hard block, model allowlist by group, rate limit. It
   writes a ledger row. This is where "this user may use model X but not Y" and "this user is over
   their rate" are enforced, before any authorization.
4. **Cedar authorizes** the call: *may this principal perform this action on this resource?* Cedar is
   **deny-by-default** — if no policy explicitly permits it, it's forbidden. Policies permit tools to a
   named group; consequential actions are explicitly *forbidden to the agent entirely*.
5. **The tool runs only if permitted.** The tool is a Lambda the platform wired from the use-case
   manifest — the agent can't invoke arbitrary code, only the declared tools.
6. **A consequential action never runs inline.** The agent is Cedar-forbidden from it; instead it calls
   `request_human_signoff`, which starts the HITL state machine. A human approves, and a
   *separately-scoped* executor performs the action once — a role the agent does not hold.

## The controls (what / why / how enforced / fail mode)

| Control | What it does | Why it's here | How it's enforced | Fails… |
|---|---|---|---|---|
| **Cedar authorization** | Deny-by-default tool authorization per caller group | Stop the agent doing anything not explicitly allowed | AgentCore PolicyEngine evaluates Cedar policies at the Gateway | **closed** (no permit → forbid) |
| **Guardrail (via IAM)** | Content filters, PII block/anonymize, denied topics | Keep model inputs/outputs inside policy | An IAM **deny** on the **governed runtime role** for any Bedrock call lacking the approved guardrail — not a request to attach one. Scoped to that role, **not account-wide** (account-/org-wide is org mode) | **closed** (no/other guardrail → AccessDenied) |
| **Model allowlist** | Only named foundation models / inference profiles | Prevent use of unapproved/expensive models | **Runtime role** IAM scoped to `allowedModelIds`; empty list is rejected at config load | **closed** |
| **Human-in-the-loop (HITL)** | Consequential actions pause for a human; executed once, audited | A person owns irreversible/consequential acts | Step Functions `waitForTaskToken` + a DynamoDB approvals ledger + a separately-scoped executor | **closed** (unapproved/unknown → not executed) |
| **Kill switch** | One action blocks all tool calls at the Gateway | Incident response / emergency stop | A forbid-all Cedar policy created on demand; **only reports engaged once the policy is confirmed active** | **closed** (can't confirm → not "engaged") |
| **Per-user interceptor** | Block / model-by-group / rate limit, with a ledger | Per-identity governance and spend control | Gateway REQUEST interceptor Lambda + DynamoDB ledger | **closed / configurable** |
| **WORM audit trail** | Tamper-resistant record of management + data events | Prove what happened, for compliance | CloudTrail → Object-Lock S3, incl. AgentCore data events **and the approval-Lambda invoke** | — |
| **Customer-managed KMS** | Every store encrypted with a customer key | Key ownership / data control | CMK on logs, evidence, memory, ledgers | — |
| **Budgets** | Spend alerts (and, in org mode, a cost kill switch) | Bound cost | AWS Budgets + alerts; org adds a Budgets→SCP freeze | — |

## How they interlock (the important part)

The controls are **layered**, and the layers are deliberately different *kinds* of enforcement so a
gap in one doesn't open the door:

- **IAM is the hard floor.** Even if Cedar were misconfigured, the runtime role physically cannot call
  an unapproved model or an ungoverned inference — AWS denies it. IAM is the control you fall back to.
- **Cedar is authorization.** It decides *who may do which tool*, deny-by-default, above IAM.
- **The guardrail is content.** Orthogonal to who/what — it governs the model's inputs and outputs.
- **HITL is for consequence.** The agent is forbidden the consequential action outright; a human and a
  different role own it.
- **The kill switch is incident response.** It sits over everything and fails closed.

Read that list as "to do something bad, an attacker/bug would have to defeat authorization *and* IAM
*and* the guardrail *and* (for consequential acts) a human." That layering is the pitch to a security
team.

## Config-driven, four modes

Customer differences live in `config/<customer>.json` (schema in `lib/config/platform-config.ts`) — no
customer names or account IDs in code. One codebase deploys four ways:

- **standalone** — one account; the pilot/MVP path (baseline + agent platform + controls together).
- **spoke** — a workload account that reports up to a hub.
- **hub** — a dedicated governance account (central log archive, observability sink, catalog).
- **org** — management/delegated-admin account (SCPs, Bedrock org policy, Guard hooks via StackSets).

The **standalone MVP** is the mature, live-verified path. Hub/spoke/org are built and test-verified but
need multi-account environments to validate live.

## What it is — and isn't — today

Be honest with customers and yourself. The maturity of each capability is tracked in
[`REMEDIATION.md`](REMEDIATION.md) under four labels (*implemented / locally verified / live verified /
release accepted*). The standalone MVP has **explicit exclusions** that are limitations by design, not
gaps that were closed: authenticated approver identity (the approver is role-gated but caller-named),
real-backend idempotency, shared-account logging restoration, multi-agent A2A, and multi-account. Never
describe the platform as production-ready, "exactly-once", or fully A2A-enabled on current evidence.

## Where to go next

1. Get your machine ready: [`docs/SA-SETUP.md`](SA-SETUP.md) → run `scripts/acceptance/preflight.sh`.
2. Deploy and verify: [`docs/runbooks/DEPLOYMENT.md`](runbooks/DEPLOYMENT.md) (§12b standalone walkthrough).
3. Prove it: `scripts/acceptance/run-acceptance.sh` (the §15/§15b matrix). Passing this from a clean
   checkout is both the release-acceptance gate and your SA certification.
