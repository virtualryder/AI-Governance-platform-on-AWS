"""Per-user Gateway REQUEST interceptor for governed AgentCore.

AgentCore Gateway invokes this before routing each MCP tool call. Input (grounded against AWS docs):
  {"interceptorInputVersion":"1.0","mcp":{"gatewayRequest":{"headers":{...},"body":{jsonrpc,id,method,params}}}}
The inbound JWT is in gatewayRequest.headers.Authorization (requires passRequestHeaders=true on the
interceptor config). Identity (sub) and entitlements (cognito:groups) come from the JWT claims.

Stages (per PORT-MAP sample-per-user-governance): block -> model allowlist by group -> per-user rate
limit (token bucket in DynamoDB). Token/USD budgets + auto-downgrade are RESPONSE-side extensions
(they need the tool/model usage counts in the response) and are noted for slice-2b.

OUTPUT envelope (grounded against AWS docs): every response carries interceptorOutputVersion "1.0".
Allow/passthrough returns mcp.transformedGatewayRequest (the possibly-modified request); deny returns
mcp.transformedGatewayResponse (the gateway replies with it immediately).
"""
import base64
import json
import os
import time

import boto3

ddb = boto3.client("dynamodb")

TABLE = os.environ["LEDGER_TABLE"]
RATE_PER_MINUTE = int(os.environ.get("RATE_PER_MINUTE", "0"))  # 0 = disabled
ALLOWED_BY_GROUP = json.loads(os.environ.get("ALLOWED_MODELS_BY_GROUP", "{}"))


def _claims(headers):
    auth = ""
    for key, value in (headers or {}).items():
        if key.lower() == "authorization":
            auth = value
    token = auth.split(" ")[-1] if auth else ""
    parts = token.split(".")
    if len(parts) < 2:
        return {}
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload))
    except Exception:
        return {}


def _deny(req_id, message):
    # transformedGatewayResponse short-circuits the gateway with this reply (deny-by-interceptor).
    return {
        "interceptorOutputVersion": "1.0",
        "mcp": {
            "transformedGatewayResponse": {
                "statusCode": 403,
                "headers": {"Content-Type": "application/json"},
                "body": {"jsonrpc": "2.0", "id": req_id, "error": {"code": -32001, "message": message}},
            }
        },
    }


def handler(event, _context):
    mcp = (event or {}).get("mcp", {})
    gateway_request = mcp.get("gatewayRequest", {})
    body = gateway_request.get("body", {}) or {}
    req_id = body.get("id", 1)
    claims = _claims(gateway_request.get("headers"))
    sub = claims.get("sub", "anonymous")
    groups = claims.get("cognito:groups", []) or []
    now = int(time.time())

    # 1. Explicit per-user block (set an item USER#<sub> / BLOCK to deny).
    blocked = ddb.get_item(
        TableName=TABLE, Key={"pk": {"S": f"USER#{sub}"}, "sk": {"S": "BLOCK"}}
    ).get("Item")
    if blocked:
        return _deny(req_id, "User is blocked by governance policy.")

    # 2. Model allowlist by Cognito group — only on actual tool calls (let initialize/tools/list pass).
    if ALLOWED_BY_GROUP and body.get("method") == "tools/call":
        allowed = {m for g in groups for m in ALLOWED_BY_GROUP.get(g, [])}
        requested = json.dumps(body.get("params", {}))
        if allowed and not any(fam in requested for fam in allowed):
            # Only enforce when the group has an explicit allowlist and none matched.
            if any(g in ALLOWED_BY_GROUP for g in groups):
                return _deny(req_id, "Requested model is not permitted for your group.")

    # 3. Per-user request rate limit (fixed-minute window token bucket).
    if RATE_PER_MINUTE > 0:
        minute = now // 60
        result = ddb.update_item(
            TableName=TABLE,
            Key={"pk": {"S": f"USER#{sub}"}, "sk": {"S": f"RPM#{minute}"}},
            UpdateExpression="ADD #c :one SET #ttl = :ttl",
            ExpressionAttributeNames={"#c": "count", "#ttl": "ttl"},
            ExpressionAttributeValues={":one": {"N": "1"}, ":ttl": {"N": str(now + 120)}},
            ReturnValues="UPDATED_NEW",
        )
        if int(result["Attributes"]["count"]["N"]) > RATE_PER_MINUTE:
            return _deny(req_id, "Per-user rate limit exceeded. Try again shortly.")

    # Allow: pass the request through unchanged (transformedGatewayRequest carries the request body).
    return {"interceptorOutputVersion": "1.0", "mcp": {"transformedGatewayRequest": {"body": body}}}
