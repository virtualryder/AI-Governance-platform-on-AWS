"""Behavioral tests for the layered kill switch (F06).

Covers the fixes: release reads `policies` (not `items`), verifies deletion before flipping the flag,
refuses to release while a forbid policy remains, and rejects unknown actions (no fall-through).
"""
import importlib.util
import os
import pathlib

import pytest

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ["PARAM_PREFIX"] = "/governed-ai/test/dev"
os.environ["KILL_POLICY_NAME"] = "govai_killswitch_forbid_all"

# Both lambdas are named index.py — load under a unique module name to avoid sys.modules collision.
_path = pathlib.Path(__file__).resolve().parents[2] / "lib" / "lambda" / "kill-switch" / "index.py"
_spec = importlib.util.spec_from_file_location("killswitch_index", _path)
killswitch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(killswitch)

# The handler polls async Create/DeletePolicy with time.sleep; stub it so tests don't actually wait.
killswitch.time.sleep = lambda *_: None

KILL = "govai_killswitch_forbid_all"


class _FakeSSM:
    def __init__(self):
        self.flag = None

    def get_parameter(self, Name):
        if Name.endswith("policy-engine-arn"):
            return {"Parameter": {"Value": "arn:aws:bedrock-agentcore:us-east-1:111:policy-engine/eng-abc123"}}
        if Name.endswith("gateway-arn"):
            return {"Parameter": {"Value": "arn:aws:bedrock-agentcore:us-east-1:111:gateway/gw-x"}}
        return {"Parameter": {"Value": "x"}}

    def put_parameter(self, Name, Value, **_):
        if Name.endswith("kill-switch-state"):
            self.flag = Value


class _Conflict(Exception):
    pass


class _FakeACC:
    """Stateful fake: holds a list of policies; delete removes them."""

    def __init__(self, policies, persistent=False):
        self.policies = list(policies)
        self.persistent = persistent  # if True, delete is a no-op (simulates failed release)
        self.deleted = []
        self.created = []

        class _Exc:
            ConflictException = _Conflict

        self.exceptions = _Exc()

    def list_policy_summaries(self, **_):
        return {"policies": list(self.policies)}  # metadata-only, no KMS decrypt

    def delete_policy(self, policyEngineId, policyId):
        self.deleted.append(policyId)
        if not self.persistent:
            self.policies = [p for p in self.policies if p["policyId"] != policyId]

    def __init_create_status__(self):
        pass

    def create_policy(self, **kw):
        self.created.append(kw["name"])
        # Simulate async creation: the policy appears with a configurable terminal status.
        self.policies.append(
            {"name": kw["name"], "policyId": kw["name"] + "-x", "status": getattr(self, "create_status", "ACTIVE"), "enforcementMode": "ACTIVE"}
        )


def _wire(acc):
    ssm = _FakeSSM()
    killswitch.ssm = ssm
    killswitch.acc = acc
    return ssm


def test_release_deletes_policy_then_flags_normal():
    acc = _FakeACC([{"name": KILL, "policyId": "p1"}])
    ssm = _wire(acc)
    out = killswitch.handler({"action": "release"}, None)
    assert out["status"] == "released"
    assert acc.deleted == ["p1"]
    assert ssm.flag == "normal"


def test_release_refuses_when_policy_persists():
    acc = _FakeACC([{"name": KILL, "policyId": "p1"}], persistent=True)
    ssm = _wire(acc)
    with pytest.raises(RuntimeError):
        killswitch.handler({"action": "release"}, None)
    assert ssm.flag != "normal"  # must NOT report released


def test_unknown_action_rejected_not_released():
    acc = _FakeACC([{"name": KILL, "policyId": "p1"}])
    ssm = _wire(acc)
    with pytest.raises(ValueError):
        killswitch.handler({"action": "bogus"}, None)
    assert acc.deleted == []
    assert ssm.flag != "normal"


def test_engage_creates_policy_and_flags_engaged_when_active():
    acc = _FakeACC([])
    acc.create_status = "ACTIVE"
    ssm = _wire(acc)
    out = killswitch.handler({"action": "engage"}, None)
    assert out["status"] == "engaged"
    assert acc.created == [KILL]
    assert ssm.flag == "engaged"


def test_engage_raises_and_does_not_flag_engaged_on_create_failed():
    # B4: a CREATE_FAILED policy must NOT be reported as engaged.
    acc = _FakeACC([])
    acc.create_status = "CREATE_FAILED"
    ssm = _wire(acc)
    with pytest.raises(RuntimeError):
        killswitch.handler({"action": "engage"}, None)
    assert ssm.flag != "engaged"  # conservative incident state, not a false 'engaged'
