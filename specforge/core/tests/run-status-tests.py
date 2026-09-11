#!/usr/bin/env python3
from pathlib import Path
import hashlib, json, shutil, subprocess, sys, tempfile, yaml

CORE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CORE_ROOT / "tools"))
from specforge_project import discover_layout, project_root

ROOT = project_root(Path(__file__).resolve())
TOOL = discover_layout(ROOT).tool_root / "specforge-status.py"

def run(*args, root=ROOT):
    return subprocess.run([sys.executable, str(TOOL), "--root", str(root), *args], capture_output=True, text=True)

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def path_for(root, key, legacy_default, format1_default):
    layout = discover_layout(root)
    declared = (layout.manifest.get("paths") or {}).get(key)
    return (layout.root / declared).resolve() if declared else layout.root / (format1_default if layout.mode == "project_format_1" else legacy_default)

def change_path(root, relative):
    return path_for(root, "changes", "changes", "specforge/changes") / relative

def make_change_fixture(base, status):
    repo = Path(base) / "repo"
    shutil.copytree(ROOT, repo, ignore=shutil.ignore_patterns('.git', '__pycache__', '*.pyc', '.pytest_cache'))
    path = change_path(repo, "CHG-1002.yaml")
    data = yaml.safe_load(path.read_text())
    data["status"] = status
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    return repo

def make_open_fixture(base): return make_change_fixture(base, "validated")
def make_completed_fixture(base): return make_change_fixture(base, "completed")

layout = discover_layout(ROOT)
manifest = layout.manifest
sf_manifest = manifest.get("specforge") or {}
spec_manifest = manifest.get("specification") or {}

r = run("--json")
assert r.returncode == 0, r.stderr
j = json.loads(r.stdout)
assert j["project"]["id"] == "PRJ-0001"
assert j["specforge"]["core_version"] == sf_manifest.get("core_version")
assert j["specforge"]["data_model_version"] == sf_manifest.get("data_model_version")
assert j["specification"]["authoritative_version"] == spec_manifest.get("current_version")
assert j["specification"]["product_specification"]["status"] == "present"
assert j["specification"]["canonical_data_model"]["status"] == "present"
terminal_by_id = {item["id"]: item for item in j["changes"]["terminal"]}
assert terminal_by_id["CHG-1000"]["status"] == "completed"
assert terminal_by_id["CHG-1001"]["status"] == "completed"

with tempfile.TemporaryDirectory() as td:
    repo = make_completed_fixture(td)
    r = run("--json", root=repo); assert r.returncode == 0, r.stderr
    completed = {item["id"]: item for item in json.loads(r.stdout)["changes"]["terminal"]}
    assert completed["CHG-1002"]["status"] == "completed"
    assert completed["CHG-1002"]["current_links"]["implementation_attempts"][0]["source_revision"]["after"] == "1676345691549d3f171028383e3d3f50269633d7"

with tempfile.TemporaryDirectory() as td:
    repo = make_open_fixture(td)
    r = run("--json", root=repo); assert r.returncode == 0, r.stderr
    open_status = json.loads(r.stdout); open_by_id = {item["id"]: item for item in open_status["changes"]["open"]}
    change_1002 = yaml.safe_load(change_path(repo, "CHG-1002.yaml").read_text())
    assert open_by_id["CHG-1002"]["status"] == change_1002["status"]
    links = open_by_id["CHG-1002"]["current_links"]
    assert links["impact_analysis"]["id"] == "IA-1002-01"
    assert links["proposal"]["id"] == "PROP-1002-01"
    assert links["proposal"]["status"] == "approved"
    assert links["approvals"][0]["id"] == "APR-1002"
    assert links["approvals"][0]["decision"] == "approved"
    assert links["implementation_attempts"][0]["id"] == "IMP-1002-01"

r = run(); assert r.returncode == 0, r.stderr
for token in ["SpecForge project status", "PRJ-0001", f"Authoritative specification: {spec_manifest.get('current_version')}", "Open changes:", "Terminal changes:", "CHG-1001", "CHG-1002"]:
    assert token in r.stdout, token

with tempfile.TemporaryDirectory() as td:
    repo = make_open_fixture(td); r = run(root=repo); assert r.returncode == 0, r.stderr
    for token in ["CHG-1002", "PROP-1002-01", "APR-1002"]: assert token in r.stdout, token

tracked = change_path(ROOT, "CHG-1002.yaml"); before = digest(tracked)
r = run("--json"); assert r.returncode == 0; assert digest(tracked) == before

with tempfile.TemporaryDirectory() as td:
    repo = make_open_fixture(td); path = change_path(repo, "CHG-1002.yaml")
    data = yaml.safe_load(path.read_text()); data["impact_analysis"]["current"] = "IA-9999-01"; path.write_text(yaml.safe_dump(data, sort_keys=False))
    broken = json.loads(run("--json", root=repo).stdout)
    item = next(change for change in broken["changes"]["open"] if change["id"] == "CHG-1002")
    assert item["current_links"]["impact_analysis"]["status"] == "missing"
    assert "CHG-1002: Missing impact analysis IA-9999-01" in broken["gaps"]

with tempfile.TemporaryDirectory() as td:
    repo = make_open_fixture(td); path = change_path(repo, "CHG-1002/IA-1002-01.yaml")
    data = yaml.safe_load(path.read_text()); data["change"] = "CHG-9999"; path.write_text(yaml.safe_dump(data, sort_keys=False))
    broken = json.loads(run("--json", root=repo).stdout)
    assert "CHG-1002: Impact analysis IA-1002-01 links to change CHG-9999" in broken["gaps"]

r = run("--json", "--events", "-1"); assert r.returncode == 0, r.stderr
j = json.loads(r.stdout)
assert "CHG-0001" not in {item["id"] for group in j["changes"].values() for item in group}
assert "EVT-000001" not in {item["id"] for item in j["recent_events"]}

nested_root = path_for(ROOT, "examples", "examples", "specforge/core/examples") / "minimal"
r = run("--json", root=nested_root); assert r.returncode == 0, r.stderr
nested = json.loads(r.stdout)
assert "CHG-0001" in {item["id"] for group in nested["changes"].values() for item in group}
print("Status tests PASSED")
