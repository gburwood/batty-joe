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

checks = 0


def check(condition, message):
    global checks
    assert condition, message
    checks += 1


def expect(entries, tier):
    got = mod.classify_entries(entries, policy)
    check(got["classification"] == tier, (entries, tier, got))
    return got


expect([{"path": "tests/new-regression.py", "status": "A"}], "LOW")
expect([{"path": "tests/run-chg0005-tests.js", "status": "M"}], "MEDIUM")
expect([{"path": "tests/run-chg0005-tests.js", "status": "D"}], "MEDIUM")
expect([{"path": "tests/a.py", "status": "M"}, {"path": ".gitignore", "status": "A"}], "MEDIUM")
expect([{"path": "tests/a.py", "status": "M"}, {"path": "batty-joe-game.js", "status": "M"}], "HIGH")
unmatched = expect([{"path": "unexpected/new-surface.bin", "status": "A"}], "HIGH")
check("default_unmatched_high" in unmatched["matched_rules"], unmatched)
expect([{"path": "specforge.yaml", "status": "M"}], "HIGH")
expect([{"path": "SPECFORGE.md", "status": "M"}], "HIGH")
expect([{"path": "batty-joe-dev-spec-v1.12.0.yaml", "status": "A"}], "HIGH")

before = {
    "specforge": {"core_version": "0.1"},
    "specification": {
        "product_specification": "./batty-joe-dev-spec-v1.7.0.yaml",
        "current_version": "1.7.0",
    },
    "policy": {"approval_mode": "controlled"},
}
after_bounded = {
    "specforge": {"core_version": "0.1"},
    "specification": {
        "product_specification": "./batty-joe-dev-spec-v1.8.0.yaml",
        "current_version": "1.8.0",
    },
    "policy": {"approval_mode": "controlled"},
}
bounded = mod.bounded_legacy_manifest_documents(before, after_bounded)
check(bounded["bounded"] is True, bounded)
check(set(bounded["changed_keys"]) == {
    "specification.product_specification",
    "specification.current_version",
}, bounded)

after_unbounded = {
    **after_bounded,
    "policy": {"approval_mode": "open"},
}
unbounded = mod.bounded_legacy_manifest_documents(before, after_unbounded)
check(unbounded["bounded"] is False, unbounded)
check("policy.approval_mode" in unbounded["changed_keys"], unbounded)

legacy_manifest = {
    "paths": {
        "changes": "./changes",
        "history": "./history",
        "evidence": "./evidence",
        "tests": "./tests",
    }
}
legacy_roots = mod.bookkeeping_roots_from_manifest_document(legacy_manifest)
check(legacy_roots == ["changes", "evidence", "history"], legacy_roots)
check(mod.is_historical_bookkeeping_path("changes/CHG-0001.yaml", legacy_roots), legacy_roots)
check(mod.is_historical_bookkeeping_path("history/events/EVT-000001.yaml", legacy_roots), legacy_roots)
check(mod.is_historical_bookkeeping_path("evidence/run.yaml", legacy_roots), legacy_roots)
check(not mod.is_historical_bookkeeping_path("tests/run-v170-tests.js", legacy_roots), legacy_roots)

excluded = mod.classify_entries([
    {"path": "specforge-dist/x/y.yaml", "status": "A"},
    {"path": "x/__pycache__/a.pyc", "status": "A"},
], policy)
check(excluded["classification"] == "BLOCKED", excluded)

parsed = mod._parse_name_status("M\ttests/a.js\nA\ttests/b.js\nR100\told.js\tnew.js\n")
check(parsed == [
    {"path": "tests/a.js", "status": "M"},
    {"path": "tests/b.js", "status": "A"},
    {"path": "old.js", "status": "R"},
    {"path": "new.js", "status": "R"},
], parsed)

with tempfile.TemporaryDirectory() as td:
    p = Path(td) / "bad.yaml"
    p.write_text("version: 2\nnon_authoritative: false\n", encoding="utf-8")
    try:
        mod.load_policy(p)
    except mod.ClassifierError:
        checks += 1
    else:
        raise AssertionError("malformed/authoritative policy must fail closed")

check(mod.change_range(7, 8) == ["CHG-0007", "CHG-0008"], mod.change_range(7, 8))
print(f"risk classifier tests passed: {checks}/{checks}")
