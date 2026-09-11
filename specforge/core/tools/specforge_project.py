#!/usr/bin/env python3
"""Shared project-layout, canonical-artifact and material-revision helpers for SpecForge tooling."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import datetime
import hashlib
import re
import subprocess
from typing import Iterable

import yaml

DISTRIBUTION_ROOT_NAMES = frozenset({"specforge-dist"})
TRANSIENT_DIRECTORY_NAMES = frozenset({"__pycache__", ".pytest_cache"})
TRANSIENT_FILE_NAMES = frozenset({".DS_Store", "Thumbs.db"})
TRANSIENT_SUFFIXES = frozenset({".pyc"})
GIT_REVISION_RE = re.compile(r"^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$")
SNAPSHOT_REVISION_RE = re.compile(r"^(?:sha256:)?([0-9a-fA-F]{64})$")


@dataclass(frozen=True)
class ProjectLayout:
    root: Path
    mode: str
    manifest_path: Path
    manifest: dict
    governance_root: Path
    core_root: Path
    record_roots: tuple[Path, ...]
    tool_root: Path


def normalize_yaml_scalars(value):
    if isinstance(value, dict):
        return {k: normalize_yaml_scalars(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize_yaml_scalars(v) for v in value]
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    return value


def load_yaml(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        return normalize_yaml_scalars(yaml.safe_load(handle))


def project_root(candidate: Path) -> Path:
    candidate = candidate.resolve()
    for current in (candidate, *candidate.parents):
        if current.name in DISTRIBUTION_ROOT_NAMES:
            continue
        if (current / "specforge" / "project.yaml").is_file() or (current / "specforge.yaml").is_file():
            return current
    raise FileNotFoundError(f"No SpecForge project manifest found from {candidate}")


def _resolve(root: Path, value: str | None) -> Path | None:
    if not value:
        return None
    return (root / value).resolve()


def discover_layout(candidate: Path) -> ProjectLayout:
    root = project_root(candidate)
    new_manifest = root / "specforge" / "project.yaml"
    legacy_manifest = root / "specforge.yaml"
    if new_manifest.is_file() and legacy_manifest.is_file():
        raise ValueError("ambiguous_project_authority:specforge/project.yaml,specforge.yaml")
    if new_manifest.is_file():
        manifest = load_yaml(new_manifest)
        if not isinstance(manifest, dict):
            raise ValueError("specforge/project.yaml must contain a mapping")
        paths = manifest.get("paths") or {}
        governance_root = root / "specforge"
        core_root = _resolve(root, paths.get("core")) or (governance_root / "core")
        tool_root = _resolve(root, paths.get("tools")) or (core_root / "tools")
        record_roots = []
        for key, default in (
            ("changes", "specforge/changes"),
            ("decisions", "specforge/decisions"),
            ("history", "specforge/history"),
            ("evidence", "specforge/evidence"),
        ):
            record_roots.append(_resolve(root, paths.get(key, default)) or (root / default))
        return ProjectLayout(
            root=root,
            mode="project_format_1",
            manifest_path=new_manifest,
            manifest=manifest,
            governance_root=governance_root,
            core_root=core_root,
            record_roots=tuple(record_roots),
            tool_root=tool_root,
        )

    manifest = load_yaml(legacy_manifest)
    if not isinstance(manifest, dict):
        raise ValueError("specforge.yaml must contain a mapping")
    paths = manifest.get("paths") or {}
    record_roots = []
    for key in ("changes", "history"):
        value = paths.get(key)
        if value:
            record_roots.append(_resolve(root, value))
    return ProjectLayout(
        root=root,
        mode="legacy_root",
        manifest_path=legacy_manifest,
        manifest=manifest,
        governance_root=root,
        core_root=root,
        record_roots=tuple(p for p in record_roots if p is not None),
        tool_root=_resolve(root, paths.get("tools")) or (root / "tools"),
    )


def canonical_artifact_bytes(path: Path) -> bytes:
    """Canonical text bytes for governed-artifact integrity digests."""
    raw = path.read_bytes()
    text = raw.decode("utf-8-sig")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text.encode("utf-8")


def canonical_artifact_digest(path: Path) -> str:
    return hashlib.sha256(canonical_artifact_bytes(path)).hexdigest()


def is_distribution_path(path: Path, root: Path) -> bool:
    try:
        parts = path.resolve().relative_to(root.resolve()).parts
    except ValueError:
        return False
    return bool(parts) and parts[0] in DISTRIBUTION_ROOT_NAMES


def is_nested_project(path: Path, layout: ProjectLayout) -> bool:
    if is_distribution_path(path, layout.root):
        return True
    current = path.parent
    while current != layout.root and layout.root in current.parents:
        if current.name in DISTRIBUTION_ROOT_NAMES:
            return True
        if (current / "specforge" / "project.yaml").is_file() or (current / "specforge.yaml").is_file():
            return True
        current = current.parent
    return False


def iter_record_files(layout: ProjectLayout) -> Iterable[Path]:
    if layout.mode == "project_format_1":
        for record_root in layout.record_roots:
            if not record_root.exists():
                continue
            for path in record_root.rglob("*.yaml"):
                if not is_nested_project(path, layout):
                    yield path
        return

    for path in layout.root.rglob("*.yaml"):
        if path == layout.manifest_path or is_distribution_path(path, layout.root) or is_nested_project(path, layout):
            continue
        yield path


def relative(layout: ProjectLayout, path: Path) -> str:
    return str(path.resolve().relative_to(layout.root)).replace("\\", "/")


def _same_path(left: Path, right: Path) -> bool:
    try:
        return left.samefile(right)
    except (FileNotFoundError, OSError):
        return str(left.resolve()).casefold() == str(right.resolve()).casefold()


def governance_bookkeeping_roots(layout: ProjectLayout) -> tuple[Path, ...]:
    if layout.mode == "project_format_1":
        paths = layout.manifest.get("paths") or {}
        defaults = {
            "changes": "specforge/changes",
            "decisions": "specforge/decisions",
            "history": "specforge/history",
            "evidence": "specforge/evidence",
        }
        return tuple((layout.root / paths.get(key, default)).resolve() for key, default in defaults.items())
    paths = layout.manifest.get("paths") or {}
    roots = []
    for key in ("changes", "history"):
        if paths.get(key):
            roots.append((layout.root / paths[key]).resolve())
    return tuple(roots)


def is_governance_bookkeeping_path(path: Path, layout: ProjectLayout) -> bool:
    candidate = path.resolve()
    for root in governance_bookkeeping_roots(layout):
        try:
            candidate.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def is_transient_material_path(path: Path, layout: ProjectLayout) -> bool:
    try:
        rel = path.resolve().relative_to(layout.root.resolve())
    except ValueError:
        return True
    if any(part in TRANSIENT_DIRECTORY_NAMES for part in rel.parts[:-1]):
        return True
    if rel.name in TRANSIENT_FILE_NAMES or rel.suffix in TRANSIENT_SUFFIXES:
        return True
    return False


def iter_material_files(layout: ProjectLayout) -> Iterable[Path]:
    """Yield files that constitute project material for immutable snapshot purposes."""
    for path in layout.root.rglob("*"):
        if not path.is_file():
            continue
        try:
            rel = path.resolve().relative_to(layout.root.resolve())
        except ValueError:
            continue
        if rel.parts and rel.parts[0] == ".git":
            continue
        if is_distribution_path(path, layout.root) or is_nested_project(path, layout):
            continue
        if is_governance_bookkeeping_path(path, layout):
            continue
        if is_transient_material_path(path, layout):
            continue
        yield path


def material_snapshot(layout: ProjectLayout) -> dict:
    """Return a deterministic content manifest digest for project material."""
    entries = []
    for path in sorted(iter_material_files(layout), key=lambda item: relative(layout, item)):
        rel = relative(layout, path)
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        entries.append((rel, digest))
    manifest_bytes = "".join(f"{rel}\0{digest}\n" for rel, digest in entries).encode("utf-8")
    digest = hashlib.sha256(manifest_bytes).hexdigest()
    return {
        "provider": "specforge_snapshot",
        "algorithm": "sha256",
        "revision": f"sha256:{digest}",
        "digest": digest,
        "file_count": len(entries),
        "entries": [{"path": rel, "sha256": sha} for rel, sha in entries],
    }


def _run_git(layout: ProjectLayout, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(layout.root), *args],
        capture_output=True,
        text=True,
    )


def git_worktree_root(layout: ProjectLayout) -> Path | None:
    try:
        result = _run_git(layout, "rev-parse", "--show-toplevel")
    except (FileNotFoundError, OSError):
        return None
    if result.returncode:
        return None
    text = result.stdout.strip()
    if not text:
        return None
    candidate = Path(text)
    return candidate.resolve() if _same_path(candidate, layout.root) else None


def _looks_git_revision(value) -> bool:
    return isinstance(value, str) and bool(GIT_REVISION_RE.fullmatch(value.strip()))


def _snapshot_digest(value) -> str | None:
    if not isinstance(value, str):
        return None
    match = SNAPSHOT_REVISION_RE.fullmatch(value.strip())
    return match.group(1).lower() if match else None


def _provider_name(value) -> str | None:
    if not value:
        return None
    value = str(value).strip().lower().replace("-", "_")
    aliases = {
        "git": "git",
        "specforge_snapshot": "specforge_snapshot",
        "snapshot": "specforge_snapshot",
        "content_snapshot": "specforge_snapshot",
    }
    return aliases.get(value, value)


def _git_commit_exists(layout: ProjectLayout, revision: str) -> bool:
    result = _run_git(layout, "cat-file", "-e", f"{revision}^{{commit}}")
    return result.returncode == 0


def _git_is_ancestor(layout: ProjectLayout, ancestor: str, descendant: str) -> bool:
    result = _run_git(layout, "merge-base", "--is-ancestor", ancestor, descendant)
    return result.returncode == 0


def _git_material_differences(layout: ProjectLayout, after: str) -> list[str]:
    differences = set()
    tracked = _run_git(layout, "diff", "--name-only", after, "--")
    if tracked.returncode == 0:
        differences.update(line.strip() for line in tracked.stdout.splitlines() if line.strip())
    untracked = _run_git(layout, "ls-files", "--others", "--exclude-standard")
    if untracked.returncode == 0:
        differences.update(line.strip() for line in untracked.stdout.splitlines() if line.strip())
    material = []
    for rel in sorted(differences):
        if is_governance_bookkeeping_path(layout.root / rel, layout):
            continue
        material.append(rel.replace("\\", "/"))
    return material


def verify_source_revision(
    layout: ProjectLayout,
    source_revision: dict | None,
    *,
    mode: str = "static",
    require_provider: bool = False,
) -> dict:
    """Verify provider-neutral immutable material revision evidence.

    `mode='transition'` verifies current material capture and therefore requires the
    backing provider to be available. `mode='static'` validates historical evidence
    without requiring today's material tree to equal an old implementation state.
    """
    source_revision = source_revision or {}
    before = source_revision.get("before")
    after = source_revision.get("after")
    explicit = _provider_name(source_revision.get("system") or source_revision.get("provider"))
    material_effects = source_revision.get("material_effects", True) is not False
    blockers = []
    details = {}

    if not after:
        return {"valid": False, "provider": explicit, "blockers": ["source_revision_after_missing"], "details": details}

    if material_effects and before and str(before) == str(after):
        blockers.append("source_revision_not_advanced")

    git_root = git_worktree_root(layout)
    provider = explicit
    if provider is None:
        if require_provider:
            provider = "git" if git_root is not None else "specforge_snapshot"
        elif git_root is not None and _looks_git_revision(before) and _looks_git_revision(after):
            provider = "git"
        elif _snapshot_digest(before) and _snapshot_digest(after):
            provider = "specforge_snapshot"
        else:
            provider = "legacy"

    if provider == "legacy":
        return {"valid": not blockers, "provider": provider, "blockers": blockers, "details": details}

    if provider == "git":
        if git_root is None:
            details["provider_available"] = False
            if mode == "transition":
                blockers.append("source_revision_provider_unavailable:git")
            return {"valid": not blockers, "provider": provider, "blockers": blockers, "details": details}
        details["provider_available"] = True
        if not isinstance(before, str) or not _git_commit_exists(layout, before):
            blockers.append("source_revision_before_not_git_commit")
        if not isinstance(after, str) or not _git_commit_exists(layout, after):
            blockers.append("source_revision_after_not_git_commit")
        if not blockers:
            if before and not _git_is_ancestor(layout, before, after):
                blockers.append("source_revision_lineage_invalid:before_after")
            head = _run_git(layout, "rev-parse", "HEAD")
            current_head = head.stdout.strip() if head.returncode == 0 else None
            details["head"] = current_head
            if current_head and not _git_is_ancestor(layout, after, current_head):
                blockers.append("source_revision_lineage_invalid:after_head")
            if mode == "transition" and not blockers:
                material_differences = _git_material_differences(layout, after)
                details["material_differences"] = material_differences
                if material_differences:
                    blockers.append("uncaptured_material_changes")
        return {"valid": not blockers, "provider": provider, "blockers": blockers, "details": details}

    if provider == "specforge_snapshot":
        before_digest = _snapshot_digest(before)
        after_digest = _snapshot_digest(after)
        if not before_digest:
            blockers.append("source_revision_before_snapshot_invalid")
        if not after_digest:
            blockers.append("source_revision_after_snapshot_invalid")
        if mode == "transition" and not blockers:
            current = material_snapshot(layout)
            details["current_snapshot"] = current["revision"]
            details["file_count"] = current["file_count"]
            if current["digest"] != after_digest:
                blockers.append("uncaptured_material_changes")
        return {"valid": not blockers, "provider": provider, "blockers": blockers, "details": details}

    blockers.append(f"source_revision_provider_unsupported:{provider}")
    return {"valid": False, "provider": provider, "blockers": blockers, "details": details}
