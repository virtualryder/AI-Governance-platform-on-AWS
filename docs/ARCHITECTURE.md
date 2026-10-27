# Architecture Decision Record: AI Governance Landing Zone on AgentCore

Status: Proposed · Owner: David Ryder (HCLS SA), with Shashi (SLG) · Date: 2026-10-27

## Problem
SLG and HCLS customers are adopting AI agents faster than they can govern them. Most already run
an established AWS multi-account environment. They need a low-friction, repeatable way to stand up
governed agent infrastructure and a harness for their first use case, without re-platforming.

## Decision
**Hub-and-spoke, packaged as one CDK framework with a single-account (`standalone`) mode.**

- **Governance hub account** holds what AWS designed to be centralized: Agent Registry (shared via RAM),
  central observability and CloudWatch Omni, log archive, Service Catalog portfolio, and the guardrail
  referenced by the org-level Bedrock policy.
- **Spoke stack** deploys into new *or existing* workload accounts: AgentCore Runtime/Harness, Gateway +
  Policy engine (Cedar), Memory, Identity, Browser, plus the per-account evidence layer (invocation
  logging, CloudTrail, KMS) and operational controls.
- **Standalone** collapses hub features into the spoke so a pilot runs in one account, then graduates to
  hub-and-spoke by redeploying with `mode=hub` + `mode=spoke` — no re-architecture.

## Why not "everything in one AI account"
1. **Cedar is gateway-scoped.** Policies naming specific tools must name a specific Gateway ARN; Cedar has
   no wildcard actions. Policy engines attach to gateways, which live with the agents.
   (AgentCore docs: Policy scope.)
2. **Data gravity and compliance boundaries.** PHI/CJIS-scoped agents should run beside the data inside
   the account boundaries the customer already accredited.
3. **Blast radius, quotas, cost attribution.** One account per workload/environment keeps a runaway agent
   from exhausting shared quotas and gives clean chargeback.
4. AWS SRA explicitly allows merging the Generative AI and Application accounts when usage is spread
   across the org — that is our `standalone`/`spoke` pattern. (AWS SRA: Generative AI.)

## Why not "just drop AgentCore into each account"
Without a hub there is no org-wide guardrail enforcement, no shared registry/approval workflow, no single
audit view, and configuration drifts per team.

## Control placement

| Concern | Hub | Spoke | Org (mgmt/delegated) | Source / note |
|---|---|---|---|---|
| Guardrails | guardrail (or mgmt acct) | account-level enforcement + app guardrails | Bedrock policy (BEDROCK_POLICY) | Org enforcement needs guardrail in mgmt acct; no automated-reasoning policies |
| Tool authorization | — | Policy engine + Cedar per gateway | — | Default-deny, GA 2026-03-03 |
| Agent/tool catalog | Agent Registry + RAM share | publish/consume | — | No CFN resource yet → custom resource |
| Identity | — | Cognito user pool, short-lived JWT, Workload Identity | — | User-scoped tool calls |
| Telemetry | cross-account sink, Omni | AgentCore observability (OTel), invocation logs | — | Omni has no CFN resource → manual/SDK enable |
| Audit trail | log archive | CloudTrail incl. data events | org trail (existing) | |
| Change control | Service Catalog portfolio | Guard hooks | StackSets for hooks, SCPs | |
| Cost | — | Budgets + actions, Gateway rate limits | — | |
| Kill switch | — | Cedar forbid-all, endpoint disable | SCP deny on OU | Layered fastest→broadest |
| HITL | — | Step Functions InvokeHarness + task token | — | |

## Open risks
- `@aws-cdk/aws-bedrock-agentcore-alpha` is alpha; production paths use L1.
- Agent Registry launched in preview in 5 Regions; confirm GA/Region status per customer.
- **GovCloud availability of AgentCore** must be confirmed for SLG customers that require it.
- Org-level guardrail enforcement requires management-account involvement; fallback is account-level
  enforcement in each spoke.

## References
- AgentCore Policy core concepts — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-core-concepts.html
- AgentCore harness — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/harness.html
- Registry cross-account sharing — https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/registry-cross-account-sharing.html
- Amazon Bedrock policies (Organizations) — https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_bedrock.html
- Guardrails enforcements — https://docs.aws.amazon.com/bedrock/latest/userguide/guardrails-enforcements.html
- Generative AI for the AWS SRA — https://docs.aws.amazon.com/prescriptive-guidance/latest/security-reference-architecture/gen-ai-sra.html
- Agent ops maturity: platform operations — https://docs.aws.amazon.com/prescriptive-guidance/latest/agent-ops-maturity-roadmap-for-enterprise-ai/platform-operations.html
- CloudWatch Omni — https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch-omni.html
