"""API key management — keys are stored as sha256 hashes, never plaintext."""

import hashlib
import secrets
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import NotFoundError
from app.models.ledger import ApiKey

router = APIRouter(prefix="/api", tags=["api-keys"])


def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class CreateKeyRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)


def _key_out(key: ApiKey) -> dict[str, Any]:
    return {
        "id": key.id,
        "name": key.name,
        "prefix": key.prefix,
        "enabled": key.enabled,
        "created_at": key.created_at.isoformat() if key.created_at else None,
    }


@router.get("/apikeys")
def list_keys(db: Session = Depends(get_db)) -> dict[str, Any]:
    keys = db.query(ApiKey).order_by(ApiKey.created_at.desc()).all()
    return {"keys": [_key_out(k) for k in keys]}


@router.post("/apikeys", status_code=201)
def create_key(req: CreateKeyRequest, db: Session = Depends(get_db)) -> dict[str, Any]:
    raw = f"lp_live_{secrets.token_hex(16)}"
    key = ApiKey(name=req.name, prefix=raw[:12] + "…", key_hash=hash_key(raw))
    db.add(key)
    db.commit()
    # The full key is returned exactly once; only the hash is at rest.
    return {**_key_out(key), "key": raw}


@router.post("/apikeys/{key_id}/disable")
def disable_key(key_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    key = db.get(ApiKey, key_id)
    if key is None:
        raise NotFoundError("apikey.not_found", "api key not found")
    key.enabled = False
    db.commit()
    return _key_out(key)


@router.post("/apikeys/{key_id}/enable")
def enable_key(key_id: str, db: Session = Depends(get_db)) -> dict[str, Any]:
    key = db.get(ApiKey, key_id)
    if key is None:
        raise NotFoundError("apikey.not_found", "api key not found")
    key.enabled = True
    db.commit()
    return _key_out(key)
