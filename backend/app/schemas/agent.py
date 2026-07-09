"""AgentSpec — the one artifact every creation method converges into."""

from typing import Any, Literal

from pydantic import BaseModel, Field

# Latest Sonnet inference profile available in the target account (verified via
# bedrock list-inference-profiles; there is no "sonnet-5" profile).
DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-6"

Method = Literal["harness", "zip_runtime", "container", "studio"]


class ToolRef(BaseModel):
    """Reference to a tool the agent may call.

    type=builtin → AgentCore builtin (code-interpreter / browser)
    type=gateway → MCP tool via the shared gateway (wired in phase 6)
    type=mcp     → remote MCP server URL
    """

    type: Literal["builtin", "gateway", "mcp"]
    name: str
    config: dict[str, Any] = Field(default_factory=dict)


class MemoryConfig(BaseModel):
    short_term: bool = True
    long_term: bool = False


class AgentSpec(BaseModel):
    name: str = Field(pattern=r"^[a-z][a-z0-9-]{2,47}$")
    method: Method
    model_id: str = DEFAULT_MODEL_ID
    system_prompt: str = Field(min_length=1, max_length=20000)
    tools: list[ToolRef] = Field(default_factory=list)
    skills: list[str] = Field(default_factory=list)
    # extra pip requirements for zip_runtime/studio agents (on top of the template base set)
    requirements: list[str] = Field(default_factory=list)
    # pre-generated agent code (studio method) — bypasses the strands template
    code: str | None = Field(default=None, max_length=200000)
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    env: dict[str, str] = Field(default_factory=dict)
    max_iterations: int = Field(default=10, ge=1, le=100)
    timeout_seconds: int = Field(default=300, ge=10, le=3600)


class InvokeRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=100000)
    session_id: str | None = None
    actor_id: str = "default"


class InvokeResponse(BaseModel):
    text: str
    session_id: str
    latency_ms: int
