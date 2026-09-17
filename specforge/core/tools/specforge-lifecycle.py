#!/usr/bin/env python3
"""Executable lifecycle gates for SpecForge Controlled mode."""
from pathlib import Path
import argparse
import json
import os
import subprocess
import sys

try:
    import yaml
except ImportError:
    print(json.dumps({"permitted": False, "blockers": ["PyYAML unavailable"]}))
    sys.exit(2)

from specforge_project import (
    approval_gate,
    canonical_artifact_digest,
    discover_layout,
    iter_record_files,
    load_yaml,
    read_project_governance_tier_state,
    relative,
    verify_source_revision,
)
from specforge_integration import PROFILE as INTEGRATION_PROFILE, verify_integration_evidence
from specforge_governance_tier import completion_tier, floor_check, stale_policy_check


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


def _python_env():
    env = os.environ.copy()
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def material_revision_profile(layout):
    core = layout.core_root / "core.yaml"
    try:
        data = load_yaml(core)
    except Exception:
        return None
    return ((data or {}).get("material_revision") or {}).get("verification_profile")


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
    details["material_revision_profile"] = material_revision_profile(layout)

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
            result = subprocess.run(
                [sys.executable, "-B", str(pack_tool), "--root", str(layout.root), "--json"],
                capture_output=True,
                text=True,
                env=_python_env(),
            )
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
            result = subprocess.run(
                [sys.executable, "-B", str(validator), str(layout.root)],
                capture_output=True,
                text=True,
                env=_python_env(),
            )
            details["repository_validation"] = {"status": "passed" if result.returncode == 0 else "failed", "output": (result.stdout + result.stderr).strip()}
            if result.returncode: blockers.append("repository_validation_failed")
        except Exception as exc:
            details["repository_validation"] = {"status": "blocked", "reason": str(exc)}
            blockers.append("repository_validation_blocked")

    return {"ready": not blockers, "blockers": blockers, "details": details}


def _active_profile_and_v2_extras(layout, recs, chg, raw_profile):
    """The controlled_v2 fresh-approval-only checks, run at target=='approved' for every
    controlled change regardless of declared profile.

    Applies the active-profile/grandfather rule uniformly first (a v2-active project must
    refuse a fresh, ungrandfathered controlled_v1 declaration just as much as a mismatched
    v2 one); only once that profile is accepted, and only if it is controlled_v2, does
    preparation completeness / staleness / the floor additionally apply. Never re-run for
    any later transition (in_progress, implemented, validated, completed).
    """
    blockers = []
    state = read_project_governance_tier_state(layout)
    if state["status"] == "corrupted":
        return ["governance_tier_activation_state_corrupted"]

    proposal_id = (chg.get("proposal") or {}).get("current")
    proposal_digest = None
    if proposal_id in recs:
        try:
            proposal_digest = canonical_artifact_digest(recs[proposal_id][1])
        except Exception:
            proposal_digest = None
    grandfathered = proposal_digest is not None and proposal_digest in state["grandfather_digests"]

    if raw_profile != state["effective_lifecycle_profile"] and not grandfathered:
        return ["governance_tier_profile_mismatch"]

    if raw_profile != "controlled_v2":
        return blockers

    if proposal_id not in recs:
        return ["current_proposal_missing"]
    proposal, _ = recs[proposal_id]
    if not (proposal.get("governance_tier") or {}).get("policy_digest"):
        return ["governance_tier_not_prepared"]
    blockers += stale_policy_check(layout, proposal)
    blockers += floor_check(layout, proposal)
    return blockers


def _implementation_verification(layout, implementation, historical_terminal):
    source_revision = implementation.get("source_revision") or {}
    integration = implementation.get("integration") or {}
    declared_profile = integration.get("profile") or source_revision.get("verification_profile")
    current_profile = material_revision_profile(layout)
    material_effects = source_revision.get("material_effects", True) is not False

    if historical_terminal:
        if integration.get("profile") == INTEGRATION_PROFILE:
            return verify_integration_evidence(layout, implementation, mode="static")
        return verify_source_revision(
            layout,
            source_revision,
            mode="static",
            require_provider=False,
        )

    if current_profile == INTEGRATION_PROFILE:
        if not material_effects:
            return verify_source_revision(
                layout,
                source_revision,
                mode="transition",
                require_provider=True,
            )
        if declared_profile != INTEGRATION_PROFILE or integration.get("profile") != INTEGRATION_PROFILE:
            return {
                "valid": False,
                "blockers": ["integration_evidence_required_by_current_material_profile"],
                "details": {"required_profile": INTEGRATION_PROFILE, "declared_profile": declared_profile},
            }
        return verify_integration_evidence(layout, implementation, mode="transition")

    return verify_source_revision(
        layout,
        source_revision,
        mode="transition",
        require_provider=True,
    )


def completion_gate(layout, recs, chg):
    blockers = approval_gate(layout, recs, chg)
    ready = bootstrap(layout.root)
    if not ready["ready"]: blockers += ["bootstrap:" + item for item in ready["blockers"]]
    attempts = (chg.get("implementation") or {}).get("attempts") or []
    if not attempts: return blockers + ["implementation_attempt_missing"]

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

        verification = _implementation_verification(layout, implementation, historical_terminal)
        if not verification.get("valid"):
            source_blockers += verification.get("blockers") or []
            for path in (verification.get("details") or {}).get("material_differences") or []:
                source_blockers.append("uncaptured_material_path:" + path)
            continue

        if (chg.get("governance") or {}).get("lifecycle_enforcement") == "controlled_v2":
            tier_result = completion_tier(layout, recs, implementation)
            if not tier_result.get("valid") or tier_result.get("blockers"):
                source_blockers += tier_result.get("blockers") or ["governance_tier_completion_check_failed"]
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
    raw_profile = (chg.get("governance") or {}).get("lifecycle_enforcement")
    governed = raw_profile in ("controlled_v1", "controlled_v2")
    blockers = []
    if raw_profile and not governed:
        blockers.append(f"unsupported_lifecycle_enforcement:{raw_profile}")
    if governed:
        if target in ("approved", "in_progress", "implemented", "validated", "completed"): blockers += approval_gate(layout, recs, chg)
        if target == "approved": blockers += _active_profile_and_v2_extras(layout, recs, chg, raw_profile)
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
