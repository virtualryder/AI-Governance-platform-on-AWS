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
# (review #4). If a target is configured but this is unset, the executor REFUSES (never falls back to
# the input action — review #3 follow-up).
CONSEQUENTIAL_TOOL = os.environ.get("CONSEQUENTIAL_TOOL", "")


def handler(event, _context):
    digest = event["actionDigest"]
    target = TARGET_ARN
    approver = event.get("approver", "unknown")
    actor = event.get("actor", "")
    tool = CONSEQUENTIAL_TOOL

    # Claim the action FIRST: PENDING -> EXECUTING. This is the exactly-once / replay guard AND it is
    # the audit ledger's write-guard — EVERY terminal write below happens only on a row we just
    # claimed. A replay (row already EXECUTING/COMPLETED/REJECTED/UNKNOWN) fails the condition and
    # returns here WITHOUT rewriting the record, so a prior outcome can never be clobbered (review #3b:
    # the earlier code did a self-approval REJECTED write BEFORE the claim, which overwrote terminal
    # rows on replay).
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

    # Defensive self-approval check (review #3). NOTE: this is NOT yet enforced separation of duties —
    # `approver` is still free text while `actor` is the Cognito sub, so a determined self-approver can
    # just type a different name. Authenticated approver identity is a tracked follow-up (REMEDIATION).
    # It runs AFTER the claim so this REJECTED write lands only on the row we own, never on a replay.
    if approver and actor and approver == actor:
        _set_status(digest, "REJECTED", {"executed": False, "error": "self_approval_forbidden", "actor": actor})
        return {"status": "rejected", "actionDigest": digest, "executed": False, "error": "self_approval_forbidden"}

    # Fail closed if we would invoke but the platform tool name is not pinned: the tool must come from
    # config, never from the SM input, so an unset CONSEQUENTIAL_TOOL is a misconfiguration, not a
    # licence to trust event["action"].
    if target and not tool:
        _set_status(digest, "FAILED", {"executed": False, "error": "consequential_tool_not_configured"})
        return {"status": "failed", "actionDigest": digest, "executed": False, "error": "consequential_tool_not_configured"}

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

    # --- Backend success contract (fail closed) -------------------------------------------------
    # The target tool Lambda MUST return a JSON object that signals success POSITIVELY with top-level
    # "ok": true (and MAY include a result). Failure is "ok": false or an error-indicator key. The
    # executor marks COMPLETED ONLY on a positive success signal — never on the mere absence of a
    # recognized error (review #4a: an unrecognized error shape, e.g. {"errorMessage": ...} with no
    # FunctionError, or {"statusCode": 500}, was previously marked successful). Anything it cannot
    # positively classify is UNKNOWN and reconcilable via the idempotency key (the action digest); it
    # never guesses success. Malformed/non-JSON responses are UNKNOWN too, not an uncaught crash that
    # would strand the row at EXECUTING (review #4b).
    function_error = resp.get("FunctionError")
    try:
        body = resp.get("Payload")
        raw = body.read() if body is not None else b""
        payload = json.loads(raw or b"{}")
    except (ValueError, TypeError, AttributeError) as exc:
        _set_status(digest, "UNKNOWN", {"executed": False, "error": "unparseable_response", "detail": str(exc)[:300]})
        raise RuntimeError(
            "HITL executor got an unparseable backend response; outcome UNKNOWN "
            "(reconcile via idempotency key %s)" % digest
        )

    # Explicit failure: the function raised (FunctionError), or returned ok:false, or carries an
    # error-indicator key. The action did NOT succeed.
    if function_error or (isinstance(payload, dict) and (payload.get("ok") is False or _has_error_indicator(payload))):
        _set_status(digest, "FAILED", {"executed": False, "functionError": function_error, "payload": payload})
        return {
            "status": "failed",
            "actionDigest": digest,
            "approver": approver,
            "executed": False,
            "functionError": function_error,
            "payload": payload,
        }

    # Positive success: a JSON object with ok:true and no error indicator.
    if isinstance(payload, dict) and payload.get("ok") is True and not _has_error_indicator(payload):
        _set_status(digest, "COMPLETED", {"executed": True, "payload": payload})
        return {"status": "completed", "actionDigest": digest, "approver": approver, "executed": True, "payload": payload}

    # Ambiguous: a response we cannot classify as success OR failure (no "ok", unexpected shape). Fail
    # CLOSED to UNKNOWN and raise — reporting COMPLETED here is exactly the false-success defect (#4a).
    _set_status(digest, "UNKNOWN", {"executed": False, "error": "unrecognized_response_shape", "payload": payload})
    raise RuntimeError(
        "HITL executor got an unrecognized backend response (no positive success signal); outcome "
        "UNKNOWN (reconcile via idempotency key %s)" % digest
    )


# Keys any of which, if present in the tool response, mean the action did not cleanly succeed. A Lambda
# that RAISES yields {"errorMessage","errorType","stackTrace"} + FunctionError; a handled error may
# return {"error": ...}. Either way we do not treat the response as success.
_ERROR_INDICATOR_KEYS = ("error", "errorMessage", "errorType")


def _has_error_indicator(payload):
    return any(k in payload for k in _ERROR_INDICATOR_KEYS)


def _set_status(digest, status, result):
    ddb.update_item(
        TableName=TABLE,
        Key={"pk": {"S": digest}},
        UpdateExpression="SET #s = :s, #r = :result",
        ExpressionAttributeNames={"#s": "status", "#r": "result"},
        ExpressionAttributeValues={":s": {"S": status}, ":result": {"S": json.dumps(result)[:3500]}},
    )
