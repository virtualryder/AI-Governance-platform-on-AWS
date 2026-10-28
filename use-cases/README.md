# Use cases

A **use case** is a governed agent built on the platform. Each is a manifest plus its tool Lambdas;
the shared **`_harness/`** turns a manifest into a running AgentCore Runtime agent.

```
_harness/          reusable runtime (reused from governed-core, Strands-based)
  agent.py         Strands + BedrockAgentCoreApp; MCP over the governed gateway with the human's JWT
  render.py        manifest -> gateway targets + Cedar policies (by Cognito group) + guardrail + prompt
  Dockerfile       ARM64, pinned base by digest, non-root, opentelemetry-instrument (AgentCore Observability)
  requirements.txt pinned Strands / bedrock-agentcore / mcp / ADOT
  _obs_setup.sh    Transaction Search / ADOT observability bootstrap
citizen-311/       first use case: SLG 311 service-request intake
  manifest.yaml    agent, identity, tools, workflow, Cedar policies, guardrail
  tools/index.py   svc311 tool Lambda (reference implementation)
```

## How the harness relates to the platform

The CDK stacks (`lib/`) stand up the **governed platform** — baseline, gateway + Cedar policy engine,
controls — independent of any use case. A use case adds three things on top:

1. **Tool Lambdas** (e.g. `citizen-311/tools/`) — the agent's domain tools.
2. **A manifest** — compiled by `render.py` into the gateway **targets** (MCP tool schemas), the
   **Cedar policies** (permit by Cognito group + forbid the consequential action), and the runtime
   **workflow prompt**.
3. **A Runtime container image** — built from `_harness/` with the compiled prompt baked in as env.

## End-to-end flow

```bash
# 1. Compile the manifest (targets, Cedar, guardrail, prompt)
python use-cases/_harness/render.py use-cases/citizen-311/manifest.yaml build/citizen-311

# 2. Build + push the agent image to ECR (Runtime is ARM64)
docker build -t <acct>.dkr.ecr.<region>.amazonaws.com/citizen-311:latest \
  --platform linux/arm64 use-cases/_harness
docker push <acct>.dkr.ecr.<region>.amazonaws.com/citizen-311:latest

# 3. Point the platform at the image, then deploy — this activates AgentCore Runtime
#    config: agentcore.runtimeImageUri = <that image URI>
npx cdk deploy --all -c mode=standalone -c configFile=config/<customer>.json --profile <target>
```

The rendered **targets** are attached to the gateway and the **Cedar policies** to the policy engine
(the platform's gateway is created in `LOG_ONLY` first; flip `agentcore.cedarMode` to `ENFORCE` once
the per-tool policies validate). The agent authenticates the human and forwards their **access token**
as the bearer on every MCP call, so Cedar evaluates the real human principal — and the agent is
forbidden from calling the consequential `submit_service_request`, which the HITL sign-off gate owns.

> The harness is reused from the Aegis `governed-core` runtime. Confirm the gateway→Lambda-target
> event contract (tool name via `context.client_context`) against current AWS docs before production.
