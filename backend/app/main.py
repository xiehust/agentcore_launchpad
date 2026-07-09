"""FastAPI application factory."""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import app.deployer.container  # noqa: F401 — registers the container (Claude SDK) method
import app.deployer.harness  # noqa: F401 — registers the harness deploy method
import app.deployer.zip_runtime  # noqa: F401 — registers zip_runtime + studio methods
from app.core.config import get_settings
from app.core.db import init_db
from app.core.errors import register_error_handlers
from app.deployer.pipeline import resume_pending_jobs
from app.routers.agents import router as agents_router
from app.routers.apikeys import router as apikeys_router
from app.routers.chat import router as chat_router
from app.routers.governance import router as governance_router
from app.routers.public_api import router as public_router
from app.routers.registry import router as registry_router
from app.routers.tools import router as tools_router

API_DESCRIPTION = """AgentCore Launchpad — enterprise agent platform.

The `/v1` endpoints are the **public integration surface** (X-Api-Key auth,
sync + SSE streaming invoke). `/api/*` endpoints back the console UI and share
the same invoke chain, so behavior is identical across both entrances.
"""


def create_app(resume_jobs: bool = False) -> FastAPI:
    settings = get_settings()
    app = FastAPI(
        title=f"{settings.app_name} API",
        version=settings.version,
        description=API_DESCRIPTION,
        docs_url="/api/docs",
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_error_handlers(app)
    init_db()
    app.include_router(agents_router)
    app.include_router(tools_router)
    app.include_router(registry_router)
    app.include_router(chat_router)
    app.include_router(governance_router)
    app.include_router(apikeys_router)
    app.include_router(public_router)
    if resume_jobs:
        resumed = resume_pending_jobs()
        if resumed:
            logging.getLogger("launchpad").info(
                "resumed %d interrupted deploy job(s)", len(resumed)
            )

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {
            "status": "ok",
            "version": settings.version,
            "region": settings.region,
        }

    return app


app = create_app(resume_jobs=True)
