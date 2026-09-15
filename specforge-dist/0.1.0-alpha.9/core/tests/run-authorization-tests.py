#!/usr/bin/env python3
from pathlib import Path
import json
import shutil
import subprocess
import sys
import tempfile

import yaml

ROOT = Path(__file__).resolve().parents[3]


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)


def expect(condition, name, detail=""):
    if not condition:
        print(f"FAIL: {name}")
        if detail:
            print(detail)
        raise SystemExit(1)
    print(f"PASS: {name}")


def write_yaml(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data, sort_keys=False), encoding="utf-8")


with tempfile.TemporaryDirectory(prefix="specforge-auth-") as temp_dir:
    project = Path(temp_dir) / "project"
    shutil.copytree(
        ROOT,
        project,
        ignore=shutil.ignore_patterns(".git", "specforge-dist", "__pycache__", "*.pyc"),
    )

    change_path = project / "specforge" / "changes" / "CHG-1010.yaml"
    attempt_path = project / "specforge" / "changes" / "CHG-1010" / "implementation" / "IMP-1010-01.yaml"
    change = yaml.safe_load(change_path.read_text(encoding="utf-8"))
    change["status"] = "approved"
    change.setdefault("implementation", {})["attempts"] = []
    write_yaml(change_path, change)

    git = lambda *args: run("git", *args, cwd=project)
    expect(git("init").returncode == 0, "git-init")
    expect(git("config", "user.email", "specforge-tests@example.invalid").returncode == 0, "git-config-email")
    expect(git("config", "user.name", "SpecForge Tests").returncode == 0, "git-config-name")
    expect(git("add", ".").returncode == 0, "git-add-baseline")
    expect(git("commit", "-m", "baseline").returncode == 0, "git-commit-baseline")
    head = git("rev-parse", "HEAD").stdout.strip()

    guard = project / "specforge" / "core" / "tools" / "specforge-authorization.py"
    def guard_run():
        return run(sys.executable, str(guard), "--root", str(project), "--json")

    clean = guard_run()
    expect(clean.returncode == 0, "clean-project-valid", clean.stdout + clean.stderr)

    readme = project / "README.md"
    original = readme.read_text(encoding="utf-8")
    readme.write_text(original + "\nunauthorized experiment edit\n", encoding="utf-8")
    unauthorized = guard_run()
    expect(unauthorized.returncode != 0, "unauthorized-material-blocked", unauthorized.stdout + unauthorized.stderr)
    expect("unauthorized_material_changes" in unauthorized.stdout, "unauthorized-reason-reported", unauthorized.stdout)
    expect("README.md" in unauthorized.stdout, "unauthorized-path-reported", unauthorized.stdout)

    readme.write_text(original, encoding="utf-8")
    governance = project / "specforge" / "history" / "events" / "EVT-999999.yaml"
    governance.write_text("id: EVT-999999\ntimestamp: '2026-09-14T16:20:00+01:00'\nevent_type: test\n", encoding="utf-8")
    governance_only = guard_run()
    expect(governance_only.returncode == 0, "governance-only-does-not-block", governance_only.stdout + governance_only.stderr)

    change = yaml.safe_load(change_path.read_text(encoding="utf-8"))
    change["status"] = "in_progress"
    change.setdefault("implementation", {})["attempts"] = ["IMP-1010-01"]
    write_yaml(change_path, change)
    attempt = yaml.safe_load(attempt_path.read_text(encoding="utf-8"))
    attempt["source_revision"] = {"system": "git", "before": head, "after": None}
    attempt["outcome"] = "in_progress"
    write_yaml(attempt_path, attempt)

    readme.write_text(original + "\nauthorized experiment edit\n", encoding="utf-8")
    authorized = guard_run()
    expect(authorized.returncode == 0, "authorized-material-permitted", authorized.stdout + authorized.stderr)
    data = json.loads(authorized.stdout)
    expect(data.get("authorized") is True, "active-authorization-reported", authorized.stdout)

print("Authorization regression tests PASSED")
