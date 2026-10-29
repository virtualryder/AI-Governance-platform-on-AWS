"""CloudFormation custom resource for Bedrock model-invocation logging with safe ownership (F11).

Bedrock model-invocation logging is an account+Region SINGLETON. A naive Put/Delete would silently
redirect another application's logs on deploy and disable logging on teardown. This handler reads the
existing configuration first and honours an explicit ownership mode:

  create  (default) — set logging ONLY if none exists; refuse to overwrite a pre-existing config.
  adopt             — never Put or Delete; use whatever the account already has.
  manage            — take over, stashing the prior config in SSM and restoring it on Delete.

Invoked via the CDK Provider framework (returns {PhysicalResourceId, Data}); the framework writes the
CloudFormation response.
"""
import json
import os

import boto3

bedrock = boto3.client("bedrock")
ssm = boto3.client("ssm")

STASH_PREFIX = os.environ.get("STASH_PREFIX", "/governed-ai/_internal/invocation-logging")


def _existing():
    resp = bedrock.get_model_invocation_logging_configuration()
    return resp.get("loggingConfig")


def _is_ours(existing, our_log_group):
    cw = (existing or {}).get("cloudWatchConfig") or {}
    return cw.get("logGroupName") == our_log_group


def handler(event, _context):
    request_type = event["RequestType"]
    props = event["ResourceProperties"]
    our_log_group = props["LogGroupName"]
    mode = props.get("OwnershipMode", "create")
    stash = f"{STASH_PREFIX}/{props['StashKey']}"
    logging_config = json.loads(props["LoggingConfig"])
    phys = props.get("PhysicalId", "bedrock-invocation-logging")

    if request_type in ("Create", "Update"):
        if mode == "adopt":
            return {"PhysicalResourceId": phys, "Data": {"ownership": "adopt", "managed": "false"}}

        existing = _existing()
        if existing and not _is_ours(existing, our_log_group):
            if mode == "create":
                raise Exception(
                    "An existing Bedrock model-invocation logging configuration was found in this "
                    "account/Region. Refusing to overwrite it (ownership 'create'). Set "
                    "governance.invocationLoggingOwnership to 'manage' to take it over (the prior "
                    "config is restored on teardown) or 'adopt' to keep the existing configuration."
                )
            # manage: stash the prior config so Delete can restore it.
            ssm.put_parameter(Name=stash, Value=json.dumps(existing), Type="String", Overwrite=True)

        bedrock.put_model_invocation_logging_configuration(loggingConfig=logging_config)
        return {"PhysicalResourceId": phys, "Data": {"ownership": mode, "managed": "true"}}

    if request_type == "Delete":
        if mode == "adopt":
            return {"PhysicalResourceId": phys}
        # Restore a stashed prior config if we took one over; otherwise delete only if still ours.
        try:
            prior = ssm.get_parameter(Name=stash)["Parameter"]["Value"]
            bedrock.put_model_invocation_logging_configuration(loggingConfig=json.loads(prior))
            ssm.delete_parameter(Name=stash)
            return {"PhysicalResourceId": phys}
        except ssm.exceptions.ParameterNotFound:
            pass
        if _is_ours(_existing(), our_log_group):
            bedrock.delete_model_invocation_logging_configuration()
        return {"PhysicalResourceId": phys}

    return {"PhysicalResourceId": phys}
