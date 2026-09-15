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
GIT_STATUSES = {"A", "M", "D", "R", "C", "T", "U", "X", "B"}
BOUNDED_LEGACY_MANIFEST_KEYS = {
    "specification.product_specification",
    "specification.current_version",
}
BOOKKEEPING_PATH_KEYS = ("changes", "decisions", "history", "evidence")


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
    if data.get("version") != 2 or data.get("non_authoritative") is not True:
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
        statuses = rule.get("statuses")
        if statuses is not None:
            if not isinstance(statuses, list) or not statuses or not all(isinstance(s, str) and s in GIT_STATUSES for s in statuses):
                raise ClassifierError(f"policy_invalid:statuses:{rid}")
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
    return fnmatch.fnmatchcase(_norm(path), _norm(pattern))


def _normalise_entry(entry: dict[str, Any]) -> dict[str, str]:
    path = _norm(str(entry.get("path") or ""))
    status = str(entry.get("status") or "").upper()[:1]
    if not path:
        raise ClassifierError("diff_entry_missing_path")
    if status not in GIT_STATUSES:
        raise ClassifierError(f"diff_entry_invalid_status:{path}:{status}")
    return {"path": path, "status": status}


def classify_entries(entries: list[dict[str, Any]], policy: dict[str, Any]) -> dict[str, Any]:
    ranks = {k: int(v) for k, v in policy["tiers"].items()}
    material = []
    for raw in entries:
        entry = _normalise_entry(raw)
        if not excluded_by_policy(entry["path"], policy):
            material.append(entry)
    if not material:
        return {
            "classification": "BLOCKED",
            "material_paths": [],
            "git_entries": [],
            "matched_rules": [],
            "blocker": "no_material_paths_after_exclusions",
        }

    path_results = []
    overall_tier = None
    overall_rank = -1
    all_rules = []
    default_tier = policy["defaults"]["unmatched_tier"]
    dedup = {(entry["path"], entry["status"]): entry for entry in material}
    for _, entry in sorted(dedup.items()):
        path, status = entry["path"], entry["status"]
        matches = []
        best_tier = None
        best_rank = -1
        for rule in policy["rules"]:
            statuses = rule.get("statuses")
            if statuses is not None and status not in statuses:
                continue
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
        path_results.append({"path": path, "status": status, "tier": best_tier, "matched_rules": matches})
    return {
        "classification": overall_tier,
        "material_paths": [item["path"] for item in path_results],
        "git_entries": [{"path": item["path"], "status": item["status"]} for item in path_results],
        "matched_rules": sorted(set(all_rules)),
        "path_results": path_results,
        "blocker": None,
    }


def classify_paths(paths: list[str], policy: dict[str, Any]) -> dict[str, Any]:
    """Compatibility helper: a bare path is treated as a newly-added path."""
    return classify_entries([{"path": path, "status": "A"} for path in paths], policy)


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


def _load_yaml_text(text: str, reference: str) -> dict[str, Any]:
    try:
        data = yaml.safe_load(text)
    except Exception as exc:
        raise ClassifierError(f"yaml_parse_failed:{reference}:{exc}") from exc
    if not isinstance(data, dict):
        raise ClassifierError(f"yaml_invalid_mapping:{reference}")
    return data


def bookkeeping_roots_from_manifest_document(document: dict[str, Any]) -> list[str]:
    paths = document.get("paths") or {}
    if not isinstance(paths, dict):
        return []
    roots = []
    for key in BOOKKEEPING_PATH_KEYS:
        value = paths.get(key)
        if not isinstance(value, str) or not value.strip():
            continue
        root = _norm(value.strip()).rstrip("/")
        if root and root != ".":
            roots.append(root)
    return sorted(set(roots))


def is_historical_bookkeeping_path(path: str, roots: list[str]) -> bool:
    candidate = _norm(path).rstrip("/")
    for raw_root in roots:
        root = _norm(raw_root).rstrip("/")
        if root and (candidate == root or candidate.startswith(root + "/")):
            return True
    return False


def _historical_bookkeeping_from_git(root: Path, before: str, after: str) -> dict[str, Any]:
    roots: set[str] = set()
    manifests = []
    for revision in (before, after):
        listed = {
            _norm(line.strip())
            for line in _git(root, "ls-tree", "-r", "--name-only", revision, "--", "specforge.yaml").splitlines()
            if line.strip()
        }
        if "specforge.yaml" not in listed:
            continue
        reference = f"{revision}:specforge.yaml"
        document = _load_yaml_text(_git(root, "show", reference), reference)
        revision_roots = bookkeeping_roots_from_manifest_document(document)
        roots.update(revision_roots)
        manifests.append({"revision": revision, "manifest": "specforge.yaml", "roots": revision_roots})
    return {"roots": sorted(roots), "manifests": manifests}


_MISSING = object()


def _semantic_leaf_differences(before: Any, after: Any, prefix: tuple[str, ...] = ()) -> set[str]:
    if isinstance(before, dict) and isinstance(after, dict):
        changed: set[str] = set()
        for key in sorted(set(before) | set(after), key=str):
            b = before.get(key, _MISSING)
            a = after.get(key, _MISSING)
            child = prefix + (str(key),)
            if b is _MISSING or a is _MISSING:
                changed.add(".".join(child))
            else:
                changed.update(_semantic_leaf_differences(b, a, child))
        return changed
    if before != after:
        return {".".join(prefix) if prefix else "<root>"}
    return set()


def bounded_legacy_manifest_documents(before: dict[str, Any], after: dict[str, Any]) -> dict[str, Any]:
    changed = sorted(_semantic_leaf_differences(before, after))
    bounded = bool(changed) and set(changed).issubset(BOUNDED_LEGACY_MANIFEST_KEYS)
    return {
        "bounded": bounded,
        "changed_keys": changed,
        "allowed_keys": sorted(BOUNDED_LEGACY_MANIFEST_KEYS),
        "reason": "bounded_specification_pointer_update" if bounded else "unbounded_or_non_pointer_manifest_change",
    }


def _bounded_legacy_manifest_from_git(root: Path, before: str, after: str, status: str) -> dict[str, Any]:
    result = {
        "path": "specforge.yaml",
        "status": status,
        "bounded": False,
        "changed_keys": [],
        "allowed_keys": sorted(BOUNDED_LEGACY_MANIFEST_KEYS),
        "reason": "manifest_not_modified",
    }
    if status != "M":
        return result
    before_doc = _load_yaml_text(_git(root, "show", f"{before}:specforge.yaml"), f"{before}:specforge.yaml")
    after_doc = _load_yaml_text(_git(root, "show", f"{after}:specforge.yaml"), f"{after}:specforge.yaml")
    result.update(bounded_legacy_manifest_documents(before_doc, after_doc))
    result["path"] = "specforge.yaml"
    result["status"] = status
    return result


def _parse_name_status(text: str) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        raw_status = fields[0].strip()
        status = raw_status[:1].upper()
        if status not in GIT_STATUSES:
            raise ClassifierError(f"git_diff_unknown_status:{raw_status}")
        if status in {"R", "C"}:
            if len(fields) != 3:
                raise ClassifierError(f"git_diff_malformed_rename_copy:{line}")
            entries.append({"path": _norm(fields[1]), "status": status})
            entries.append({"path": _norm(fields[2]), "status": status})
        else:
            if len(fields) != 2:
                raise ClassifierError(f"git_diff_malformed_entry:{line}")
            entries.append({"path": _norm(fields[1]), "status": status})
    return entries


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
    base = {
        "change": change_id,
        "classification": "BLOCKED",
        "material_paths": [],
        "git_entries": [],
        "matched_rules": [],
        "bounded_manifest": [],
        "historical_bookkeeping": {"roots": [], "manifests": []},
        "blocker": None,
    }
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

        raw_entries = _parse_name_status(_git(root, "diff", "--name-status", before, after, "--"))
        historical_bookkeeping = _historical_bookkeeping_from_git(root, before, after)
        material_entries: list[dict[str, str]] = []
        excluded = []
        bounded_manifest = []
        for raw in raw_entries:
            entry = _normalise_entry(raw)
            path, status = entry["path"], entry["status"]
            try:
                current_bookkeeping = bool(is_bookkeeping(root / path, layout))
            except Exception as exc:
                raise ClassifierError(f"bookkeeping_evaluation_failed:{path}:{exc}") from exc
            historical_bookkeeping_match = is_historical_bookkeeping_path(path, historical_bookkeeping["roots"])
            policy_excluded = excluded_by_policy(path, policy)
            if current_bookkeeping or historical_bookkeeping_match or policy_excluded:
                if current_bookkeeping:
                    reason = "current_layout_bookkeeping"
                elif historical_bookkeeping_match:
                    reason = "historical_manifest_bookkeeping"
                else:
                    reason = "policy_exclusion"
                excluded.append({"path": path, "status": status, "reason": reason})
                continue
            if path == "specforge.yaml":
                manifest = _bounded_legacy_manifest_from_git(root, before, after, status)
                bounded_manifest.append(manifest)
                if manifest["bounded"]:
                    continue
            material_entries.append(entry)

        if not material_entries and bounded_manifest and all(item["bounded"] for item in bounded_manifest):
            base.update({
                "implementation": passed.get("id"),
                "source_revision": {"before": before, "after": after},
                "excluded_paths": excluded,
                "bounded_manifest": bounded_manifest,
                "historical_bookkeeping": historical_bookkeeping,
                "blocker": "bounded_manifest_only_no_risk_bearing_material",
            })
            return base

        verdict = classify_entries(material_entries, policy)
        base.update(verdict)
        base["implementation"] = passed.get("id")
        base["source_revision"] = {"before": before, "after": after}
        base["excluded_paths"] = excluded
        base["bounded_manifest"] = bounded_manifest
        base["historical_bookkeeping"] = historical_bookkeeping
        return base
    except ClassifierError as exc:
        base["blocker"] = str(exc)
        return base
    except Exception as exc:
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
        results = [{
            "change": cid,
            "classification": "BLOCKED",
            "material_paths": [],
            "git_entries": [],
            "matched_rules": [],
            "bounded_manifest": [],
            "historical_bookkeeping": {"roots": [], "manifests": []},
            "blocker": str(exc),
        } for cid in ids]
    payload = {
        "experiment": "CHG-0012",
        "proposal": "PROP-0012-02",
        "non_authoritative": True,
        "policy": str(policy_path),
        "results": results,
    }
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=False))
    else:
        print("CHG-0012 NON-AUTHORITATIVE RETROSPECTIVE CLASSIFIER - CONTROLLED RUN 2")
        for result in results:
            suffix = f" ({result['blocker']})" if result.get("blocker") else ""
            print(f"{result['change']}: {result['classification']}{suffix}")
    return 2 if any(r["classification"] == "BLOCKED" for r in results) else 0


if __name__ == "__main__":
    raise SystemExit(main())
