"""Shared runtime environment derivation for AgentCore deployers."""

from collections.abc import Mapping
from typing import Any

from app.schemas.agent import AgentSpec


def runtime_environment(
    spec: AgentSpec, resources: Mapping[str, Any]
) -> dict[str, str]:
    """Merge user environment with platform-owned runtime values."""
    environment = dict(spec.env)
    memory_id = resources.get("memory_id")
    if (spec.memory.short_term or spec.memory.long_term) and memory_id:
        environment["LAUNCHPAD_MEMORY_ID"] = str(memory_id)
    return environment
