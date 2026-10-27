# Architecture Decision Record: AI Governance Landing Zone on AgentCore

Status: Accepted (grounded against AWS docs 2026-10-27) · Owner: David Ryder (HCLS SA), with Shashi (SLG) · Date: 2026-10-27

## Problem
SLG and HCLS customers are adopting AI agents faster than they can govern them. Most already run
an established AWS multi-account environment (Organizations, usually Control Tower or LZA, with
accredited CJIS/PHI workload accounts). They need a low-friction, repeatable way to stand up
governed agent infrastructure and a harness for their first use case, **without re-platforming or
re-accrediting**.

## Decision
**A governance *overlay*, not a new landing zone. Hub-and-spoke, packaged as one CDK framework with a
single-account (`standalone`) pilot mode.** We bring landing-zone-grade governance *to* the accounts
the customer already runs; we do not force a greenfield landing zone, and we do not scatter ungoverned
AgentCore into each account.

- **Governance hub account** holds what AWS designed to be centralized: AWS Agent Registry (shared via
  RAM), cross-account observability sink (OAM) + CloudWatch Omni Space, log archive, Service Catalog
  portfolio, and the guardrail referenced by the org-level Bedrock declarative policy. Maps to the AWS
  SRA **Security-Tooling / delegated-administrator** account.
- **Spoke stack** deploys into new *or existing* workload accounts (enrolled into an Agentic OU, no
  workload migration): AgentCore Runtime/Harness, Gateway + Policy engine (Cedar), Memory, Identity,
  Browser, plus the per-account evidence layer (invocation logging, CloudTrail data events, KMS) and
  operational controls.
- **Standalone** collapses hub features into the spoke so a pilot runs in one account, then graduates to
  hub-and-spoke by redeploying with `mode=hub` + `mode=spoke` — no re-architecture.
- **Org** (management or delegated admin) applies the mandatory, org-wide layer: Bedrock declarative
  policy, Agentic-OU SCPs, and Guard hooks via StackSets.

### Scoping decisions (confirmed 2026-10-27)
1. **Commercial first.** Build and validate in commercial regions (us-east-1). GovCloud (US) is a
   fast-follow, **gated on confirming per-service availability** (AgentCore, CloudWatch Omni, Bedrock
   declarative policy) in the GovCloud partition — see Open Risks. Region/partition is config-driven.
2. **Config-driven Control Tower detection.** When the customer runs Control Tower, org-wide controls
   ship via **Customizations for Control Tower (CfCT) + service-managed StackSets**; without CT, via
   plain (self-managed) StackSets. The `org` config carries a `controlTower` toggle (`auto` default).
3. **First reference use case: SLG Citizen Services / 311** agent, built on the repeatable harness in
   `use-cases/`. HCLS use case is a fast-follow on the same harness.

## Why not "a brand-new landing zone" for established customers
Established SLG/HCLS customers already have an Organization and accredited accounts. AWS's sanctioned
path is to **enroll existing workload accounts into a dedicated governance OU** (Control Tower "Enroll
account"; no workload migration) and layer controls via **CfCT / service-managed StackSets** and
**Guard Hooks** from a **delegated-admin** account. Forcing a new landing zone means re-accreditation
and migration — a deal-killer for regulated, change-averse buyers. Reserve the greenfield "stand up a
new account/landing zone" path only for customers with no Organization (served by `standalone` → `hub`+`spoke`).

## Why not "everything in one AI account"
1. **Cedar is gateway-scoped.** Action-scoped policies must name a specific Gateway ARN; Cedar has no
   `*` action glob. Policy engines attach to gateways, which live with the agents. (AgentCore Policy
   scope.)
2. **Data gravity and compliance boundaries.** PHI/CJIS-scoped agents should run beside the data inside
   the account boundaries the customer already accredited.
3. **Blast radius, quotas, cost attribution.** One account per workload/environment keeps a runaway
   agent from exhausting shared quotas and gives clean chargeback.
4. AWS SRA explicitly allows merging the Generative AI and Application accounts when usage is spread
   across the org — that is our `standalone`/`spoke` pattern. (AWS SRA: Generative AI.)

## Why not "just drop AgentCore into each account"
Without a hub there is no org-wide guardrail enforcement, no shared registry/approval workflow, no
single audit view, and configuration drifts per team.

## Control placement

| Concern | Hub | Spoke | Org (mgmt/delegated) | Source / IaC note |
|---|---|---|---|---|
| Guardrails | guardrail (or mgmt acct) | account-level enforcement + app guardrails | **Bedrock declarative policy** (Organizations) | Org enforcement is declarative (verify via `DescribeEffectivePolicy`); automated-reasoning policies unsupported org-wide. Backstop with `bedrock:GuardrailIdentifier` SCP key |
| Tool authorization | — | **Policy + PolicyEngine (Cedar), native CFN** per gateway | — | Default-deny; `LOG_ONLY` vs `ENFORCE`. AgentCore's own Cedar engine, **not** Amazon Verified Permissions |
| Agent/tool catalog | AWS Agent Registry + RAM share | publish/consume | — | GA feature, **no CFN type → `AwsCustomResource`** |
| Identity | — | Cognito user pool, short-lived JWT, Workload Identity, token vault | — | Inbound (SigV4/OAuth) + outbound (user-delegated/autonomous); user-scoped tool calls |
| Telemetry | OAM sink (`AWS::Oam::Sink`), CloudWatch Omni Space | AgentCore observability (OTel/ADOT), invocation logs, OAM link | — | Observability enabled by convention; Transaction Search via `AWS::XRay::TransactionSearchConfig`. Omni GA 2026-09 |
| Model invocation logging | — | prompts/completions → S3 + CloudWatch | — | `PutModelInvocationLoggingConfiguration`, **no CFN → `AwsCustomResource`**, off by default |
| Audit trail | log archive | CloudTrail incl. AgentCore data events | org trail (existing) | Data events for Gateway (`InvokeGateway`), Runtime (`InvokeAgentRuntime`), Registry (`InvokeRegistryMcp`); Memory data-event type UNCONFIRMED |
| Change control | Service Catalog portfolio (shared org-wide) | Guard hooks (`AWS::CloudFormation::GuardHook`) | StackSets (service-managed when CT, else self-managed), SCPs | |
| Cost | — | Budgets + actions, Gateway rate limits | **Budgets SCP action** (cost kill switch) | Budget action can apply an SCP to a target account from mgmt |
| Kill switch | — | Cedar forbid-all → endpoint disable | SCP deny on OU | Layered fastest→broadest; + Budgets SCP action for cost |
| HITL | — | Step Functions InvokeHarness + `waitForTaskToken` | — | |

## IaC mechanism summary (native CFN vs custom resource)
- **Native CloudFormation (`AWS::BedrockAgentCore::*`):** Runtime, RuntimeEndpoint, Harness,
  HarnessEndpoint, Gateway, GatewayTarget, GatewayRateLimit, GatewayRule, Memory, WorkloadIdentity,
  ApiKey/OAuth2 CredentialProvider, BrowserCustom, CodeInterpreterCustom, **Policy, PolicyEngine**,
  Evaluator/OnlineEvaluationConfig. Prefer L1 (`aws-cdk-lib/aws-bedrockagentcore`). Alpha L2
  existence UNCONFIRMED — treat L1 as the production path.
- **Custom resource (`AwsCustomResource`) required — no CFN type today:** AWS Agent Registry, Bedrock
  model invocation logging, AgentCore Observability enablement (convention-based; the CFN-representable
  slice is `AWS::XRay::TransactionSearchConfig`).

## Multi-agent collaboration (native)
The platform supports multi-agent collaboration as a first-class capability, not an add-on.
- **Two tiers.** *In-process* multi-agent (Strands Swarm/Graph/Workflow/Agents-as-Tools) runs inside one
  Runtime container — shared memory, one trace. *Cross-Runtime* collaboration uses the **A2A** protocol
  (JSON-RPC 2.0, served on Runtime port `:9000/`), where each agent is a separately deployed, separately
  governed Runtime.
- **Discovery.** Collaborators are found via the Agent Card (`/.well-known/agent-card.json`) and the AWS
  Agent Registry MCP endpoint (governed publish: draft → pending → discoverable).
- **Identity/authz boundary (important).** Agent-to-agent *invoke* authorization is **IAM**
  (`bedrock-agentcore:InvokeAgentRuntime`) + OAuth audience binding, or AgentCore Identity **OBO token
  exchange (RFC 8693)** carrying both the agent workload identity and the original user `sub`. **Cedar
  governs the invoked agent's *tool* calls at its Gateway — not the A2A hop.** Both layers must be
  documented and configured; do not assume Cedar covers inter-agent invocation.
- **Orchestration.** AWS recommends **supervisor/orchestrator-worker** for governed enterprise use
  (intent routing, clean per-agent context, central quality control); swarm only for parallel exploration
  with convergence detection + per-swarm token budgets.
- **Shared context.** AgentCore Memory namespaces (`/actor/{actorId}/{sessionId}/{strategyId}`) — a shared
  actor-scoped namespace carries cross-agent case context (e.g. a 311 case across supervisor + spokes).
- **Governance across the graph.** Session → Trace → Spans with trace-context propagation; for async/A2A
  hops, propagate an explicit **correlation ID**. The **kill switch must fan out across every agent** in
  the graph (Cedar forbid-all disables tools, but a rogue A2A agent also needs Runtime endpoint disable /
  SCP on `InvokeAgentRuntime`). There is **no native call-graph budget** — attribute cost per-agent via
  tags/inference-profile and reconstruct graph spend from correlation IDs.

Config: `agentcore.protocol`, `agentcore.multiAgent` (orchestration, in-process sub-agents, remote
collaborators, shared memory namespace), and `agentcore.cedarMode` in `lib/config/platform-config.ts`.
See `docs/PORT-MAP.md` for the manifest schema and harness wiring.

## AWS-public provenance (harvest + cite)
No AWS-official multi-account AgentCore governance landing zone exists to adopt wholesale, so this repo is
the base and harvests from AWS-public sources for best-practice provenance:
- **Landing Zone Accelerator (LZA)** — SCP/Config-rule patterns + its Healthcare and State & Local Gov
  sample configs. Reference/harvest.
- **AWS SRA — Generative AI** (`aws-samples/aws-security-reference-architecture-examples/.../genai`) —
  `bedrock_guardrails` (config-driven guardrail; we add the version it omits) + `bedrock_org` (14 detective
  Config rules + cross-account OAM). Harvest.
- **`aws-samples/sample-agentcore-enterprise-platform`** — config-schema, federation, Cedar/guardrail
  enforcement wiring, consolidated-SCP, A2A multi-agent. Reference (CDK-Python/Terraform; do not rebase).
- **`aws-samples/sample-per-user-governance-for-bedrock-agentcore-gateway`** — per-user Gateway interceptor
  + ledger (block/allowlist/rate-limit/token+USD budget/auto-downgrade). Port into Controls (CDK-TS).

## Open risks
- `@aws-cdk/aws-bedrock-agentcore-alpha` (if used) is alpha; production paths use L1. Pin exact versions.
- **GovCloud availability** of AgentCore, CloudWatch Omni, and the Bedrock declarative policy must be
  confirmed per-service before promising GovCloud to SLG customers. Commercial-first per decision above.
- AWS Agent Registry Region/GA status to confirm per customer Region.
- Org-level guardrail enforcement is **declarative** (inheritance-based), needs management-account
  involvement; fallback is account-level enforcement in each spoke + the `bedrock:GuardrailIdentifier`
  SCP key.
- AgentCore Memory as a distinct CloudTrail data-event resource type is UNCONFIRMED.

## Reusable assets (prior work on this machine)
- `C:\DRyder\Best Go-To-Market Opportunity\aws-native-reference\_shared\runtime\` — AgentCore runtime
  harness (`serve.py`, `handler.py`, `Dockerfile`); candidate to generalize into `use-cases/` harness.
- `C:\DRyder\Best Go-To-Market Opportunity\platform_core\fsi_agent_platform\mcp_gateway\` — MCP gateway
  + token pattern (`gateway.py`, `tokens.py`).
- `C:\Users\daryd\Projects-DR\` — additional governance work (inventory pending scan 2026-10-27).

## References
- AgentCore Policy core concepts — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html
- AgentCore Policy getting started — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-getting-started.html
- AgentCore Runtime HTTP contract — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html
- AgentCore Identity / OAuth — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-oauth.html
- AgentCore CloudFormation types — https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/AWS_BedrockAgentCore.md
- Registry cross-account sharing — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-cross-account-sharing.html
- Bedrock model invocation logging — https://docs.aws.amazon.com/bedrock/latest/userguide/model-invocation-logging.html
- Guardrails enforcements — https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-enforcements.html
- `bedrock:GuardrailIdentifier` SCP key — https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-permissions-id.html
- Amazon Bedrock Organizations policy — https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_bedrock.html
- AgentCore observability get started — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-get-started.html
- CloudWatch cross-account (OAM) — https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Unified-Cross-Account.html
- CloudWatch Omni — https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch-omni.html
- Customizations for Control Tower (CfCT) — https://docs.aws.amazon.com/controltower/latest/userguide/cfct-overview.html
- CloudFormation Guard Hooks — https://docs.aws.amazon.com/cloudformation-cli/latest/hooks-userguide/hooks-guard.html
- Budgets controls / actions — https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-controls.html
- Generative AI for the AWS SRA — https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/gen-ai-sra.html
- Organizing Your AWS Environment (foundational OUs) — https://docs.aws.amazon.com/whitepapers/latest/organizing-your-aws-environment/foundational-ous.html
- AgentCore Runtime A2A protocol — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-a2a.html
- AgentCore on-behalf-of token exchange (RFC 8693) — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/on-behalf-of-token-exchange.html
- AgentCore Memory namespace organization — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/memory-organization.html
- Agent Registry MCP endpoint (discovery) — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-mcp-endpoint.html
- Well-Architected Agentic AI Lens (AGENTPERF05/AGENTSEC05) — https://docs.aws.amazon.com/wellarchitected/latest/agentic-ai-lens/
- Strands multi-agent patterns — https://strandsagents.com/latest/documentation/docs/user-guide/concepts/multi-agent/agent-to-agent/
- LZA on AWS (sample configs: Healthcare, SLG) — https://github.com/awslabs/landing-zone-accelerator-on-aws
- SRA GenAI examples (bedrock_org, bedrock_guardrails) — https://github.com/aws-samples/aws-security-reference-architecture-examples
- sample-agentcore-enterprise-platform — https://github.com/aws-samples/sample-agentcore-enterprise-platform
- sample-per-user-governance-for-bedrock-agentcore-gateway — https://github.com/aws-samples/sample-per-user-governance-for-bedrock-agentcore-gateway
