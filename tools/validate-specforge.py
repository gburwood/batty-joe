#!/usr/bin/env python3
from pathlib import Path
import json, re, sys

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

def normalize_yaml_scalars(value):
    import datetime
    if isinstance(value, dict):
        return {k: normalize_yaml_scalars(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalize_yaml_scalars(v) for v in value]
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    return value

def load_yaml(path):
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
        return normalize_yaml_scalars(data)

def rel(path):
    return str(path.relative_to(ROOT)).replace("\\", "/")

def classify_id(value):
    for kind, pattern in TYPE_INFO:
        if pattern.match(str(value)):
            return kind
    return None

def is_nested_project(path):
    current = path.parent
    while current != ROOT and ROOT in current.parents:
        if (current / "specforge.yaml").exists():
            return True
        current = current.parent
    return False

# Bootstrap contract
for required in ("SPECFORGE.md", "specforge.yaml"):
    if not (ROOT / required).exists():
        errors.append(f"Missing required file: {required}")

manifest = None
manifest_path = ROOT / "specforge.yaml"
if manifest_path.exists():
    try:
        manifest = load_yaml(manifest_path)
        if not isinstance(manifest, dict):
            errors.append("specforge.yaml must contain a mapping")
            manifest = None
        else:
            for key in ("specforge", "project", "specification", "paths", "policy"):
                if key not in manifest:
                    errors.append(f"Manifest missing key: {key}")
    except Exception as exc:
        errors.append(f"Cannot parse specforge.yaml: {exc}")

# Validate manifest path declarations.
if manifest:
    for name, value in (manifest.get("paths") or {}).items():
        values = value if isinstance(value, list) else [value]
        for item in values:
            if not isinstance(item, str):
                continue
            target = (ROOT / item).resolve()
            if not target.exists():
                errors.append(f"Manifest path '{name}' does not exist: {item}")

# Load schemas.
schemas = {}
schema_root = ROOT / ((manifest or {}).get("paths", {}).get("schemas", "./schemas"))
if schema_root.exists():
    for path in schema_root.glob("*.schema.json"):
        try:
            schemas[path.name.replace(".schema.json", "")] = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            errors.append(f"Cannot parse schema {rel(path)}: {exc}")

records = {}
by_kind = {}

# Only inspect this project. A descendant containing specforge.yaml is another project boundary.
for path in ROOT.rglob("*.yaml"):
    if path == manifest_path or is_nested_project(path):
        continue
    try:
        data = load_yaml(path)
    except Exception as exc:
        errors.append(f"Cannot parse {rel(path)}: {exc}")
        continue
    if not isinstance(data, dict) or not data.get("id"):
        continue

    rid = str(data["id"])
    kind = classify_id(rid)
    if not kind:
        errors.append(f"Unrecognised canonical id {rid} in {rel(path)}")
        continue

    if rid in records:
        errors.append(f"Duplicate canonical id {rid}: {records[rid]['path']} and {rel(path)}")
        continue

    records[rid] = {"kind": kind, "data": data, "path": rel(path)}
    by_kind.setdefault(kind, {})[rid] = data

    schema = schemas.get(kind)
    if schema:
        try:
            jsonschema.Draft202012Validator(schema, format_checker=jsonschema.FormatChecker()).validate(data)
        except jsonschema.ValidationError as exc:
            location = ".".join(str(x) for x in exc.absolute_path) or "<root>"
            errors.append(f"Schema validation failed for {rel(path)} at {location}: {exc.message}")

def exists(rid, kind=None):
    rec = records.get(rid)
    return bool(rec and (kind is None or rec["kind"] == kind))

def require_ref(owner, field, rid, kind=None):
    if rid is None:
        return
    if not exists(str(rid), kind):
        suffix = f" ({kind})" if kind else ""
        errors.append(f"Broken reference in {owner}: {field} -> {rid}{suffix}")

# Referential integrity
for rid, rec in records.items():
    d, kind, owner = rec["data"], rec["kind"], rec["path"]

    if kind == "requirement":
        intro = d.get("introduced") or {}
        require_ref(owner, "introduced.by_change", intro.get("by_change"), "change")
        for ac in d.get("acceptance_criteria") or []:
            require_ref(owner, "acceptance_criteria", ac, "acceptance-criterion")

    elif kind == "acceptance-criterion":
        require_ref(owner, "requirement", d.get("requirement"), "requirement")
        for test in ((d.get("verification") or {}).get("tests") or []):
            # Test records may be external/executable-only in alpha. Do not require canonical TEST record yet.
            pass

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
        p = records.get(str(d.get("proposal")))
        if p and p["data"].get("change") != d.get("change"):
            errors.append(f"Approval/change mismatch in {owner}: proposal {d.get('proposal')} belongs to {p['data'].get('change')}")

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

# Cross-link consistency for proposals and impact analyses.
for rid, rec in records.items():
    if rec["kind"] == "proposal":
        chg = records.get(str(rec["data"].get("change")))
        if chg:
            current = (chg["data"].get("proposal") or {}).get("current")
            # Historical proposal revisions need not be current, so only ensure ownership.
            if not rid.startswith("PROP-" + str(rec["data"].get("change")).split("-")[-1] + "-"):
                errors.append(f"Proposal ID/change mismatch in {rec['path']}: {rid} vs {rec['data'].get('change')}")
    elif rec["kind"] == "impact-analysis":
        if not rid.startswith("IA-" + str(rec["data"].get("change")).split("-")[-1] + "-"):
            errors.append(f"Impact-analysis ID/change mismatch in {rec['path']}: {rid} vs {rec['data'].get('change')}")

if errors:
    print("SpecForge validation FAILED")
    for error in errors:
        print(f" - {error}")
    sys.exit(1)

print("SpecForge validation PASSED")
print(f" Repository: {ROOT}")
print(f" Canonical records discovered: {len(records)}")
print(" Nested SpecForge projects: excluded from parent validation")
