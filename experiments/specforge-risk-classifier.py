#!/usr/bin/env python3
"""Non-authoritative retrospective SpecForge risk classifier (CHG-0012 experiment)."""
from __future__ import annotations

import argparse
import fnmatch
import json
from pathlib import Path
import subprocess
import sys
from typing import Any

try:
    import yaml
except ImportError as exc:  # fail closed
    print(json.dumps({"non_authoritative": True, "error": "PyYAML unavailable", "results": []}))
    raise SystemExit(2) from exc

TIERS = ("LOW", "MEDIUM", "HIGH")


class ClassifierError(RuntimeError):
    pass


def _norm(path: str) -> str:
    path = path.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def load_policy(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ClassifierError(f"policy_load_failed:{exc}") from exc
    if not isinstance(data, dict):
        raise ClassifierError("policy_invalid:not_mapping")
    if data.get("version") != 1 or data.get("non_authoritative") is not True:
        raise ClassifierError("policy_invalid:version_or_authority_flag")
    tiers = data.get("tiers")
    if not isinstance(tiers, dict) or set(tiers) != set(TIERS):
        raise ClassifierError("policy_invalid:tiers")
    try:
        ranks = {name: int(tiers[name]) for name in TIERS}
    except Exception as exc:
        raise ClassifierError("policy_invalid:tier_rank") from exc
    if not (ranks["LOW"] < ranks["MEDIUM"] < ranks["HIGH"]):
        raise ClassifierError("policy_invalid:tier_order")
    default = ((data.get("defaults") or {}).get("unmatched_tier"))
    if default not in TIERS:
        raise ClassifierError("policy_invalid:unmatched_tier")
    rules = data.get("rules")
    if not isinstance(rules, list) or not rules:
        raise ClassifierError("policy_invalid:rules")
    seen = set()
    for rule in rules:
        if not isinstance(rule, dict):
            raise ClassifierError("policy_invalid:rule_not_mapping")
        rid, tier, globs = rule.get("id"), rule.get("tier"), rule.get("globs")
        if not isinstance(rid, str) or not rid or rid in seen:
            raise ClassifierError("policy_invalid:rule_id")
        seen.add(rid)
        if tier not in TIERS or not isinstance(globs, list) or not globs or not all(isinstance(g, str) and g for g in globs):
            raise ClassifierError(f"policy_invalid:rule:{rid}")
    return data


def excluded_by_policy(path: str, policy: dict[str, Any]) -> bool:
    path = _norm(path)
    ex = policy.get("exclusions") or {}
    if any(path.startswith(_norm(p)) for p in ex.get("prefixes") or []):
        return True
    parts = set(Path(path).parts)
    if any(str(part) in parts for part in ex.get("path_parts") or []):
        return True
    if any(path.endswith(str(suffix)) for suffix in ex.get("suffixes") or []):
        return True
    return False


def _matches(path: str, pattern: str) -> bool:
    path, pattern = _norm(path), _norm(pattern)
    return fnmatch.fnmatchcase(path, pattern)


def classify_paths(paths: list[str], policy: dict[str, Any]) -> dict[str, Any]:
    ranks = {k: int(v) for k, v in policy["tiers"].items()}
    material = [_norm(p) for p in paths if not excluded_by_policy(p, policy)]
    if not material:
        return {"classification": "BLOCKED", "material_paths": [], "matched_rules": [], "blocker": "no_material_paths_after_exclusions"}

    path_results = []
    overall_tier = None
    overall_rank = -1
    all_rules = []
    default_tier = policy["defaults"]["unmatched_tier"]
    for path in sorted(set(material)):
        matches = []
        best_tier = None
        best_rank = -1
        for rule in policy["rules"]:
            if any(_matches(path, pattern) for pattern in rule["globs"]):
                matches.append(rule["id"])
                rank = ranks[rule["tier"]]
                if rank > best_rank:
                    best_tier, best_rank = rule["tier"], rank
        if best_tier is None:
            best_tier = default_tier
            best_rank = ranks[best_tier]
            matches = ["default_unmatched_high"]
        if best_rank > overall_rank:
            overall_tier, overall_rank = best_tier, best_rank
        all_rules.extend(matches)
        path_results.append({"path": path, "tier": best_tier, "matched_rules": matches})
    return {
        "classification": overall_tier,
        "material_paths": [item["path"] for item in path_results],
        "matched_rules": sorted(set(all_rules)),
        "path_results": path_results,
        "blocker": None,
    }


def _git(root: Path, *args: str) -> str:
    try:
        result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, timeout=30)
    except Exception as exc:
        raise ClassifierError(f"git_execution_failed:{exc}") from exc
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().replace("\n", " ")
        raise ClassifierError(f"git_failed:{' '.join(args)}:{detail}")
    return result.stdout


def _load_yaml(path: Path) -> dict[str, Any]:
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise ClassifierError(f"yaml_load_failed:{path}:{exc}") from exc
    if not isinstance(data, dict):
        raise ClassifierError(f"yaml_invalid:{path}")
    return data


def _install_core_helpers(root: Path):
    tool_root = root / "specforge" / "core" / "tools"
    if not tool_root.is_dir():
        raise ClassifierError("core_tools_missing")
    sys.path.insert(0, str(tool_root))
    try:
        from specforge_project import discover_layout, is_governance_bookkeeping_path, iter_record_files  # type: ignore
    except Exception as exc:
        raise ClassifierError(f"core_helper_import_failed:{exc}") from exc
    return discover_layout, is_governance_bookkeeping_path, iter_record_files


def _records(root: Path) -> tuple[Any, Any, dict[str, tuple[dict[str, Any], Path]]]:
    discover_layout, is_bookkeeping, iter_record_files = _install_core_helpers(root)
    try:
        layout = discover_layout(root)
    except Exception as exc:
        raise ClassifierError(f"project_discovery_failed:{exc}") from exc
    records: dict[str, tuple[dict[str, Any], Path]] = {}
    for path in iter_record_files(layout):
        try:
            data = _load_yaml(path)
        except ClassifierError:
            continue
        rid = data.get("id")
        if rid:
            records[str(rid)] = (data, path)
    return layout, is_bookkeeping, records


def classify_change(root: Path, change_id: str, policy: dict[str, Any]) -> dict[str, Any]:
    base = {"change": change_id, "classification": "BLOCKED", "material_paths": [], "matched_rules": [], "blocker": None}
    try:
        layout, is_bookkeeping, records = _records(root)
        item = records.get(change_id)
        if not item:
            raise ClassifierError("change_missing")
        change = item[0]
        attempts = ((change.get("implementation") or {}).get("attempts") or [])
        passed = None
        for attempt_id in reversed(attempts):
            rec = records.get(str(attempt_id))
            if rec and rec[0].get("outcome") == "passed":
                passed = rec[0]
                break
        if not passed:
            raise ClassifierError("passed_implementation_missing")
        src = passed.get("source_revision") or {}
        before, after = src.get("before"), src.get("after")
        if not isinstance(before, str) or not isinstance(after, str) or not before or not after:
            raise ClassifierError("source_revision_unresolved")
        raw_paths = [line.strip() for line in _git(root, "diff", "--name-only", before, after, "--").splitlines() if line.strip()]
        material = []
        excluded = []
        for raw in raw_paths:
            path = _norm(raw)
            try:
                bookkeeping = bool(is_bookkeeping(root / path, layout))
            except Exception as exc:
                raise ClassifierError(f"bookkeeping_evaluation_failed:{path}:{exc}") from exc
            if bookkeeping or excluded_by_policy(path, policy):
                excluded.append(path)
            else:
                material.append(path)
        verdict = classify_paths(material, policy)
        base.update(verdict)
        base["implementation"] = passed.get("id")
        base["source_revision"] = {"before": before, "after": after}
        base["excluded_paths"] = sorted(set(excluded))
        return base
    except ClassifierError as exc:
        base["blocker"] = str(exc)
        return base
    except Exception as exc:  # fail closed on unexpected classifier failure
        base["blocker"] = f"classifier_failure:{type(exc).__name__}:{exc}"
        return base


def change_range(start: int, end: int) -> list[str]:
    if start < 1 or end < start:
        raise ClassifierError("invalid_change_range")
    return [f"CHG-{number:04d}" for number in range(start, end + 1)]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--policy", default=None)
    parser.add_argument("--from-change", dest="from_change", type=int, default=1)
    parser.add_argument("--to-change", dest="to_change", type=int, default=11)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    root = Path(args.root).resolve()
    policy_path = Path(args.policy).resolve() if args.policy else root / "experiments" / "specforge-risk-policy.yaml"
    try:
        ids = change_range(args.from_change, args.to_change)
        policy = load_policy(policy_path)
        results = [classify_change(root, cid, policy) for cid in ids]
    except ClassifierError as exc:
        try:
            ids = change_range(args.from_change, args.to_change)
        except ClassifierError:
            ids = []
        results = [{"change": cid, "classification": "BLOCKED", "material_paths": [], "matched_rules": [], "blocker": str(exc)} for cid in ids]
    payload = {
        "experiment": "CHG-0012",
        "non_authoritative": True,
        "policy": str(policy_path),
        "results": results,
    }
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=False))
    else:
        print("CHG-0012 NON-AUTHORITATIVE RETROSPECTIVE CLASSIFIER")
        for result in results:
            suffix = f" ({result['blocker']})" if result.get("blocker") else ""
            print(f"{result['change']}: {result['classification']}{suffix}")
    return 2 if any(r["classification"] == "BLOCKED" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
