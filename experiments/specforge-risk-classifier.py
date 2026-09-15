#!/usr/bin/env python3
"""Experimental, non-authoritative retrospective SpecForge risk classifier.

CHG-0012 only. This tool reads repository history and emits classifications. It is
not imported by, and must not influence, any SpecForge lifecycle or authorization
path.
"""
from __future__ import annotations

import argparse
import fnmatch
import json
from pathlib import Path
import subprocess
import sys
from typing import Any

import yaml


class ClassifierError(RuntimeError):
    """A failure that makes trustworthy classification impossible."""


def normalise_path(value: str) -> str:
    return value.strip().replace("\\", "/").lstrip("./")


def load_policy(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ClassifierError(f"policy_load_failed:{exc}") from exc

    if not isinstance(data, dict):
        raise ClassifierError("policy_invalid:not_mapping")
    if data.get("version") != 1:
        raise ClassifierError("policy_invalid:unsupported_version")
    if data.get("non_authoritative") is not True:
        raise ClassifierError("policy_invalid:must_be_non_authoritative")

    tiers = data.get("tiers")
    if not isinstance(tiers, dict) or set(tiers) != {"LOW", "MEDIUM", "HIGH"}:
        raise ClassifierError("policy_invalid:tiers")
    ranks = [tiers[name] for name in ("LOW", "MEDIUM", "HIGH")]
    if any(isinstance(rank, bool) or not isinstance(rank, int) for rank in ranks):
        raise ClassifierError("policy_invalid:tier_ranks")
    if not (ranks[0] < ranks[1] < ranks[2]):
        raise ClassifierError("policy_invalid:tier_order")

    defaults = data.get("defaults")
    if not isinstance(defaults, dict) or defaults.get("unmatched_tier") not in tiers:
        raise ClassifierError("policy_invalid:unmatched_tier")

    exclusions = data.get("exclusions") or {}
    if not isinstance(exclusions, dict):
        raise ClassifierError("policy_invalid:exclusions")
    for key in ("prefixes", "path_parts", "suffixes"):
        values = exclusions.get(key, [])
        if not isinstance(values, list) or any(not isinstance(v, str) or not v for v in values):
            raise ClassifierError(f"policy_invalid:exclusions.{key}")

    rules = data.get("rules")
    if not isinstance(rules, list) or not rules:
        raise ClassifierError("policy_invalid:rules")
    seen_ids: set[str] = set()
    for rule in rules:
        if not isinstance(rule, dict):
            raise ClassifierError("policy_invalid:rule_not_mapping")
        rule_id = rule.get("id")
        if not isinstance(rule_id, str) or not rule_id or rule_id in seen_ids:
            raise ClassifierError("policy_invalid:rule_id")
        seen_ids.add(rule_id)
        if rule.get("tier") not in tiers:
            raise ClassifierError(f"policy_invalid:rule_tier:{rule_id}")
        globs = rule.get("globs")
        if not isinstance(globs, list) or not globs or any(not isinstance(g, str) or not g for g in globs):
            raise ClassifierError(f"policy_invalid:rule_globs:{rule_id}")
    return data


def excluded_by_policy(path: str, policy: dict[str, Any]) -> bool:
    path = normalise_path(path)
    exclusions = policy.get("exclusions") or {}
    if any(path.startswith(normalise_path(prefix)) for prefix in exclusions.get("prefixes", [])):
        return True
    parts = set(Path(path).parts)
    if any(part in parts for part in exclusions.get("path_parts", [])):
        return True
    if any(path.endswith(suffix) for suffix in exclusions.get("suffixes", [])):
        return True
    return False


def classify_paths(paths: list[str], policy: dict[str, Any]) -> dict[str, Any]:
    tiers = policy["tiers"]
    unmatched_tier = policy["defaults"]["unmatched_tier"]
    material_paths = sorted({normalise_path(path) for path in paths if path and not excluded_by_policy(path, policy)})
    if not material_paths:
        return {
            "classification": "BLOCKED",
            "material_paths": [],
            "matched_rules": [],
            "path_results": [],
            "blocker": "no_material_paths_after_exclusions",
        }

    path_results: list[dict[str, Any]] = []
    matched_rule_ids: set[str] = set()
    overall_tier = "LOW"

    for path in material_paths:
        matches: list[dict[str, Any]] = []
        for rule in policy["rules"]:
            if any(fnmatch.fnmatchcase(path, pattern) for pattern in rule["globs"]):
                matches.append(rule)

        if matches:
            winning_rank = max(tiers[rule["tier"]] for rule in matches)
            path_tier = next(name for name, rank in tiers.items() if rank == winning_rank)
            rule_ids = sorted(rule["id"] for rule in matches)
            matched_rule_ids.update(rule_ids)
        else:
            path_tier = unmatched_tier
            rule_ids = ["default_unmatched_high"]
            matched_rule_ids.add("default_unmatched_high")

        if tiers[path_tier] > tiers[overall_tier]:
            overall_tier = path_tier
        path_results.append({"path": path, "tier": path_tier, "matched_rules": rule_ids})

    return {
        "classification": overall_tier,
        "material_paths": material_paths,
        "matched_rules": sorted(matched_rule_ids),
        "path_results": path_results,
        "blocker": None,
    }


def run_git(root: Path, *args: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *args],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception as exc:
        raise ClassifierError(f"git_execution_failed:{exc}") from exc
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().replace("\n", " ")
        raise ClassifierError(f"git_failed:{' '.join(args)}:{detail}")
    return result.stdout


def install_core_helpers(root: Path):
    tool_root = (root / "specforge" / "core" / "tools").resolve()
    if not tool_root.is_dir():
        raise ClassifierError("core_tool_root_missing")
    tool_text = str(tool_root)
    if tool_text not in sys.path:
        sys.path.insert(0, tool_text)
    try:
        from specforge_project import discover_layout, is_governance_bookkeeping_path, iter_record_files, load_yaml
    except Exception as exc:
        raise ClassifierError(f"core_helper_import_failed:{exc}") from exc
    return discover_layout, is_governance_bookkeeping_path, iter_record_files, load_yaml


def discover_records(root: Path):
    discover_layout, is_governance_bookkeeping_path, iter_record_files, load_yaml = install_core_helpers(root)
    try:
        layout = discover_layout(root)
    except Exception as exc:
        raise ClassifierError(f"project_discovery_failed:{exc}") from exc

    records: dict[str, tuple[dict[str, Any], Path]] = {}
    for path in iter_record_files(layout):
        try:
            data = load_yaml(path)
        except Exception:
            continue
        if isinstance(data, dict) and data.get("id"):
            records[str(data["id"])] = (data, path)
    return layout, records, is_governance_bookkeeping_path


def blocked(change_id: str, reason: str, implementation: str | None = None) -> dict[str, Any]:
    return {
        "change": change_id,
        "implementation": implementation,
        "classification": "BLOCKED",
        "material_paths": [],
        "excluded_paths": [],
        "matched_rules": [],
        "path_results": [],
        "source_revision": None,
        "blocker": reason,
    }


def classify_change(root: Path, change_id: str, policy: dict[str, Any]) -> dict[str, Any]:
    try:
        layout, records, is_governance_bookkeeping_path = discover_records(root)
        entry = records.get(change_id)
        if not entry:
            return blocked(change_id, "change_missing")
        change = entry[0]

        attempts = (change.get("implementation") or {}).get("attempts") or []
        if not isinstance(attempts, list):
            return blocked(change_id, "implementation_attempts_invalid")

        selected_id = None
        selected = None
        for attempt_id in reversed(attempts):
            candidate = records.get(str(attempt_id))
            if candidate and candidate[0].get("outcome") == "passed":
                selected_id = str(attempt_id)
                selected = candidate[0]
                break
        if selected is None:
            return blocked(change_id, "passed_implementation_missing")

        source = selected.get("source_revision") or {}
        before = source.get("before")
        after = source.get("after")
        if not isinstance(before, str) or not before or not isinstance(after, str) or not after:
            return blocked(change_id, "source_revision_incomplete", selected_id)

        # Resolve both revisions independently. Failure is BLOCKED, never a guessed result.
        run_git(root, "cat-file", "-e", f"{before}^{{commit}}")
        run_git(root, "cat-file", "-e", f"{after}^{{commit}}")
        changed = [normalise_path(line) for line in run_git(root, "diff", "--name-only", before, after, "--").splitlines() if line.strip()]

        material: list[str] = []
        excluded: list[dict[str, str]] = []
        for path in changed:
            if excluded_by_policy(path, policy):
                excluded.append({"path": path, "reason": "transient_or_distribution"})
                continue
            if is_governance_bookkeeping_path(layout.root / path, layout):
                excluded.append({"path": path, "reason": "governance_bookkeeping"})
                continue
            material.append(path)

        result = classify_paths(material, policy)
        result.update(
            {
                "change": change_id,
                "implementation": selected_id,
                "source_revision": {"before": before, "after": after},
                "excluded_paths": sorted(excluded, key=lambda item: item["path"]),
            }
        )
        return result
    except ClassifierError as exc:
        return blocked(change_id, str(exc))
    except Exception as exc:
        return blocked(change_id, f"classifier_failure:{type(exc).__name__}:{exc}")


def change_range(first: int, last: int) -> list[str]:
    if first < 1 or last < first:
        raise ClassifierError("invalid_change_range")
    return [f"CHG-{number:04d}" for number in range(first, last + 1)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--policy", default="experiments/specforge-risk-policy.yaml")
    parser.add_argument("--from-change", type=int, default=1)
    parser.add_argument("--to-change", type=int, default=11)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    root = Path(args.root).resolve()
    policy_path = Path(args.policy)
    if not policy_path.is_absolute():
        policy_path = root / policy_path

    try:
        policy = load_policy(policy_path)
        ids = change_range(args.from_change, args.to_change)
        results = [classify_change(root, change_id, policy) for change_id in ids]
        payload = {
            "experiment": "CHG-0012",
            "non_authoritative": True,
            "policy": str(policy_path.relative_to(root)).replace("\\", "/") if policy_path.is_relative_to(root) else str(policy_path),
            "results": results,
        }
    except ClassifierError as exc:
        payload = {
            "experiment": "CHG-0012",
            "non_authoritative": True,
            "policy": str(policy_path),
            "results": [],
            "blocker": str(exc),
        }
        print(json.dumps(payload, indent=2))
        return 2

    if args.json:
        print(json.dumps(payload, indent=2))
    else:
        for item in results:
            suffix = f" ({item['blocker']})" if item.get("blocker") else ""
            print(f"{item['change']}: {item['classification']}{suffix}")

    return 2 if any(item["classification"] == "BLOCKED" for item in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
