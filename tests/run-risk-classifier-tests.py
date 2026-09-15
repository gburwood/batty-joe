#!/usr/bin/env python3
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MODULE = ROOT / "experiments" / "specforge-risk-classifier.py"
POLICY = ROOT / "experiments" / "specforge-risk-policy.yaml"
spec = spec_from_file_location("risk_classifier", MODULE)
mod = module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(mod)
policy = mod.load_policy(POLICY)


def expect(paths, tier):
    got = mod.classify_paths(paths, policy)
    assert got["classification"] == tier, (paths, tier, got)
    return got


expect(["tests/run-chg0005-tests.js"], "LOW")
expect(["tests/a.py", ".gitignore"], "MEDIUM")
expect(["tests/a.py", "batty-joe-game.js"], "HIGH")
unmatched = expect(["unexpected/new-surface.bin"], "HIGH")
assert "default_unmatched_high" in unmatched["matched_rules"]
expect(["specforge/project.yaml"], "HIGH")
expect(["SPECFORGE.md"], "HIGH")
expect(["batty-joe-dev-spec-v1.12.0.yaml"], "HIGH")
assert mod.classify_paths(["specforge-dist/x/y.yaml", "x/__pycache__/a.pyc"], policy)["classification"] == "BLOCKED"

with tempfile.TemporaryDirectory() as td:
    p = Path(td) / "bad.yaml"
    p.write_text("version: 1\nnon_authoritative: false\n", encoding="utf-8")
    try:
        mod.load_policy(p)
    except mod.ClassifierError:
        pass
    else:
        raise AssertionError("malformed/authoritative policy must fail closed")

assert mod.change_range(7, 8) == ["CHG-0007", "CHG-0008"]
print("risk classifier tests passed: 10/10")
