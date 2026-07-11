"""Skill ingestion pipeline — acquire skill bundles from diverse sources and
converge them into one ``SkillBundle`` abstraction the registry console uploads
to S3.

AWS Registry AGENT_SKILLS records only carry inline descriptors (``skillMd`` +
``skillDefinition``, each ≤100KB); the multi-file bundle真身 lives in
``s3://{artifacts_bucket}/skills/{name}/`` and the deploy-time packager
(``deployer/zip_runtime.py``) downloads the whole prefix. This module is the
producer side: every source resolves to a staging directory + metadata,
validated once, before ``registry_console.register_skill_bundle`` uploads the
files and creates the record.

The acquirer seam (``bundle_from_*``) is designed so later sources — git shallow
clone, url fetch — plug in as new functions returning the same ``SkillBundle``;
only ``inline`` and ``zip`` are implemented here.
"""

import io
import re
import stat
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Any, Literal

import yaml

from app.core.errors import AppError

# Shared caps — the single source of truth for skill limits. The deploy-time
# consumer (deployer/zip_runtime.py) imports SKILL_BUNDLE_MAX_BYTES so producer
# and consumer never drift.
SKILL_MD_MAX_BYTES = 102_400  # AWS skillMd.inlineContent cap
SKILL_BUNDLE_MAX_BYTES = 50 * 1024 * 1024  # per-skill S3 bundle cap
SKILL_FILE_COUNT_MAX = 200
SKILL_NAME_RE = re.compile(r"^[a-z][a-z0-9-]{2,63}$")

_DEFAULT_VERSION = "0.1.0"
_CHUNK = 1024 * 1024
_EXCERPT_CHARS = 4000


class SkillValidationError(AppError):
    """A bundle failed validation (bad content, unsafe archive, oversize …).

    Subclasses AppError so it flows through the standard error envelope as a
    422; callers doing per-item import catch it to report failures individually.
    """

    def __init__(self, message: str, detail: Any = None):
        super().__init__("registry.skill_invalid", message, detail=detail, status_code=422)


@dataclass
class SkillSource:
    """Provenance stamped into ``skillDefinition.inlineContent.source``."""

    kind: Literal["inline", "zip", "git", "url"]
    url: str | None = None
    ref: str | None = None
    subdir: str | None = None
    imported_at: str = ""  # ISO8601 UTC, stamped at registration time


@dataclass
class SkillBundle:
    """A skill staged on local disk plus the metadata the registry needs.

    ``root`` holds ``SKILL.md`` at its top level (after any unwrapping) and any
    supporting files. The owning ``TemporaryDirectory`` is kept alive via
    ``_tmp`` so the staging directory survives between the inspect and import
    requests; ``close()`` releases it.
    """

    root: Path
    name: str
    description: str
    version: str
    files: list[str]  # POSIX-relative paths under root, sorted
    skill_md: str
    source: SkillSource
    _tmp: TemporaryDirectory | None = field(default=None, repr=False, compare=False)

    def close(self) -> None:
        if self._tmp is not None:
            self._tmp.cleanup()
            self._tmp = None


def parse_frontmatter(markdown: str) -> dict[str, Any]:
    """Parse a leading ``---`` YAML frontmatter block; ``{}`` when absent/broken.

    Shared with registry_console (which re-exports it for backward compat).
    """
    if not markdown.startswith("---"):
        return {}
    try:
        _, frontmatter, _ = markdown.split("---", 2)
    except ValueError:
        return {}
    try:
        loaded = yaml.safe_load(frontmatter)
    except yaml.YAMLError:
        return {}
    return loaded if isinstance(loaded, dict) else {}


# ---------- acquirers (return a bundle whose files are already on disk) ----------

def bundle_from_inline(skill_md: str) -> SkillBundle:
    """A single-file bundle from raw SKILL.md text (the legacy paste path)."""
    tmp = TemporaryDirectory(prefix="skill-inline-")
    root = Path(tmp.name)
    (root / "SKILL.md").write_text(skill_md, encoding="utf-8")
    return _bundle_from_dir(root, SkillSource(kind="inline"), tmp)


def bundle_from_zip(data: bytes) -> SkillBundle:
    """Extract a zip bundle safely, unwrap a single top-level dir, and describe
    it. Raises SkillValidationError on any archive-safety violation (bad zip,
    absolute/traversal paths, symlinks, zip bomb, file-count overflow)."""
    tmp = TemporaryDirectory(prefix="skill-zip-")
    try:
        _extract_zip_safely(data, Path(tmp.name))
        root = _unwrap_single_top_dir(Path(tmp.name))
        return _bundle_from_dir(root, SkillSource(kind="zip"), tmp)
    except BaseException:
        tmp.cleanup()
        raise


# ---------- validation ----------

def bundle_errors(bundle: SkillBundle) -> list[str]:
    """Content-level validation errors (empty list = valid). Used by inspect to
    report per-skill status; ``validate_bundle`` raises on the same set."""
    errors: list[str] = []
    skill_md_path = bundle.root / "SKILL.md"
    if not skill_md_path.is_file():
        errors.append("missing SKILL.md at bundle root")
    else:
        md_bytes = skill_md_path.stat().st_size
        if md_bytes > SKILL_MD_MAX_BYTES:
            errors.append(
                f"SKILL.md is {md_bytes} bytes — exceeds the {SKILL_MD_MAX_BYTES} byte limit"
            )
    if len(bundle.files) > SKILL_FILE_COUNT_MAX:
        errors.append(f"{len(bundle.files)} files — exceeds the {SKILL_FILE_COUNT_MAX} file limit")
    total = _dir_size(bundle.root)
    if total > SKILL_BUNDLE_MAX_BYTES:
        errors.append(f"bundle is {total} bytes — exceeds the {SKILL_BUNDLE_MAX_BYTES} byte limit")
    return errors


def validate_bundle(bundle: SkillBundle) -> None:
    """Raise SkillValidationError if the bundle is not importable."""
    errors = bundle_errors(bundle)
    if errors:
        raise SkillValidationError("; ".join(errors), detail=errors)


# ---------- internals ----------

def _bundle_from_dir(root: Path, source: SkillSource, tmp: TemporaryDirectory) -> SkillBundle:
    files = sorted(
        p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()
    )
    skill_md_path = root / "SKILL.md"
    skill_md = (
        skill_md_path.read_text(encoding="utf-8", errors="replace")
        if skill_md_path.is_file()
        else ""
    )
    meta = parse_frontmatter(skill_md)
    return SkillBundle(
        root=root,
        name=str(meta.get("name", "") or "").strip(),
        description=str(meta.get("description", "") or "").strip(),
        version=str(meta.get("version", "") or "").strip() or _DEFAULT_VERSION,
        files=files,
        skill_md=skill_md,
        source=source,
        _tmp=tmp,
    )


def _unwrap_single_top_dir(root: Path) -> Path:
    """Descend into a lone wrapper directory (e.g. GitHub archive ``repo-ref/``)
    when the root has no SKILL.md but its single top-level entry is a directory
    that does."""
    if (root / "SKILL.md").is_file():
        return root
    entries = list(root.iterdir())
    if len(entries) == 1 and entries[0].is_dir() and (entries[0] / "SKILL.md").is_file():
        return entries[0]
    return root


def _extract_zip_safely(data: bytes, dest: Path) -> None:
    """Extract every file entry into ``dest`` while enforcing archive safety:
    reject symlinks, absolute paths, and ``..`` traversal; cap file count; and
    abort mid-stream once actually-decompressed bytes exceed the bundle cap
    (defends against a zip bomb that lies about its declared sizes)."""
    dest_root = dest.resolve()
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise SkillValidationError("uploaded file is not a valid zip archive") from exc

    total = 0
    count = 0
    with archive as zf:
        for info in zf.infolist():
            name = info.filename
            if _is_symlink(info):
                raise SkillValidationError(f"zip entry '{name}' is a symlink — refused")
            _reject_unsafe_name(name)
            if info.is_dir():
                continue
            target = (dest / name).resolve()
            if not _is_within(target, dest_root):
                raise SkillValidationError(f"zip entry '{name}' escapes the bundle root")
            count += 1
            if count > SKILL_FILE_COUNT_MAX:
                raise SkillValidationError(
                    f"zip has more than {SKILL_FILE_COUNT_MAX} files"
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as out:
                while True:
                    chunk = src.read(_CHUNK)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > SKILL_BUNDLE_MAX_BYTES:
                        raise SkillValidationError(
                            f"bundle exceeds the {SKILL_BUNDLE_MAX_BYTES} byte uncompressed limit"
                        )
                    out.write(chunk)


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    return stat.S_ISLNK(info.external_attr >> 16)


def _reject_unsafe_name(name: str) -> None:
    norm = name.replace("\\", "/")
    if norm.startswith("/"):
        raise SkillValidationError(f"zip entry '{name}' uses an absolute path")
    if len(norm) >= 2 and norm[1] == ":":  # Windows drive letter (C:/...)
        raise SkillValidationError(f"zip entry '{name}' uses an absolute path")
    if ".." in PurePosixPath(norm).parts:
        raise SkillValidationError(f"zip entry '{name}' escapes the bundle root")


def _is_within(target: Path, root: Path) -> bool:
    return target == root or root in target.parents


def _dir_size(root: Path) -> int:
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
