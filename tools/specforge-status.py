#!/usr/bin/env python3
"""Render the current SpecForge project/bootstrap status from canonical repository evidence."""

from pathlib import Path
import argparse
import datetime
import json
import sys

try:
    import yaml
except ImportError:
    print("ERROR: PyYAML is required: pip install pyyaml", file=sys.stderr)
    sys.exit(2)


TERMINAL_CHANGE_STATUSES = {"completed", "rejected", "cancelled"}


def norm(value):
    if isinstance(value, dict):
        return {key: norm(item) for key, item in value.items()}
    if isinstance(value, list):
        return [norm(item) for item in value]
    if isinstance(value, (datetime.datetime, datetime.date)):
        return value.isoformat()
    return value


def load(path):
    with path.open(encoding="utf-8") as handle:
        return norm(yaml.safe_load(handle))


def is_nested_project_record(path, root):
    current = path.parent
    while current != root and root in current.parents:
        if (current / "specforge.yaml").exists():
            return True
        current = current.parent
    return False


def discover_records(root):
    records = {}
    for path in root.rglob("*.yaml"):
        if path.name == "specforge.yaml" or is_nested_project_record(path, root):
            continue
        try:
            data = load(path)
        except Exception:
            continue
        if isinstance(data, dict) and data.get("id"):
            records[str(data["id"])] = {
                "data": data,
                "path": str(path.relative_to(root)).replace("\\", "/"),
            }
    return records


def record_ref(records, record_id):
    if not record_id:
        return None
    record = records.get(str(record_id))
    if not record:
        return {"id": record_id, "status": "missing"}
    return {
        "id": record_id,
        "status": "present",
        "path": record["path"],
        "record": record["data"],
    }


def public_ref(item, extra_fields=()):
    if item is None:
        return None
    result = {key: value for key, value in item.items() if key != "record"}
    if item.get("status") == "present":
        record = item["record"]
        for field in extra_fields:
            result[field] = record.get(field)
    return result


def manifest_artifact(root, declared_path, label, gaps):
    if not declared_path:
        gaps.append(f"Manifest does not declare {label}")
        return {"declared_path": declared_path, "status": "missing"}
    path = (root / str(declared_path)).resolve()
    try:
        relative = path.relative_to(root)
        display_path = str(relative).replace("\\", "/")
    except ValueError:
        display_path = str(path)
    status = "present" if path.is_file() else "missing"
    if status == "missing":
        gaps.append(f"Missing {label} {declared_path}")
    return {"declared_path": declared_path, "path": display_path, "status": status}


def build_change_summary(records, change_id, change_record, gaps):
    data = change_record["data"]
    item = {
        "id": change_id,
        "path": change_record["path"],
        "title": data.get("title"),
        "classification": data.get("classification"),
        "status": data.get("status"),
        "lifecycle_category": (
            "terminal" if data.get("status") in TERMINAL_CHANGE_STATUSES else "open"
        ),
        "current_links": {
            "impact_analysis": None,
            "proposal": None,
            "approvals": [],
            "implementation_attempts": [],
            "release": None,
        },
    }

    impact_id = (data.get("impact_analysis") or {}).get("current")
    if impact_id:
        ref = record_ref(records, impact_id)
        item["current_links"]["impact_analysis"] = public_ref(ref, ("change", "revision"))
        if ref["status"] == "missing":
            gaps.append(f"{change_id}: Missing impact analysis {impact_id}")
        elif ref["record"].get("change") != change_id:
            gaps.append(
                f"{change_id}: Impact analysis {impact_id} links to change {ref['record'].get('change')}"
            )

    proposal_id = (data.get("proposal") or {}).get("current")
    if proposal_id:
        ref = record_ref(records, proposal_id)
        item["current_links"]["proposal"] = public_ref(ref, ("change", "revision", "status"))
        if ref["status"] == "missing":
            gaps.append(f"{change_id}: Missing proposal {proposal_id}")
        elif ref["record"].get("change") != change_id:
            gaps.append(
                f"{change_id}: Proposal {proposal_id} links to change {ref['record'].get('change')}"
            )

    for approval_id in data.get("approvals") or []:
        ref = record_ref(records, approval_id)
        item["current_links"]["approvals"].append(
            public_ref(ref, ("change", "proposal", "decision", "timestamp"))
        )
        if ref["status"] == "missing":
            gaps.append(f"{change_id}: Missing approval {approval_id}")
        elif ref["record"].get("change") != change_id:
            gaps.append(
                f"{change_id}: Approval {approval_id} links to change {ref['record'].get('change')}"
            )

    for attempt_id in ((data.get("implementation") or {}).get("attempts") or []):
        ref = record_ref(records, attempt_id)
        item["current_links"]["implementation_attempts"].append(
            public_ref(ref, ("change", "proposal", "attempt", "outcome", "source_revision", "tests"))
        )
        if ref["status"] == "missing":
            gaps.append(f"{change_id}: Missing implementation attempt {attempt_id}")
        else:
            attempt = ref["record"]
            if attempt.get("change") != change_id:
                gaps.append(
                    f"{change_id}: Implementation attempt {attempt_id} links to change {attempt.get('change')}"
                )
            source_revision = attempt.get("source_revision") or {}
            if attempt.get("outcome") == "passed" and not source_revision.get("after"):
                gaps.append(f"{change_id}: Implementation attempt {attempt_id} has no recorded source revision after")

    release_id = (data.get("release") or {}).get("completed_in")
    if release_id:
        ref = record_ref(records, release_id)
        item["current_links"]["release"] = public_ref(ref, ("version", "status"))
        if ref["status"] == "missing":
            gaps.append(f"{change_id}: Missing release {release_id}")

    return item


def build_status(root, event_limit=10):
    manifest_path = root / "specforge.yaml"
    if not manifest_path.is_file():
        raise FileNotFoundError(manifest_path)

    manifest = load(manifest_path)
    if not isinstance(manifest, dict):
        raise ValueError("specforge.yaml does not contain a mapping")

    gaps = []
    records = discover_records(root)
    sf = manifest.get("specforge") or {}
    project = manifest.get("project") or {}
    specification = manifest.get("specification") or {}
    policy = manifest.get("policy") or {}

    product_spec = manifest_artifact(
        root, specification.get("product_specification"), "product specification", gaps
    )
    data_model = manifest_artifact(
        root, specification.get("canonical_data_model"), "canonical data model", gaps
    )

    changes = []
    for record_id, record in records.items():
        if record_id.startswith("CHG-"):
            changes.append(build_change_summary(records, record_id, record, gaps))
    changes.sort(key=lambda item: item["id"])

    open_changes = [item for item in changes if item["lifecycle_category"] == "open"]
    terminal_changes = [item for item in changes if item["lifecycle_category"] == "terminal"]

    events = []
    for record_id, record in records.items():
        if not record_id.startswith("EVT-"):
            continue
        event = record["data"]
        events.append(
            {
                "id": record_id,
                "timestamp": event.get("timestamp"),
                "event_type": event.get("event_type"),
                "actor": event.get("actor"),
                "entity": event.get("entity"),
                "related": event.get("related"),
                "path": record["path"],
            }
        )
    events.sort(key=lambda item: (str(item.get("timestamp") or ""), item["id"]), reverse=True)
    if event_limit >= 0:
        events = events[:event_limit]

    return {
        "project_root": str(root),
        "project": {"id": project.get("id"), "name": project.get("name")},
        "specforge": {
            "core_version": sf.get("core_version"),
            "data_model_version": sf.get("data_model_version"),
            "approval_mode": policy.get("approval_mode"),
            "forensic_traceability": policy.get("forensic_traceability"),
            "repository_completeness": policy.get("repository_completeness"),
        },
        "specification": {
            "authoritative_version": specification.get("current_version"),
            "product_specification": product_spec,
            "canonical_data_model": data_model,
        },
        "changes": {"open": open_changes, "terminal": terminal_changes},
        "recent_events": events,
        "gaps": gaps,
    }


def link_label(link):
    if not link:
        return "<none>"
    suffix = ""
    if link.get("status") == "missing":
        suffix = " [missing]"
    elif "decision" in link and link.get("decision"):
        suffix = f" [{link['decision']}]"
    elif "outcome" in link and link.get("outcome"):
        suffix = f" [{link['outcome']}]"
    elif "status" in link and link.get("status") not in {"present", "missing"}:
        suffix = f" [{link['status']}]"
    elif link.get("status"):
        suffix = f" [{link['status']}]"
    return f"{link.get('id')}{suffix}"


def human(status):
    project = status["project"]
    specforge = status["specforge"]
    specification = status["specification"]
    lines = [
        "SpecForge project status",
        f"Project: {project.get('id')}  {project.get('name')}",
        f"Core: {specforge.get('core_version')}  Data model: {specforge.get('data_model_version')}",
        f"Approval mode: {specforge.get('approval_mode')}",
        f"Authoritative specification: {specification.get('authoritative_version')}",
        f"Product specification: {specification['product_specification'].get('path')} [{specification['product_specification'].get('status')}]",
        f"Canonical data model: {specification['canonical_data_model'].get('path')} [{specification['canonical_data_model'].get('status')}]",
        "",
        "Open changes:",
    ]

    if not status["changes"]["open"]:
        lines.append("  <none>")
    for change in status["changes"]["open"]:
        links = change["current_links"]
        lines.append(f"  {change['id']} [{change.get('status')}] {change.get('title')}")
        lines.append(f"    impact: {link_label(links['impact_analysis'])}")
        lines.append(f"    proposal: {link_label(links['proposal'])}")
        approvals = ", ".join(link_label(item) for item in links["approvals"]) or "<none>"
        lines.append(f"    approvals: {approvals}")
        attempts = ", ".join(link_label(item) for item in links["implementation_attempts"]) or "<none>"
        lines.append(f"    implementation: {attempts}")
        lines.append(f"    release: {link_label(links['release'])}")

    lines.extend(["", "Terminal changes:"])
    if not status["changes"]["terminal"]:
        lines.append("  <none>")
    for change in status["changes"]["terminal"]:
        lines.append(f"  {change['id']} [{change.get('status')}] {change.get('title')}")

    lines.extend(["", "Recent forensic events:"])
    if not status["recent_events"]:
        lines.append("  <none>")
    for event in status["recent_events"]:
        entity = event.get("entity") or {}
        lines.append(
            f"  {event.get('timestamp', '?')}  {event['id']}  {event.get('event_type', '?')}  {entity.get('id', '?')}"
        )

    lines.append("")
    if status["gaps"]:
        lines.append("Evidence gaps:")
        lines.extend(f"  ! {gap}" for gap in status["gaps"])
    else:
        lines.append("Evidence gaps: none detected in explicit project/current links")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Render current SpecForge project/bootstrap status from canonical evidence."
    )
    parser.add_argument("--root", default=".", help="SpecForge project root (default: current directory)")
    parser.add_argument("--json", action="store_true", dest="as_json", help="Emit JSON")
    parser.add_argument(
        "--events", type=int, default=10, help="Number of recent forensic events to show; use -1 for all"
    )
    args = parser.parse_args()
    root = Path(args.root).resolve()

    try:
        status = build_status(root, args.events)
    except FileNotFoundError:
        print(f"ERROR: No specforge.yaml at project root {root}", file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"ERROR: Unable to read SpecForge project: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(status, indent=2) if args.as_json else human(status))
    return 0


if __name__ == "__main__":
    sys.exit(main())
