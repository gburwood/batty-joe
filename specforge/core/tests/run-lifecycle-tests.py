#!/usr/bin/env python3
from pathlib import Path
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import yaml

CORE_ROOT = Path(__file__).resolve().parents[1]
TOOLS = CORE_ROOT / "tools"
sys.path.insert(0, str(TOOLS))
from specforge_project import discover_layout, project_root  # noqa: E402

ROOT = project_root(Path(__file__).resolve())


def lifecycle_tool(root):
    return discover_layout(root).tool_root / "specforge-lifecycle.py"


def run(root, *args):
    tool = lifecycle_tool(root)
    return subprocess.run(
        [sys.executable, str(tool), *args, '--root', str(root), '--json'],
        capture_output=True,
        text=True,
    )


def git(root, *args):
    return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, check=True)


def check(name, condition):
    if not condition:
        raise AssertionError(name)
    print('PASS', name)


def result_json(result):
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise AssertionError(f'non-json lifecycle output: {result.stdout!r}') from exc


def snapshot_tree(path):
    snapshot = {}
    for file_path in sorted(p for p in path.rglob('*') if p.is_file()):
        relative = file_path.relative_to(path).as_posix()
        snapshot[relative] = hashlib.sha256(file_path.read_bytes()).hexdigest()
    return snapshot


def isolated_repo():
    td = tempfile.TemporaryDirectory()
    dst = Path(td.name) / 'repo'
    shutil.copytree(
        ROOT,
        dst,
        ignore=shutil.ignore_patterns('.git', '__pycache__', '*.pyc', '.pytest_cache'),
    )
    return td, dst


def isolated_git_repo():
    td = tempfile.TemporaryDirectory()
    dst = Path(td.name) / 'repo'
    result = subprocess.run(
        ['git', 'clone', '--quiet', '--local', '--no-hardlinks', str(ROOT), str(dst)],
        capture_output=True,
        text=True,
    )
    if result.returncode:
        td.cleanup()
        raise AssertionError('local Git fixture clone failed: ' + result.stdout + result.stderr)
    return td, dst


def changes_root(root):
    layout = discover_layout(root)
    declared = (layout.manifest.get('paths') or {}).get('changes')
    if declared:
        return (layout.root / declared).resolve()
    return layout.governance_root / 'changes'


def change_path(root, relative):
    return changes_root(root) / relative


# Guard the authoritative CHG-1004 evidence against accidental test mutation.
chg1004_root = change_path(ROOT, 'CHG-1004')
authoritative_before = snapshot_tree(chg1004_root)

# Current repository bootstrap must be ready.
r = run(ROOT, 'bootstrap')
check('bootstrap-ready', r.returncode == 0)

# CHG-1004 has exact approval and may advance into implementation.
r = run(ROOT, 'transition', 'CHG-1004', '--to', 'in_progress')
check('exact-approval-permits-implementation', r.returncode == 0)

# A genuinely completed historical change with valid legacy evidence remains completable.
r = run(ROOT, 'transition', 'CHG-1004', '--to', 'completed')
check('completed-change-has-valid-completion-evidence', r.returncode == 0)

# Missing completion evidence is tested only in isolated repository state.
td, dst = isolated_repo()
try:
    chg_path = change_path(dst, 'CHG-1004.yaml')
    chg = yaml.safe_load(chg_path.read_text(encoding='utf-8'))
    chg['status'] = 'validated'
    chg_path.write_text(yaml.safe_dump(chg, sort_keys=False), encoding='utf-8')

    imp_path = change_path(dst, 'CHG-1004/implementation/IMP-1004-01.yaml')
    imp = yaml.safe_load(imp_path.read_text(encoding='utf-8'))
    (imp.get('source_revision') or {}).pop('after', None)
    imp_path.write_text(yaml.safe_dump(imp, sort_keys=False), encoding='utf-8')

    r = run(dst, 'transition', 'CHG-1004', '--to', 'completed')
    out = result_json(r)
    check(
        'completion-refused-without-evidence',
        r.returncode != 0
        and 'passed_implementation_with_required_evidence_and_source_revision_missing'
        in out.get('blockers', []),
    )
finally:
    td.cleanup()

# Tampering with exact proposal invalidates approval, again only in isolated state.
td, dst = isolated_repo()
try:
    proposal_path = change_path(dst, 'CHG-1004/PROP-1004-01.yaml')
    proposal_path.write_text(
        proposal_path.read_text(encoding='utf-8') + '\n# materialized tamper\n',
        encoding='utf-8',
    )
    r = run(dst, 'transition', 'CHG-1004', '--to', 'in_progress')
    out = result_json(r)
    check(
        'proposal-digest-tamper-blocked',
        r.returncode != 0 and 'valid_exact_human_approval_missing' in out.get('blockers', []),
    )
finally:
    td.cleanup()

# Reproduce the Batty Joe / Copilot false-completion pattern in a clone that preserves
# the authoritative Git history. The approved implementation exists only in the working
# tree while before and after both claim the unchanged pre-implementation HEAD.
td, dst = isolated_git_repo()
try:
    baseline = git(dst, 'rev-parse', 'HEAD').stdout.strip()

    chg_path = change_path(dst, 'CHG-1009.yaml')
    chg = yaml.safe_load(chg_path.read_text(encoding='utf-8'))
    chg['status'] = 'validated'
    chg.setdefault('implementation', {})['attempts'] = ['IMP-1009-99']
    chg_path.write_text(yaml.safe_dump(chg, sort_keys=False), encoding='utf-8', newline='\n')

    imp_path = change_path(dst, 'CHG-1009/implementation/IMP-1009-99.yaml')
    imp_path.parent.mkdir(parents=True, exist_ok=True)
    imp = {
        'id': 'IMP-1009-99',
        'change': 'CHG-1009',
        'proposal': 'PROP-1009-02',
        'attempt': 99,
        'actor': {'type': 'ai', 'id': 'copilot-regression-fixture'},
        'source_revision': {'system': 'git', 'before': baseline, 'after': baseline},
        'outcome': 'passed',
        'validation_checks': [{'name': 'fixture-validation', 'required': True, 'status': 'passed'}],
        'tests': {'status': 'passed', 'passed': ['fixture'], 'failed': []},
    }
    imp_path.write_text(yaml.safe_dump(imp, sort_keys=False), encoding='utf-8', newline='\n')
    (dst / 'batty-joe.js').write_text('// approved implementation remains uncommitted\n', encoding='utf-8', newline='\n')

    r = run(dst, 'transition', 'CHG-1009', '--to', 'completed')
    out = result_json(r)
    check(
        'copilot-false-completion-refused',
        r.returncode != 0
        and 'source_revision_not_advanced' in out.get('blockers', [])
        and 'passed_implementation_with_required_evidence_and_source_revision_missing' in out.get('blockers', []),
    )
finally:
    td.cleanup()

# Regression scenarios must never mutate authoritative CHG-1004 history.
authoritative_after = snapshot_tree(chg1004_root)
check('authoritative-change-unchanged', authoritative_before == authoritative_after)

print('Lifecycle tests PASSED')
