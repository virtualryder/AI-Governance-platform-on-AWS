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
import time

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
    """Yield every policy summary on the engine, following pagination.

    Uses ListPolicySummaries (metadata only) — it does NOT decrypt customer content, so it needs no
    access to the policy-engine KMS key, unlike ListPolicies which fails with a KMS AccessDenied."""
    token = None
    while True:
        kwargs = {"policyEngineId": engine_id}
        if token:
            kwargs["nextToken"] = token
        resp = acc.list_policy_summaries(**kwargs)
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
        base = dict(
            policyEngineId=engine_id,
            name=KILL_NAME,
            description="Kill switch: forbid all tool calls on this gateway.",
            definition={"cedar": {"statement": statement}},
            # A blanket forbid trips AgentCore's automated-reasoning findings and would CREATE_FAILED
            # under default validation; IGNORE_ALL_FINDINGS lets this restrictive forbid be created
            # (same as the use-case tool-scoped policies).
            validationMode="IGNORE_ALL_FINDINGS",
        )
        try:
            # ACTIVE = the policy blocks (not just logs). Some bundled SDKs predate this parameter;
            # fall back to the default if the client rejects it (the engine still enforces ACTIVE policies).
            try:
                acc.create_policy(enforcementMode="ACTIVE", **base)
            except Exception as exc:
                if "enforcementMode" in str(exc):
                    acc.create_policy(**base)
                else:
                    raise
        except acc.exceptions.ConflictException:
            pass  # already engaged
        # Record a CONSERVATIVE incident state immediately: we are attempting containment, but must NOT
        # claim "engaged" until the forbid policy reaches a successful terminal state (ACTIVE).
        _set_flag("engaging")
        # CreatePolicy is ASYNCHRONOUS — poll until the policy is terminal. SUCCESS == READY/ACTIVE with
        # an ACTIVE enforcement mode. A CREATE_FAILED (or no usable policy / timeout) is a FAILURE: raise
        # and leave the flag conservative so no one believes a broken switch is protecting them (B4).
        ACTIVE_STATES = {"READY", "ACTIVE", "AVAILABLE"}
        status = mode = None
        for _ in range(20):
            p = next((p for p in _iter_policies(engine_id) if p.get("name") == KILL_NAME), None)
            if p:
                status, mode = p.get("status"), p.get("enforcementMode")
                if status and status != "CREATING":
                    break
            time.sleep(3)
        if status not in ACTIVE_STATES or (mode is not None and mode != "ACTIVE"):
            raise RuntimeError(
                f"Kill-switch engage did NOT reach active enforcement (policyStatus={status}, "
                f"enforcementMode={mode}); leaving state=engaging. Containment is NOT confirmed — "
                "verify with a real tool request and retry or escalate."
            )
        _set_flag("engaged")
        return {"status": "engaged", "gateway": gateway_arn, "enforcementMode": mode, "policyStatus": status}

    # release — delete every kill policy, then POLL until none remain (DeletePolicy is asynchronous)
    # before flipping the flag. Never report released while a forbid policy is still attached.
    deleted = _kill_policy_ids(engine_id)
    for policy_id in deleted:
        acc.delete_policy(policyEngineId=engine_id, policyId=policy_id)

    remaining = deleted
    for _ in range(20):
        remaining = _kill_policy_ids(engine_id)
        if not remaining:
            break
        time.sleep(3)
    if remaining:
        raise RuntimeError(
            f"Kill-switch release failed: {len(remaining)} forbid policy(ies) still attached "
            f"({remaining}); leaving state=engaged."
        )

    _set_flag("normal")
    return {"status": "released", "gateway": gateway_arn, "deletedPolicies": deleted}
