from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.errors import AppError, NotFoundError, register_error_handlers


def make_client() -> TestClient:
    app = FastAPI()
    register_error_handlers(app)

    @app.get("/boom")
    def boom():
        raise AppError("agent.invalid_state", "Agent is not deployable", {"agent_id": "a-1"})

    @app.get("/missing")
    def missing():
        raise NotFoundError("agent.not_found", "Agent not found")

    return TestClient(app, raise_server_exceptions=False)


def test_app_error_envelope():
    res = make_client().get("/boom")
    assert res.status_code == 400
    assert res.json() == {
        "code": "agent.invalid_state",
        "message": "Agent is not deployable",
        "detail": {"agent_id": "a-1"},
    }


def test_not_found_status():
    res = make_client().get("/missing")
    assert res.status_code == 404
    assert res.json()["code"] == "agent.not_found"


def test_unknown_route_uses_http_envelope():
    res = make_client().get("/nope")
    assert res.status_code == 404
    assert res.json()["code"] == "http.404"
