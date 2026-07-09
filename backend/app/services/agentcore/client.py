"""boto3 client factories — the only place AgentCore clients are constructed.

Preview API drift is contained here and in the sibling wrapper modules;
everything else passes clients explicitly so tests can inject stubs.
"""

from functools import lru_cache

import boto3

from app.core.config import get_settings


@lru_cache
def control_client():
    return boto3.client("bedrock-agentcore-control", region_name=get_settings().region)


@lru_cache
def data_client():
    return boto3.client("bedrock-agentcore", region_name=get_settings().region)
