# Glossary

Terms and acronyms used across this repo, in plain language. For how they fit together read
[`docs/CONCEPTS.md`](docs/CONCEPTS.md).

### AgentCore (Amazon Bedrock AgentCore)
AWS's managed runtime and surrounding services for running AI agents. The platform uses its native L1
CloudFormation resources. The pieces you'll meet:
- **Runtime / RuntimeEndpoint** — the container (ARM64) that runs the agent; invoked over an HTTPS
  endpoint with a Bearer JWT. Only created once a real image digest is configured.
- **Gateway** — the MCP endpoint the agent calls to reach tools; where authorization and the
  interceptor run. Uses `CUSTOM_JWT` auth.
- **PolicyEngine** — evaluates Cedar policies to permit/forbid a tool call.
- **Memory** — managed agent memory store (off in the MVP).
- **Browser / CodeInterpreter** — optional sandboxed capabilities.
- **WorkloadIdentity** — the agent's own identity for service-to-service calls.

### A2A (Agent-to-Agent)
A protocol for one agent to delegate to another. In this repo it's IAM scaffolding only — not an
orchestrated collaboration. An explicit MVP exclusion.

### Access token vs ID token
Both are JWTs from the identity provider. The **access token** carries `client_id` and
`cognito:groups`; the Gateway/Runtime authorizer matches on `client_id`, so you must send the **access
token**. The **ID token** puts the client in the `aud` claim and will *not* match — a classic first-run
mistake.

### Action digest
A stable hash identifying a specific consequential action + its arguments. The key of the HITL
approvals ledger row and the idempotency key passed to the backend — so a replay maps to the same row
and the same intended effect.

### ADOT (AWS Distro for OpenTelemetry)
The telemetry agent used for AgentCore observability (spans/traces). Off in the minimal profile, so the
acceptance run reads evidence from ledgers + CloudTrail + Step Functions history instead of traces.

### Cedar
AWS's policy language for authorization. Policies here `permit` a tool to a named group or `forbid` a
consequential action. **Deny-by-default**: no matching permit means forbidden. Cedar has no wildcard
actions, and the group match is a quoted-token substring so `csr-agents` does not match
`csr-agents-readonly`.

### cdk-nag
A CDK linter that checks synthesized templates against security rule packs (`AwsSolutions` +
`HIPAASecurity` here). Must pass clean or carry a justified suppression.

### CMK (customer-managed KMS key)
An encryption key the customer owns and controls, used on every store that supports it (logs, evidence,
memory, ledgers) — versus an AWS-managed key.

### Consequential action
An action with real-world effect that must not happen without a human (e.g. "submit the service
request"). The agent is Cedar-forbidden from it; it routes to the HITL gate.

### Delegated admin
An org account (other than management) authorized to administer a service org-wide — used so StackSet
and policy operations don't all run from the management account.

### Guardrail (Amazon Bedrock Guardrail)
Configurable content controls: content filters, PII block/anonymize, denied topics. Enforced here not
by asking the model nicely but by an **IAM deny** on any Bedrock call that doesn't carry the approved
guardrail. Versioned — and a content change now mints a new version (review #5).

### HITL (human-in-the-loop)
The approval gate for consequential actions: a Step Functions `waitForTaskToken` workflow + a DynamoDB
approvals ledger + a separately-scoped executor Lambda. A human approves; the action executes once and
is audited.

### Idempotency key
A value (here, the action digest) passed to the backend so that a repeated call produces the effect
once. True end-to-end idempotency depends on the real system of record honoring it — an MVP exclusion.

### Inference profile
A Bedrock construct that routes a model call (e.g. cross-region). The runtime's model may be a
cross-region inference profile, which is why IAM grants are scoped to both foundation-model and
inference-profile ARNs.

### Interceptor
A Gateway REQUEST hook (Lambda) that runs per call before authorization: hard block, model allowlist by
group, rate limit. Writes a per-user ledger row.

### JWT (JSON Web Token) / Bearer
The signed token format the identity provider issues. Sent as `Authorization: Bearer <token>` to the
Runtime/Gateway. The Runtime is JWT-authorized — a SigV4 `invoke-agent-runtime` is *rejected*.

### Kill switch
An incident control that creates a forbid-all Cedar policy to block every tool call at the Gateway. It
only reports `engaged` after confirming the policy is active (fail-closed), and `release` only reports
success after confirming the policy is gone.

### Manifest (use-case manifest)
`use-cases/<name>/manifest.yaml` — declares the agent's tools, groups, model, and consequential action.
CDK compiles it into gateway targets + tool-scoped Cedar + the runtime model/prompt. The source of
truth for a use case; `render.py` is a reference compiler for inspecting the output.

### MCP (Model Context Protocol)
The protocol the agent uses to call tools through the Gateway (`tools/call`). Each tool maps to a
Gateway target (a Lambda).

### OAM (CloudWatch Observability Access Manager)
Cross-account observability sharing — a spoke links its telemetry to a hub's OAM sink. Gated to
spoke/hub modes.

### SCP (Service Control Policy)
An AWS Organizations guardrail that caps what principals in an account/OU may do. Org mode uses SCPs
for the inference perimeter and control-plane integrity, with the deployer role exempted.

### SigV4
AWS's request-signing auth (what most CLI calls use). Note: the AgentCore Runtime does **not** accept
SigV4 — it wants a Bearer JWT. SigV4 is used for the control-plane calls (SSM, DynamoDB, Lambda, etc.).

### StackSet
A CloudFormation mechanism to deploy the same stack across many accounts/regions — used in org mode for
Guard hooks. Runs `callAs SELF` or `DELEGATED_ADMIN`.

### Standalone / spoke / hub / org
The four deploy modes (see CONCEPTS). Standalone = one-account MVP; spoke = workload account; hub =
governance account; org = management/delegated-admin enforcement.

### Strands
The Python agent framework (`strands-agents`) the reference harness is built on. The agent code lives
in `use-cases/_harness/agent.py`.

### Transaction Search
A CloudWatch feature (via `AWS::XRay::TransactionSearchConfig`) used for AgentCore observability
indexing. Off in the minimal profile.

### WORM (write-once-read-many)
Tamper-resistant storage. The evidence/log bucket uses S3 Object Lock so audit records can't be altered
or deleted within the retention window — which is also why teardown must empty it with a governance
bypass before the bucket can be removed.
