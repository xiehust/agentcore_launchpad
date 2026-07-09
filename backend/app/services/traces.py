"""Trace queries — spans from CloudWatch Transaction Search (aws/spans).

Span probing pattern adapted from agentcore_eva_opt backend/app/telemetry.py
(github.com/xiehust/agentcore_eva_opt): term-filter the aws/spans log group,
then keep only events that really contain the session id.
"""

import json
import time
from typing import Any

import boto3

from app.core.config import get_settings

SPANS_LOG_GROUP = "aws/spans"

CATEGORY_RULES = [
    ("policy", ("policy", "authorize")),
    ("memory", ("memory", "createevent", "listevents", "retrieve", "listactors",
                "listsessions")),
    ("tool", ("tool", "hr-database", "office-facts", "gateway", "mcp")),
    ("model", ("chat", "invoke_model", "converse", "anthropic", "bedrock-runtime", "gen_ai")),
    ("runtime", ("invoke_harness", "invokeharness", "runtime", "invocations", "harness",
                 "event_loop")),
]


def find_session_spans(
    logs_client: Any,
    session_id: str,
    lookback_hours: int = 3,
    limit: int = 100,
    max_pages: int = 20,
) -> list[dict[str, Any]]:
    start_ms = int((time.time() - lookback_hours * 3600) * 1000)
    spans: list[dict[str, Any]] = []
    token: str | None = None
    for _ in range(max_pages):
        kwargs: dict[str, Any] = {
            "logGroupName": SPANS_LOG_GROUP,
            "filterPattern": f'"{session_id}"',
            "startTime": start_ms,
            "limit": limit,
        }
        if token:
            kwargs["nextToken"] = token
        response = logs_client.filter_log_events(**kwargs)
        for event in response.get("events", []):
            message = event.get("message", "")
            if session_id not in message:
                continue
            try:
                spans.append(json.loads(message))
            except (ValueError, TypeError):
                continue
        token = response.get("nextToken")
        if not token or len(spans) >= limit:
            break
    return spans[:limit]


def _span_times(span: dict[str, Any]) -> tuple[float | None, float | None]:
    """(start_ms, end_ms) tolerant of OTEL export shape variations."""
    for start_key, end_key, scale in (
        ("startTimeUnixNano", "endTimeUnixNano", 1e6),
        ("startTime", "endTime", 1.0),
    ):
        start, end = span.get(start_key), span.get(end_key)
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            return float(start) / scale, float(end) / scale
        if isinstance(start, str) and isinstance(end, str):
            try:
                return float(start) / scale, float(end) / scale
            except ValueError:
                continue
    return None, None


def categorize(name: str) -> str:
    lowered = name.lower()
    for category, needles in CATEGORY_RULES:
        if any(needle in lowered for needle in needles):
            return category
    return "other"


def normalize_spans(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for span in spans:
        name = str(span.get("name") or span.get("spanName") or "span")
        start_ms, end_ms = _span_times(span)
        rows.append(
            {
                "name": name[:80],
                "category": categorize(name),
                "start_ms": start_ms,
                "duration_ms": (end_ms - start_ms) if start_ms and end_ms else None,
                "trace_id": span.get("traceId") or span.get("trace_id"),
            }
        )
    timed = [r for r in rows if r["start_ms"] is not None]
    if timed:
        origin = min(r["start_ms"] for r in timed)
        for r in rows:
            r["start_ms"] = round(r["start_ms"] - origin, 1) if r["start_ms"] else 0.0
            if r["duration_ms"] is not None:
                r["duration_ms"] = round(r["duration_ms"], 1)
    rows.sort(key=lambda r: r["start_ms"] or 0)
    return rows


def session_trace(session_id: str, lookback_hours: int = 3) -> dict[str, Any]:
    settings = get_settings()
    logs = boto3.client("logs", region_name=settings.region)
    raw = find_session_spans(logs, session_id, lookback_hours=lookback_hours)
    spans = normalize_spans(raw)
    region = settings.region
    return {
        "session_id": session_id,
        "span_count": len(spans),
        "spans": spans,
        "log_group": SPANS_LOG_GROUP,
        "cloudwatch_url": (
            f"https://{region}.console.aws.amazon.com/cloudwatch/home?region={region}"
            "#logsV2:log-groups/log-group/aws$252Fspans"
        ),
    }
