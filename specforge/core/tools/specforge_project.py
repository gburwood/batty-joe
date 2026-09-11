#!/usr/bin/env python3
"""Shared project-layout and canonical-artifact helpers for SpecForge tooling."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import datetime
import hashlib
from typing import Iterable

import yaml

DISTRIBUTION_ROOT_NAMES = frozenset({"specforge-dist"})


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
