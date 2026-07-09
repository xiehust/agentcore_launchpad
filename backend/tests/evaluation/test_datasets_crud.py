"""Datasets CRUD + JSONL upload — adapted from agentcore_eva_opt dataset tests."""

from pathlib import Path

SAMPLES = Path(__file__).resolve().parents[3] / "samples" / "datasets"


def test_dataset_create_list_delete(client):
    created = client.post(
        "/api/eval/datasets",
        json={"name": "crud-ds", "items": [{"prompt": "hello"}]},
    )
    assert created.status_code == 201
    ds_id = created.json()["id"]
    listed = client.get("/api/eval/datasets").json()["datasets"]
    assert any(d["id"] == ds_id for d in listed)
    assert client.delete(f"/api/eval/datasets/{ds_id}").json()["deleted"] is True


def test_dataset_rejects_items_without_prompt(client):
    res = client.post("/api/eval/datasets", json={"name": "bad", "items": [{"x": 1}]})
    assert res.status_code == 422
    assert res.json()["code"] == "dataset.invalid_item"


def test_jsonl_upload_en_and_zh_samples(client):
    for filename, locale in (("hr_baseline_en.jsonl", "en"), ("hr_baseline_zh.jsonl", "zh-CN")):
        content = (SAMPLES / filename).read_text(encoding="utf-8")
        res = client.post(
            "/api/eval/datasets/upload",
            json={"name": filename.replace(".jsonl", ""), "locale": locale, "jsonl": content},
        )
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["item_count"] == 5
        if locale == "zh-CN":
            assert "计算器" in body["items"][0]["prompt"]  # zh survives round-trip


def test_jsonl_upload_rejects_bad_lines(client):
    res = client.post(
        "/api/eval/datasets/upload",
        json={"name": "bad", "jsonl": '{"prompt": "ok"}\nnot-json\n'},
    )
    assert res.status_code == 422
    assert res.json()["code"] == "dataset.invalid_jsonl"
