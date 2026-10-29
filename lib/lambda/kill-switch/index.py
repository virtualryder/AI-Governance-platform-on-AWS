"""Layered kill switch for the governed AgentCore platform.

Engage: attach a forbid-all Cedar policy to the gateway's policy engine (denies every tool call
across the agent graph, since Cedar `forbid` overrides every `permit`) and flip the fail-closed SSM
flag to `engaged`. Release: delete the forbid-all policy and set the flag back to `normal` — but ONLY
after confirming the policy is actually gone (the release must never report success while the deny is
still attached).

`forbid` is restrictive, so AgentCore's automated reasoning does not reject it the way it rejects a
blanket permit.

Contract notes (grounded against AWS docs, 2026-10-29):
- `ListPolicies` returns the list under `policies` (NOT `items`) and is paginated via `nextToken`.
- Only two actions are valid: `engage` and `release`. An unknown/missing action is rejected — it must
  never fall through to release (which would silently clear the deny).
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


def _iter_policies(engine_id):
    """Yield every policy on the engine, following pagination."""
    token = None
    while True:
        kwargs = {"policyEngineId": engine_id}
        if token:
            kwargs["nextToken"] = token
        resp = acc.list_policies(**kwargs)
        # AWS returns the list under `policies`; tolerate `items` only as a defensive fallback.
        for policy in resp.get("policies", resp.get("items", [])):
            yield policy
        token = resp.get("nextToken")
        if not token:
            break


def _kill_policy_ids(engine_id):
    return [
        p["policyId"]
        for p in _iter_policies(engine_id)
        if p.get("name") == KILL_NAME and p.get("policyId")
    ]


def handler(event, _context):
    action = (event or {}).get("action", "engage")
    if action not in ("engage", "release"):
        # Fail closed: never let an unknown action drop into the release path.
        raise ValueError(f"Unknown kill-switch action {action!r}; expected 'engage' or 'release'.")

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

    # release — delete every kill policy, then VERIFY none remain before flipping the flag.
    deleted = []
    for policy_id in _kill_policy_ids(engine_id):
        acc.delete_policy(policyEngineId=engine_id, policyId=policy_id)
        deleted.append(policy_id)

    remaining = _kill_policy_ids(engine_id)
    if remaining:
        # Still attached — do NOT report released or flip SSM to normal.
        raise RuntimeError(
            f"Kill-switch release failed: {len(remaining)} forbid policy(ies) still attached "
            f"({remaining}); leaving state=engaged."
        )

    _set_flag("normal")
    return {"status": "released", "gateway": gateway_arn, "deletedPolicies": deleted}
