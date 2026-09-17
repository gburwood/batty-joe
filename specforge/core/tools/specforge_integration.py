#!/usr/bin/env python3
"""Integration-aware immutable material evidence for SpecForge Core."""
from __future__ import annotations

from io import BytesIO
from pathlib import Path
import subprocess
import tarfile
import tempfile

from specforge_project import (
    _git_material_differences,
    discover_layout,
    git_worktree_root,
    material_snapshot,
)

PROFILE = "immutable_material_v3"


def _run_git(layout, *args, text=True):
    return subprocess.run(
        ["git", "-C", str(layout.root), *args],
        capture_output=True,
        text=text,
    )


def _snapshot_revision(value):
    if isinstance(value, dict):
        value = value.get("revision")
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if text.startswith("sha256:") and len(text) == 71:
        body = text[7:]
    elif len(text) == 64:
        body = text
        text = "sha256:" + text
    else:
        return None
    if all(ch in "0123456789abcdef" for ch in body):
        return text
    return None


def _git_commit(layout, value):
    if git_worktree_root(layout) is None or not isinstance(value, str) or not value.strip():
        return None
    result = _run_git(layout, "rev-parse", "--verify", f"{value.strip()}^{{commit}}")
    return result.stdout.strip() if result.returncode == 0 and result.stdout.strip() else None


def _git_is_ancestor(layout, ancestor, descendant):
    if not ancestor or not descendant:
        return False
    return _run_git(layout, "merge-base", "--is-ancestor", ancestor, descendant).returncode == 0


def _safe_extract_tar(raw, destination):
    destination = destination.resolve()
    with tarfile.open(fileobj=BytesIO(raw), mode="r:") as archive:
        for member in archive.getmembers():
            target = (destination / member.name).resolve()
            if target != destination and destination not in target.parents:
                raise ValueError("git_archive_path_escape")
        archive.extractall(destination)


def material_snapshot_for_git_revision(layout, revision):
    """Calculate the canonical material snapshot for an arbitrary Git commit.

    The commit is exported into a temporary directory and passed through the
    ordinary project discovery/material_snapshot boundary. This deliberately
    avoids maintaining a second path-scope or hashing implementation.
    """
    commit = _git_commit(layout, revision)
    if not commit:
        return {
            "valid": False,
            "revision": revision,
            "blockers": ["integration_revision_not_git_commit"],
            "snapshot": None,
        }
    result = _run_git(layout, "archive", "--format=tar", commit, text=False)
    if result.returncode:
        return {
            "valid": False,
            "revision": commit,
            "blockers": ["integration_revision_archive_failed"],
            "snapshot": None,
        }
    try:
        with tempfile.TemporaryDirectory(prefix="specforge-material-") as td:
            root = Path(td)
            _safe_extract_tar(result.stdout, root)
            historical_layout = discover_layout(root)
            snapshot = material_snapshot(historical_layout)
    except Exception as exc:
        return {
            "valid": False,
            "revision": commit,
            "blockers": [f"integration_revision_materialisation_failed:{exc}"],
            "snapshot": None,
        }
    return {"valid": True, "revision": commit, "blockers": [], "snapshot": snapshot}


def capture_target(layout, target_ref):
    """Capture the accepted target state before a Git integration begins."""
    if git_worktree_root(layout) is None:
        return {
            "captured": False,
            "provider": "git",
            "target_ref": target_ref,
            "blockers": ["integration_provider_unavailable:git"],
        }
    target_before = _git_commit(layout, target_ref)
    if not target_before:
        return {
            "captured": False,
            "provider": "git",
            "target_ref": target_ref,
            "blockers": ["integration_target_ref_unresolvable"],
        }
    return {
        "captured": True,
        "provider": "git",
        "profile": PROFILE,
        "target_ref": target_ref,
        "target_before": target_before,
        "blockers": [],
    }


def _first_parent_commits(layout, start, end):
    result = _run_git(layout, "rev-list", "--first-parent", "--reverse", f"{start}..{end}")
    if result.returncode:
        return None
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def discover_integrated_revision(layout, target_before, target_ref, implementation_material):
    """Find the actual target-line commit that first carries implementation material."""
    implementation_material = _snapshot_revision(implementation_material)
    before = _git_commit(layout, target_before)
    target = _git_commit(layout, target_ref)
    if not implementation_material:
        return {"valid": False, "blockers": ["implementation_material_identity_invalid"]}
    if not before:
        return {"valid": False, "blockers": ["integration_target_before_not_git_commit"]}
    if not target:
        return {"valid": False, "blockers": ["integration_target_ref_unresolvable"]}
    if not _git_is_ancestor(layout, before, target):
        return {"valid": False, "blockers": ["integration_target_lineage_invalid:target_before_target_ref"]}
    commits = _first_parent_commits(layout, before, target)
    if commits is None:
        return {"valid": False, "blockers": ["integration_target_first_parent_path_unavailable"]}
    checked = []
    for commit in commits:
        material = material_snapshot_for_git_revision(layout, commit)
        if not material.get("valid"):
            return {"valid": False, "blockers": material.get("blockers") or ["integration_materialisation_failed"]}
        revision = material["snapshot"]["revision"]
        checked.append({"revision": commit, "material": revision})
        if revision == implementation_material:
            return {
                "valid": True,
                "target_before": before,
                "target_revision": target,
                "integrated_revision": commit,
                "implementation_material": implementation_material,
                "checked": checked,
                "blockers": [],
            }
    return {
        "valid": False,
        "target_before": before,
        "target_revision": target,
        "checked": checked,
        "blockers": ["integration_material_not_found_on_target_first_parent_path"],
    }


def build_git_integration_evidence(layout, source_revision, target_ref, target_before, integrated_revision=None):
    """Build authoritative Git integration evidence from observed repository state."""
    source_revision = source_revision or {}
    source_after = source_revision.get("after")
    source_material = material_snapshot_for_git_revision(layout, source_after)
    if not source_material.get("valid"):
        return {"valid": False, "blockers": source_material.get("blockers") or []}
    implementation_material = source_material["snapshot"]["revision"]
    discovery = discover_integrated_revision(layout, target_before, target_ref, implementation_material)
    if not discovery.get("valid"):
        return {"valid": False, "blockers": discovery.get("blockers") or [], "details": discovery}
    discovered = discovery["integrated_revision"]
    if integrated_revision:
        supplied = _git_commit(layout, integrated_revision)
        if not supplied or supplied != discovered:
            return {
                "valid": False,
                "blockers": ["integration_revision_not_mechanically_discovered_target_transition"],
                "details": {"supplied": supplied or integrated_revision, "discovered": discovered},
            }
    integrated_material = material_snapshot_for_git_revision(layout, discovered)
    if not integrated_material.get("valid"):
        return {"valid": False, "blockers": integrated_material.get("blockers") or []}
    return {
        "valid": True,
        "blockers": [],
        "integration": {
            "profile": PROFILE,
            "provider": "git",
            "target_ref": target_ref,
            "target_before": discovery["target_before"],
            "integrated_revision": discovered,
            "implementation_material": {
                "provider": "specforge_snapshot",
                "revision": implementation_material,
                "file_count": source_material["snapshot"]["file_count"],
            },
            "integrated_material": {
                "provider": "specforge_snapshot",
                "revision": integrated_material["snapshot"]["revision"],
                "file_count": integrated_material["snapshot"]["file_count"],
            },
            "verification": {
                "status": "passed",
                "method": "target_first_parent_transition_plus_canonical_material_equivalence",
            },
        },
        "details": {"discovery": discovery},
    }


def build_snapshot_integration_evidence(layout, source_revision):
    """Build direct integration evidence for a provider-neutral snapshot project."""
    source_revision = source_revision or {}
    before = _snapshot_revision(source_revision.get("before"))
    after = _snapshot_revision(source_revision.get("after"))
    blockers = []
    if not before:
        blockers.append("source_revision_before_snapshot_invalid")
    if not after:
        blockers.append("source_revision_after_snapshot_invalid")
    if before and after and source_revision.get("material_effects", True) is not False and before == after:
        blockers.append("source_revision_not_advanced")
    current = material_snapshot(layout)
    if after and current["revision"] != after:
        blockers.append("uncaptured_material_changes")
    if blockers:
        return {"valid": False, "blockers": sorted(set(blockers))}
    material = {
        "provider": "specforge_snapshot",
        "revision": after,
        "file_count": current["file_count"],
    }
    return {
        "valid": True,
        "blockers": [],
        "integration": {
            "profile": PROFILE,
            "provider": "specforge_snapshot",
            "integrated_revision": after,
            "implementation_material": material,
            "integrated_material": dict(material),
            "verification": {
                "status": "passed",
                "method": "direct_canonical_material_identity",
            },
        },
    }


def _verify_source_git_lineage(layout, source_revision, *, required):
    source_revision = source_revision or {}
    before = _git_commit(layout, source_revision.get("before"))
    after = _git_commit(layout, source_revision.get("after"))
    blockers = []
    if not before:
        blockers.append("source_revision_before_not_git_commit")
    if not after:
        blockers.append("source_revision_after_not_git_commit")
    if before and after:
        if source_revision.get("material_effects", True) is not False and before == after:
            blockers.append("source_revision_not_advanced")
        if not _git_is_ancestor(layout, before, after):
            blockers.append("source_revision_lineage_invalid:before_after")
    if required and blockers:
        return None, blockers
    return after, blockers


def verify_integration_evidence(layout, implementation, *, mode="transition"):
    """Verify immutable_material_v3 integration evidence.

    Transition mode recomputes source and integrated material, mechanically derives
    the accepted target-line integration commit and verifies current material capture.
    Static mode preserves historical verification after squash/rebase source commits
    may no longer be reachable, using persisted implementation-material identity plus
    the durable integrated commit on the accepted line.
    """
    implementation = implementation or {}
    source_revision = implementation.get("source_revision") or {}
    integration = implementation.get("integration") or {}
    blockers = []
    details = {"profile": integration.get("profile")}

    if integration.get("profile") != PROFILE:
        blockers.append("integration_profile_missing_or_unsupported")
        return {"valid": False, "profile": integration.get("profile"), "blockers": blockers, "details": details}

    source_provider = str(source_revision.get("system") or source_revision.get("provider") or "").lower().replace("-", "_")
    provider = str(integration.get("provider") or source_provider or "").lower().replace("-", "_")
    implementation_material = _snapshot_revision(integration.get("implementation_material"))
    integrated_material = _snapshot_revision(integration.get("integrated_material"))
    details.update({
        "provider": provider,
        "implementation_material": implementation_material,
        "integrated_material": integrated_material,
    })
    if not implementation_material:
        blockers.append("implementation_material_identity_invalid")
    if not integrated_material:
        blockers.append("integrated_material_identity_invalid")
    if implementation_material and integrated_material and implementation_material != integrated_material:
        blockers.append("integration_material_identity_mismatch")

    if provider == "specforge_snapshot":
        before = _snapshot_revision(source_revision.get("before"))
        source_after = _snapshot_revision(source_revision.get("after"))
        integrated_revision = _snapshot_revision(integration.get("integrated_revision"))
        if not before:
            blockers.append("source_revision_before_snapshot_invalid")
        if not source_after:
            blockers.append("source_revision_after_snapshot_invalid")
        if (
            before
            and source_after
            and source_revision.get("material_effects", True) is not False
            and before == source_after
        ):
            blockers.append("source_revision_not_advanced")
        if not integrated_revision:
            blockers.append("integrated_revision_snapshot_invalid")
        if source_after and implementation_material and source_after != implementation_material:
            blockers.append("source_material_identity_mismatch")
        if integrated_revision and integrated_material and integrated_revision != integrated_material:
            blockers.append("integrated_revision_material_identity_mismatch")
        if mode == "transition" and not blockers:
            current = material_snapshot(layout)
            details["current_material"] = current["revision"]
            if current["revision"] != integrated_material:
                blockers.append("integrated_material_not_current")
        return {
            "valid": not blockers,
            "profile": PROFILE,
            "provider": provider,
            "blockers": sorted(set(blockers)),
            "details": details,
        }

    if provider != "git":
        blockers.append(f"integration_provider_unsupported:{provider or 'missing'}")
        return {"valid": False, "profile": PROFILE, "provider": provider or None, "blockers": blockers, "details": details}

    if git_worktree_root(layout) is None:
        details["provider_available"] = False
        if mode == "transition":
            blockers.append("integration_provider_unavailable:git")
        return {"valid": not blockers, "profile": PROFILE, "provider": provider, "blockers": blockers, "details": details}
    details["provider_available"] = True

    target_ref = integration.get("target_ref")
    target_commit = _git_commit(layout, target_ref) if target_ref else None
    target_before = _git_commit(layout, integration.get("target_before"))
    integrated_revision = _git_commit(layout, integration.get("integrated_revision"))
    if not target_ref:
        blockers.append("integration_target_ref_missing")
    elif mode == "transition" and not target_commit:
        blockers.append("integration_target_ref_unresolvable")
    if not target_before:
        blockers.append("integration_target_before_not_git_commit")
    if not integrated_revision:
        blockers.append("integrated_revision_not_git_commit")
    if target_before and integrated_revision and not _git_is_ancestor(layout, target_before, integrated_revision):
        blockers.append("integration_target_lineage_invalid:target_before_integrated")

    head = _git_commit(layout, "HEAD")
    details["head"] = head
    if integrated_revision and head and not _git_is_ancestor(layout, integrated_revision, head):
        blockers.append("integrated_revision_not_on_current_project_lineage")

    if integrated_revision and integrated_material:
        snapshot = material_snapshot_for_git_revision(layout, integrated_revision)
        if not snapshot.get("valid"):
            blockers += snapshot.get("blockers") or []
        else:
            actual = snapshot["snapshot"]["revision"]
            details["computed_integrated_material"] = actual
            if actual != integrated_material:
                blockers.append("integrated_material_recomputation_mismatch")

    source_after, source_blockers = _verify_source_git_lineage(
        layout,
        source_revision,
        required=mode == "transition",
    )
    if mode == "transition":
        blockers += source_blockers
    else:
        details["source_revision_static_blockers"] = source_blockers
    if source_after and implementation_material:
        source_snapshot = material_snapshot_for_git_revision(layout, source_after)
        if not source_snapshot.get("valid"):
            if mode == "transition":
                blockers += source_snapshot.get("blockers") or []
        else:
            actual = source_snapshot["snapshot"]["revision"]
            details["computed_implementation_material"] = actual
            if actual != implementation_material:
                blockers.append("implementation_material_recomputation_mismatch")

    if target_ref and target_before and implementation_material:
        endpoint = target_commit or ("HEAD" if mode == "static" else None)
        if endpoint:
            discovery = discover_integrated_revision(layout, target_before, endpoint, implementation_material)
            details["discovery"] = discovery
            if not discovery.get("valid"):
                blockers += discovery.get("blockers") or []
            elif integrated_revision and discovery.get("integrated_revision") != integrated_revision:
                blockers.append("integration_revision_not_mechanically_discovered_target_transition")

    if mode == "transition" and integrated_revision:
        material_differences = _git_material_differences(layout, integrated_revision)
        details["material_differences"] = material_differences
        if material_differences:
            blockers.append("uncaptured_material_changes")

    verification = integration.get("verification") or {}
    if verification.get("status") not in {None, "passed"}:
        blockers.append("integration_record_verification_not_passed")

    return {
        "valid": not blockers,
        "profile": PROFILE,
        "provider": provider,
        "blockers": sorted(set(blockers)),
        "details": details,
    }
