#!/usr/bin/env python3
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

import yaml

CORE_ROOT = Path(__file__).resolve().parents[1]
TOOLS = CORE_ROOT / "tools"
sys.path.insert(0, str(TOOLS))

from specforge_project import (  # noqa: E402
    discover_layout,
    git_worktree_root,
    material_snapshot,
    project_root,
    verify_source_revision,
)

ROOT = project_root(Path(__file__).resolve())


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    print("PASS", name)


def git(root, *args, check_result=True):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True)
    if check_result and result.returncode:
        raise AssertionError(result.stdout + result.stderr)
    return result


def write_project(root):
    for rel in (
        "specforge/core",
        "specforge/packs",
        "specforge/changes",
        "specforge/decisions",
        "specforge/history",
        "specforge/evidence",
    ):
        (root / rel).mkdir(parents=True, exist_ok=True)
    manifest = {
        "specforge": {"project_format": 1, "core_version": "test", "data_model_version": "test"},
        "project": {"id": "PRJ-TEST", "name": "Revision Test"},
        "specification": {
            "product_specification": "./product.txt",
            "canonical_data_model": "./model.txt",
            "current_version": "test",
        },
        "paths": {
            "core": "./specforge/core",
            "packs": "./specforge/packs",
            "changes": "./specforge/changes",
            "decisions": "./specforge/decisions",
            "history": "./specforge/history",
            "evidence": "./specforge/evidence",
        },
        "ownership": {"framework_owned": [], "project_owned": []},
        "packs": [],
        "policy": {"approval_mode": "controlled"},
    }
    (root / "specforge/project.yaml").write_text(yaml.safe_dump(manifest, sort_keys=False), encoding="utf-8", newline="\n")
    (root / "product.txt").write_text("one\n", encoding="utf-8", newline="\n")
    (root / "model.txt").write_text("model\n", encoding="utf-8", newline="\n")


# Git provider: immutable commits, governance-only bookkeeping and uncaptured material.
with tempfile.TemporaryDirectory() as td:
    root = Path(td) / "repo"
    root.mkdir()
    write_project(root)
    git(root, "init")
    git(root, "config", "user.email", "fixture@example.invalid")
    git(root, "config", "user.name", "Fixture")
    git(root, "add", ".")
    git(root, "commit", "-m", "before")
    before = git(root, "rev-parse", "HEAD").stdout.strip()

    (root / "product.txt").write_text("two\n", encoding="utf-8", newline="\n")
    git(root, "add", "product.txt")
    git(root, "commit", "-m", "material implementation")
    after = git(root, "rev-parse", "HEAD").stdout.strip()
    layout = discover_layout(root)

    result = verify_source_revision(
        layout,
        {"system": "git", "before": before, "after": after},
        mode="transition",
        require_provider=True,
    )
    check("git-captured-material-valid", result["valid"])

    (root / "specforge/history/EVT-test.yaml").write_text("id: EVT-999999\n", encoding="utf-8")
    result = verify_source_revision(
        layout,
        {"system": "git", "before": before, "after": after},
        mode="transition",
        require_provider=True,
    )
    check("git-governance-bookkeeping-does-not-block", result["valid"])

    (root / "product.txt").write_text("three\n", encoding="utf-8", newline="\n")
    result = verify_source_revision(
        layout,
        {"system": "git", "before": before, "after": after},
        mode="transition",
        require_provider=True,
    )
    check(
        "git-uncaptured-material-blocked",
        not result["valid"]
        and "uncaptured_material_changes" in result["blockers"]
        and "product.txt" in result["details"].get("material_differences", []),
    )

    result = verify_source_revision(
        layout,
        {"system": "git", "before": after, "after": after},
        mode="static",
        require_provider=False,
    )
    check("git-same-revision-blocked", not result["valid"] and "source_revision_not_advanced" in result["blockers"])

    result = verify_source_revision(
        layout,
        {"system": "git", "before": before, "after": "0" * 40},
        mode="static",
        require_provider=False,
    )
    check("git-nonexistent-revision-blocked", not result["valid"] and "source_revision_after_not_git_commit" in result["blockers"])


# SpecForge snapshot provider: no Git required and governance bookkeeping excluded.
with tempfile.TemporaryDirectory() as td:
    root = Path(td) / "repo"
    root.mkdir()
    write_project(root)
    layout = discover_layout(root)
    before = material_snapshot(layout)["revision"]
    (root / "product.txt").write_text("two\n", encoding="utf-8", newline="\n")
    after = material_snapshot(layout)["revision"]

    result = verify_source_revision(
        layout,
        {"system": "specforge_snapshot", "before": before, "after": after},
        mode="transition",
        require_provider=True,
    )
    check("snapshot-captured-material-valid", result["valid"])

    (root / "specforge/evidence/note.txt").write_text("bookkeeping\n", encoding="utf-8")
    check("snapshot-governance-does-not-change-digest", material_snapshot(layout)["revision"] == after)
    result = verify_source_revision(
        layout,
        {"system": "specforge_snapshot", "before": before, "after": after},
        mode="transition",
        require_provider=True,
    )
    check("snapshot-governance-bookkeeping-does-not-block", result["valid"])

    (root / "product.txt").write_text("three\n", encoding="utf-8", newline="\n")
    result = verify_source_revision(
        layout,
        {"system": "specforge_snapshot", "before": before, "after": after},
        mode="transition",
        require_provider=True,
    )
    check("snapshot-uncaptured-material-blocked", not result["valid"] and "uncaptured_material_changes" in result["blockers"])


# A project nested under an unrelated parent Git repository is not itself Git-backed.
with tempfile.TemporaryDirectory() as td:
    parent = Path(td) / "parent"
    parent.mkdir()
    git(parent, "init")
    project = parent / "nested-project"
    project.mkdir()
    write_project(project)
    layout = discover_layout(project)
    check("unrelated-parent-git-not-selected", git_worktree_root(layout) is None)
    snapshot = material_snapshot(layout)
    check("nested-unmanaged-project-has-snapshot", snapshot["revision"].startswith("sha256:"))


# Static validator regression for the exact false-completion evidence shape. The
# disposable copy intentionally lacks .git; equal immutable Git references are still
# self-contradictory and must be rejected without needing provider history.
with tempfile.TemporaryDirectory() as td:
    fixture = Path(td) / "repo"
    shutil.copytree(
        ROOT,
        fixture,
        ignore=shutil.ignore_patterns(".git", "__pycache__", "*.pyc", ".pytest_cache"),
    )
    chg_path = fixture / "specforge/changes/CHG-1009.yaml"
    chg = yaml.safe_load(chg_path.read_text(encoding="utf-8"))
    chg["status"] = "completed"
    chg.setdefault("implementation", {})["attempts"] = ["IMP-1009-99"]
    chg_path.write_text(yaml.safe_dump(chg, sort_keys=False), encoding="utf-8", newline="\n")

    equal = "1" * 40
    imp_path = fixture / "specforge/changes/CHG-1009/implementation/IMP-1009-99.yaml"
    imp_path.parent.mkdir(parents=True, exist_ok=True)
    imp = {
        "id": "IMP-1009-99",
        "change": "CHG-1009",
        "proposal": "PROP-1009-02",
        "attempt": 99,
        "actor": {"type": "ai", "id": "validator-regression-fixture"},
        "source_revision": {"system": "git", "before": equal, "after": equal},
        "outcome": "passed",
        "validation_checks": [{"name": "fixture-validation", "required": True, "status": "passed"}],
        "tests": {"status": "passed", "passed": ["fixture"], "failed": []},
    }
    imp_path.write_text(yaml.safe_dump(imp, sort_keys=False), encoding="utf-8", newline="\n")
    validator = fixture / "specforge/core/tools/validate-specforge.py"
    result = subprocess.run([sys.executable, "-B", str(validator), str(fixture)], capture_output=True, text=True)
    check(
        "validator-rejects-equal-false-completion",
        result.returncode != 0 and "source_revision_not_advanced" in (result.stdout + result.stderr),
    )

print("Source revision tests PASSED")
