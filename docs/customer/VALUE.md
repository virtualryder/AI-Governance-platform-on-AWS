# Governed AI Agent Platform — value overview

*A one-page overview an SA can walk a customer through. Audience: the buyer's security, compliance, and
delivery leads (SLG / HCLS). Keep it honest — this describes a **pilot on synthetic data**, and its
credibility with risk-averse buyers comes from being precise about both what it enforces and what it
deliberately excludes (see [`LIMITS.md`](LIMITS.md)).*

## The problem

AI agents are useful because they can *act* — call tools, hit systems, take steps on a user's behalf.
That is exactly what makes a security or compliance team say "no." Their questions aren't about the
model's quality; they're: *What can this thing do? Who authorized it? What stops it? Can we prove what
happened? Can we turn it off?* Most agent demos can't answer those.

## What this platform is

A repeatable, CDK-deployable **governance envelope** around an Amazon Bedrock AgentCore agent, built on
AWS-native controls. The agent is treated as untrusted; the envelope is what you certify. Deployed into
**the customer's own AWS account**, config-driven, with cdk-nag (AWS Solutions + HIPAA) passing clean.

## The five questions it answers — with a demonstrable "no"

| A security reviewer asks… | This platform's answer | Enforced by |
|---|---|---|
| Can the agent do something it isn't authorized to? | **No** | Cedar authorization, **deny-by-default**, per caller group |
| Can **the agent** call an LLM without our guardrail? | **No** | An IAM **deny** on the agent's governed runtime role for any ungoverned/unapproved-guardrail inference — not a polite request |
| Can **the agent** use a model we didn't approve? | **No** | The agent's runtime-role IAM is scoped to an explicit model allowlist (empty list fails closed) |
| Can a consequential action happen without a human? | **No** | Human-in-the-loop sign-off; the agent is forbidden the action; a separate role executes it once |
| Can we prove what happened, and stop it instantly? | **Yes / Yes** | WORM (write-once) audit trail + customer-managed encryption; one-action kill switch |

The point is the **layering**: to do something harmful, a prompt or bug would have to defeat
authorization *and* IAM *and* the guardrail *and* (for consequential actions) a human. That is the
pitch — not "the model is safe," but "the agent *cannot* step outside the envelope."

> **Scope to state accurately:** in standalone/spoke, the guardrail and model-allowlist denies bind the
> **governed runtime role** (the agent's execution role) — they govern *this agent*, not every
> principal in the account. Denying ungoverned inference **account-/org-wide** is the **org mode** SCP.
> Don't tell an auditor standalone enforces account-wide; it enforces for the governed agent.

## What the customer gets from the pilot

- A **working governed agent in their account**, driven by their own identity groups, on synthetic data.
- Controls they can see enforce themselves live: an unauthorized user denied, the agent's ungoverned model call
  denied, a consequential action paused for a human and then executed exactly once, a kill switch that
  blocks everything, and a tamper-resistant audit record of all of it.
- **Customer-managed KMS** on every store, **short-lived tokens**, least-privilege IAM, and per-user
  rate/model governance.
- An **inspectable, config-driven reference** — not a black box. They can read the policies, the
  controls, and the honest maturity assessment.

## Why a regulated buyer is comfortable saying "yes" to the pilot

- It is scoped as a **pilot on synthetic data in one account** — its job is to prove the governance
  model and get risk owners comfortable, not to run production transactions. The exclusions
  ([`LIMITS.md`](LIMITS.md)) are acceptable at pilot scope and have a clear production path.
- It speaks their language: **deny-by-default**, WORM audit, customer-held keys, separation of duties,
  emergency stop — and maps to frameworks they already use (NIST AI RMF; HIPAA-pack-clean synth; retention
  floors for PHI/CJIS; data-residency and payload-logging decisions made explicitly, not by default).
- It is **honest**. The platform ships its own limitations and maturity labels. Risk-averse buyers trust
  that far more than "fully secure."

## From pilot to production (the build-out)

A pilot proves the envelope; production fits it to the customer. In rough order: authenticated approver
identity, integrating the real system of record behind the human gate, federating the customer's IdP,
multi-account rollout (hub/spoke + org SCP enforcement), turning on observability/dashboards, authoring
their real use cases, and the usual production hardening (threat model, pen test, DR, change
management). See [`LIMITS.md`](LIMITS.md) for the mapping from each exclusion to its production step.

## One-line summary

> It lets a regulated organization put an AI agent into production **inside an enforced, auditable
> governance envelope they control** — and prove, live, that the agent cannot act outside it.
