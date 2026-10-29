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


def handler(event, _context):
    digest = event["actionDigest"]
    target = TARGET_ARN
    approver = event.get("approver", "unknown")

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

    # Perform the consequential action against the configured target Lambda (the system of record /
    # use-case submit tool). No target configured -> record only (safe no-op).
    result = {"executed": False, "note": "no execution target configured"}
    if target:
        # The gateway tool Lambda reads the tool name from the Lambda client context
        # (bedrockAgentCoreToolName) and the arguments from the event body — mirror that contract so
        # the executor's direct invoke matches a normal gateway invocation.
        client_context = base64.b64encode(
            json.dumps({"custom": {"bedrockAgentCoreToolName": event["action"]}}).encode()
        ).decode()
        resp = lam.invoke(
            FunctionName=target,
            Payload=json.dumps(event.get("args", {})).encode(),
            ClientContext=client_context,
        )
        body = resp.get("Payload")
        payload = json.loads(body.read() or b"{}") if body else {}
        result = {"executed": True, "payload": payload}

    ddb.update_item(
        TableName=TABLE,
        Key={"pk": {"S": digest}},
        UpdateExpression="SET #s = :done, #r = :result",
        ExpressionAttributeNames={"#s": "status", "#r": "result"},
        ExpressionAttributeValues={":done": {"S": "COMPLETED"}, ":result": {"S": json.dumps(result)[:3500]}},
    )
    return {"status": "completed", "actionDigest": digest, "approver": approver, **result}
