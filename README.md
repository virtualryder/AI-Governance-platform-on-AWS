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
- **AgentCore layer** (native L1): Cognito (short-lived JWT) or external IdP, **MCP Gateway** with a
  **Cedar PolicyEngine** (deny-by-default, `LOG_ONLY`→`ENFORCE`), WorkloadIdentity, Memory, Browser /
  CodeInterpreter, image-gated **Runtime**, and CloudWatch Transaction Search observability.
- **Controls**: layered **kill switch** (Cedar forbid-all), **HITL** Step Functions (`waitForTaskToken`),
  Budgets + alerts, and a **per-user Gateway interceptor** + DynamoDB ledger (block / model-allowlist by
  Cognito group / rate limit).
- **Hub + Org**: organization SCPs (AI-inference perimeter + control-plane integrity), SCP-exempt
  deployer role, Bedrock org declarative policy (`BEDROCK_POLICY`), CloudFormation **Guard hooks**,
  **Budgets→SCP cost kill switch**, central WORM log archive, OAM cross-account sink, Service Catalog,
  **Agent Registry** (+RAM), a **CloudWatch governance dashboard**, **SRA detective Config rules**, and
  an **org-wide Guard-hook StackSet** (service-managed, auto-deploying to the Agentic OU).
- **Multi-agent (A2A)**: config-driven agent-to-agent collaboration — the runtime role is granted
  `InvokeAgentRuntime` on allow-listed collaborator runtimes (plus OBO token exchange and Agent
  Registry publish), and the `multiAgent` config is handed to the Strands harness. Cedar still governs
  the *invoked* agent's tools, not the A2A invoke itself.
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

## Status
**All six build steps complete** (see `CLAUDE.md`). All four modes synth, **22 tests green, cdk-nag
clean** across standalone/hub/spoke/org.

**Live-validated on AWS** (standalone, torn down after): the full citizen-311 agent ran end-to-end —
Cognito JWT → AgentCore Runtime → MCP Gateway → per-user interceptor → Cedar. The agent listed its
governed tools, ran the intake workflow, and **correctly refused the consequential `submit` action**
(owned by the HITL sign-off gate). Deny-by-default was verified before any tools were attached.

**Org-wide Guard-hook rollout** (service-managed StackSet auto-deploying to the Agentic OU) and
**multi-agent A2A** invoke-authz + registry-discovery wiring (`multiAgent` config → runtime IAM for
`InvokeAgentRuntime` / OBO token exchange / registry publish) are built and synth/nag/test-verified;
live deploy requires an AWS Organization. Remaining backlog (tracked in `CLAUDE.md`): CloudWatch
**Omni Space** upgrade (a newer CFN type than the pinned `aws-cdk-lib`).
