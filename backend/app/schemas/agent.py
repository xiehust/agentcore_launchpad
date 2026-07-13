"""AgentSpec — the one artifact every creation method converges into."""

import re
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

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


class KnowledgeBaseRef(BaseModel):
    """Managed Knowledge Base mounted on the agent via the shared KB gateway.

    name/description are denormalized at selection time — they feed the system
    prompt and detail views without a Bedrock round-trip.
    """

    kb_id: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9]+$")
    name: str = Field(default="", max_length=200)
    description: str = Field(default="", max_length=1000)


class MemoryConfig(BaseModel):
    short_term: bool = True
    long_term: bool = False


# AgentCore filesystemConfigurations mount-path contract: exactly one level under
# /mnt, 6-200 chars (see task research: runtime-filesystem-configurations).
MOUNT_PATH_RE = r"^/mnt/[a-zA-Z0-9._-]+/?$"

_S3_FILES_AP_RE = re.compile(
    r"^arn:aws[\w-]*:s3files:[^:]+:\d{12}:file-system/[^/]+/access-point/.+$"
)
_EFS_AP_RE = re.compile(
    r"^arn:aws[\w-]*:elasticfilesystem:[^:]+:\d{12}:access-point/.+$"
)


class SessionStorageFs(BaseModel):
    """Managed session storage (Preview) — per-session, reset on version update."""

    mount_path: str = Field(
        default="/mnt/workspace", pattern=MOUNT_PATH_RE, min_length=6, max_length=200
    )


class ByoMount(BaseModel):
    """Bring-your-own mount: an S3 Files or EFS access point."""

    access_point_arn: str = Field(min_length=20, max_length=2048)
    mount_path: str = Field(pattern=MOUNT_PATH_RE, min_length=6, max_length=200)


class VpcNetwork(BaseModel):
    """networkModeConfig for networkMode=VPC — required by BYO file systems."""

    subnets: list[str] = Field(min_length=1, max_length=8)
    security_groups: list[str] = Field(min_length=1, max_length=5)


class FilesystemConfig(BaseModel):
    """AgentCore Runtime filesystemConfigurations (≤1 session, ≤2 s3, ≤2 efs).

    session_storage defaults ON; an explicit JSON null disables it.
    """

    session_storage: SessionStorageFs | None = Field(default_factory=SessionStorageFs)
    s3_files: list[ByoMount] = Field(default_factory=list, max_length=2)
    efs: list[ByoMount] = Field(default_factory=list, max_length=2)

    @property
    def byo(self) -> bool:
        return bool(self.s3_files or self.efs)

    @model_validator(mode="after")
    def _check(self) -> "FilesystemConfig":
        paths = [m.mount_path.rstrip("/") for m in (*self.s3_files, *self.efs)]
        if self.session_storage:
            paths.append(self.session_storage.mount_path.rstrip("/"))
        if len(paths) != len(set(paths)):
            raise ValueError("filesystem mount paths must be unique")
        for mount in self.s3_files:
            if not _S3_FILES_AP_RE.match(mount.access_point_arn):
                raise ValueError(
                    f"'{mount.access_point_arn}' is not an S3 Files access point ARN"
                )
        for mount in self.efs:
            if not _EFS_AP_RE.match(mount.access_point_arn):
                raise ValueError(
                    f"'{mount.access_point_arn}' is not an EFS access point ARN"
                )
        return self


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
    # Strands Studio canvas graph {nodes, edges, graphMode} — persisted for later edit/re-publish
    studio_flow: dict[str, Any] | None = None
    memory: MemoryConfig = Field(default_factory=MemoryConfig)
    env: dict[str, str] = Field(default_factory=dict)
    max_iterations: int = Field(default=10, ge=1, le=100)
    timeout_seconds: int = Field(default=300, ge=10, le=3600)
    # AgentCore Runtime persistent storage — consumed by the container method only
    filesystem: FilesystemConfig = Field(default_factory=FilesystemConfig)
    # VPC networkModeConfig; mandatory whenever a BYO file system is mounted
    network: VpcNetwork | None = None
    # Managed KBs mounted via the shared KB gateway — harness-only in v1
    # (container/zip/studio have no authenticated gateway channel yet)
    knowledge_bases: list[KnowledgeBaseRef] = Field(default_factory=list, max_length=10)

    @model_validator(mode="after")
    def _byo_needs_vpc(self) -> "AgentSpec":
        if self.filesystem.byo and self.network is None:
            raise ValueError(
                "BYO file systems (S3 Files / EFS) require VPC network configuration"
            )
        return self

    @model_validator(mode="after")
    def _kb_needs_harness(self) -> "AgentSpec":
        if self.knowledge_bases and self.method != "harness":
            raise ValueError(
                "knowledge_bases are only supported by the harness method in v1"
            )
        return self


class InvokeRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=100000)
    session_id: str | None = None
    actor_id: str = "default"


class InvokeResponse(BaseModel):
    text: str
    session_id: str
    latency_ms: int
