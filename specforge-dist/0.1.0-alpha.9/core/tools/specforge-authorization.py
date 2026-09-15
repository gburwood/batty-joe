#!/usr/bin/env python3
"""Implementation-authorization guard for SpecForge controlled mode."""
from pathlib import Path
import argparse
import json
import subprocess
import sys

from specforge_project import (
    canonical_artifact_digest,
    discover_layout,
    git_worktree_root,
    is_governance_bookkeeping_path,
    iter_record_files,
    load_yaml,
    material_snapshot,
    relative,
)


def records(layout):
    out = {}
    for path in iter_record_files(layout):
        try:
            data = load_yaml(path)
        except Exception:
            continue
        if isinstance(data, dict) and data.get("id"):
            out[str(data["id"])] = (data, path)
    return out


def run_git(layout, *args):
    return subprocess.run(["git", "-C", str(layout.root), *args], capture_output=True, text=True)


def git_material_differences(layout, reference):
    differences = set()
    tracked = run_git(layout, "diff", "--name-only", reference, "--")
    if tracked.returncode == 0:
        differences.update(x.strip() for x in tracked.stdout.splitlines() if x.strip())
    untracked = run_git(layout, "ls-files", "--others", "--exclude-standard")
    if untracked.returncode == 0:
        differences.update(x.strip() for x in untracked.stdout.splitlines() if x.strip())
    result = []
    for rel in sorted(differences):
        path = layout.root / rel
        if is_governance_bookkeeping_path(path, layout):
            continue
        if rel.replace("\\", "/").startswith("specforge-dist/"):
            continue
        if "__pycache__" in Path(rel).parts or rel.endswith(".pyc"):
            continue
        result.append(rel.replace("\\", "/"))
    return result


def exact_approval(layout, recs, change):
    proposal_id = (change.get("proposal") or {}).get("current")
    proposal_record = recs.get(str(proposal_id))
    if not proposal_record:
        return None
    proposal, proposal_path = proposal_record
    digest = canonical_artifact_digest(proposal_path)
    for approval_id in change.get("approvals") or []:
        item = recs.get(str(approval_id))
        if not item:
            continue
        approval, _ = item
        if approval.get("change") != change.get("id"):
            continue
        if approval.get("proposal") != proposal_id or approval.get("decision") != "approved":
            continue
        if (approval.get("actor") or {}).get("type") != "human":
            continue
        expected = (approval.get("evidence") or {}).get("proposal_digest") or (approval.get("scope") or {}).get("proposal_sha256")
        if expected == digest:
            return {"approval": approval_id, "proposal": proposal_id, "proposal_digest": digest}
    return None


def active_authorizations(layout, recs):
    items = []
    for rid, (change, _) in recs.items():
        if not rid.startswith("CHG-"):
            continue
        if (change.get("governance") or {}).get("lifecycle_enforcement") != "controlled_v1":
            continue
        if change.get("status") not in {"in_progress", "implemented", "validated"}:
            continue
        approval = exact_approval(layout, recs, change)
        if not approval:
            continue
        for attempt_id in ((change.get("implementation") or {}).get("attempts") or []):
            attempt_item = recs.get(str(attempt_id))
            if not attempt_item:
                continue
            attempt, _ = attempt_item
            if attempt.get("change") != rid or attempt.get("proposal") != approval["proposal"]:
                continue
            if attempt.get("outcome") not in {"in_progress", "implemented", "pending_validation", "passed"}:
                continue
            source = attempt.get("source_revision") or {}
            before = source.get("before")
            provider = str(source.get("system") or source.get("provider") or "").lower().replace("-", "_")
            if not before:
                continue
            items.append({"change": rid, "attempt": attempt_id, "before": before, "provider": provider or None, "approval": approval["approval"]})
    return items


def evaluate(root):
    try:
        layout = discover_layout(root)
    except Exception as exc:
        return {"valid": False, "authorized": False, "blockers": [f"project_discovery_failed:{exc}"], "details": {}}
    recs = records(layout)
    authorizations = active_authorizations(layout, recs)
    git_root = git_worktree_root(layout)
    details = {"project_format_mode": layout.mode, "active_authorizations": authorizations}
    blockers = []

    if git_root is not None:
        head = run_git(layout, "rev-parse", "HEAD")
        current_head = head.stdout.strip() if head.returncode == 0 else None
        details["provider"] = "git"
        details["head"] = current_head
        baseline = current_head
        if authorizations:
            before_values = {item["before"] for item in authorizations if item.get("provider") in {None, "git"}}
            if len(before_values) == 1:
                baseline = next(iter(before_values))
            elif len(before_values) > 1:
                blockers.append("multiple_active_material_authorizations")
        if baseline:
            differences = git_material_differences(layout, baseline)
        else:
            differences = []
        details["material_differences"] = differences
        if differences and not authorizations:
            blockers.append("unauthorized_material_changes")
        if differences and len(authorizations) > 1:
            blockers.append("ambiguous_material_authorization")
        for path in differences:
            if not authorizations:
                blockers.append("unauthorized_material_path:" + path)
        return {"valid": not blockers, "authorized": bool(authorizations), "blockers": sorted(set(blockers)), "details": details}

    details["provider"] = "specforge_snapshot"
    current = material_snapshot(layout)
    details["current_snapshot"] = current["revision"]
    if not authorizations:
        details["note"] = "No active material implementation. Snapshot projects require an authorization baseline before implementation begins."
        return {"valid": True, "authorized": False, "blockers": [], "details": details}
    if len(authorizations) > 1:
        blockers.append("multiple_active_material_authorizations")
    else:
        before = authorizations[0]["before"]
        details["authorized_before"] = before
        if before != current["revision"]:
            details["note"] = "Material differs from the authorized starting snapshot; this is expected only after implementation has begun."
    return {"valid": not blockers, "authorized": bool(authorizations), "blockers": sorted(set(blockers)), "details": details}


def main():
    parser = argparse.ArgumentParser(description="Check whether current material mutation is governed by an active SpecForge implementation authorization.")
    parser.add_argument("--root", default=".")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = evaluate(Path(args.root).resolve())
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        print("SpecForge implementation authorization " + ("PASSED" if result["valid"] else "FAILED"))
        for blocker in result.get("blockers") or []:
            print(" - " + blocker)
    return 0 if result["valid"] else 1


if __name__ == "__main__":
    sys.exit(main())
