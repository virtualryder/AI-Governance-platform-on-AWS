"""Behavioral tests for the per-user Gateway interceptor (F09).

Covers the fixes: ordinary tools are never model-gated, model gating is exact (no substring scan),
unmapped groups are handled explicitly, and approved model ids pass.
"""
import base64
import importlib.util
import json
import os
import pathlib

os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
os.environ["LEDGER_TABLE"] = "test-ledger"
os.environ["RATE_PER_MINUTE"] = "0"
os.environ["ALLOWED_MODELS_BY_GROUP"] = json.dumps({"csr-agents": ["anthropic.claude-sonnet-4-5-20250929-v1:0"]})
os.environ["MODEL_PARAM_NAME"] = "modelId"
os.environ["MODEL_ALLOWLIST_DEFAULT"] = "deny"

# Both lambdas are named index.py — load under a unique module name to avoid sys.modules collision.
_path = pathlib.Path(__file__).resolve().parents[2] / "lib" / "lambda" / "interceptor" / "index.py"
_spec = importlib.util.spec_from_file_location("interceptor_index", _path)
interceptor = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(interceptor)


class _FakeDDB:
    def get_item(self, **_):
        return {}  # never blocked

    def update_item(self, **_):
        return {"Attributes": {"count": {"N": "1"}}}


interceptor.ddb = _FakeDDB()


def _token(groups):
    payload = base64.urlsafe_b64encode(json.dumps({"sub": "u1", "cognito:groups": groups}).encode()).decode().rstrip("=")
    return f"h.{payload}.s"


def _event(groups, name, arguments):
    return {
        "mcp": {
            "gatewayRequest": {
                "headers": {"Authorization": f"Bearer {_token(groups)}"},
                "body": {"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": name, "arguments": arguments}},
            }
        }
    }


def _allowed(resp):
    return "transformedGatewayRequest" in resp["mcp"]


def _denied(resp):
    return "transformedGatewayResponse" in resp["mcp"]


def test_ordinary_tool_not_model_gated_even_if_text_contains_model_name():
    # F09 regression: an approved model string in a free-text arg must NOT be treated as model routing.
    resp = interceptor.handler(_event(["csr-agents"], "svc311___create", {"text": "anthropic.claude-sonnet-4-5 rocks"}), None)
    assert _allowed(resp)


def test_model_routing_allowed_model_passes():
    resp = interceptor.handler(_event(["csr-agents"], "router", {"modelId": "anthropic.claude-sonnet-4-5-20250929-v1:0"}), None)
    assert _allowed(resp)


def test_model_routing_disallowed_model_denied():
    resp = interceptor.handler(_event(["csr-agents"], "router", {"modelId": "openai.gpt-4o"}), None)
    assert _denied(resp)


def test_unmapped_group_denied_by_default():
    resp = interceptor.handler(_event(["random-group"], "router", {"modelId": "anthropic.claude-sonnet-4-5-20250929-v1:0"}), None)
    assert _denied(resp)


def test_substring_sibling_model_not_allowed():
    # a lookalike/sibling id must NOT be authorized by the exact allowlist (B5 exact equality)
    resp = interceptor.handler(_event(["csr-agents"], "router", {"modelId": "anthropic.claude-sonnet-4-5-20250929-v2:0"}), None)
    assert _denied(resp)
