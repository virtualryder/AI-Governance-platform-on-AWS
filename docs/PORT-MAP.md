# Build Playbook & Port Map

How to build steps 2–6 by harvesting proven assets instead of writing from scratch. Every row names
a **source file → target in this repo → treatment** (as-is / port / reference). Grounded against AWS
docs 2026-10-27. Keep runtime = Python, infra = CDK TypeScript.

## Source inventory

**Private (Aegis lineage) — `C:\Users\daryd\Projects-DR\`**
- `governed-agent-platform\iac\` — CDK **TS** governance baseline + AgentCore custom-resource (now superseded by L1).
- `WOGplatform\infra\ai-landing-zone\` — SCP JSON, Bedrock org declarative-policy JSON, Service Catalog portfolio, evidence vault, account baseline.
- `governed-core\src\governed_core\` — Python runtime harness (Strands), `engine/render.py`, `engine/signoff.asl.json.tmpl`, `controls/kill_switch.py`.

**AWS-public (reference clones) — `C:\DRyder\_aws-public-reference\`** (gitignored, outside repo)
- `sample-agentcore-enterprise-platform\` — CDK Python + Terraform; richest reference for config schema, federation, Cedar/guardrail wiring, consolidated SCP, A2A multi-agent.
- `sample-per-user-governance-for-bedrock-agentcore-gateway\` — CDK **TS**; drop-in per-user Gateway interceptor + ledger. **Highest-value lift.**
- `aws-security-reference-architecture-examples\aws_sra_examples\solutions\genai\` — CFN; guardrail config shape + 14 detective Config rules.

## Step 2 — GovernanceBaseline

| Source | → Target | Treatment |
|---|---|---|
| `governed-agent-platform\iac\lib\governance-core-stack.ts` — CMK + CW-Logs key policy, WORM S3 (Object Lock), DynamoDB audit ledger + approvals, Backup | `lib/constructs/{kms,evidence-bucket,audit-ledger}.ts` → GovernanceBaseline | PORT; config-drive retention/removal; fix deprecated `pointInTimeRecovery`→`pointInTimeRecoverySpecification` |
| `sample-agentcore-enterprise-platform\stacks\runtime_stack.py:339-415,794-818` — guardrail + `Null:{bedrock:GuardrailIdentifier:true}` IAM deny | GovernanceBaseline guardrail construct | PORT the **ungoverned-inference deny** — key pattern |
| SRA `genai\bedrock_guardrails\lambda\src\app.py` `set_guardrail_config` (673-751) | GovernanceBaseline `CfnGuardrail` | REFERENCE for config-block toggles; **ADD `CfnGuardrailVersion`** (SRA omits it) |
| NEW (no source) | CloudTrail + AgentCore data events (`InvokeGateway`/`InvokeAgentRuntime`/`InvokeRegistryMcp`); Bedrock invocation logging via `AwsCustomResource` (`PutModelInvocationLoggingConfiguration`) | BUILD |

## Step 3 — AgentPlatform (native L1, drop the custom resource)

| Source | → Target | Treatment |
|---|---|---|
| `sample-agentcore-enterprise-platform\stacks\gateway_stack.py:161-196` — `CfnPolicyEngine` + per-control `CfnPolicy` + `GatewayPolicyEngineConfiguration(mode)` | `lib/constructs/agent-gateway.ts` | REFERENCE; use L1 `aws-cdk-lib/aws-bedrockagentcore` |
| `governed-agent-platform\iac\lambda\agentcore-provider\index.js` | — | **DROP** — superseded by `CfnPolicyEngine`/`CfnGateway`/`CfnWorkloadIdentity` |
| NEW | Cognito L2 user pool/client (or `identity` IdP), `CfnGateway` (CUSTOM_JWT) → `CfnPolicyEngine`, `CfnGatewayTarget`, `CfnGatewayRateLimit`, `CfnPolicy` (Cedar rendered per-gateway ARN), `CfnRuntime`+`CfnRuntimeEndpoint`, `CfnMemory`, `CfnBrowserCustom`, `CfnCodeInterpreterCustom` | BUILD — confirm props against `node_modules/aws-cdk-lib/aws-bedrockagentcore/lib/*.generated.d.ts` (rule #1) |
| NEW | Agent Registry (+ RAM share) + Bedrock invocation logging | `AwsCustomResource` only (no CFN type) |

## Step 4 — Controls

| Source | → Target | Treatment |
|---|---|---|
| `sample-per-user-governance-...\infra\lib\governance-gateway.ts` — single-table DynamoDB + interceptor Lambda + L1 `CfnGateway` interceptorConfigurations + least-priv role | `lib/constructs/gateway-interceptor.ts` → Controls | **PORT (CDK-TS, near drop-in)** |
| `...\infra\lambda\lambda_function.py` `_handle_request` stages + `DynamoRepository` + `Policy` | Controls Lambda asset (Python) | PORT — block / allowlist / rate-limit / budget / auto-downgrade / TOCTOU `admit()` |
| `...\attach_interceptor.py` | Controls (spoke onto existing gateway) | PORT as-is (custom resource, REQUEST-only to preserve streaming) |
| `...\attribution_lambda.py`+`usd_quota.py`+`pricing.py`+`window.py` | Controls USD budgets | PORT — extends `controls.perUserGovernance` |
| `governed-core\engine\signoff.asl.json.tmpl` | HITL Step Functions | REUSE-AS-IS — real `waitForTaskToken`; sub `{{PREFIX}}` via CDK |
| `governed-core\controls\kill_switch.py` | Layered kill switch | REFERENCE — SSM fail-closed flag + Cedar forbid-all + endpoint disable; **must fan out across multi-agent graph** |
| NEW | Budgets + **SCP action** (cost kill switch), `CfnGatewayRateLimit`, Guard hooks, Service Catalog product | BUILD |

## Step 5 — GovernanceHub + OrgFoundation

| Source | → Target | Treatment |
|---|---|---|
| `WOGplatform\...\org-baseline\policies\scp-ai-inference-perimeter.json`, `scp-ai-control-plane-integrity.json` | `policies/scp/` → OrgFoundation | **LIFT VERBATIM** (parameterize `aegis-*` role/prefix); reproduce the `aegis-platform-deployer` SCP-exempt role |
| `WOGplatform\...\org-baseline\policies\bedrock-org-guardrail-policy.json` | `policies/bedrock-org/` → OrgFoundation | LIFT VERBATIM (template guardrail ARN); apply as Bedrock declarative policy (`AwsCustomResource` if no CFN) |
| `sample-agentcore-enterprise-platform\control-library\terraform\org-guardrails\gateway.tf` — merges 8 gateway SCPs into 1 (stay under 5-per-target quota) | OrgFoundation | PORT pattern to CDK (concat Statements) |
| `WOGplatform\...\service-catalog\aegis-portfolio.yaml` | GovernanceHub | PORT to CDK; **add a 2nd product = the use-case** |
| `WOGplatform\...\evidence-vault-log-archive.yaml` | GovernanceHub log archive | PORT to CDK with our KMS/S3 defaults |
| SRA `genai\bedrock_org\lambda\rules\sra_bedrock_check_*` (14 Config rules) | Detective layer (Hub/Org) | PORT selected (guardrails, invocation logging, VPC endpoints) as CDK custom Config rules |
| NEW | OAM `Sink`/`Link` (cross-account telemetry), CloudWatch Omni Space, Guard hooks via StackSets | BUILD |

## Step 6 — use-cases/_harness + citizen-311 (Python runtime)

| Source | → Target | Treatment |
|---|---|---|
| `governed-core\src\governed_core\runtime\agent.py` (Strands + BedrockAgentCoreApp + MCPClient) | `use-cases/_harness/agent.py` | REUSE-AS-IS, light generalize (strip domain vocab) |
| `governed-core\...\runtime\{Dockerfile,_launch.sh,_obs_setup.sh,...}` | `use-cases/_harness/` | REUSE-AS-IS (ARM64; Transaction Search via `_obs_setup.sh`) |
| `governed-core\engine\render.py` | `use-cases/_harness/render.py` | REUSE — manifest→env/Cedar/target compiler = single source of truth |
| NEW | `use-cases/citizen-311/manifest.yaml` | BUILD — 311 tools, workflow, consequential-action (→ HITL), Cedar by Cognito group |

## Multi-agent collaboration (native) — manifest schema + harness

AgentCore Runtime speaks **A2A** (JSON-RPC 2.0) on **:9000/** alongside HTTP (:8080/invocations) and MCP
(:8000/mcp). Discovery via Agent Card (`/.well-known/agent-card.json`) + Agent Registry MCP endpoint.
Inter-agent invoke authz is **IAM (`bedrock-agentcore:InvokeAgentRuntime`) + OAuth audience, or AgentCore
Identity OBO token exchange (RFC 8693)** — **Cedar governs the invoked agent's *tool* calls at the Gateway,
not the A2A invoke itself.** In-process Strands patterns (Swarm/Graph/Workflow/Agents-as-Tools) share one
container + one trace; A2A crosses Runtime boundaries. AWS recommends **supervisor/orchestrator-worker** for
governed enterprise use.

`manifest.yaml` additions (compiled by `render.py`; mirrored in `PlatformConfig.agentcore.multiAgent`):
```yaml
protocol: A2A            # HTTP | MCP | A2A
collaboration:
  type: supervisor       # supervisor | swarm | graph | workflow | a2a
  in_process_subagents: [classifier, router]          # Strands agents sharing this container
  remote_collaborators:
    - name: benefits-eligibility
      runtime_arn: arn:aws:bedrock-agentcore:...:runtime/...   # or registry record
      agent_card_url: https://.../.well-known/agent-card.json
      auth: obo          # iam | obo
      scopes: [eligibility.read]
memory:
  shared_namespace: /actor/{actorId}/case/{caseId}/   # cross-agent 311-case context
registry: { publish: true, record_type: a2aAgentCard }
inter_agent:
  invoke_allowlist: [arn:aws:bedrock-agentcore:...:runtime/benefits-eligibility]  # → IAM role
budgets: { attribution_tag: agent-name, correlation_id_passthrough: true }
```
Harness (`agent.py`): branch on `protocol` — `serve_a2a(StrandsA2AExecutor(...))` for A2A vs
`BedrockAgentCoreApp` for HTTP/MCP; build in-process `Swarm`/`Graph` from `in_process_subagents`; wrap each
`remote_collaborators` entry as a Strands `A2AAgent` acquiring an OBO/IAM token per hop; propagate
`correlation_id` + trace context on every outbound call; read/write the shared Memory namespace.

## Cross-cutting (net-new in all sources)
- **cdk-nag** (AwsSolutions + HIPAASecurity) — absent everywhere; add with justified suppressions (rule #6).
- **`aegis-platform-deployer`** SCP-exempt deployer role — the kingpin both lifted SCPs reference; reproduce (config-driven name) or the SCPs lock us out.
- **Kill switch fan-out** across the multi-agent call graph; **budget attribution** per-agent via correlation IDs (no native call-graph budget).

## Recommended build order
2 → 3 → 4 → 6 (harness + 311 to exercise 2–4 end-to-end) → 5 (hub/org) → cdk-nag + tests + all-mode synth.
After each step: `npm run build` → `npm run synth:<mode>` → `npm test` (rule #2).
