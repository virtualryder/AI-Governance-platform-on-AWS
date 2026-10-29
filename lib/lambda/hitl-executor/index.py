"""HITL post-approval executor (F05).

Performs the approved consequential action EXACTLY ONCE, through a role separate from the agent (the
agent is Cedar-forbidden from the action — separation of duties). Invoked by the approval state
machine only after a human approves. Idempotency/replay protection: it claims the approval record
(PENDING -> EXECUTING) with a conditional update; if the claim fails the action was already run, so it
does not execute again.

Input: {actionDigest, action, args, actor, approver, approvedAt, caseId, targetArn}
"""
import base64
import json
import os

import boto3

ddb = boto3.client("dynamodb")
lam = boto3.client("lambda")

TABLE = os.environ["APPROVALS_TABLE"]
# The single, configured execution target (use-case submit tool Lambda). The AGENT cannot influence
# this — it is wired by the platform, not supplied in the execution input. Empty => record-only.
TARGET_ARN = os.environ.get("TARGET_ARN", "")
# The platform-pinned consequential tool name. The executor uses THIS, not event["action"] — the
# runtime can start an execution with any input, so the tool to invoke must not come from the input
# (review #4). Falls back to the input action only if unset (legacy).
CONSEQUENTIAL_TOOL = os.environ.get("CONSEQUENTIAL_TOOL", "")


def handler(event, _context):
    digest = event["actionDigest"]
    target = TARGET_ARN
    approver = event.get("approver", "unknown")
    actor = event.get("actor", "")
    tool = CONSEQUENTIAL_TOOL or event.get("action", "")

    # Separation of duties (review #3): the approver must not be the actor who proposed the action.
    if approver and actor and approver == actor:
        _set_status(digest, "REJECTED", {"executed": False, "error": "self_approval_forbidden", "actor": actor})
        return {"status": "rejected", "actionDigest": digest, "executed": False, "error": "self_approval_forbidden"}

    # Claim the action: PENDING -> EXECUTING. Fails if it is not PENDING (already executing/completed),
    # which is the exactly-once / replay guard.
    try:
        ddb.update_item(
            TableName=TABLE,
            Key={"pk": {"S": digest}},
            UpdateExpression="SET #s = :executing, approver = :approver, approvedAt = :at",
            ConditionExpression="attribute_exists(pk) AND #s = :pending",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={
                ":executing": {"S": "EXECUTING"},
                ":pending": {"S": "PENDING"},
                ":approver": {"S": approver},
                ":at": {"S": event.get("approvedAt", "")},
            },
        )
    except ddb.exceptions.ConditionalCheckFailedException:
        return {"status": "already_handled", "actionDigest": digest, "executed": False}

    # No target configured -> record-only completion (safe no-op, nothing executed).
    if not target:
        _set_status(digest, "COMPLETED", {"executed": False, "note": "no execution target configured"})
        return {"status": "completed", "actionDigest": digest, "approver": approver, "executed": False}

    # Perform the consequential action against the configured target Lambda. The gateway tool Lambda
    # reads the tool name from the Lambda client context and the args from the body; mirror that, and
    # pass a stable idempotency key (the action digest) so a REAL backend can dedupe.
    client_context = base64.b64encode(
        json.dumps({"custom": {"bedrockAgentCoreToolName": tool, "idempotencyKey": digest}}).encode()
    ).decode()
    try:
        resp = lam.invoke(
            FunctionName=target,
            Payload=json.dumps({**event.get("args", {}), "idempotencyKey": digest}).encode(),
            ClientContext=client_context,
        )
    except Exception as exc:  # transport failure AFTER claiming -> outcome UNKNOWN, needs reconciliation
        _set_status(digest, "UNKNOWN", {"executed": False, "error": "invoke_transport_failure", "detail": str(exc)[:300]})
        raise RuntimeError("HITL executor transport failure; outcome UNKNOWN (reconcile via backend idempotency key %s)" % digest)

    # Distinguish invocation transport from function success: a Lambda FunctionError (or an
    # application-level error in the tool's result) means the business action did NOT succeed (B3b).
    body = resp.get("Payload")
    payload = json.loads(body.read() or b"{}") if body else {}
    function_error = resp.get("FunctionError")
    app_error = isinstance(payload, dict) and payload.get("error")
    if function_error or app_error:
        _set_status(digest, "FAILED", {"executed": False, "functionError": function_error, "payload": payload})
        return {
            "status": "failed",
            "actionDigest": digest,
            "approver": approver,
            "executed": False,
            "functionError": function_error,
            "payload": payload,
        }

    _set_status(digest, "COMPLETED", {"executed": True, "payload": payload})
    return {"status": "completed", "actionDigest": digest, "approver": approver, "executed": True, "payload": payload}


def _set_status(digest, status, result):
    ddb.update_item(
        TableName=TABLE,
        Key={"pk": {"S": digest}},
        UpdateExpression="SET #s = :s, #r = :result",
        ExpressionAttributeNames={"#s": "status", "#r": "result"},
        ExpressionAttributeValues={":s": {"S": status}, ":result": {"S": json.dumps(result)[:3500]}},
    )
