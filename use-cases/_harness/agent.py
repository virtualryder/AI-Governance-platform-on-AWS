"""Generic governed intake agent — runs natively on Amazon Bedrock AgentCore Runtime.

Reusable across agents: the workflow prompt, model, and gateway discovery all come from the manifest
(passed in as env vars by the launch step). Identity: the human authenticates and their ACCESS token
is the bearer for every governed Gateway (MCP) tool call, so Cedar evaluates the real human principal.
The agent never commits the consequential action; it requests human sign-off (separation of duties).
"""
import base64
import datetime
import hashlib
import json
import os
import logging
import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient
from mcp.client.streamable_http import streamablehttp_client

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s agent %(message)s")
log = logging.getLogger("agent")

app = BedrockAgentCoreApp()

MODEL_ID = os.environ.get("MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")
REGION = os.environ.get("AWS_REGION", "us-east-1")
# Approved guardrail pinned by the platform baseline (passed in by the AgentPlatform stack).
GUARDRAIL_ID = os.environ.get("GUARDRAIL_ID", "")
GUARDRAIL_VERSION = os.environ.get("GUARDRAIL_VERSION", "")
# Human-in-the-loop: the consequential action is performed only after approval, via the state machine.
HITL_SM_ARN = os.environ.get("HITL_STATE_MACHINE_ARN", "")
CONSEQUENTIAL_ACTION = os.environ.get("CONSEQUENTIAL_ACTION", "submit_service_request")
GATEWAY_URL_ENV = os.environ.get("GATEWAY_URL", "")
GATEWAY_SSM_PARAM = os.environ.get("GATEWAY_SSM_PARAM", "")
# Multi-agent (A2A) config, passed in by the AgentPlatform stack. Orchestration is OFF unless enabled.
# NOTE: implemented but NOT live-validated — it needs a second deployed collaborator agent to invoke.
try:
    MULTI_AGENT = json.loads(os.environ.get("MULTI_AGENT", "{}"))
except Exception:
    MULTI_AGENT = {}
WORKLOAD_IDENTITY_ARN = os.environ.get("WORKLOAD_IDENTITY_ARN", "")
MEMORY_ID = os.environ.get("MEMORY_ID", "")


def _save_memory(subject, case_id, correlation_id, summary):
    """Persist a case-outcome event to AgentCore Memory when a memory store is provisioned (Gate 5:
    the harness actually USES Memory, not just provisions it). Best-effort; API shape confirmed live."""
    if not MEMORY_ID:
        return
    try:
        boto3.client("bedrock-agentcore", region_name=REGION).create_event(
            memoryId=MEMORY_ID,
            actorId=subject,
            sessionId=correlation_id,
            # eventTimestamp is REQUIRED by the CreateEvent request model (its omission was a defect).
            eventTimestamp=datetime.datetime.now(datetime.timezone.utc),
            payload=[{"conversational": {"role": "ASSISTANT", "content": {"text": summary[:4000]}}}],
        )
        log.info("memory_event_saved case_id=%s", case_id)
    except Exception as exc:
        log.info("memory save skipped/failed (non-fatal): %s", exc)


def _collaborator_tools(subject, case_id, correlation_id, user_token):
    """Build one delegation tool per remote collaborator (supervisor orchestration). Each tool invokes
    the collaborator's AgentCore Runtime, exchanges an OBO token when the collaborator requires it, and
    propagates the correlation id so the whole case is one auditable chain. Cedar governs the invoked
    agent's TOOLS at its own gateway — this only authorizes the A2A invoke.

    API parameter/response shapes for InvokeAgentRuntime / GetWorkloadAccessToken are newer and must be
    confirmed against the live SDK; this path is implemented but not yet live-validated."""
    if not MULTI_AGENT.get("enabled"):
        return []
    collaborators = MULTI_AGENT.get("remoteCollaborators") or []
    acc = boto3.client("bedrock-agentcore", region_name=REGION)
    tools = []
    for collab in collaborators:
        name = collab.get("name")
        runtime_arn = collab.get("runtimeArn")
        if not name or not runtime_arn:
            continue

        def _make(collab=collab, name=name, runtime_arn=runtime_arn):
            @tool(name="invoke_%s" % name)
            def _invoke(task: str) -> dict:
                """Delegate a subtask to the %s collaborator agent; returns its result.""" % name
                payload = {"prompt": task, "correlation_id": correlation_id, "case_id": case_id, "delegated_by": subject}
                if collab.get("auth") == "obo" and user_token and WORKLOAD_IDENTITY_ARN:
                    try:
                        wat = acc.get_workload_access_token(
                            workloadIdentityArn=WORKLOAD_IDENTITY_ARN, userToken=user_token
                        )
                        payload["access_token"] = wat.get("workloadAccessToken") or wat.get("accessToken")
                    except Exception as exc:
                        log.warning("OBO token exchange failed for %s: %s", name, exc)
                try:
                    resp = acc.invoke_agent_runtime(
                        agentRuntimeArn=runtime_arn,
                        runtimeSessionId=correlation_id,
                        contentType="application/json",
                        accept="application/json",
                        payload=json.dumps(payload).encode(),
                    )
                    body = resp.get("response")
                    return json.loads(body.read()) if body else {"status": "no_response"}
                except Exception as exc:
                    log.warning("A2A invoke of %s failed: %s", name, exc)
                    return {"error": "collaborator_invoke_failed", "collaborator": name, "detail": str(exc)[:200]}

            return _invoke

        tools.append(_make())
    return tools


def _publish_registry_record():
    """Publish this agent's discovery record (draft) so collaborators can find it (H3). Best-effort;
    not live-validated."""
    if not MULTI_AGENT.get("publishToRegistry"):
        return
    try:
        boto3.client("bedrock-agentcore", region_name=REGION).create_registry_record(
            description="Governed agent (auto-published at startup).",
        )
    except Exception as exc:
        log.info("registry publish skipped/failed (non-fatal): %s", exc)

# The governed workflow prompt is manifest-driven (passed via --env at launch). Fallback below keeps
# the agent safe/generic if it is missing.
SYSTEM = os.environ.get("SYSTEM_PROMPT") or (
    "You are an intake agent running under strict governance on Amazon Bedrock AgentCore. Your tools "
    "are exposed via a governed gateway; every call is authorized by policy against the human identity "
    "you act for. Use the available tools in a sensible order, never commit a consequential submission "
    "directly (that is owned by the human sign-off gate), and if any tool is denied by policy, STOP and "
    "report exactly which control blocked you. End with a short summary and the sign-off status."
)


def _gateway_url():
    if GATEWAY_SSM_PARAM:
        try:
            p = boto3.client("ssm", region_name=REGION).get_parameter(Name=GATEWAY_SSM_PARAM)
            log.info("gateway_url source=SSM param=%s", GATEWAY_SSM_PARAM)
            return p["Parameter"]["Value"]
        except Exception as exc:
            log.warning("SSM gateway lookup failed (%s); falling back to GATEWAY_URL env", type(exc).__name__)
    return GATEWAY_URL_ENV


def _identity_from_token(token):
    """Derive the audit identity from the verified JWT claims — NOT from caller-supplied payload
    labels (which are untrusted). Returns (subject, display) from sub / email / username claims."""
    parts = (token or "").split(".")
    if len(parts) < 2:
        return "", ""
    pad = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(pad))
    except Exception:
        return "", ""
    subject = claims.get("sub", "")
    display = claims.get("email") or claims.get("cognito:username") or claims.get("username") or subject
    return subject, display


@app.entrypoint
def invoke(payload, context=None):
    p = payload or {}
    token = p.get("access_token") or ""
    case_id = p.get("case_id") or p.get("icsr_id") or "CASE-0001"
    if not token:
        return {"error": "no access_token provided; a human identity is required to drive governed tools"}

    # Audit identity comes from the token, not the payload. A caller-supplied "requester" is only a
    # display hint and must never override the authenticated subject for audit/attribution.
    subject, display = _identity_from_token(token)
    if not subject:
        return {"error": "access_token is not a decodable JWT; a verified human identity is required"}
    requester = display
    # A correlation id threads this case across A2A hops and traces (propagated to collaborators).
    correlation_id = p.get("correlation_id") or ("case-%s-%s" % (case_id, subject[:8])).replace(" ", "-")
    prompt = p.get("prompt") or (
        "Process the intake for case %s (requester %s). Run the governed workflow end to end and "
        "request human sign-off with the case id and requester." % (case_id, requester)
    )
    log.info(
        "invocation subject=%s requester=%s case_id=%s corr=%s token_present=%s multi_agent=%s",
        subject, requester, case_id, correlation_id, bool(token), bool(MULTI_AGENT.get("enabled")),
    )
    _publish_registry_record()

    gw = _gateway_url()
    if not gw:
        return {"error": "gateway URL not available (SSM and env both empty)"}

    # Apply the approved guardrail/version to every model call. The runtime role denies ungoverned
    # inference (Null bedrock:GuardrailIdentifier), so the guardrail must be attached here or inference
    # fails closed — demonstrating that governance is enforced, not merely provisioned.
    model_kwargs = {"model_id": MODEL_ID, "region_name": REGION, "temperature": 0.2}
    if GUARDRAIL_ID:
        model_kwargs["guardrail_id"] = GUARDRAIL_ID
        if GUARDRAIL_VERSION:
            model_kwargs["guardrail_version"] = GUARDRAIL_VERSION
    model = BedrockModel(**model_kwargs)
    mcp_client = MCPClient(lambda: streamablehttp_client(gw, headers={"Authorization": "Bearer %s" % token}))
    with mcp_client:
        tools = mcp_client.list_tools_sync()
        names = [getattr(t, "tool_name", str(t)) for t in tools]
        log.info("authorized_tools requester=%s count=%d names=%s", requester, len(names), names)
        if not tools:
            log.warning("ACCESS DENIED requester=%s (no authorized tools)", requester)
            return {
                "result": "ACCESS DENIED - your identity is not authorized for any governed tool at the "
                          "gateway (Cedar deny-by-default). No workflow was run and nothing was drafted, "
                          "masked, audited, or submitted.",
                "tools_available": [], "governed": True,
            }
        @tool
        def request_human_signoff(category: str, address: str, details: str = "") -> dict:
            """Request human sign-off to file the 311 service request (the consequential action the
            agent is NOT permitted to perform directly). Starts the approval workflow; a human
            approver must approve before anything is filed. Returns the pending approval id."""
            if not HITL_SM_ARN:
                return {"status": "no_hitl_configured", "note": "approval gate not deployed"}
            args = {"category": category, "address": address, "details": details}
            digest = hashlib.sha256(
                json.dumps({"action": CONSEQUENTIAL_ACTION, "args": args, "case": case_id}, sort_keys=True).encode()
            ).hexdigest()
            resp = boto3.client("stepfunctions", region_name=REGION).start_execution(
                stateMachineArn=HITL_SM_ARN,
                input=json.dumps(
                    {
                        "actionDigest": digest,
                        "action": CONSEQUENTIAL_ACTION,
                        "args": args,
                        "actor": subject,
                        "caseId": case_id,
                    }
                ),
            )
            log.info("hitl_signoff_requested actor=%s case=%s digest=%s", subject, case_id, digest[:12])
            return {"status": "pending_approval", "executionArn": resp["executionArn"], "actionDigest": digest}

        # Supervisor orchestration (Gate 5): add a delegation tool per remote collaborator so the agent
        # can hand subtasks to other governed agents (A2A). Empty unless multiAgent.enabled.
        collab_tools = _collaborator_tools(subject, case_id, correlation_id, token)
        agent = Agent(model=model, tools=tools + [request_human_signoff] + collab_tools, system_prompt=SYSTEM)
        result = agent(prompt)
    log.info("invocation_complete requester=%s case_id=%s result_chars=%d", requester, case_id, len(str(result)))
    _save_memory(subject, case_id, correlation_id, str(result))
    return {"result": str(result), "tools_available": names}


if __name__ == "__main__":
    app.run()
