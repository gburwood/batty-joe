#!/usr/bin/env python3
from pathlib import Path
import json, subprocess, sys, tempfile

CORE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from portable_fixture import create_project, git, install_controlled_change


def run(root, *args):
    tool = root / 'specforge/core/tools/specforge-lifecycle.py'
    return subprocess.run([sys.executable, '-B', str(tool), *args, '--root', str(root), '--json'], capture_output=True, text=True)

def check(name, condition, detail=''):
    if not condition:
        if detail:
            print(detail)
        raise AssertionError(name)
    print('PASS', name)

def result_json(result): return json.loads(result.stdout)

# Bootstrap and exact-approval gate in a host-neutral project.
with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'; create_project(root, CORE, git_backed=True)
    install_controlled_change(root, 'CHG-9003', status='approved', attempt=False)
    git(root, 'add', 'specforge/changes'); git(root, 'commit', '-m', 'portable lifecycle fixture')
    r = run(root, 'bootstrap'); check('bootstrap-ready', r.returncode == 0, r.stdout + r.stderr)
    r = run(root, 'transition', 'CHG-9003', '--to', 'in_progress'); check('exact-approval-permits-implementation', r.returncode == 0, r.stdout + r.stderr)

# Valid completion evidence with a real material before/after pair.
with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'; state = create_project(root, CORE, git_backed=True); before = state['trusted_revision']
    install_controlled_change(root, 'CHG-9004', status='in_progress', attempt=True, before=before, outcome='in_progress')
    git(root, 'add', 'specforge/changes'); git(root, 'commit', '-m', 'start portable implementation')
    (root / 'product.txt').write_text('two\n', encoding='utf-8', newline='\n'); git(root, 'add', 'product.txt'); git(root, 'commit', '-m', 'portable material implementation')
    after = git(root, 'rev-parse', 'HEAD').stdout.strip()
    install_controlled_change(root, 'CHG-9004', status='validated', attempt=True, before=before, after=after, outcome='passed')
    git(root, 'add', 'specforge/changes'); git(root, 'commit', '-m', 'record passed portable implementation')
    r = run(root, 'transition', 'CHG-9004', '--to', 'completed'); check('completed-change-has-valid-completion-evidence', r.returncode == 0, r.stdout + r.stderr)

# Missing after evidence must refuse completion.
with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'; state = create_project(root, CORE, git_backed=True); before = state['trusted_revision']
    install_controlled_change(root, 'CHG-9005', status='validated', attempt=True, before=before, outcome='passed')
    git(root, 'add', 'specforge/changes'); git(root, 'commit', '-m', 'missing source-after fixture')
    r = run(root, 'transition', 'CHG-9005', '--to', 'completed'); out = result_json(r)
    check('completion-refused-without-evidence', r.returncode != 0 and 'passed_implementation_with_required_evidence_and_source_revision_missing' in out.get('blockers', []), r.stdout + r.stderr)

# Tampering with the exact approved proposal invalidates approval.
with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'; create_project(root, CORE, git_backed=True)
    rec = install_controlled_change(root, 'CHG-9006', status='approved', attempt=False)
    git(root, 'add', 'specforge/changes'); git(root, 'commit', '-m', 'proposal tamper fixture')
    rec['proposal_path'].write_text(rec['proposal_path'].read_text(encoding='utf-8') + '\n# tamper\n', encoding='utf-8')
    r = run(root, 'transition', 'CHG-9006', '--to', 'in_progress'); out = result_json(r)
    check('proposal-digest-tamper-blocked', r.returncode != 0 and 'valid_exact_human_approval_missing' in out.get('blockers', []), r.stdout + r.stderr)

# False completion with equal immutable revisions must be refused.
with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'; state = create_project(root, CORE, git_backed=True); equal = state['trusted_revision']
    install_controlled_change(root, 'CHG-9007', status='validated', attempt=True, before=equal, after=equal, outcome='passed')
    git(root, 'add', 'specforge/changes'); git(root, 'commit', '-m', 'false completion fixture')
    r = run(root, 'transition', 'CHG-9007', '--to', 'completed'); out = result_json(r)
    check('copilot-false-completion-refused', r.returncode != 0 and 'source_revision_not_advanced' in out.get('blockers', []) and 'passed_implementation_with_required_evidence_and_source_revision_missing' in out.get('blockers', []), r.stdout + r.stderr)

print('Lifecycle tests PASSED')
