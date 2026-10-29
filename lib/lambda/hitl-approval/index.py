"""HITL approval callback. An authorized approver invokes this (via console, CLI, or a wired UI/API)
with the task token captured in the approval SNS message to resolve a waiting Step Functions
execution. The approver identity is bound into the task output so the executor records WHO approved.

Event: {"taskToken": "...", "decision": "approve"|"reject", "approver": "<id>", "reason": "..."?}

The approver should be a verified identity (e.g. from the invoking principal / an authenticated UI),
distinct from the agent and from the action's actor — this Lambda records it but does not itself
authenticate; wire it behind an authenticated channel (API Gateway authorizer / console IAM).
"""
import datetime
import json

import boto3

sfn = boto3.client("stepfunctions")


def handler(event, _context):
    token = event["taskToken"]
    decision = event.get("decision", "reject")
    approver = event.get("approver") or "unspecified-approver"
    if decision == "approve":
        sfn.send_task_success(
            taskToken=token,
            output=json.dumps(
                {
                    "approved": True,
                    "approver": approver,
                    "approvedAt": datetime.datetime.utcnow().isoformat() + "Z",
                }
            ),
        )
    else:
        sfn.send_task_failure(
            taskToken=token,
            error="Rejected",
            cause=json.dumps({"approver": approver, "reason": event.get("reason", "Rejected by approver")}),
        )
    return {"status": decision, "approver": approver}
