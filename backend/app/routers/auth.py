"""Optional local username/password authentication for the console."""

import hashlib
import hmac
import time
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.core.config import Settings, get_settings
from app.core.errors import AppError, envelope

router = APIRouter(prefix="/api/auth", tags=["auth"])

COOKIE_NAME = "launchpad_session"
SESSION_TTL_SECONDS = 12 * 3600

_OPEN_API_PATHS = {"/api/auth/login", "/api/auth/status", "/api/health"}


def _password(settings: Settings | None = None) -> str | None:
    secret = (settings or get_settings()).auth_password
    if secret is None:
        return None
    return secret.get_secret_value() or None


def enabled(settings: Settings | None = None) -> bool:
    return _password(settings) is not None


def _signing_key(settings: Settings | None = None) -> bytes:
    current = settings or get_settings()
    material = (
        f"agentcore-launchpad-session:{current.auth_username}:{_password(current)}"
    )
    return hashlib.sha256(material.encode("utf-8")).digest()


def _sign(expiry: int, settings: Settings | None = None) -> str:
    signature = hmac.new(
        _signing_key(settings),
        str(expiry).encode("ascii"),
        hashlib.sha256,
    )
    return f"{expiry}.{signature.hexdigest()}"


def _verify(cookie: str | None, settings: Settings | None = None) -> bool:
    if not cookie or "." not in cookie:
        return False
    expiry_text = cookie.partition(".")[0]
    if not expiry_text.isdigit():
        return False
    expected = _sign(int(expiry_text), settings)
    return hmac.compare_digest(cookie, expected) and int(expiry_text) > time.time()


def is_authenticated(request: Request, settings: Settings | None = None) -> bool:
    return _verify(request.cookies.get(COOKIE_NAME), settings)


async def auth_middleware(request: Request, call_next: Any) -> Any:
    """Require a console session while leaving health and /v1 contracts intact."""
    settings = get_settings()
    if enabled(settings) and request.method != "OPTIONS":
        path = request.url.path
        guarded = (path == "/api" or path.startswith("/api/")) and (
            path not in _OPEN_API_PATHS
        )
        if guarded and not is_authenticated(request, settings):
            return JSONResponse(
                status_code=401,
                content=envelope("auth.required", "Authentication required"),
            )
    return await call_next(request)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


@router.get("/status")
def status(request: Request) -> dict[str, Any]:
    settings = get_settings()
    required = enabled(settings)
    authenticated = not required or is_authenticated(request, settings)
    return {
        "auth_required": required,
        "authenticated": authenticated,
        "username": settings.auth_username if required and authenticated else None,
    }


@router.post("/login")
def login(req: LoginRequest, response: Response) -> dict[str, Any]:
    settings = get_settings()
    password = _password(settings)
    if password is None:
        return {
            "ok": True,
            "auth_required": False,
            "expires_at": None,
            "username": None,
        }

    username_ok = hmac.compare_digest(
        req.username.encode("utf-8"),
        settings.auth_username.encode("utf-8"),
    )
    password_ok = hmac.compare_digest(
        req.password.encode("utf-8"),
        password.encode("utf-8"),
    )
    if not (username_ok and password_ok):
        raise AppError(
            "auth.invalid_credentials",
            "Invalid username or password",
            status_code=401,
        )

    expiry = int(time.time()) + SESSION_TTL_SECONDS
    response.set_cookie(
        COOKIE_NAME,
        _sign(expiry, settings),
        max_age=SESSION_TTL_SECONDS,
        httponly=True,
        secure=settings.auth_cookie_secure,
        samesite="lax",
        path="/",
    )
    return {
        "ok": True,
        "auth_required": True,
        "expires_at": expiry,
        "username": settings.auth_username,
    }


@router.post("/logout")
def logout(response: Response) -> dict[str, bool]:
    settings = get_settings()
    response.delete_cookie(
        COOKIE_NAME,
        path="/",
        secure=settings.auth_cookie_secure,
        httponly=True,
        samesite="lax",
    )
    return {"ok": True}
