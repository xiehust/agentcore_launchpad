"""Gateway bootstrap idempotency, MCP client parsing, harness gateway mapping."""

import json
from unittest.mock import MagicMock

import httpx
import pytest

from app.deployer.harness import build_create_params
from app.schemas.agent import AgentSpec
from app.services import gateway_bootstrap as gb
from app.services import mcp_client

GW_ARN = "arn:aws:bedrock-agentcore:us-west-2:111:gateway/launchpad-gw-abc"
OAUTH_ARN = (
    "arn:aws:bedrock-agentcore:us-west-2:111:token-vault/default"
    "/oauth2credentialprovider/launchpad-gw-m2m"
)


def make_control(gateways=(), targets=(), api_providers=(), oauth_providers=()):
    control = MagicMock()
    control.list_gateways.return_value = {"items": list(gateways)}
    control.list_gateway_targets.return_value = {"items": list(targets)}
    control.list_api_key_credential_providers.return_value = {
        "credentialProviders": list(api_providers)
    }
    control.list_oauth2_credential_providers.return_value = {
        "credentialProviders": list(oauth_providers)
    }
    control.get_gateway.return_value = {
        "gatewayId": "launchpad-gw-abc",
        "gatewayArn": GW_ARN,
        "gatewayUrl": "https://gw.example/mcp",
        "status": "READY",
        "name": "launchpad-gw",
        "roleArn": "arn:role",
        "protocolType": "MCP",
        "authorizerType": "CUSTOM_JWT",
        "authorizerConfiguration": {
            "customJWTAuthorizer": {"discoveryUrl": "https://x", "allowedClients": ["console"]}
        },
    }
    control.create_gateway.return_value = {"gatewayId": "launchpad-gw-abc"}
    control.create_gateway_target.return_value = {"targetId": "T1"}
    control.get_gateway_target.return_value = {"status": "READY"}
    control.create_api_key_credential_provider.return_value = {
        "credentialProviderArn": "arn:apikey"
    }
    control.create_oauth2_credential_provider.return_value = {
        "credentialProviderArn": OAUTH_ARN
    }
    return control


def test_ensure_gateway_reuses_existing():
    control = make_control(gateways=[{"name": "launchpad-gw", "gatewayId": "launchpad-gw-abc"}])
    gw, created = gb.ensure_gateway(
        control, role_arn="arn:role", user_pool_id="p", client_id="c", region="us-west-2"
    )
    assert created is False and gw["arn"] == GW_ARN
    control.create_gateway.assert_not_called()


def test_ensure_gateway_creates_with_jwt_auth():
    control = make_control()
    gw, created = gb.ensure_gateway(
        control, role_arn="arn:role", user_pool_id="us-west-2_ABC", client_id="cid",
        region="us-west-2",
    )
    assert created is True
    kwargs = control.create_gateway.call_args.kwargs
    assert kwargs["authorizerType"] == "CUSTOM_JWT"
    jwt = kwargs["authorizerConfiguration"]["customJWTAuthorizer"]
    assert "us-west-2_ABC/.well-known/openid-configuration" in jwt["discoveryUrl"]
    assert jwt["allowedClients"] == ["cid"]


def test_ensure_targets_idempotent():
    control = make_control(
        targets=[{"name": "hr-database", "targetId": "T-hr"},
                 {"name": "office-facts", "targetId": "T-of"}]
    )
    tid, created = gb.ensure_lambda_target(control, "gw", "arn:lambda")
    assert (tid, created) == ("T-hr", False)
    tid2, created2 = gb.ensure_openapi_target(control, "gw", "https://api/prod", "arn:apikey")
    assert (tid2, created2) == ("T-of", False)
    control.create_gateway_target.assert_not_called()


def test_openapi_target_injects_server_and_api_key():
    control = make_control()
    gb.ensure_openapi_target(control, "gw", "https://abc.execute-api/prod/", "arn:apikey")
    kwargs = control.create_gateway_target.call_args.kwargs
    spec = json.loads(kwargs["targetConfiguration"]["mcp"]["openApiSchema"]["inlinePayload"])
    assert spec["servers"] == [{"url": "https://abc.execute-api/prod"}]
    cred = kwargs["credentialProviderConfigurations"][0]
    assert cred["credentialProviderType"] == "API_KEY"
    akp = cred["credentialProvider"]["apiKeyCredentialProvider"]
    assert akp["credentialParameterName"] == "x-api-key"
    assert akp["credentialLocation"] == "HEADER"


def test_ensure_gateway_allows_client_appends_once():
    control = make_control()
    changed = gb.ensure_gateway_allows_client(control, "gw", "m2m-id")
    assert changed is True
    updated = control.update_gateway.call_args.kwargs
    assert updated["authorizerConfiguration"]["customJWTAuthorizer"]["allowedClients"] == [
        "console", "m2m-id",
    ]
    # second call: already present
    control2 = make_control()
    control2.get_gateway.return_value["authorizerConfiguration"]["customJWTAuthorizer"][
        "allowedClients"
    ] = ["console", "m2m-id"]
    assert gb.ensure_gateway_allows_client(control2, "gw", "m2m-id") is False
    control2.update_gateway.assert_not_called()


def test_harness_gateway_tool_mapping():
    spec = AgentSpec(
        name="gw-agent",
        method="harness",
        system_prompt="x",
        tools=[{"type": "gateway", "name": "hr-database"}],
    )
    params = build_create_params(
        spec, "arn:role", None,
        gateway={"arn": GW_ARN, "oauth_provider_arn": OAUTH_ARN},
    )
    tool = params["tools"][0]
    assert tool["type"] == "agentcore_gateway"
    cfg = tool["config"]["agentCoreGateway"]
    assert cfg["gatewayArn"] == GW_ARN
    assert cfg["outboundAuth"]["oauth"] == {
        "providerArn": OAUTH_ARN,
        "grantType": "CLIENT_CREDENTIALS",
        "scopes": ["launchpad-gw/invoke"],
    }


def test_harness_gateway_ignored_without_config():
    spec = AgentSpec(
        name="gw-agent", method="harness", system_prompt="x",
        tools=[{"type": "gateway", "name": "hr-database"}],
    )
    params = build_create_params(spec, "arn:role", None, gateway=None)
    assert "tools" not in params


def test_mcp_client_parses_sse_and_json(monkeypatch):
    sse = httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        text='event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"a"}]}}\n\n',
    )
    assert mcp_client._parse_jsonrpc_body(sse)["result"]["tools"] == [{"name": "a"}]
    plain = httpx.Response(
        200,
        headers={"content-type": "application/json"},
        text='{"jsonrpc":"2.0","id":2,"result":{"ok":true}}',
    )
    assert mcp_client._parse_jsonrpc_body(plain)["result"] == {"ok": True}


def test_mcp_rpc_raises_envelope_on_401(monkeypatch):
    def fake_post(url, json=None, headers=None, timeout=None):
        return httpx.Response(401, text="Unauthorized", request=httpx.Request("POST", url))

    monkeypatch.setattr(mcp_client.httpx, "post", fake_post)
    from app.core.errors import AppError

    with pytest.raises(AppError) as err:
        mcp_client._rpc("https://gw/mcp", "tok", "tools/list")
    assert err.value.code == "gateway.unauthorized"
