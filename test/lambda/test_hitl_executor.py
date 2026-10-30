"""Behavioral tests for the HITL post-approval executor (F05).

Covers exactly-once execution, replay/double-submit protection, and record-only when no target is set.
"""
import importlib.util
import os
import pathlib


class _CCF(Exception):
    pass


os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ["APPROVALS_TABLE"] = "approvals"
os.environ["TARGET_ARN"] = "arn:aws:lambda:us-east-1:1:function:submit-tool"
os.environ["CONSEQUENTIAL_TOOL"] = "submit_service_request"  # platform-pinned tool (review #4)

_path = pathlib.Path(__file__).resolve().parents[2] / "lib" / "lambda" / "hitl-executor" / "index.py"
_spec = importlib.util.spec_from_file_location("hitl_executor_index", _path)
executor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(executor)


class _FakeDDB:
    def __init__(self, status="PENDING"):
        self.status = status

        class _Exc:
            ConditionalCheckFailedException = _CCF

        self.exceptions = _Exc()

    def update_item(self, TableName, Key, UpdateExpression, ExpressionAttributeValues, ExpressionAttributeNames=None, ConditionExpression=None):
        if ConditionExpression and ":pending" in ExpressionAttributeValues:
            # claim PENDING -> EXECUTING
            if self.status != "PENDING":
                raise _CCF()
            self.status = "EXECUTING"
        elif ":s" in ExpressionAttributeValues:
            # _set_status(...) -> COMPLETED | FAILED | UNKNOWN
            self.status = ExpressionAttributeValues[":s"]["S"]


class _FakeLambda:
    def __init__(self):
        self.invocations = 0

    def invoke(self, FunctionName, Payload, **kwargs):
        self.invocations += 1

        class _Body:
            def read(self_inner):
                return b'{"result": "filed", "ref": "SR-1"}'

        return {"Payload": _Body()}


def _event():
    return {
        "actionDigest": "d1",
        "action": "submit_service_request",
        "args": {"category": "pothole", "address": "1 Main St"},
        "actor": "user-sub-123",
        "approver": "approver-999",
        "approvedAt": "2026-10-29T00:00:00Z",
        "caseId": "CASE-1",
    }


def test_executes_once_when_pending():
    executor.ddb = _FakeDDB("PENDING")
    executor.lam = _FakeLambda()
    out = executor.handler(_event(), None)
    assert out["executed"] is True
    assert out["approver"] == "approver-999"
    assert executor.lam.invocations == 1


def test_replay_is_blocked_when_not_pending():
    executor.ddb = _FakeDDB("COMPLETED")  # already handled
    executor.lam = _FakeLambda()
    out = executor.handler(_event(), None)
    assert out["executed"] is False
    assert out["status"] == "already_handled"
    assert executor.lam.invocations == 0  # must NOT submit again


def test_record_only_when_no_target(monkeypatch):
    monkeypatch.setattr(executor, "TARGET_ARN", "")
    executor.ddb = _FakeDDB("PENDING")
    executor.lam = _FakeLambda()
    out = executor.handler(_event(), None)
    assert out["executed"] is False
    assert executor.lam.invocations == 0


class _ErrLambda:
    """Returns an invocation with a FunctionError (function ran but failed)."""
    def invoke(self, FunctionName, Payload, **kwargs):
        class _Body:
            def read(self_inner):
                return b'{"errorMessage": "backend down"}'
        return {"Payload": _Body(), "FunctionError": "Unhandled"}


class _RaisingLambda:
    def invoke(self, FunctionName, Payload, **kwargs):
        raise RuntimeError("network reset")


def test_function_error_is_not_recorded_as_completed():
    # B3b: a Lambda FunctionError must NOT yield executed:true/COMPLETED.
    ddb = _FakeDDB("PENDING")
    executor.ddb = ddb
    executor.lam = _ErrLambda()
    out = executor.handler(_event(), None)
    assert out["status"] == "failed"
    assert out["executed"] is False
    assert ddb.status == "FAILED"


def test_transport_failure_after_claim_is_unknown_and_raises():
    # B3c: a transport failure after claiming must mark UNKNOWN (reconcilable), not COMPLETED.
    import pytest
    ddb = _FakeDDB("PENDING")
    executor.ddb = ddb
    executor.lam = _RaisingLambda()
    with pytest.raises(RuntimeError):
        executor.handler(_event(), None)
    assert ddb.status == "UNKNOWN"


def test_self_approval_is_rejected():
    # review #3: approver == actor must be refused (defensive self-approval check).
    ddb = _FakeDDB("PENDING")
    executor.ddb = ddb
    executor.lam = _FakeLambda()
    evt = _event()
    evt["actor"] = "same-person"
    evt["approver"] = "same-person"
    out = executor.handler(evt, None)
    assert out["executed"] is False
    assert out["status"] == "rejected"
    assert executor.lam.invocations == 0
    assert ddb.status == "REJECTED"  # the row we just claimed (PENDING) is now terminal REJECTED


def test_self_approval_replay_does_not_clobber_terminal_ledger():
    # review #3b: the self-approval check must NOT overwrite a terminal row on replay. The earlier code
    # ran the REJECTED write BEFORE the claim, so replaying an already-COMPLETED action with
    # approver == actor rewrote the ledger to REJECTED (audit corruption). The claim must guard it.
    ddb = _FakeDDB("COMPLETED")  # action already executed and recorded
    executor.ddb = ddb
    executor.lam = _FakeLambda()
    evt = _event()
    evt["actor"] = "same-person"
    evt["approver"] = "same-person"
    out = executor.handler(evt, None)
    assert out["status"] == "already_handled"
    assert out["executed"] is False
    assert executor.lam.invocations == 0
    assert ddb.status == "COMPLETED"  # untouched — the prior outcome is preserved


def test_refuses_when_consequential_tool_unset_with_target(monkeypatch):
    # minor review item: with a target configured, an empty CONSEQUENTIAL_TOOL is a misconfiguration —
    # the executor must refuse, never fall back to the input's action name.
    monkeypatch.setattr(executor, "CONSEQUENTIAL_TOOL", "")
    ddb = _FakeDDB("PENDING")
    executor.ddb = ddb
    executor.lam = _FakeLambda()
    out = executor.handler(_event(), None)
    assert out["status"] == "failed"
    assert out["executed"] is False
    assert out["error"] == "consequential_tool_not_configured"
    assert executor.lam.invocations == 0
    assert ddb.status == "FAILED"
