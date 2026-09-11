#!/usr/bin/env python3
"""Executable lifecycle gates for SpecForge Controlled mode."""
from pathlib import Path
import argparse
import json
import subprocess
import sys

try:
    import yaml
except ImportError:
    print(json.dumps({"permitted": False, "blockers": ["PyYAML unavailable"]}))
    sys.exit(2)

from specforge_project import (
    canonical_artifact_digest,
    discover_layout,
    iter_record_files,
    load_yaml,
    relative,
    verify_source_revision,
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


def manifest_path(layout, key, default=None):
    paths = layout.manifest.get("paths") or {}
    value = paths.get(key, default)
    if not value:
        return None
    return (layout.root / value).resolve()


def bootstrap(root):
    blockers = []
    details = {}
    try:
        layout = discover_layout(root)
    except Exception as exc:
        return {"ready": False, "blockers": [f"project_discovery_failed:{exc}"], "details": details}

    details["project_format_mode"] = layout.mode
    details["manifest"] = relative(layout, layout.manifest_path)
    sf = layout.manifest.get("specforge") or {}
    details["core_version"] = sf.get("core_version")
    details["project_format"] = sf.get("project_format")

    if layout.mode == "project_format_1":
        entry = layout.root / "specforge" / "SPECFORGE.md"
        if not entry.is_file(): blockers.append("missing:specforge/SPECFORGE.md")
    else:
        entry = layout.root / "SPECFORGE.md"
        if not entry.is_file(): blockers.append("missing:SPECFORGE.md")

    specification = layout.manifest.get("specification") or {}
    for key in ("product_specification", "canonical_data_model"):
        value = specification.get(key)
        target = (layout.root / value).resolve() if value else None
        if not target or not target.is_file(): blockers.append(f"missing_authority:{key}")

    required_paths = ["rules", "workflows", "changes", "history"]
    if layout.mode == "project_format_1": required_paths += ["core", "packs", "decisions", "evidence"]
    for key in required_paths:
        target = manifest_path(layout, key)
        if not target or not target.exists(): blockers.append(f"missing_path:{key}")

    if layout.mode == "project_format_1":
        pack_tool = layout.tool_root / "specforge-pack.py"
        if not pack_tool.is_file():
            blockers.append("pack_resolver_missing")
        else:
            result = subprocess.run([sys.executable, str(pack_tool), "--root", str(layout.root), "--json"], capture_output=True, text=True)
            try: pack_details = json.loads(result.stdout or "{}")
            except Exception: pack_details = {"permitted": False, "blockers": ["pack_resolver_output_invalid"]}
            details["packs"] = pack_details
            if result.returncode or not pack_details.get("permitted"):
                blockers += ["pack:" + x for x in pack_details.get("blockers", ["validation_failed"])]

    validator = layout.tool_root / "validate-specforge.py"
    if not validator.is_file():
        blockers.append("validator_missing")
    else:
        try:
            result = subprocess.run([sys.executable, str(validator), str(layout.root)], capture_output=True, text=True)
            details["repository_validation"] = {"status": "passed" if result.returncode == 0 else "failed", "output": (result.stdout + result.stderr).strip()}
            if result.returncode: blockers.append("repository_validation_failed")
        except Exception as exc:
            details["repository_validation"] = {"status": "blocked", "reason": str(exc)}
            blockers.append("repository_validation_blocked")

    return {"ready": not blockers, "blockers": blockers, "details": details}


def approval_gate(layout, recs, chg):
    blockers = []
    proposal_id = (chg.get("proposal") or {}).get("current")
    if not proposal_id or proposal_id not in recs: return ["current_proposal_missing"]
    _proposal, proposal_path = recs[proposal_id]
    actual = canonical_artifact_digest(proposal_path)
    valid = False
    for approval_id in chg.get("approvals") or []:
        if approval_id not in recs: continue
        approval, _ = recs[approval_id]
        if approval.get("decision") != "approved" or approval.get("proposal") != proposal_id: continue
        if (approval.get("actor") or {}).get("type") != "human": continue
        evidence = approval.get("evidence") or {}
        expected = evidence.get("proposal_digest") or (approval.get("scope") or {}).get("proposal_sha256")
        if expected and expected == actual:
            valid = True; break
    if not valid: blockers.append("valid_exact_human_approval_missing")
    return blockers


def completion_gate(layout, recs, chg):
    blockers = approval_gate(layout, recs, chg)
    ready = bootstrap(layout.root)
    if not ready["ready"]: blockers += ["bootstrap:" + item for item in ready["blockers"]]
    attempts = (chg.get("implementation") or {}).get("attempts") or []
    if not attempts: return blockers + ["implementation_attempt_missing"]

    # A change already recorded as completed may carry pre-alpha.8 historical source
    # evidence. Re-evaluating that terminal state must not retroactively require a
    # live provider. A new transition to completed is strict and verifies that the
    # current material tree is captured by the declared immutable after state.
    historical_terminal = chg.get("status") == "completed"
    passed = []
    source_blockers = []
    for implementation_id in attempts:
        if implementation_id not in recs: continue
        implementation, _ = recs[implementation_id]
        if implementation.get("outcome") != "passed": continue
        checks = implementation.get("validation_checks") or []
        required = [item for item in checks if item.get("required")]
        if not required or any(item.get("status") != "passed" for item in required): continue
        tests = implementation.get("tests") or {}
        test_ok = tests.get("status") == "passed" or (isinstance(tests.get("passed"), list) and tests.get("passed") and not tests.get("failed"))
        if not test_ok: continue

        verification = verify_source_revision(
            layout,
            implementation.get("source_revision") or {},
            mode="static" if historical_terminal else "transition",
            require_provider=not historical_terminal,
        )
        if not verification.get("valid"):
            source_blockers += verification.get("blockers") or []
            for path in (verification.get("details") or {}).get("material_differences") or []:
                source_blockers.append("uncaptured_material_path:" + path)
            continue
        passed.append(implementation_id)

    if not passed:
        blockers += source_blockers
        blockers.append("passed_implementation_with_required_evidence_and_source_revision_missing")
    return blockers


def decision(root, change_id, target):
    try: layout = discover_layout(root)
    except Exception as exc: return {"permitted": False,"change": change_id,"target": target,"blockers": [f"project_discovery_failed:{exc}"]}
    recs = records(layout)
    if change_id not in recs: return {"permitted": False,"change": change_id,"target": target,"blockers": ["change_missing"]}
    chg, _ = recs[change_id]
    governed = (chg.get("governance") or {}).get("lifecycle_enforcement") == "controlled_v1"
    blockers = []
    if governed:
        if target in ("approved", "in_progress", "implemented", "validated", "completed"): blockers += approval_gate(layout, recs, chg)
        if target == "completed": blockers = completion_gate(layout, recs, chg)
    return {"permitted": not blockers,"change": change_id,"current": chg.get("status"),"target": target,"governed": governed,"project_format_mode": layout.mode,"blockers": sorted(set(blockers))}


def main():
    parser = argparse.ArgumentParser(); sub = parser.add_subparsers(dest="cmd", required=True)
    bp = sub.add_parser("bootstrap"); bp.add_argument("--root", default="."); bp.add_argument("--json", action="store_true")
    tp = sub.add_parser("transition"); tp.add_argument("change"); tp.add_argument("--to", required=True); tp.add_argument("--root", default="."); tp.add_argument("--json", action="store_true")
    args = parser.parse_args(); root = Path(args.root).resolve()
    out = bootstrap(root) if args.cmd == "bootstrap" else decision(root, args.change, args.to)
    if args.json: print(json.dumps(out, indent=2))
    else:
        state = "READY" if out.get("ready") else ("PERMITTED" if out.get("permitted") else "REFUSED")
        print(state + "\n" + "\n".join(" - " + item for item in out.get("blockers", [])))
    ok = out.get("ready", out.get("permitted", False)); sys.exit(0 if ok else 1)

if __name__ == "__main__": main()
