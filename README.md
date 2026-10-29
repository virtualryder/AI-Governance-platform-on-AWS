# Governed AI Agent Platform (Amazon Bedrock AgentCore)

A repeatable, **config-driven, CDK-deployable AI governance platform** built on Amazon Bedrock
AgentCore. It targets regulated workloads — US State & Local Government (SLG) and Healthcare & Life
Sciences (HCLS) — and ships as four deployment modes so it can meet a customer where they already
are, from a single-account pilot to an organization-wide control plane.

**Start here:** **[docs/runbooks/DEPLOYMENT.md](docs/runbooks/DEPLOYMENT.md)** (the SA + customer
deployment runbook — decision tree, architecture diagrams, customer questionnaire, step-by-step,
troubleshooting) · `docs/ARCHITECTURE.md` (decision record) · `docs/CONTROLS.md` (control matrix) ·
`CLAUDE.md` (build rules and plan).

## Deployment modes
Pick the smallest mode that fits — reuse an existing landing zone rather than rebuilding one.

| Mode | Use when | Stacks |
|---|---|---|
| `standalone` | Pilot in one existing or new account (thin first slice) | Baseline + AgentPlatform + Controls (+ collapsed hub) |
| `spoke` | Add governed agents to an existing account / landing zone | Baseline + AgentPlatform + Controls |
| `hub` | Dedicated AI governance account (central telemetry, registry, catalog) | GovernanceHub |
| `org` | Management / delegated-admin account | OrgFoundation (SCPs, Bedrock org policy, Guard hooks, Budgets→SCP) |

```powershell
npx cdk deploy --all -c mode=standalone -c configFile=config/<customer>.json --profile <target>
```

## What's built

- **Governance baseline** (per account): customer-managed KMS, WORM evidence/log bucket (S3 Object
  Lock, TLS-only, versioned), multi-region CloudTrail with **AgentCore data events** + CMK-encrypted
  CloudWatch Logs, **Bedrock model-invocation logging**, and a **versioned Bedrock Guardrail** with an
  ungoverned-inference deny (`Null:{bedrock:GuardrailIdentifier}`).
- **AgentCore layer** (native L1): Cognito (short-lived JWT, machine **and** human clients + groups) or
  external IdP, **MCP Gateway** with a **Cedar PolicyEngine** that **enforces by default** (`ENFORCE`;
  `LOG_ONLY` is rejected unless explicitly acknowledged), WorkloadIdentity, Memory, Browser /
  CodeInterpreter, image-gated **Runtime** pinned to the approved guardrail, and CloudWatch Transaction
  Search observability (resource policy + indexing percentage wired).
- **Controls**: layered **kill switch** (Cedar forbid-all, with a release that verifies the deny is gone
  before reporting released), an **end-to-end HITL** workflow (propose → approve/reject/timeout →
  exactly-once execute via a separately-scoped executor → audit ledger), Budgets + alerts, and a
  **per-user Gateway interceptor** + DynamoDB ledger (block / exact model allowlist by Cognito group /
  rate limit).
- **Hub + Org**: organization SCPs (AI-inference perimeter + control-plane integrity), SCP-exempt
  deployer role, Bedrock org declarative policy (`BEDROCK_POLICY`), CloudFormation **Guard hooks**,
  **Budgets→SCP cost kill switch**, central WORM log archive, OAM cross-account sink, Service Catalog,
  **Agent Registry** (+RAM), a **CloudWatch governance dashboard**, **SRA detective Config rules**,
  an **org-wide Guard-hook StackSet** (service-managed, auto-deploying to the Agentic OU), and an
  opt-in **CloudWatch Omni Space** (`AWS::CloudWatch::Space`) upgrade for unified + agent observability.
- **Multi-agent (A2A) — built, not yet live-validated**: the runtime role is granted
  `InvokeAgentRuntime` on allow-listed collaborator runtimes (plus OBO token exchange and Agent Registry
  publish), and the harness now **consumes** `multiAgent` — supervisor orchestration adds a delegation
  tool per collaborator (InvokeAgentRuntime), exchanges an OBO token for `auth:'obo'`, publishes a
  registry record, and propagates a correlation id across A2A hops. Cedar still governs the *invoked*
  agent's tools, not the A2A invoke. Proving it needs a second deployed collaborator agent
  (`docs/REMEDIATION.md` Gate 5).
- **Use cases**: a reusable **Strands harness** (`use-cases/_harness/`: `agent.py` + `render.py`
  manifest compiler + ARM64 Dockerfile) and **citizen-311** — a manifest-driven agent whose tool
  targets and Cedar policies are deployed onto the gateway from the manifest.
- **Security defaults everywhere:** customer-managed KMS on every store that supports it, S3 block
  public access + TLS-only + versioning, least-privilege IAM, and `cdk-nag` (`AwsSolutions` +
  `HIPAASecurity`) passing with justified, documented suppressions.
- **Config-driven:** all customer differences live in `config/<customer>.json`
  (schema: `lib/config/platform-config.ts`). No customer names or account IDs in code.

## Develop
```powershell
npm install
npm run build              # type-check
npm test                   # template assertions (jest)
npm run synth:standalone   # (also :hub :spoke :org)
npm run nag                # cdk-nag AwsSolutions + HIPAA packs
```
Copy `config/platform.example.json` to `config/<customer>.json` for each customer.

> **Deployment is intentionally not run from arbitrary machines.** Synth and test freely; deploy only
> against an explicitly named target account/profile (`--profile <name>`).

## Maturity

This is a **governance accelerator undergoing a defined hardening + validation phase** — not a
production-certified, four-mode product. An independent readiness review (29 Oct 2026) found several
controls that were provisioned but not wired end to end; those critical defects have since been fixed
(see [`docs/REMEDIATION.md`](docs/REMEDIATION.md)). The honest per-capability status:

| Capability | Status | Notes |
|---|---|---|
| CDK build / 4-mode synth / cdk-nag | **Live-tested** (local) | 30 jest + 17 pytest green; nag clean ×4 modes |
| Standalone foundation (baseline + platform + controls) | **Live-tested** (2026-10-29) | deployed to a real account; enforcing Cedar, guardrail pinned to runtime, HITL end-to-end, safe logging ownership — all exercised live |
| citizen-311 governed workflow | **Live-validated** (post-fix) | full workflow run in-account: authorized/denied/approved/kill-switch all pass — see `docs/REMEDIATION.md` Gate 2 |
| Kill switch / guardrail enforcement / interceptor | **Live-tested + unit-tested** | engage→block→release→restore verified live; behavioral pytest for kill-switch + interceptor + HITL executor + logging ownership |
| Human identity (Cognito groups + human client) | **Integrated** | provisioned; user creation is a scripted operational step |
| Hub / spoke cross-account integration | **Built, not live-validated** | spoke OAM link, cross-account evidence replication (+ hub inbound policy), catalog shares, per-spoke dashboard widgets — synth/nag/test-verified; needs two real accounts in one Org to close (Gate 3) |
| Org enforcement (SCPs, StackSet, budget→SCP) | **Built, not live-validated** | SCP principal alignment fixed (platform roles named under the governed prefix + CDK exec-role exemption), delegated-admin switch, Bedrock-scoped budget, guardrail-ownership warning — synth/test-verified; needs a **test OU** to validate under active SCPs (Gate 4) |
| Multi-agent A2A | **Built, not live-validated** | the harness now orchestrates — delegation tool per collaborator (InvokeAgentRuntime), OBO exchange, registry publish, correlation id; needs a second deployed agent to prove (Gate 5) |
| Private networking (VPC) | **Built, not live-validated** | `agentcore.network: VPC` places Runtime + Browser in the customer VPC (subnets/SGs); needs live egress/PrivateLink validation |
| CloudWatch Omni Space | **Synth-tested** | needs a real Omni domain + live telemetry validation |

**Maturity legend:** *live-tested* (run against AWS post-fix) · *integrated* (wired across constructs,
synth/unit-verified) · *partial* (some pieces missing) · *synth/nag-tested only* · *scaffolding*.

**Hardening plan (gated):** (1) truthful scope + safe defaults ✅; (2) **standalone reference** —
critical wiring closed and **validated live in a real account** (2026-10-29) ✅; (3) connected
hub/spoke — **integration built** (OAM links, evidence replication, catalog shares); cross-account
live-validation pending (needs two accounts in one Org); (4) org enforcement — **principal
alignment + delegated-admin + budget scope built**; live validation pending (needs a test OU); (5)
optional capabilities — **A2A orchestration,
private VPC networking, and Memory use are built**; A2A/VPC/Omni live validation needs a second agent /
VPC / Omni domain. See `docs/REMEDIATION.md` for the findings-to-fixes map + Gate-2 evidence and
`docs/CONTROLS.md` for per-control status.

**Packaging note:** CDK synthesizes CloudFormation but these are **not four prepackaged CloudFormation
launch products** — templates depend on assets (Lambdas, custom-resource providers) and, for the
runtime, a prebuilt ARM64 ECR image. Treat it as one shared CDK implementation with deployment
profiles.
