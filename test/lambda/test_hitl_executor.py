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
        elif ":done" in ExpressionAttributeValues:
            self.status = "COMPLETED"


class _FakeLambda:
    def __init__(self):
        self.invocations = 0

    def invoke(self, FunctionName, Payload):
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
