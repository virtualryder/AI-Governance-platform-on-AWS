# POC demo talk-track

*A ~20-minute live demo of the governed agent for a customer's security/delivery leads, using the
citizen-311 reference use case. Each beat has **Say / Show / The point**. It mirrors the acceptance
matrix, so the scripted harness (`scripts/acceptance/run-acceptance.sh`) can drive the harder beats
reliably while you narrate. Synthetic data only.*

> Golden rule: **lead with the "no".** The memorable moments are the denials and the pause-for-a-human,
> not the agent being clever. Let them watch the envelope hold.

## Before the room (precheck)

- Platform deployed to the demo account; a use case active (Runtime up). Run
  `scripts/acceptance/preflight.sh` — all green.
- Two identities provisioned: **csr-alice** (group `csr-agents`, authorized) and **viewer-bob** (no
  group, unauthorized).
- Terminal ready with the §12b authenticated-invoke snippet; the acceptance harness ready in another
  pane. Have `CHAOS_MODE` **off**.
- Optional dry run: `scripts/acceptance/run-acceptance.sh` once beforehand so you know it's green and
  you have an evidence folder to show.

## Beat 1 — Frame it (60s)

**Say:** "AI agents are valuable because they can *act*. That's also what makes your security team
nervous. So I'm not going to show you a clever chatbot — I'm going to show you an agent inside a
governance envelope, and I'm going to try to make it misbehave, and watch it get stopped. The agent
runs in *your* account, under *your* identities, with *your* keys."

**The point:** reset expectations from "demo the AI" to "demo the controls."

## Beat 2 — The agent does its job, but can't overstep (3 min)

**Say:** "This is a 311 service-request agent. An authorized caseworker, Alice, asks it to intake a
pothole report and file it."

**Show:** invoke as **csr-alice** (§12b curl, or `run-acceptance.sh --only hitl-approve` up to the
pause). The response lists the governed tools — catalog lookup, classify, validate address, check
duplicate — **but not** `submit_service_request`, and the agent runs the intake and then **stops to
request human sign-off**.

**The point:** the agent is useful *and* it does not hold the consequential action at all — filing is
not in its hands. "Notice it didn't even try to file. It can't."

## Beat 3 — Deny-by-default for the wrong user (2 min)

**Say:** "Now Bob, who isn't in the caseworker group, asks for the same thing."

**Show:** invoke as **viewer-bob** (or `run-acceptance.sh --only unauthorized`). The gateway denies;
the agent gets **zero tools** and an access-denied result.

**The point:** "This isn't the model deciding to refuse — it's authorization, deny-by-default, before
any tool runs. No policy permits Bob, so the answer is no."

## Beat 4 — The human gate (3 min)

**Say:** "Back to Alice's paused request. A supervisor reviews and approves."

**Show:** `run-acceptance.sh --only hitl-approve` end-to-end → the approvals **ledger** shows the action
`COMPLETED`, filed **exactly once**, with who approved and when. Mention: a **reject** records
`REJECTED` and nothing is filed; a **replay** of the same approval is a no-op.

**The point:** separation of duties — a human, through a *different* role than the agent, owns the
consequential act, and it's recorded once in a tamper-resistant ledger. (Be honest here: approver
identity is role-gated in the pilot; binding it to an authenticated principal is the production step —
see LIMITS.)

## Beat 5 — It can't make an ungoverned model call (2 min)

**Say:** "Could someone route around the guardrail — call a model directly, or with no guardrail?"

**Show:** `run-acceptance.sh --only missing-guardrail,wrong-guardrail` → both return **AccessDenied**
from IAM.

**The point:** "The guardrail isn't a suggestion. The runtime's permissions physically forbid any
inference that doesn't carry your approved guardrail, and any model you didn't approve. That's the IAM
floor underneath everything."

## Beat 6 — The emergency stop (2 min)

**Say:** "Something looks wrong in production at 2am. One action."

**Show:** `run-acceptance.sh --only killswitch` → engage blocks all tool calls at the gateway; release
restores. (Or invoke the kill-switch Lambda live.)

**The point:** "Instant containment — it blocks every tool call at the governed gateway — and it fails
closed: it only reports 'engaged' once the block is confirmed active, and only reports 'released' once
it confirms the block is gone."

## Beat 7 — Prove what happened (2 min)

**Say:** "Everything you just saw is on the record."

**Show:** the approvals ledger rows and the acceptance **evidence folder**
(`acceptance-out/<timestamp>/report.txt` + raw responses); mention the WORM CloudTrail trail (incl. the
approver's invoke) and customer-managed KMS.

**The point:** "Write-once audit, your keys. For an auditor, 'prove it' is a query, not a promise."

## Beat 8 — Close (90s)

**Say:** "That's the envelope: authorization, an IAM floor, a guardrail, a human for consequence, an
emergency stop, and a tamper-resistant record — all in your account, config-driven, and honest about
what's pilot scope versus production. Here's exactly what we'd do to take it to a real workload."

**Show:** [`VALUE.md`](VALUE.md) build-out section and [`LIMITS.md`](LIMITS.md).

**The point:** convert the "no, it can't" confidence into a concrete production plan.

## If asked to go off-script

- *"Can it just ignore the policy if I prompt it right?"* → try it live as Bob, or ask it to file
  directly as Alice. The deny is at the gateway/IAM, not the prompt. This is the best possible moment —
  invite it.
- *"What about our data?"* → point to customer-managed KMS, data-classification-driven retention, and
  the explicit data-boundary questions in runbook §4. Be straight that payload logging captures content.
- *"Is this production-ready?"* → No, and say so plainly — it's a pilot that proves the governance
  model. Walk them through LIMITS. Honesty here is the sale.
