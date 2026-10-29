# Controls Matrix — Governed AI Agent Platform

Every control below is grounded in AWS documentation (validated 2026-10-27) and maps to a deployment
mode, an IaC mechanism, and the governance concern it satisfies. "Custom" = `AwsCustomResource`
(no CloudFormation resource exists today); "L1" = `aws-cdk-lib/aws-bedrockagentcore` CFN construct.

Legend — Modes: **S**=standalone · **P**=spoke · **H**=hub · **O**=org.

### Implementation status (by build step)
- **Step 2 (baseline, deployed+verified on AWS):** A1, A2, A3, A4, B1, B2.
- **Step 3 (agent platform, deployed+verified on AWS):** C1, C2, C3, C5 (engine + per-gateway Cedar; `LOG_ONLY` default), D2, G1, G2, G3.
- **Step 4 (controls, synth+nag+tests green; per-user path nag-verified via sa-test):** E1 (Cedar forbid-all kill switch, Lambda-driven), E4 (budgets + alerts), E6 (HITL `waitForTaskToken`), E7 (per-user interceptor + ledger: per-user block, model allowlist by Cognito group, rate limit; token/USD budget + auto-downgrade are RESPONSE-side extensions). E5 (gateway rate limit) stays per-use-case — `CfnGatewayRateLimit` keys on specific dimension values, so blanket RPM lives in the E7 interceptor.
- **Step 5 slice A (org foundation, synth+nag+tests green):** org SCPs — AI inference perimeter (B4-adjacent: deny Bedrock inference outside governed roles) + control-plane integrity (protect invocation logging, AgentCore/guardrail control plane, evidence vaults), both lifted from the Aegis baseline and parameterized; the SCP-exempt platform deployer role (the kingpin every SCP exempts). E2 (broad SCP kill switch) is satisfied by these perimeters. **B3** (Bedrock org declarative policy) done — native `AWS::Organizations::Policy` type `BEDROCK_POLICY` pinning the guardrail floor + comprehensive content guarding org-wide (gated on `org.orgGuardrailArn`).
- **Step 5 slice B (governance hub, synth+nag+tests green):** A5 (central WORM log archive), D3 (OAM cross-account observability sink, org-scoped). Created only in dedicated `hub` mode; `standalone` collapses (baseline provides evidence).
- **Step 5 (cont.):** F1 (Guard Hook) done — `AWS::CloudFormation::GuardHook` in WARN over RESOURCE+STACK ops, evaluating `policies/guard/baseline.guard` (S3 BPA+encryption, guardrail CMK, gateway CUSTOM_JWT); org-wide rollout via StackSets (F2) is the documented distribution.
- **Step 5 (cont.):** E3 (cost kill switch) done — a detached cost-freeze SCP (deny all Bedrock inference, deployer-exempt) auto-attached to the Agentic OU by an `AWS::Budgets::BudgetsAction` (`APPLY_SCP_POLICY`) at 100% of the monthly budget.
- **Step 5 (cont.):** F3 (Service Catalog) done — hub portfolio + a "governed data workspace" product (CMK + BPA + TLS + versioned bucket) for self-service compliant provisioning.
- **Step 5 (cont.):** D4 (governance dashboard, `AWS::CloudWatch::Dashboard`) + SRA detective Config rules (custom rules: invocation-logging-configured, guardrails-present; gated on `controls.detectiveConfigRules`, needs a Config recorder) done.
- **Step 5 done (cont.):** F2 (Guard-hook StackSets rollout) — service-managed `AWS::CloudFormation::StackSet` with auto-deployment to the Agentic OU, embedding a per-account Guard hook that reads the hub's central rules (shared org-wide by `aws:PrincipalOrgID`); gated on `org.organizationId` + `org.agenticOuId`. H3 (multi-agent discovery) — `multiAgent` config drives runtime IAM (`InvokeAgentRuntime` on allow-listed collaborators, OBO token exchange, registry publish) + env wiring for the Strands harness.
- **Step 5 done (cont.):** CloudWatch Omni Space upgrade (D4+) — `AWS::CloudWatch::Space` (+ optional `AWS::CloudWatch::OmniDashboard`) declared via the raw `CfnResource` escape hatch because both are newer than the pinned `aws-cdk-lib`; grounded against the CFN Template Reference. Hub-mode, gated on `agentcore.omni.domainId`; the construct creates the space operator / data-access role (trusts `cloudwatch.amazonaws.com` + the confused-deputy `sts:TagSession/SetSourceIdentity/SetContext` actions and `aws:SourceAccount`, carries `CloudWatchOmniSpaceAccessPolicy` as base + boundary).
- **All step-5 items complete.** StackSets + A2A + Omni are synth/nag/test-verified (24 tests, cdk-nag clean ×4 modes); live deploy of StackSets needs an AWS Organization, and the Omni Space needs an out-of-band Omni domain (console + SSO onboarding).
Controls not yet listed are design targets realized in later steps.

## A. Evidence & audit (per-account baseline)

| # | Control | Service / resource | IaC | Modes | Notes |
|---|---|---|---|---|---|
| A1 | Encryption at rest | Customer-managed KMS key per store | L2 | S,P,H | Key rotation on; grants least-privilege |
| A2 | Central log bucket | S3 (block public access, TLS-only, versioned, KMS) | L2 | S,P,H | Object Lock optional for phi/cjis |
| A3 | Control-plane + data-plane audit | CloudTrail + advanced event selectors | L2 | S,P | Data events: `InvokeGateway`, `InvokeAgentRuntime`, `InvokeRegistryMcp` |
| A4 | Model I/O capture | Bedrock model invocation logging → S3 + CW Logs | **Custom** | S,P | `PutModelInvocationLoggingConfiguration`; off by default; `largeDataDeliveryS3Config` for big payloads |
| A5 | Log archive | Dedicated bucket + lifecycle | L2 | H | SRA log-archive role |

## B. Guardrails (content safety)

| # | Control | Service / resource | IaC | Modes | Notes |
|---|---|---|---|---|---|
| B1 | Content/PII/topic guardrail | Bedrock Guardrail + immutable version | L1/Custom | S,P,H | Filters, denied topics, PII block/mask, contextual grounding |
| B2 | Account-level enforcement | Guardrail applied to all inference in account | Custom | S,P | Via config `enforceAccountLevel` |
| B3 | Org-wide enforcement | Bedrock **declarative policy** (Organizations) | Custom/StackSets | O | Verify `DescribeEffectivePolicy`; no automated-reasoning org-wide |
| B4 | Guardrail SCP backstop | `bedrock:GuardrailIdentifier` condition | SCP | O | `Null:true` deny = must use a guardrail; `StringNotEquals` pins version |

## C. Identity & authorization

| # | Control | Service / resource | IaC | Modes | Notes |
|---|---|---|---|---|---|
| C1 | Short-lived user tokens | Cognito user pool + app client | L2 | S,P | `accessTokenValidityMinutes` 5–60 |
| C2 | Agent workload identity | AgentCore WorkloadIdentity | L1 | S,P | Unique ARN per agent; token vault (KMS) |
| C3 | Inbound auth | OAuth (OIDC discovery URL / audiences / clients) or SigV4 | L1 | S,P | Cognito/Okta/Entra, no user migration |
| C4 | Outbound auth / delegation | OAuth2/ApiKey CredentialProvider; token exchange | L1 | S,P | User-delegated (3LO) or autonomous (2LO) |
| C5 | Tool authorization (Cedar) | AgentCore Policy + PolicyEngine | L1 | S,P | Default-deny; `LOG_ONLY`→`ENFORCE`; baseline templates rendered per gateway ARN |

## D. Observability & lineage

| # | Control | Service / resource | IaC | Modes | Notes |
|---|---|---|---|---|---|
| D1 | Agent tracing | AgentCore Observability (OTel: sessions→traces→spans) | convention | S,P | Auto on Runtime; ADOT + env vars off-runtime |
| D2 | Transaction Search | X-Ray `UpdateTraceSegmentDestination` → CloudWatchLogs | **Custom** | S,P | Idempotent custom resource (tolerates pre-existing account-level config; does not disable on teardown) — the CFN `TransactionSearchConfig` fails AlreadyExists |
| D3 | Cross-account telemetry | OAM `Sink` (hub) + `Link` (spoke) | L1 | H,P | Sink policy scoped by `aws:PrincipalOrgID` |
| D4 | Governance dashboard | `AWS::CloudWatch::Dashboard` (guardrail + invocation + gateway metrics) | L1 | H | Always-on, zero-prerequisite governance view |
| D4+ | Unified/agent observability upgrade | CloudWatch Omni `AWS::CloudWatch::Space` (+ optional `OmniDashboard`), with the space operator / data-access role | L1 via raw `CfnResource` (newer than pinned cdk-lib) | H | ✅ `agentcore.omni.domainId` (domain created out-of-band at Omni onboarding); auto-discovers topology + golden metrics; `enableModelInference` adds eval-driven agent observability |

## E. Operational controls

| # | Control | Service / resource | IaC | Modes | Notes |
|---|---|---|---|---|---|
| E1 | Kill switch (fast) | Cedar forbid-all policy / endpoint disable | L1 | S,P | Fastest blast-radius containment |
| E2 | Kill switch (broad) | SCP deny on Agentic OU | SCP | O | Org-level stop |
| E3 | Cost kill switch | Budgets action → apply SCP | L2 | O | From mgmt acct to target account |
| E4 | Budgets + alerts | AWS Budgets + SNS notifications | L2 | S,P | `monthlyBudgetUsd`, `budgetAlertEmails` |
| E5 | Gateway rate limit | AgentCore GatewayRateLimit | L1 | S,P | `gatewayRequestsPerMinute` |
| E6 | Human-in-the-loop | Step Functions (InvokeHarness + `waitForTaskToken`) | L2 | S,P | `humanInTheLoop` toggle |
| E7 | Per-user Gateway governance | Gateway REQUEST interceptor Lambda + single-table DynamoDB ledger | L2+Custom | S,P | Per-user block, model allowlist (Cognito group), rate limit; token/USD budget + auto-downgrade are RESPONSE-side follow-ups. `controls.perUserGovernance`. **Interceptor I/O contract (live-validated):** input `mcp.gatewayRequest` (JWT in Authorization header, needs `passRequestHeaders`); output `interceptorOutputVersion:"1.0"` + `mcp.transformedGatewayRequest` (allow) or `transformedGatewayResponse` (deny). |

## F. Change control & distribution

| # | Control | Service / resource | IaC | Modes | Notes |
|---|---|---|---|---|---|
| F1 | Proactive deploy-time policy | CloudFormation Guard Hook (`AWS::CloudFormation::GuardHook`) | L1 | P,O | `FailureMode: FAIL` blocks non-compliant resources |
| F2 | Org-wide hook rollout | Service-managed `AWS::CloudFormation::StackSet`, auto-deploy to Agentic OU; embedded hook reads hub rules via `aws:PrincipalOrgID` | L1 | O | ✅ Auto-deploys so new accounts inherit; WARN→FAIL once tuned |
| F3 | Self-service catalog | Service Catalog portfolio + products | L2 | H | Shared org-wide / OU / account from hub |
| F4 | Agent/tool catalog | AWS Agent Registry + RAM share | **Custom** | H | No CFN type |

## G. Tooling capabilities (per use case)

| # | Control | Service / resource | IaC | Modes | Notes |
|---|---|---|---|---|---|
| G1 | Web access | AgentCore Browser (BrowserCustom/Profile) | L1 | S,P | `enableBrowser`; session recording |
| G2 | Code execution | AgentCore Code Interpreter | L1 | S,P | Sandboxed ephemeral microVM |
| G3 | Shared context | AgentCore Memory (short + long term) | L1 | S,P | `enableMemory`, `memoryEventExpiryDays` |

## H. Multi-agent collaboration controls

| # | Control | Service / resource | IaC | Modes | Notes |
|---|---|---|---|---|---|
| H1 | Agent-to-agent invoke authz | IAM `bedrock-agentcore:InvokeAgentRuntime` + OAuth audience / OBO token exchange | L1 | S,P | ✅ **Cedar does NOT gate A2A invoke** — only the invoked agent's tools. `multiAgent.remoteCollaborators[].runtimeArn` → allow-listed on the runtime role (+ OBO perms when `auth:'obo'`) |
| H2 | Invoked-agent tool authz | Cedar at the collaborator's Gateway | L1 | S,P | Standard per-gateway Cedar applies once B is invoked |
| H3 | Governed discovery | Agent Registry publish (draft→pending→discoverable) | Custom | H | ✅ `multiAgent.publishToRegistry` → runtime IAM `Create/UpdateRegistryRecord` |
| H4 | Shared context | AgentCore Memory shared namespace | L1 | S,P | `multiAgent.sharedMemoryNamespace`; actor-scoped cross-agent |
| H5 | Cross-graph kill switch | Cedar forbid-all (tools) + Runtime endpoint disable + SCP on `InvokeAgentRuntime` | L1/SCP | S,P,O | **Must fan out to every agent** in the call graph |
| H6 | Cross-graph cost attribution | Per-agent tags / inference-profile + correlation-ID reconstruction | convention | S,P | No native call-graph budget; `budgets.attribution_tag` + `correlation_id_passthrough` |
| H7 | Cross-graph trace continuity | OTEL session→trace→spans + correlation-ID propagation on A2A hops | convention | S,P | Mandate correlation-ID passthrough so a case is one auditable chain |

## Detective compliance layer (SRA GenAI harvest)
Implemented as CDK custom AWS Config rules (`controls.detectiveConfigRules`, Controls stack): `guardrails-present` and `invocation-logging-configured`. Additional SRA checks (`_s3`, `check_vpc_endpoints`, `check_guardrail_encryption`) extend the same check Lambda.
These detect drift beneath the preventative SCP/Cedar/guardrail controls above.

## Baseline Cedar policies (templates, rendered per gateway ARN)
Because Cedar has no wildcard action and action-scoped policies must name a specific Gateway ARN,
`policies/cedar/baseline/` holds **templates** rendered per gateway at synth time:
- `default-deny.cedar` — forbid all unless explicitly permitted.
- `require-authenticated-principal.cedar` — permit only principals with a verified JWT `sub`.
- `kill-switch.cedar` — forbid-all toggle (E1).
- `deny-high-risk-tools.cedar` — forbid tools tagged high-risk without HITL context.
`policies/cedar/customer/` holds per-customer additions.
