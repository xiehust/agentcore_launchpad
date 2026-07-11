"""Server-Sent Events (SSE) formatting utilities.

Ported verbatim from strands_studio_ui ``backend/app/utils/sse_formatter.py``
(origin/main). Used by the AI-fix codegen stream to frame JSON events
(``event: <type>`` + ``data: <json>``) and the terminal ``event: end``.
"""

import json
from typing import Any


class SSEFormatter:
    """Utility class for formatting Server-Sent Events."""

    @staticmethod
    def format_data(
        data: str, event_type: str = "message", event_id: str | None = None
    ) -> str:
        """Format a raw string payload as an SSE event."""
        sse_lines = []
        if event_id:
            sse_lines.append(f"id: {event_id}")
        sse_lines.append(f"event: {event_type}")
        sse_lines.append(f"data: {data}")
        sse_lines.append("")  # blank line terminates the event
        return "\n".join(sse_lines) + "\n"

    @staticmethod
    def format_json_data(
        data: dict[str, Any], event_type: str = "message", event_id: str | None = None
    ) -> str:
        """Format a JSON-serializable payload as an SSE event."""
        json_data = json.dumps(data, ensure_ascii=False)
        return SSEFormatter.format_data(json_data, event_type, event_id)

    @staticmethod
    def format_error(error_message: str, error_code: str | None = None) -> str:
        """Format an error message as an SSE ``error`` event."""
        error_data: dict[str, Any] = {"error": error_message}
        if error_code:
            error_data["code"] = error_code
        return SSEFormatter.format_json_data(error_data, "error")

    @staticmethod
    def format_end_event() -> str:
        """Terminal ``event: end`` signalling stream completion."""
        return SSEFormatter.format_data("", "end")

    @staticmethod
    def format_heartbeat() -> str:
        """Keep-alive heartbeat event."""
        return SSEFormatter.format_data("ping", "heartbeat")


class StreamingError(Exception):
    """Exception raised during streaming operations."""


class StreamTimeoutError(StreamingError):
    """Exception raised when a streaming operation times out."""


class StreamParsingError(StreamingError):
    """Exception raised when parsing streaming data fails."""
