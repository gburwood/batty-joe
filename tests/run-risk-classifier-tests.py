#!/usr/bin/env python3
"""Focused deterministic tests for the non-authoritative CHG-0012 classifier."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile

import yaml


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "experiments" / "specforge-risk-classifier.py"
POLICY_PATH = ROOT / "experiments" / "specforge-risk-policy.yaml"

spec = importlib.util.spec_from_file_location("specforge_risk_classifier", MODULE_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError("unable to load classifier module")
classifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(classifier)
policy = classifier.load_policy(POLICY_PATH)

passed = 0


def check(name, condition):
    global passed
    if not condition:
        raise AssertionError(name)
    passed += 1


result = classifier.classify_paths(["tests/run-chg0005-tests.js"], policy)
check("ordinary test is LOW", result["classification"] == "LOW")

result = classifier.classify_paths(["tests/run-v170-tests.js", ".gitignore"], policy)
check("repository config raises tests to MEDIUM", result["classification"] == "MEDIUM")

result = classifier.classify_paths(["tests/example.js", "batty-joe-game.js"], policy)
check("runtime source raises mixed diff to HIGH", result["classification"] == "HIGH")

result = classifier.classify_paths(["unexpected/new-surface.xyz"], policy)
check(
    "unmatched path fails upward to HIGH",
    result["classification"] == "HIGH" and "default_unmatched_high" in result["matched_rules"],
)

result = classifier.classify_paths(["specforge/project.yaml"], policy)
check("project manifest is HIGH", result["classification"] == "HIGH")

result = classifier.classify_paths(["SPECFORGE.md"], policy)
check("legacy entry point is HIGH", result["classification"] == "HIGH")

result = classifier.classify_paths(["batty-joe-dev-spec-v1.12.0.yaml"], policy)
check("product specification is HIGH", result["classification"] == "HIGH")

result = classifier.classify_paths(
    [
        "specforge-dist/0.1.0-alpha.10/core/core.yaml",
        "specforge/core/tools/__pycache__/specforge_project.cpython-314.pyc",
    ],
    policy,
)
check(
    "only transient/distribution paths fail closed",
    result["classification"] == "BLOCKED" and result["blocker"] == "no_material_paths_after_exclusions",
)

with tempfile.TemporaryDirectory() as temp_dir:
    bad_policy = dict(policy)
    bad_policy["non_authoritative"] = False
    path = Path(temp_dir) / "bad-policy.yaml"
    path.write_text(yaml.safe_dump(bad_policy, sort_keys=False), encoding="utf-8")
    try:
        classifier.load_policy(path)
    except classifier.ClassifierError as exc:
        rejected = "must_be_non_authoritative" in str(exc)
    else:
        rejected = False
check("policy cannot declare itself authoritative", rejected)

check(
    "change range is deterministic",
    classifier.change_range(7, 8) == ["CHG-0007", "CHG-0008"],
)

print(f"risk classifier tests passed: {passed}/10")
