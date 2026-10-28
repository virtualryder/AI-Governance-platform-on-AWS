"""Layered kill switch for the governed AgentCore platform.

Engage: attach a forbid-all Cedar policy to the gateway's policy engine (denies every tool call
across the agent graph, since Cedar `forbid` overrides every `permit`) and flip the fail-closed SSM
flag to `engaged`. Release: delete the forbid-all policy and set the flag back to `normal`.

`forbid` is restrictive, so AgentCore's automated reasoning does not reject it the way it rejects a
blanket permit. API parameter shapes are validated on first invocation (this Lambda deploys fine
regardless); adjust here if an engage call surfaces a parameter error.
"""
import os
import boto3

ssm = boto3.client("ssm")
acc = boto3.client("bedrock-agentcore-control")

PREFIX = os.environ["PARAM_PREFIX"]
KILL_NAME = os.environ.get("KILL_POLICY_NAME", "govai_killswitch_forbid_all")


def _param(name):
    return ssm.get_parameter(Name=f"{PREFIX}/{name}")["Parameter"]["Value"]


def _set_flag(state):
    ssm.put_parameter(
        Name=f"{PREFIX}/controls/kill-switch-state", Value=state, Type="String", Overwrite=True
    )


def handler(event, _context):
    action = (event or {}).get("action", "engage")
    engine_arn = _param("agent-platform/policy-engine-arn")
    engine_id = engine_arn.split("policy-engine/")[-1]
    gateway_arn = _param("agent-platform/gateway-arn")

    if action == "engage":
        statement = f'forbid(principal, action, resource == AgentCore::Gateway::"{gateway_arn}");'
        try:
            acc.create_policy(
                policyEngineId=engine_id,
                name=KILL_NAME,
                description="Kill switch: forbid all tool calls on this gateway.",
                definition={"cedar": {"statement": statement}},
                enforcementMode="ACTIVE",
            )
        except acc.exceptions.ConflictException:
            pass  # already engaged
        _set_flag("engaged")
        return {"status": "engaged", "gateway": gateway_arn}

    # release
    for policy in acc.list_policies(policyEngineId=engine_id).get("items", []):
        if policy.get("name") == KILL_NAME:
            acc.delete_policy(policyEngineId=engine_id, policyId=policy["policyId"])
    _set_flag("normal")
    return {"status": "released", "gateway": gateway_arn}
