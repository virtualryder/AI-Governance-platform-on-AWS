"""SRA-style detective AWS Config custom rule for the governed-AI platform.

One Lambda backs multiple Config rules; it branches on the invoking rule name (ScheduledNotification):
  - govai-detect-invocation-logging : Bedrock model-invocation logging is configured in this account
  - govai-detect-guardrails-present : at least one Bedrock guardrail exists in this account
Reports COMPLIANT / NON_COMPLIANT on the account resource via config:PutEvaluations.
"""
import datetime
import json
import os

import boto3

config = boto3.client("config")
bedrock = boto3.client("bedrock")
ACCOUNT = os.environ.get("ACCOUNT_ID", "")


def _invocation_logging_compliant():
    cfg = bedrock.get_model_invocation_logging_configuration().get("loggingConfig")
    return bool(cfg)


def _guardrails_compliant():
    return len(bedrock.list_guardrails().get("guardrails", [])) > 0


CHECKS = {
    "invocation-logging": _invocation_logging_compliant,
    "guardrails-present": _guardrails_compliant,
}


def handler(event, _context):
    rule_name = event.get("configRuleName", "")
    check = next((fn for key, fn in CHECKS.items() if key in rule_name), None)
    try:
        compliant = check() if check else False
    except Exception:
        compliant = False
    config.put_evaluations(
        Evaluations=[
            {
                "ComplianceResourceType": "AWS::::Account",
                "ComplianceResourceId": ACCOUNT,
                "ComplianceType": "COMPLIANT" if compliant else "NON_COMPLIANT",
                "OrderingTimestamp": datetime.datetime.utcnow(),
            }
        ],
        ResultToken=event["resultToken"],
    )
    return {"rule": rule_name, "compliant": compliant}
