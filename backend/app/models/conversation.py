"""Studio local-debug conversation models (in-memory, ephemeral).

Ported from strands_studio_ui backend/app/models/conversation.py (origin/main),
trimmed to the local-debug fields launchpad needs. project_id/version are kept
optional for port parity but carry local defaults; bedrock_api_key is added
(launchpad flows are Bedrock by default).
"""

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class ConversationSession(BaseModel):
    session_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    project_id: str = "studio-local"
    version: str = "local"
    agent_config: dict[str, Any] = {}
    created_at: datetime = Field(default_factory=datetime.now)
    updated_at: datetime = Field(default_factory=datetime.now)
    message_count: int = 0
    openai_api_key: str | None = None
    bedrock_api_key: str | None = None


class ChatMessage(BaseModel):
    message_id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str
    sender: Literal["user", "agent"]
    content: str
    timestamp: datetime = Field(default_factory=datetime.now)
    metadata: dict[str, Any] | None = None


class CreateConversationRequest(BaseModel):
    generated_code: str = Field(min_length=1, max_length=400000)
    flow_data: dict[str, Any] = {}
    project_id: str = "studio-local"
    version: str = "local"
    openai_api_key: str | None = None
    bedrock_api_key: str | None = None


class ChatRequest(BaseModel):
    message: str
    stream: bool = False


class ChatResponse(BaseModel):
    message_id: str
    content: str
    timestamp: datetime
    streaming_complete: bool = True
    success: bool = True
    error: str | None = None


class UpdateSessionCodeRequest(BaseModel):
    generated_code: str = Field(min_length=1, max_length=400000)


class ConversationListResponse(BaseModel):
    sessions: list[ConversationSession]


class ConversationHistoryResponse(BaseModel):
    session: ConversationSession
    messages: list[ChatMessage]


class MessageListResponse(BaseModel):
    messages: list[ChatMessage]
