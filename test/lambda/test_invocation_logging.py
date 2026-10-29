"""Behavioral tests for the invocation-logging ownership custom resource (F11).

Covers: 'create' refuses to overwrite a pre-existing config, 'adopt' leaves it alone, 'manage' takes
over and restores on delete, and a self-created config is deleted on teardown.
"""
import importlib.util
import json
import os
import pathlib

import pytest

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ["STASH_PREFIX"] = "/governed-ai/_internal/invocation-logging"

_path = pathlib.Path(__file__).resolve().parents[2] / "lib" / "lambda" / "invocation-logging" / "index.py"
_spec = importlib.util.spec_from_file_location("invlog_index", _path)
invlog = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(invlog)

OUR_LG = "/governed-ai/acme/dev/bedrock-invocations"
OUR_CONFIG = {"cloudWatchConfig": {"logGroupName": OUR_LG, "roleArn": "arn:aws:iam::1:role/r"}}
THEIR_CONFIG = {"cloudWatchConfig": {"logGroupName": "/someone/else", "roleArn": "arn:aws:iam::1:role/other"}}


class _ParamNotFound(Exception):
    pass


class _FakeBedrock:
    def __init__(self, existing):
        self.config = existing
        self.puts = []
        self.deletes = 0

    def get_model_invocation_logging_configuration(self):
        return {"loggingConfig": self.config} if self.config else {}

    def put_model_invocation_logging_configuration(self, loggingConfig):
        self.puts.append(loggingConfig)
        self.config = loggingConfig

    def delete_model_invocation_logging_configuration(self):
        self.deletes += 1
        self.config = None


class _FakeSSM:
    def __init__(self):
        self.store = {}

        class _Exc:
            ParameterNotFound = _ParamNotFound

        self.exceptions = _Exc()

    def put_parameter(self, Name, Value, **_):
        self.store[Name] = Value

    def get_parameter(self, Name):
        if Name not in self.store:
            raise _ParamNotFound()
        return {"Parameter": {"Value": self.store[Name]}}

    def delete_parameter(self, Name):
        self.store.pop(Name, None)


def _wire(existing):
    invlog.bedrock = _FakeBedrock(existing)
    invlog.ssm = _FakeSSM()
    return invlog.bedrock, invlog.ssm


def _event(rt, mode):
    return {
        "RequestType": rt,
        "ResourceProperties": {
            "LogGroupName": OUR_LG,
            "LoggingConfig": json.dumps(OUR_CONFIG),
            "OwnershipMode": mode,
            "StashKey": "acme-dev",
            "PhysicalId": "bedrock-invocation-logging-1-us-east-1",
        },
    }


def test_create_sets_logging_when_none_exists():
    bedrock, _ = _wire(None)
    invlog.handler(_event("Create", "create"), None)
    assert bedrock.puts == [OUR_CONFIG]


def test_create_refuses_to_overwrite_existing():
    _wire(THEIR_CONFIG)
    with pytest.raises(Exception):
        invlog.handler(_event("Create", "create"), None)


def test_adopt_never_writes():
    bedrock, _ = _wire(THEIR_CONFIG)
    invlog.handler(_event("Create", "adopt"), None)
    assert bedrock.puts == []


def test_manage_takes_over_and_restores_on_delete():
    bedrock, ssm = _wire(THEIR_CONFIG)
    invlog.handler(_event("Create", "manage"), None)
    assert bedrock.config == OUR_CONFIG  # took over
    invlog.handler(_event("Delete", "manage"), None)
    assert bedrock.config == THEIR_CONFIG  # prior restored
    assert bedrock.deletes == 0


def test_delete_removes_self_created_config():
    bedrock, _ = _wire(None)
    invlog.handler(_event("Create", "create"), None)  # we created it
    invlog.handler(_event("Delete", "create"), None)
    assert bedrock.deletes == 1
