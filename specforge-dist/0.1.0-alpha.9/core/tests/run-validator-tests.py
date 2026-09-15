#!/usr/bin/env python3
from pathlib import Path
import subprocess, tempfile, shutil, sys, yaml

ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = ROOT / "tools" / "validate-specforge.py"
EXAMPLE = ROOT / "examples" / "minimal"

def run(path):
    return subprocess.run([sys.executable, str(VALIDATOR), str(path)], capture_output=True, text=True)

def expect_pass(path, label):
    r = run(path)
    assert r.returncode == 0, f"{label}\n{r.stdout}\n{r.stderr}"

def expect_fail(path, text, label):
    r = run(path)
    assert r.returncode != 0, f"{label}: unexpectedly passed"
    assert text in r.stdout, f"{label}: expected {text!r}\n{r.stdout}"

expect_pass(EXAMPLE, "minimal example should validate")
expect_pass(ROOT, "parent project should validate while excluding nested example project")

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / "bad"
    shutil.copytree(EXAMPLE, bad)
    (bad / "SPECFORGE.md").unlink()
    expect_fail(bad, "Missing required file", "missing bootstrap")

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / "bad"
    shutil.copytree(EXAMPLE, bad)
    req = bad / "spec/requirements/REQ-0001.yaml"
    data = yaml.safe_load(req.read_text())
    data["status"] = "banana"
    req.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, "Schema validation failed", "schema validation")

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / "bad"
    shutil.copytree(EXAMPLE, bad)
    req = bad / "spec/requirements/REQ-0001.yaml"
    data = yaml.safe_load(req.read_text())
    data["introduced"]["by_change"] = "CHG-9999"
    req.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, "Broken reference", "broken reference")

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / "bad"
    shutil.copytree(EXAMPLE, bad)
    prop = bad / "changes/CHG-0001/PROP-0001-01.yaml"
    data = yaml.safe_load(prop.read_text())
    data["change"] = "CHG-9999"
    prop.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, "Broken reference", "proposal/change link")

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / "bad"
    shutil.copytree(EXAMPLE, bad)
    appr = bad / "changes/CHG-0001/approvals/APR-0001.yaml"
    data = yaml.safe_load(appr.read_text())
    data["proposal"] = "PROP-9999-01"
    appr.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, "Broken reference", "approval/proposal link")

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / "bad"
    shutil.copytree(EXAMPLE, bad)
    manifest = bad / "specforge.yaml"
    data = yaml.safe_load(manifest.read_text())
    data["paths"]["changes"] = "./does-not-exist"
    manifest.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, "Manifest path", "missing manifest path")

print("Validator tests PASSED")
