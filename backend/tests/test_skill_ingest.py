"""Skill ingest pipeline: zip acquire safety, unwrap, validation, inline path."""

import io
import stat
import zipfile

import pytest

from app.services import skill_ingest as si
from app.services.skill_ingest import SkillValidationError

SKILL_MD = (
    "---\nname: meeting-summarizer\ndescription: Summarize meetings\n"
    "version: 0.2.0\n---\n# Meeting summarizer\n"
)


def _make_zip(entries: dict[str, str | bytes], symlinks: dict[str, str] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
        for name, target in (symlinks or {}).items():
            info = zipfile.ZipInfo(name)
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
            zf.writestr(info, target)
    return buf.getvalue()


def test_bundle_from_inline_reads_frontmatter():
    bundle = si.bundle_from_inline(SKILL_MD)
    try:
        assert bundle.name == "meeting-summarizer"
        assert bundle.description == "Summarize meetings"
        assert bundle.version == "0.2.0"
        assert bundle.files == ["SKILL.md"]
        assert bundle.source.kind == "inline"
        assert (bundle.root / "SKILL.md").is_file()
    finally:
        bundle.close()


def test_inline_version_defaults():
    bundle = si.bundle_from_inline("---\nname: x-skill\n---\n# x")
    try:
        assert bundle.version == "0.1.0"
        assert bundle.description == ""
    finally:
        bundle.close()


def test_bundle_from_zip_normal_multifile():
    data = _make_zip({
        "SKILL.md": SKILL_MD,
        "scripts/helper.py": "print('hi')\n",
        "references/doc.md": "# doc\n",
    })
    bundle = si.bundle_from_zip(data)
    try:
        assert bundle.name == "meeting-summarizer"
        assert bundle.files == ["SKILL.md", "references/doc.md", "scripts/helper.py"]
        assert bundle.source.kind == "zip"
        si.validate_bundle(bundle)  # no raise
        assert si.bundle_errors(bundle) == []
    finally:
        bundle.close()


def test_bundle_from_zip_unwraps_single_top_dir():
    # GitHub archive shape: everything under a lone repo-ref/ wrapper directory.
    data = _make_zip({
        "meeting-summarizer-main/SKILL.md": SKILL_MD,
        "meeting-summarizer-main/scripts/helper.py": "x\n",
    })
    bundle = si.bundle_from_zip(data)
    try:
        assert (bundle.root / "SKILL.md").is_file()
        assert bundle.files == ["SKILL.md", "scripts/helper.py"]
    finally:
        bundle.close()


def test_zip_path_traversal_rejected():
    data = _make_zip({"SKILL.md": SKILL_MD, "../evil.md": "pwn"})
    with pytest.raises(SkillValidationError, match="escapes"):
        si.bundle_from_zip(data)


def test_zip_absolute_path_rejected():
    info_name = "/etc/passwd"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("SKILL.md", SKILL_MD)
        zi = zipfile.ZipInfo(info_name)
        zf.writestr(zi, "root:x:0:0")
    with pytest.raises(SkillValidationError, match="absolute"):
        si.bundle_from_zip(buf.getvalue())


def test_zip_symlink_rejected():
    data = _make_zip({"SKILL.md": SKILL_MD}, symlinks={"link": "/etc/passwd"})
    with pytest.raises(SkillValidationError, match="symlink"):
        si.bundle_from_zip(data)


def test_zip_bomb_cumulative_size_aborted(monkeypatch):
    # Streaming abort: a small cap + content over it must raise before finishing.
    monkeypatch.setattr(si, "SKILL_BUNDLE_MAX_BYTES", 256)
    data = _make_zip({"SKILL.md": SKILL_MD, "big.bin": "A" * 4096})
    with pytest.raises(SkillValidationError, match="uncompressed limit"):
        si.bundle_from_zip(data)


def test_zip_file_count_cap(monkeypatch):
    monkeypatch.setattr(si, "SKILL_FILE_COUNT_MAX", 3)
    data = _make_zip({"SKILL.md": SKILL_MD, "a": "1", "b": "2", "c": "3"})
    with pytest.raises(SkillValidationError, match="more than 3 files"):
        si.bundle_from_zip(data)


def test_zip_missing_skill_md_is_invalid():
    data = _make_zip({"scripts/helper.py": "x\n"})
    bundle = si.bundle_from_zip(data)
    try:
        errors = si.bundle_errors(bundle)
        assert any("missing SKILL.md" in e for e in errors)
        with pytest.raises(SkillValidationError):
            si.validate_bundle(bundle)
    finally:
        bundle.close()


def test_zip_oversized_skill_md_is_invalid():
    big_md = "---\nname: big-skill\n---\n" + ("x" * (si.SKILL_MD_MAX_BYTES + 100))
    data = _make_zip({"SKILL.md": big_md})
    bundle = si.bundle_from_zip(data)
    try:
        errors = si.bundle_errors(bundle)
        assert any("SKILL.md" in e and "exceeds" in e for e in errors)
    finally:
        bundle.close()


def test_bad_zip_rejected():
    with pytest.raises(SkillValidationError, match="not a valid zip"):
        si.bundle_from_zip(b"not a zip at all")


def test_parse_frontmatter_robust():
    assert si.parse_frontmatter("no frontmatter") == {}
    assert si.parse_frontmatter("---\nname: x\n---\nbody")["name"] == "x"
    assert si.parse_frontmatter("---\n: : bad yaml : :\n---\n") == {}
