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
        path = layout.root / rel
        if is_governance_bookkeeping_path(path, layout):
            continue
        if is_distribution_path(path, layout.root):
            continue
        if is_transient_material_path(path, layout):
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


def approval_gate(layout, recs, chg):
    """Verify an exact, digest-bound, human approval of the change's current proposal.

    Shared by specforge-lifecycle.py, specforge_governance_tier.py and the governance-tier
    CLI wrapper: a single implementation, imported everywhere it is needed.
    """
    blockers = []
    proposal_id = (chg.get("proposal") or {}).get("current")
    if not proposal_id or proposal_id not in recs:
        return ["current_proposal_missing"]
    _proposal, proposal_path = recs[proposal_id]
    actual = canonical_artifact_digest(proposal_path)
    valid = False
    for approval_id in chg.get("approvals") or []:
        if approval_id not in recs:
            continue
        approval, _ = recs[approval_id]
        if approval.get("decision") != "approved" or approval.get("proposal") != proposal_id:
            continue
        if (approval.get("actor") or {}).get("type") != "human":
            continue
        evidence = approval.get("evidence") or {}
        expected = evidence.get("proposal_digest") or (approval.get("scope") or {}).get("proposal_sha256")
        if expected and expected == actual:
            valid = True
            break
    if not valid:
        blockers.append("valid_exact_human_approval_missing")
    return blockers


def proposal_ever_human_approved(recs, proposal_id):
    """True if any record anywhere is a human, decision=approved approval of this proposal id.

    Ignores whether the recorded digest still matches today's bytes: this is a historical
    existence check, used to keep preparation from ever mutating a proposal that has already
    been human-approved, even after its bytes were tampered with post-approval.
    """
    for _rid, item in recs.items():
        data = item[0] if isinstance(item, tuple) else item
        if not isinstance(data, dict):
            continue
        if data.get("proposal") != proposal_id:
            continue
        if data.get("decision") != "approved":
            continue
        if (data.get("actor") or {}).get("type") != "human":
            continue
        return True
    return False


def allocate_next_event_id(layout):
    """Return the next unused EVT-NNNNNN id, scanning specforge/history/events/ for the current max."""
    paths = layout.manifest.get("paths") or {}
    history_root = (layout.root / paths.get("history", "specforge/history")).resolve()
    events_root = history_root / "events"
    pattern = re.compile(r"^EVT-(\d{6,})\.yaml$")
    highest = 0
    if events_root.is_dir():
        for path in events_root.glob("EVT-*.yaml"):
            match = pattern.match(path.name)
            if match:
                highest = max(highest, int(match.group(1)))
    return f"EVT-{(highest + 1) if highest else 100000:06d}"


def _evidence_root(layout) -> Path:
    paths = layout.manifest.get("paths") or {}
    return (layout.root / paths.get("evidence", "specforge/evidence")).resolve()


def persist_material_manifest(layout) -> dict:
    """Durably persist the current material snapshot's full path/digest manifest.

    Digest-addressed and idempotent under specforge/evidence/material-manifests/<digest>.yaml,
    so a snapshot-provider "before" state can later be reconstructed into add/modify/delete
    entries even after the working tree has moved on. The real production hook for this is
    specforge-revision.py's capture() command, not direct calls made ad hoc.
    """
    snapshot = material_snapshot(layout)
    digest = snapshot["digest"]
    manifest_root = _evidence_root(layout) / "material-manifests"
    manifest_root.mkdir(parents=True, exist_ok=True)
    target = manifest_root / f"{digest}.yaml"
    if not target.is_file():
        payload = {"revision": snapshot["revision"], "entries": snapshot["entries"]}
        target.write_text(
            yaml.safe_dump(payload, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
            newline="\n",
        )
    return {"digest": digest, "path": target}


def read_material_manifest(layout, digest: str) -> dict | None:
    """Read and digest-verify a manifest persisted by persist_material_manifest.

    Returns None (fail closed for the caller) if the manifest is missing, malformed, or its
    recomputed digest does not match the requested identity.
    """
    target = _evidence_root(layout) / "material-manifests" / f"{digest}.yaml"
    if not target.is_file():
        return None
    try:
        data = load_yaml(target)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    entries = data.get("entries")
    if not isinstance(entries, list) or not all(isinstance(e, dict) and "path" in e and "sha256" in e for e in entries):
        return None
    manifest_bytes = "".join(f"{e['path']}\0{e['sha256']}\n" for e in sorted(entries, key=lambda e: e["path"])).encode("utf-8")
    if hashlib.sha256(manifest_bytes).hexdigest() != digest:
        return None
    return {"revision": data.get("revision"), "entries": entries}


GOVERNANCE_TIER_PROFILE_TO_LIFECYCLE = {"deterministic_tier_v1": "controlled_v2"}

# Closed set of lifecycle_enforcement values recognised as governed and material-authorizing.
# Shared wherever a change's declared profile must be checked against supported values, so an
# unrecognised or future profile is never silently treated as governed or as an active material
# authorization -- extend this set explicitly, never via a wildcard or prefix match.
SUPPORTED_LIFECYCLE_ENFORCEMENT_PROFILES = frozenset({"controlled_v1", "controlled_v2"})


def read_project_governance_tier_state(layout) -> dict:
    """Read and integrity-verify this project's governance-tier activation state.

    Returns {status, tier_enforcement_profile, effective_lifecycle_profile, grandfather_digests}.
    status is one of "not_activated" (both project.yaml fields absent; controlled_v1 is the
    only valid declaration), "active" (both fields present, internally consistent, and the
    grandfather evidence file's recomputed digest matches the project.yaml anchor), or
    "corrupted" (any other combination, including an unrecognised tier_enforcement_profile) —
    corrupted always fails closed and is never conflated with not_activated.
    """
    manifest_tier = layout.manifest.get("governance_tier")
    manifest_tier = manifest_tier if isinstance(manifest_tier, dict) else {}
    tier_enforcement_profile = manifest_tier.get("enforcement_profile")
    anchor = manifest_tier.get("grandfather_digest")

    corrupted = {
        "status": "corrupted",
        "tier_enforcement_profile": tier_enforcement_profile,
        "effective_lifecycle_profile": None,
        "grandfather_digests": frozenset(),
    }

    if tier_enforcement_profile is None and anchor is None:
        return {
            "status": "not_activated",
            "tier_enforcement_profile": None,
            "effective_lifecycle_profile": "controlled_v1",
            "grandfather_digests": frozenset(),
        }
    if tier_enforcement_profile is None or anchor is None:
        return corrupted

    effective_lifecycle_profile = GOVERNANCE_TIER_PROFILE_TO_LIFECYCLE.get(tier_enforcement_profile)
    if effective_lifecycle_profile is None:
        return corrupted

    evidence_path = _evidence_root(layout) / "governance-tier-grandfather.yaml"
    if not evidence_path.is_file():
        return corrupted
    try:
        actual_digest = canonical_artifact_digest(evidence_path)
        evidence = load_yaml(evidence_path)
    except Exception:
        return corrupted
    if actual_digest != anchor or not isinstance(evidence, dict):
        return corrupted

    digests = evidence.get("proposal_digests")
    if not isinstance(digests, list):
        return corrupted

    return {
        "status": "active",
        "tier_enforcement_profile": tier_enforcement_profile,
        "effective_lifecycle_profile": effective_lifecycle_profile,
        "grandfather_digests": frozenset(str(d) for d in digests),
    }


PRODUCT_SPEC_DOC_RE = re.compile(r"^specforge-core-product-spec-(.+)\.md$")
PRODUCT_SPEC_DOC_TEMPLATE = "specforge-core-product-spec-{version}.md"
CANONICAL_DATA_MODEL_DOC_RE = re.compile(r"^specforge-core-canonical-data-model-(.+)\.md$")
CANONICAL_DATA_MODEL_DOC_TEMPLATE = "specforge-core-canonical-data-model-{version}.md"


def read_installed_core_metadata(layout) -> dict:
    """Read the actually-installed core.yaml/package.yaml beneath layout.core_root.

    Returns {"core": dict|None, "package": dict|None}; either is None if the file is
    missing or does not parse to a mapping (fail-soft: callers treat that as "nothing to
    compare against" rather than a hard error of their own).
    """
    core_path = layout.core_root / "core.yaml"
    package_path = layout.core_root / "package.yaml"
    core = load_yaml(core_path) if core_path.is_file() else None
    package = load_yaml(package_path) if package_path.is_file() else None
    return {
        "core": core if isinstance(core, dict) else None,
        "package": package if isinstance(package, dict) else None,
    }


def self_referencing_core_doc_version(layout, value, pattern) -> str | None:
    """Return the version embedded in a specification path's filename if `value` matches
    `pattern` (PRODUCT_SPEC_DOC_RE or CANONICAL_DATA_MODEL_DOC_RE) and resolves beneath
    layout.core_root/docs; otherwise None (not a self-reference to Core's own doc at all).

    Matches by filename pattern and location only, never by project id, project name, or
    any other identity signal.
    """
    if not value:
        return None
    match = pattern.match(Path(str(value)).name)
    if not match:
        return None
    try:
        resolved = (layout.root / str(value)).resolve()
    except Exception:
        return None
    try:
        resolved.relative_to((layout.core_root / "docs").resolve())
    except ValueError:
        return None
    return match.group(1)


def manifest_core_consistency_blockers(layout, manifest: dict | None = None) -> list[dict]:
    """Compare a project manifest's declared Core/data-model/package identity, and any
    recognised self-referencing specification field, against the actually-installed
    core.yaml/package.yaml beneath layout.core_root.

    Returns a list of blocker dicts, each {"code": str, ...context}; empty when fully
    consistent. Shared, single-source-of-truth predicate: validate-specforge.py calls this
    against the currently-installed manifest, and specforge-upgrade.py's pre-upgrade
    preflight calls it against the manifest before any mutation -- at that point
    layout.core_root still reflects the pre-upgrade installed Core, so both callers compare
    against the same kind of ground truth without any special-casing.
    """
    manifest = manifest if manifest is not None else layout.manifest
    installed = read_installed_core_metadata(layout)
    core_meta = installed["core"] or {}
    package_meta = installed["package"]

    sf = manifest.get("specforge") or {}
    spec = manifest.get("specification") or {}
    declared_core_version = sf.get("core_version")
    declared_data_model_version = sf.get("data_model_version")
    installed_core_version = core_meta.get("core_version")
    installed_data_model_version = core_meta.get("data_model_version")

    blockers = []

    if installed_core_version and declared_core_version != installed_core_version:
        blockers.append({
            "code": "core_version_inconsistent",
            "declared_core_version": declared_core_version,
            "installed_core_version": installed_core_version,
        })

    if installed_data_model_version and declared_data_model_version != installed_data_model_version:
        blockers.append({
            "code": "data_model_version_inconsistent",
            "declared_data_model_version": declared_data_model_version,
            "installed_data_model_version": installed_data_model_version,
        })

    if package_meta is not None and installed_core_version:
        package_version = (package_meta.get("package") or {}).get("version")
        if package_version != installed_core_version:
            blockers.append({
                "code": "package_core_version_inconsistent",
                "package_version": package_version,
                "installed_core_version": installed_core_version,
            })

    product_spec_embedded = self_referencing_core_doc_version(layout, spec.get("product_specification"), PRODUCT_SPEC_DOC_RE)
    if product_spec_embedded is not None:
        declared_current_version = spec.get("current_version")
        if product_spec_embedded != declared_core_version or declared_current_version != declared_core_version:
            blockers.append({
                "code": "self_referencing_product_specification_inconsistent",
                "embedded_version": product_spec_embedded,
                "declared_core_version": declared_core_version,
                "declared_current_version": declared_current_version,
            })

    data_model_embedded = self_referencing_core_doc_version(layout, spec.get("canonical_data_model"), CANONICAL_DATA_MODEL_DOC_RE)
    if data_model_embedded is not None and data_model_embedded != declared_data_model_version:
        blockers.append({
            "code": "self_referencing_canonical_data_model_inconsistent",
            "embedded_version": data_model_embedded,
            "declared_data_model_version": declared_data_model_version,
        })

    return blockers
