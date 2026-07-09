#!/usr/bin/env python3
"""Fail if en and zh-CN locale files don't share identical key sets."""

import json
import sys
from pathlib import Path

LOCALES = Path(__file__).resolve().parent.parent / "frontend" / "src" / "locales"
BASE, OTHER = "en", "zh-CN"


def flatten(obj: dict, prefix: str = "") -> set[str]:
    keys: set[str] = set()
    for k, v in obj.items():
        path = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            keys |= flatten(v, path)
        else:
            keys.add(path)
    return keys


def main() -> int:
    base_dir, other_dir = LOCALES / BASE, LOCALES / OTHER
    if not base_dir.is_dir() or not other_dir.is_dir():
        print(f"i18n_check: missing locale dir ({base_dir} or {other_dir})")
        return 1

    failed = False
    base_files = sorted(p.name for p in base_dir.glob("*.json"))
    other_files = sorted(p.name for p in other_dir.glob("*.json"))
    if base_files != other_files:
        print(f"i18n_check: namespace files differ: {BASE}={base_files} {OTHER}={other_files}")
        failed = True

    for name in base_files:
        if name not in other_files:
            continue
        en_keys = flatten(json.loads((base_dir / name).read_text(encoding="utf-8")))
        zh_keys = flatten(json.loads((other_dir / name).read_text(encoding="utf-8")))
        only_en = sorted(en_keys - zh_keys)
        only_zh = sorted(zh_keys - en_keys)
        if only_en or only_zh:
            failed = True
            if only_en:
                print(f"i18n_check: {name}: missing in {OTHER}: {only_en}")
            if only_zh:
                print(f"i18n_check: {name}: missing in {BASE}: {only_zh}")
        else:
            print(f"i18n_check: {name}: {len(en_keys)} keys, parity OK")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
