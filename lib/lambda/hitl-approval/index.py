"""HITL approval callback. An approver invokes this (via console, CLI, or a wired UI/API) with the
task token captured in the approval SNS message to resolve a waiting Step Functions execution.

Event: {"taskToken": "...", "decision": "approve"|"reject", "output": {...}?, "reason": "..."?}
"""
import json
import boto3

sfn = boto3.client("stepfunctions")


def handler(event, _context):
    token = event["taskToken"]
    decision = event.get("decision", "reject")
    if decision == "approve":
        sfn.send_task_success(taskToken=token, output=json.dumps(event.get("output", {"approved": True})))
    else:
        sfn.send_task_failure(
            taskToken=token, error="Rejected", cause=event.get("reason", "Rejected by approver")
        )
    return {"status": decision}
