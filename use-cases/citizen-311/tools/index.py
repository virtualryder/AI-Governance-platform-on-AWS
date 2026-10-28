"""Citizen 311 tool Lambda (gateway target `svc311`) — reference implementation.

AgentCore Gateway invokes this Lambda for each MCP tool call routed to the svc311 target. The tool
name arrives in the Lambda client context (context.client_context.custom['bedrockAgentCoreToolName']);
the tool arguments arrive as the event. Returns a plain dict the gateway serializes back to the agent.

These are canned/representative responses so the governed workflow is demonstrable end-to-end without a
real system of record. `submit_service_request` is present for completeness but is forbidden to the
agent by Cedar (c311_no_self_submit) — only the human sign-off gate may invoke it.
"""
import json

CATALOG = [
    {"category": "pothole", "fields": ["address", "severity"]},
    {"category": "streetlight-out", "fields": ["address", "pole_id"]},
    {"category": "illegal-dumping", "fields": ["address", "description"]},
    {"category": "noise-complaint", "fields": ["address", "time_of_day"]},
]


def _tool_name(context):
    try:
        return (context.client_context.custom or {}).get("bedrockAgentCoreToolName", "")
    except Exception:
        return ""


def handler(event, context):
    tool = _tool_name(context)
    args = event if isinstance(event, dict) else json.loads(event or "{}")

    if tool.endswith("lookup_service_catalog"):
        return {"categories": CATALOG}
    if tool.endswith("classify_request"):
        text = (args.get("text") or "").lower()
        category = next((c["category"] for c in CATALOG if c["category"].split("-")[0] in text), "other")
        return {"category": category, "confidence": 0.8 if category != "other" else 0.3}
    if tool.endswith("validate_address"):
        return {"normalized_address": (args.get("address") or "").strip().title(), "in_jurisdiction": True}
    if tool.endswith("check_duplicate"):
        return {"duplicate": False, "open_request_id": None}
    if tool.endswith("submit_service_request"):
        # Reached only via the human sign-off gate (Cedar forbids the agent from calling this).
        return {"request_id": "SR-DEMO-0001", "status": "submitted", "category": args.get("category")}

    return {"error": "unknown tool", "tool": tool}
