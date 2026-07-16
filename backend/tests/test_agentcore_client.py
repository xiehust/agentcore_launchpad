from types import SimpleNamespace

from app.services.agentcore import client as client_mod


def test_data_client_uses_configured_read_timeout(monkeypatch):
    created = {}
    sentinel = object()

    def fake_client(service_name, **kwargs):
        created["service_name"] = service_name
        created.update(kwargs)
        return sentinel

    monkeypatch.setattr(
        client_mod,
        "get_settings",
        lambda: SimpleNamespace(region="us-east-1", agentcore_read_timeout_s=1200),
    )
    monkeypatch.setattr(client_mod.boto3, "client", fake_client)
    client_mod.data_client.cache_clear()
    try:
        assert client_mod.data_client() is sentinel
    finally:
        client_mod.data_client.cache_clear()

    assert created["service_name"] == "bedrock-agentcore"
    assert created["region_name"] == "us-east-1"
    assert created["config"].read_timeout == 1200
