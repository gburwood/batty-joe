#!/usr/bin/env python3
from pathlib import Path
import subprocess, sys, json, tempfile, shutil, yaml

CORE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(CORE_ROOT / "tools"))
from specforge_project import discover_layout, project_root

ROOT = project_root(Path(__file__).resolve())
TOOL = discover_layout(ROOT).tool_root / "specforge-trace.py"

def run(*args, root=ROOT):
    return subprocess.run([sys.executable, str(TOOL), *args, "--root", str(root)], capture_output=True, text=True)

def changes_root(root):
    layout = discover_layout(root)
    declared = (layout.manifest.get("paths") or {}).get("changes")
    if declared:
        return (layout.root / declared).resolve()
    return layout.governance_root / "changes"

r = run("CHG-1000")
assert r.returncode == 0, r.stderr
for token in ["CHG-1000", "IA-1000-01", "PROP-1000-01", "APR-1000", "IMP-1000-01", "2b02089bad4d3660d6f2019ea6d2fc7323436c54"]:
    assert token in r.stdout, token

r = run("CHG-1000", "--json")
assert r.returncode == 0
j = json.loads(r.stdout)
assert j["change"]["id"] == "CHG-1000"
assert j["implementation_attempts"][0]["source_revision"]["after"] == "2b02089bad4d3660d6f2019ea6d2fc7323436c54"

r = run("CHG-9999")
assert r.returncode != 0 and "Unknown change" in r.stderr

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / "repo"
    shutil.copytree(ROOT, bad, ignore=shutil.ignore_patterns('.git', '__pycache__', '*.pyc', '.pytest_cache'))
    ch = changes_root(bad) / "CHG-1000.yaml"
    d = yaml.safe_load(ch.read_text())
    d["approvals"] = ["APR-9999"]
    ch.write_text(yaml.safe_dump(d, sort_keys=False))
    r = run("CHG-1000", root=bad)
    assert r.returncode == 0 and "Missing approval APR-9999" in r.stdout

r = run("CHG-0001")
assert r.returncode != 0 and "Unknown change" in r.stderr
print("Trace tests PASSED")
