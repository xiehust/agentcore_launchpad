import app.core.config as config_mod
from app.core.config import Settings, load_yaml_config


def test_defaults():
    s = Settings()
    assert s.region == "us-west-2"
    assert s.database_url.startswith("sqlite:///")
    assert s.app_name == "AgentCore Launchpad"


def test_yaml_source_feeds_settings(tmp_path, monkeypatch):
    cfg = tmp_path / "launchpad.yaml"
    cfg.write_text("region: eu-central-1\naccount_id: '123456789012'\n", encoding="utf-8")
    monkeypatch.setattr(config_mod, "CONFIG_FILE", cfg)
    s = Settings()
    assert s.region == "eu-central-1"
    assert s.account_id == "123456789012"


def test_missing_yaml_is_empty(tmp_path):
    assert load_yaml_config(tmp_path / "nope.yaml") == {}


def test_env_overrides_yaml(tmp_path, monkeypatch):
    cfg = tmp_path / "launchpad.yaml"
    cfg.write_text("region: eu-central-1\n", encoding="utf-8")
    monkeypatch.setattr(config_mod, "CONFIG_FILE", cfg)
    monkeypatch.setenv("LAUNCHPAD_REGION", "ap-southeast-1")
    assert Settings().region == "ap-southeast-1"
