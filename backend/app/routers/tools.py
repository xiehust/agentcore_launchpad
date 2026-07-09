"""Tool catalog (gateway MCP tools + builtins) and builtin-tool demos."""

import time
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.core.errors import AppError
from app.services import mcp_client

router = APIRouter(prefix="/api", tags=["tools"])

BUILTIN_TOOLS = [
    {
        "name": "code-interpreter",
        "source": "builtin",
        "description": "AgentCore managed sandbox that executes code (aws.codeinterpreter.v1).",
        "inputSchema": {
            "type": "object",
            "properties": {"code": {"type": "string", "description": "Code to execute"}},
            "required": ["code"],
        },
        "auth": "IAM",
    },
    {
        "name": "browser",
        "source": "builtin",
        "description": "AgentCore managed cloud browser for web automation (aws.browser.v1).",
        "inputSchema": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "Page to open"}},
            "required": ["url"],
        },
        "auth": "IAM",
    },
]

_cache: dict[str, Any] = {"tools": None, "at": 0.0}


@router.get("/tools")
def list_tools(refresh: bool = False) -> dict[str, Any]:
    gateway_tools: list[dict[str, Any]] = []
    gateway_error: str | None = None
    if not refresh and _cache["tools"] is not None and time.time() - _cache["at"] < 60:
        gateway_tools = _cache["tools"]
    else:
        try:
            raw = mcp_client.tools_list()
            gateway_tools = [
                {
                    "name": t["name"],
                    "source": "gateway",
                    "target": t["name"].split("___")[0] if "___" in t["name"] else "",
                    "description": t.get("description", ""),
                    "inputSchema": t.get("inputSchema", {}),
                    "auth": "Cognito JWT · via launchpad-gw",
                }
                for t in raw
            ]
            _cache["tools"], _cache["at"] = gateway_tools, time.time()
        except AppError as exc:
            gateway_error = exc.code
    return {
        "gateway_url": get_settings().resources.get("gateway_url"),
        "gateway_error": gateway_error,
        "tools": gateway_tools + BUILTIN_TOOLS,
    }


class ToolCallRequest(BaseModel):
    name: str
    arguments: dict[str, Any] = Field(default_factory=dict)


@router.post("/tools/call")
def call_tool(req: ToolCallRequest) -> dict[str, Any]:
    return mcp_client.tools_call(req.name, req.arguments)


class CodeDemoRequest(BaseModel):
    code: str = Field(
        default="import math\nprint('sqrt(1764) =', math.isqrt(1764))",
        max_length=4000,
    )


@router.post("/demos/code-interpreter")
def demo_code_interpreter(req: CodeDemoRequest) -> dict[str, Any]:
    from bedrock_agentcore.tools import CodeInterpreter

    settings = get_settings()
    interpreter = CodeInterpreter(region=settings.region)
    started = time.monotonic()
    try:
        interpreter.start(session_timeout_seconds=300)
        response = interpreter.invoke("executeCode", {"language": "python", "code": req.code})
        chunks: list[str] = []
        for event in response.get("stream", []):
            result = event.get("result", {})
            for item in result.get("content", []):
                if item.get("type") == "text":
                    chunks.append(item.get("text", ""))
        return {
            "stdout": "\n".join(chunks),
            "session_id": interpreter.session_id,
            "latency_ms": int((time.monotonic() - started) * 1000),
        }
    finally:
        try:
            interpreter.stop()
        except Exception:
            pass


class BrowserDemoRequest(BaseModel):
    url: str = Field(default="https://example.com", max_length=2000)


@router.post("/demos/browser")
def demo_browser(req: BrowserDemoRequest) -> dict[str, Any]:
    from bedrock_agentcore.tools import BrowserClient
    from playwright.sync_api import sync_playwright

    settings = get_settings()
    client = BrowserClient(region=settings.region)
    started = time.monotonic()
    try:
        client.start(session_timeout_seconds=300)
        ws_url, headers = client.generate_ws_headers()
        with sync_playwright() as pw:
            browser = pw.chromium.connect_over_cdp(ws_url, headers=headers)
            page = browser.contexts[0].pages[0] if browser.contexts else (
                browser.new_context().new_page()
            )
            page.goto(req.url, wait_until="domcontentloaded", timeout=30000)
            title = page.title()
            browser.close()
        return {
            "url": req.url,
            "title": title,
            "session_id": client.session_id,
            "latency_ms": int((time.monotonic() - started) * 1000),
        }
    finally:
        try:
            client.stop()
        except Exception:
            pass
