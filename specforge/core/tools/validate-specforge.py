#!/usr/bin/env python3
from pathlib import Path
import json
import re
import subprocess
import sys

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML is required: pip install pyyaml")
    sys.exit(2)

try:
    import jsonschema
except ImportError:
    print("ERROR: jsonschema is required: pip install jsonschema")
    sys.exit(2)

from specforge_project import (
    canonical_artifact_digest,
    discover_layout,
    iter_record_files,
    load_yaml,
    manifest_core_consistency_blockers,
    read_project_governance_tier_state,
    relative,
    verify_source_revision,
)
from specforge_integration import PROFILE as INTEGRATION_PROFILE, verify_integration_evidence
from specforge_governance_tier import (
    TIER_ORDER,
    GovernanceTierError,
    classify_entries,
    validate_declared_scope,
    verify_policy_archive,
)

ROOT = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd().resolve()
errors = []

TYPE_INFO = [
    ("acceptance-criterion", re.compile(r"^AC-\d{4,}-\d{2,}$")),
    ("implementation-attempt", re.compile(r"^IMP-\d{4,}-\d{2,}$")),
    ("impact-analysis", re.compile(r"^IA-\d{4,}-\d{2,}$")),
    ("proposal", re.compile(r"^PROP-\d{4,}-\d{2,}$")),
    ("requirement", re.compile(r"^REQ-\d{4,}$")),
    ("change", re.compile(r"^CHG-\d{4,}$")),
    ("approval", re.compile(r"^APR-\d{4,}$")),
    ("decision", re.compile(r"^ADR-\d{4,}$")),
    ("forensic-event", re.compile(r"^EVT-\d{6,}$")),
    ("release", re.compile(r"^REL-\d{4,}$")),
    ("build", re.compile(r"^BLD-\d{4,}$")),
    ("environment", re.compile(r"^ENV-[A-Z0-9_-]+$")),
    ("deployment", re.compile(r"^DEP-\d{4,}$")),
]


def classify_id(value):
    for kind, pattern in TYPE_INFO:
        if pattern.match(str(value)):
            return kind
    return None


try:
    layout = discover_layout(ROOT)
except Exception as exc:
    print("SpecForge validation FAILED")
    print(f" - Project discovery failed: {exc}")
    sys.exit(1)

ROOT = layout.root
manifest = layout.manifest
manifest_path = layout.manifest_path

if layout.mode == "project_format_1":
    if not (ROOT / "specforge" / "SPECFORGE.md").is_file():
        errors.append("Missing required file: specforge/SPECFORGE.md")
    sf = manifest.get("specforge") or {}
    if sf.get("project_format") != 1:
        errors.append(f"Unsupported project_format: {sf.get('project_format')}")
    for key in ("specforge", "project", "specification", "paths", "ownership", "policy"):
        if key not in manifest:
            errors.append(f"Manifest missing key: {key}")
else:
    if not (ROOT / "SPECFORGE.md").is_file():
        errors.append("Missing required file: SPECFORGE.md")
    for key in ("specforge", "project", "specification", "paths", "policy"):
        if key not in manifest:
            errors.append(f"Manifest missing key: {key}")

for name, value in (manifest.get("paths") or {}).items():
    values = value if isinstance(value, list) else [value]
    for item in values:
        if not isinstance(item, str):
            continue
        target = (ROOT / item).resolve()
        if not target.exists():
            if name == "packs" and not (manifest.get("packs") or []):
                continue
            if name == "decisions":
                continue
            errors.append(f"Manifest path '{name}' does not exist: {item}")

specification = manifest.get("specification") or {}
for key in ("product_specification", "canonical_data_model"):
    value = specification.get(key)
    if not value and layout.mode != "project_format_1":
        continue
    target = (ROOT / value).resolve() if value else None
    if not target or not target.is_file():
        errors.append(f"Missing authoritative {key}: {value}")

for consistency_blocker in manifest_core_consistency_blockers(layout):
    code = consistency_blocker["code"]
    if code == "core_version_inconsistent":
        errors.append(
            f"Manifest specforge.core_version ({consistency_blocker['declared_core_version']}) does not match "
            f"actually-installed specforge/core/core.yaml's core_version ({consistency_blocker['installed_core_version']})"
        )
    elif code == "data_model_version_inconsistent":
        errors.append(
            f"Manifest specforge.data_model_version ({consistency_blocker['declared_data_model_version']}) does not "
            f"match actually-installed specforge/core/core.yaml's data_model_version ({consistency_blocker['installed_data_model_version']})"
        )
    elif code == "package_core_version_inconsistent":
        errors.append(
            f"specforge/core/package.yaml's declared version ({consistency_blocker['package_version']}) does not "
            f"match actually-installed specforge/core/core.yaml's core_version ({consistency_blocker['installed_core_version']})"
        )
    elif code == "self_referencing_product_specification_inconsistent":
        errors.append(
            f"specification.product_specification self-references a Core product-spec doc embedding version "
            f"{consistency_blocker['embedded_version']}, but declared core_version is "
            f"{consistency_blocker['declared_core_version']} and specification.current_version is "
            f"{consistency_blocker['declared_current_version']} -- all three must agree"
        )
    elif code == "self_referencing_canonical_data_model_inconsistent":
        errors.append(
            f"specification.canonical_data_model self-references a Core canonical-data-model doc embedding version "
            f"{consistency_blocker['embedded_version']}, but declared data_model_version is "
            f"{consistency_blocker['declared_data_model_version']}"
        )

schemas = {}
schema_value = (manifest.get("paths") or {}).get("schemas")
schema_root = (ROOT / schema_value).resolve() if schema_value else (layout.core_root / "schemas")
if schema_root.exists():
    for path in schema_root.glob("*.schema.json"):
        try:
            schemas[path.name.replace(".schema.json", "")] = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            errors.append(f"Cannot parse schema {relative(layout, path)}: {exc}")

records = {}
by_kind = {}
for path in iter_record_files(layout):
    try:
        data = load_yaml(path)
    except Exception as exc:
        errors.append(f"Cannot parse {relative(layout, path)}: {exc}")
        continue
    if not isinstance(data, dict) or not data.get("id"):
        continue
    rid = str(data["id"])
    kind = classify_id(rid)
    if not kind:
        errors.append(f"Unrecognised canonical id {rid} in {relative(layout, path)}")
        continue
    if rid in records:
        errors.append(f"Duplicate canonical id {rid}: {records[rid]['path']} and {relative(layout, path)}")
        continue
    records[rid] = {"kind": kind, "data": data, "path": relative(layout, path), "file": path}
    by_kind.setdefault(kind, {})[rid] = data
    schema = schemas.get(kind)
    if schema:
        try:
            jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(data)
        except jsonschema.ValidationError as exc:
            location = ".".join(str(x) for x in exc.absolute_path) or "<root>"
            errors.append(f"Schema validation failed for {relative(layout, path)} at {location}: {exc.message}")


def exists(rid, kind=None):
    rec = records.get(rid)
    return bool(rec and (kind is None or rec["kind"] == kind))


def require_ref(owner, field, rid, kind=None):
    if rid is None:
        return
    if not exists(str(rid), kind):
        suffix = f" ({kind})" if kind else ""
        errors.append(f"Broken reference in {owner}: {field} -> {rid}{suffix}")


for rid, rec in records.items():
    d, kind, owner = rec["data"], rec["kind"], rec["path"]
    if kind == "requirement":
        intro = d.get("introduced") or {}
        require_ref(owner, "introduced.by_change", intro.get("by_change"), "change")
        for ac in d.get("acceptance_criteria") or []:
            require_ref(owner, "acceptance_criteria", ac, "acceptance-criterion")
    elif kind == "acceptance-criterion":
        require_ref(owner, "requirement", d.get("requirement"), "requirement")
    elif kind == "impact-analysis":
        require_ref(owner, "change", d.get("change"), "change")
    elif kind == "proposal":
        require_ref(owner, "change", d.get("change"), "change")
        for ia in d.get("based_on_impact_analysis") or []:
            require_ref(owner, "based_on_impact_analysis", ia, "impact-analysis")
        for approval in d.get("approvals") or []:
            require_ref(owner, "approvals", approval, "approval")
    elif kind == "approval":
        require_ref(owner, "change", d.get("change"), "change")
        require_ref(owner, "proposal", d.get("proposal"), "proposal")
        proposal = records.get(str(d.get("proposal")))
        if proposal and proposal["data"].get("change") != d.get("change"):
            errors.append(f"Approval/change mismatch in {owner}: proposal {d.get('proposal')} belongs to {proposal['data'].get('change')}")
    elif kind == "implementation-attempt":
        require_ref(owner, "change", d.get("change"), "change")
        require_ref(owner, "proposal", d.get("proposal"), "proposal")
    elif kind == "change":
        ia = (d.get("impact_analysis") or {}).get("current")
        prop = (d.get("proposal") or {}).get("current")
        require_ref(owner, "impact_analysis.current", ia, "impact-analysis")
        require_ref(owner, "proposal.current", prop, "proposal")
        for approval in d.get("approvals") or []:
            require_ref(owner, "approvals", approval, "approval")
        for imp in ((d.get("implementation") or {}).get("attempts") or []):
            require_ref(owner, "implementation.attempts", imp, "implementation-attempt")
        completed = (d.get("release") or {}).get("completed_in")
        if completed:
            require_ref(owner, "release.completed_in", completed, "release")
    elif kind == "release":
        for change in d.get("changes") or []:
            require_ref(owner, "changes", change, "change")
        build = (d.get("build") or {}).get("id")
        if build:
            require_ref(owner, "build.id", build, "build")
        for dep in d.get("deployments") or []:
            require_ref(owner, "deployments", dep, "deployment")
    elif kind == "deployment":
        require_ref(owner, "release", d.get("release"), "release")
        require_ref(owner, "environment", d.get("environment"), "environment")
        build = (d.get("build") or {}).get("id")
        if build:
            require_ref(owner, "build.id", build, "build")

for rid, rec in records.items():
    if rec["kind"] == "proposal":
        if not rid.startswith("PROP-" + str(rec["data"].get("change")).split("-")[-1] + "-"):
            errors.append(f"Proposal ID/change mismatch in {rec['path']}: {rid} vs {rec['data'].get('change')}")
    elif rec["kind"] == "impact-analysis":
        if not rid.startswith("IA-" + str(rec["data"].get("change")).split("-")[-1] + "-"):
            errors.append(f"Impact-analysis ID/change mismatch in {rec['path']}: {rid} vs {rec['data'].get('change')}")

for rid, rec in records.items():
    if rec["kind"] != "change":
        continue
    d = rec["data"]
    if (d.get("governance") or {}).get("lifecycle_enforcement") not in ("controlled_v1", "controlled_v2"):
        continue
    proposal_id = (d.get("proposal") or {}).get("current")
    valid_approval = False
    proposal_rec = records.get(str(proposal_id))
    if proposal_rec:
        actual = canonical_artifact_digest(proposal_rec["file"])
        for approval_id in d.get("approvals") or []:
            approval_rec = records.get(str(approval_id))
            if not approval_rec:
                continue
            approval = approval_rec["data"]
            if approval.get("decision") != "approved" or approval.get("proposal") != proposal_id:
                continue
            if (approval.get("actor") or {}).get("type") != "human":
                continue
            expected = (approval.get("evidence") or {}).get("proposal_digest") or (approval.get("scope") or {}).get("proposal_sha256")
            if expected and expected == actual:
                valid_approval = True
                break
    if d.get("status") in {"approved", "in_progress", "implemented", "validated", "completed"} and not valid_approval:
        errors.append(f"Lifecycle gate violation in {rec['path']}: valid exact human approval missing")
    if d.get("status") == "completed":
        supported = False
        revision_failures = []
        for attempt_id in ((d.get("implementation") or {}).get("attempts") or []):
            attempt_rec = records.get(str(attempt_id))
            if not attempt_rec:
                continue
            attempt = attempt_rec["data"]
            checks = attempt.get("validation_checks") or []
            required = [check for check in checks if check.get("required")]
            tests = attempt.get("tests") or {}
            tests_passed = tests.get("status") == "passed" or (bool(tests.get("passed")) and not tests.get("failed"))
            if not (
                attempt.get("outcome") == "passed"
                and required
                and all(check.get("status") == "passed" for check in required)
                and tests_passed
            ):
                continue
            integration = attempt.get("integration") or {}
            if integration.get("profile") == INTEGRATION_PROFILE:
                revision = verify_integration_evidence(layout, attempt, mode="static")
            else:
                revision = verify_source_revision(
                    layout,
                    attempt.get("source_revision") or {},
                    mode="static",
                    require_provider=False,
                )
            if revision.get("valid"):
                supported = True
                break
            revision_failures += revision.get("blockers") or []
        if not supported:
            detail = ", ".join(sorted(set(revision_failures))) if revision_failures else "missing immutable source/integration revision evidence"
            errors.append(
                f"Lifecycle gate violation in {rec['path']}: completion lacks passing implementation, mandatory validation/test evidence, or verifiable material revision ({detail})"
            )

governance_tier_state = read_project_governance_tier_state(layout)
if governance_tier_state["status"] == "corrupted":
    errors.append(
        "Governance-tier activation state is corrupted: specforge/project.yaml's governance_tier fields and "
        "specforge/evidence/governance-tier-grandfather.yaml are inconsistent (missing, digest mismatch, or an "
        "unrecognised enforcement profile) rather than cleanly not-activated or validly active"
    )

policy_archive_root = (layout.root / (layout.manifest.get("paths") or {}).get("evidence", "specforge/evidence")).resolve() / "governance-tier-policy"
if policy_archive_root.is_dir():
    for archive_path in sorted(policy_archive_root.glob("*.yaml")):
        claimed = archive_path.stem
        actual = canonical_artifact_digest(archive_path)
        if actual != claimed:
            errors.append(
                f"Governance-tier policy archive digest mismatch: {relative(layout, archive_path)} claims "
                f"{claimed} but its actual content digest is {actual}"
            )

POST_APPROVAL_STATES = {"approved", "in_progress", "implemented", "validated", "completed"}
for rid, rec in records.items():
    if rec["kind"] != "change":
        continue
    d = rec["data"]
    declared_profile = (d.get("governance") or {}).get("lifecycle_enforcement")
    if declared_profile not in ("controlled_v1", "controlled_v2"):
        continue
    if d.get("status") not in POST_APPROVAL_STATES:
        continue
    if governance_tier_state["status"] == "corrupted":
        continue

    proposal_id = (d.get("proposal") or {}).get("current")
    proposal_rec = records.get(str(proposal_id))
    proposal_digest = canonical_artifact_digest(proposal_rec["file"]) if proposal_rec else None
    grandfathered = (
        governance_tier_state["status"] == "active"
        and proposal_digest is not None
        and proposal_digest in governance_tier_state["grandfather_digests"]
    )

    if not grandfathered and declared_profile != governance_tier_state["effective_lifecycle_profile"]:
        errors.append(
            f"Governance-tier profile mismatch in {rec['path']}: declares {declared_profile} but the project's "
            f"effective lifecycle profile is {governance_tier_state['effective_lifecycle_profile']} and this "
            f"change's exact current proposal digest is not present in the verified grandfather evidence"
        )
        continue

    if declared_profile != "controlled_v2" or grandfathered:
        continue
    if not proposal_rec:
        continue

    proposal_data = proposal_rec["data"]
    governance_tier = proposal_data.get("governance_tier") or {}
    requested = governance_tier.get("requested")
    policy_digest = governance_tier.get("policy_digest")

    valid_approval = False
    for approval_id in d.get("approvals") or []:
        approval_rec = records.get(str(approval_id))
        if not approval_rec:
            continue
        approval = approval_rec["data"]
        if approval.get("decision") != "approved" or approval.get("proposal") != proposal_id:
            continue
        if (approval.get("actor") or {}).get("type") != "human":
            continue
        expected = (approval.get("evidence") or {}).get("proposal_digest") or (approval.get("scope") or {}).get("proposal_sha256")
        if expected and expected == proposal_digest:
            valid_approval = True
            break
    if not valid_approval:
        errors.append(f"Governance-tier contract violation in {rec['path']}: no exact valid human approval of the current proposal")
        continue

    if requested not in TIER_ORDER:
        errors.append(f"Governance-tier contract violation in {rec['path']}: governance_tier.requested is missing or invalid")
        continue
    if not policy_digest:
        errors.append(f"Governance-tier contract violation in {rec['path']}: proposal was never prepared (governance_tier.policy_digest missing)")
        continue

    archived_policy = verify_policy_archive(layout, policy_digest)
    if archived_policy is None:
        errors.append(
            f"Governance-tier contract violation in {rec['path']}: archived policy {policy_digest} is missing or "
            f"its content digest no longer matches"
        )
        continue

    try:
        entries = validate_declared_scope(proposal_data.get("declared_scope"))
        classification = classify_entries(entries, archived_policy, layout)
        if classification.get("blocker"):
            raise GovernanceTierError(classification["blocker"])
    except GovernanceTierError as exc:
        errors.append(f"Governance-tier contract violation in {rec['path']}: declared scope is missing, malformed, or unclassifiable ({exc})")
        continue

    minimum = classification["classification"]
    if TIER_ORDER[requested] < TIER_ORDER[minimum]:
        errors.append(
            f"Governance-tier contract violation in {rec['path']}: requested_tier {requested} is below the "
            f"archived-policy-recomputed floor {minimum}"
        )

if errors:
    print("SpecForge validation FAILED")
    for error in errors:
        print(f" - {error}")
    sys.exit(1)

authorization_tool = layout.tool_root / "specforge-authorization.py"
if authorization_tool.is_file():
    authorization = subprocess.run(
        [sys.executable, str(authorization_tool), "--root", str(ROOT), "--json"],
        capture_output=True,
        text=True,
    )
    if authorization.returncode:
        print("SpecForge validation FAILED")
        print(" - Implementation authorization integrity check failed")
        if authorization.stdout.strip():
            print(authorization.stdout.strip())
        if authorization.stderr.strip():
            print(authorization.stderr.strip())
        sys.exit(1)
elif layout.mode == "project_format_1":
    print("SpecForge validation FAILED")
    print(" - Implementation authorization tool missing")
    sys.exit(1)

print("SpecForge validation PASSED")
print(f" Repository: {ROOT}")
print(f" Project format mode: {layout.mode}")
print(f" Canonical records discovered: {len(records)}")
print(" Nested SpecForge projects: excluded from parent validation")
