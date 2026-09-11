#!/usr/bin/env python3
from pathlib import Path
import json
import re
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

from specforge_project import canonical_artifact_digest, discover_layout, iter_record_files, load_yaml, relative

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
            errors.append(f"Manifest path '{name}' does not exist: {item}")

specification = manifest.get("specification") or {}
for key in ("product_specification", "canonical_data_model"):
    value = specification.get(key)
    # Project format 1 makes both authorities explicit and mandatory. Legacy projects may
    # predate that contract, so validate a declared authority but do not invent a missing one.
    if not value and layout.mode != "project_format_1":
        continue
    target = (ROOT / value).resolve() if value else None
    if not target or not target.is_file():
        errors.append(f"Missing authoritative {key}: {value}")

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
    if (d.get("governance") or {}).get("lifecycle_enforcement") != "controlled_v1":
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
        for attempt_id in ((d.get("implementation") or {}).get("attempts") or []):
            attempt_rec = records.get(str(attempt_id))
            if not attempt_rec:
                continue
            attempt = attempt_rec["data"]
            checks = attempt.get("validation_checks") or []
            required = [check for check in checks if check.get("required")]
            tests = attempt.get("tests") or {}
            tests_passed = tests.get("status") == "passed" or (bool(tests.get("passed")) and not tests.get("failed"))
            if (
                attempt.get("outcome") == "passed"
                and required
                and all(check.get("status") == "passed" for check in required)
                and tests_passed
                and (attempt.get("source_revision") or {}).get("after")
            ):
                supported = True
        if not supported:
            errors.append(f"Lifecycle gate violation in {rec['path']}: completion lacks passing implementation, mandatory validation/test evidence, or source revision")

if errors:
    print("SpecForge validation FAILED")
    for error in errors:
        print(f" - {error}")
    sys.exit(1)

print("SpecForge validation PASSED")
print(f" Repository: {ROOT}")
print(f" Project format mode: {layout.mode}")
print(f" Canonical records discovered: {len(records)}")
print(" Nested SpecForge projects: excluded from parent validation")
