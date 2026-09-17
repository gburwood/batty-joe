#!/usr/bin/env python3
from pathlib import Path
import json, subprocess, sys, tempfile, yaml

CORE = Path(__file__).resolve().parents[1]
TOOLS = CORE / 'tools'
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from portable_fixture import create_project, git, install_controlled_change
from specforge_project import discover_layout
from specforge_integration import PROFILE, build_git_integration_evidence


def run(root, *args):
    tool = root / 'specforge/core/tools/specforge-lifecycle.py'
    return subprocess.run([sys.executable, '-B', str(tool), *args, '--root', str(root), '--json'], capture_output=True, text=True)


def check(name, condition, detail=''):
    if not condition:
        if detail:
            print(detail)
        raise AssertionError(name)
    print('PASS', name)


def result_json(result):
    return json.loads(result.stdout)


with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'
    create_project(root, CORE, git_backed=True)
    install_controlled_change(root, 'CHG-9003', status='approved', attempt=False)
    git(root, 'add', 'specforge/changes')
    git(root, 'commit', '-m', 'portable lifecycle fixture')
    r = run(root, 'bootstrap')
    check('bootstrap-ready', r.returncode == 0, r.stdout + r.stderr)
    r = run(root, 'transition', 'CHG-9003', '--to', 'in_progress')
    check('exact-approval-permits-implementation', r.returncode == 0, r.stdout + r.stderr)


with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'
    state = create_project(root, CORE, git_backed=True)
    before = state['trusted_revision']
    install_controlled_change(root, 'CHG-9004', status='in_progress', attempt=True, before=before, outcome='in_progress')
    git(root, 'add', 'specforge/changes')
    git(root, 'commit', '-m', 'start portable implementation')
    (root / 'product.txt').write_text('two\n', encoding='utf-8', newline='\n')
    git(root, 'add', 'product.txt')
    git(root, 'commit', '-m', 'portable material implementation')
    core_meta = root / 'specforge/core/core.yaml'
    meta = yaml.safe_load(core_meta.read_text(encoding='utf-8'))
    meta['material_revision']['verification_profile'] = 'immutable_material_v2'
    core_meta.write_text(yaml.safe_dump(meta, sort_keys=False), encoding='utf-8', newline='\n')
    git(root, 'add', 'specforge/core/core.yaml')
    git(root, 'commit', '-m', 'fixture v2 profile')
    after = git(root, 'rev-parse', 'HEAD').stdout.strip()
    install_controlled_change(root, 'CHG-9004', status='validated', attempt=True, before=before, after=after, outcome='passed')
    git(root, 'add', 'specforge/changes')
    git(root, 'commit', '-m', 'record passed portable implementation')
    r = run(root, 'transition', 'CHG-9004', '--to', 'completed')
    check('v2-completed-change-has-valid-completion-evidence', r.returncode == 0, r.stdout + r.stderr)


with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'
    state = create_project(root, CORE, git_backed=True)
    before = state['trusted_revision']
    install_controlled_change(root, 'CHG-9005', status='validated', attempt=True, before=before, outcome='passed')
    git(root, 'add', 'specforge/changes')
    git(root, 'commit', '-m', 'missing source-after fixture')
    r = run(root, 'transition', 'CHG-9005', '--to', 'completed')
    out = result_json(r)
    check(
        'completion-refused-without-evidence',
        r.returncode != 0 and (
            'passed_implementation_with_required_evidence_and_source_revision_missing' in out.get('blockers', [])
            or 'integration_evidence_required_by_current_material_profile' in out.get('blockers', [])
        ),
        r.stdout + r.stderr,
    )


with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'
    create_project(root, CORE, git_backed=True)
    rec = install_controlled_change(root, 'CHG-9006', status='approved', attempt=False)
    git(root, 'add', 'specforge/changes')
    git(root, 'commit', '-m', 'proposal tamper fixture')
    rec['proposal_path'].write_text(rec['proposal_path'].read_text(encoding='utf-8') + '\n# tamper\n', encoding='utf-8')
    r = run(root, 'transition', 'CHG-9006', '--to', 'in_progress')
    out = result_json(r)
    check('proposal-digest-tamper-blocked', r.returncode != 0 and 'valid_exact_human_approval_missing' in out.get('blockers', []), r.stdout + r.stderr)


with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'
    state = create_project(root, CORE, git_backed=True)
    equal = state['trusted_revision']
    install_controlled_change(root, 'CHG-9007', status='validated', attempt=True, before=equal, after=equal, outcome='passed')
    git(root, 'add', 'specforge/changes')
    git(root, 'commit', '-m', 'false completion fixture')
    r = run(root, 'transition', 'CHG-9007', '--to', 'completed')
    out = result_json(r)
    check(
        'false-completion-refused',
        r.returncode != 0 and 'passed_implementation_with_required_evidence_and_source_revision_missing' in out.get('blockers', []),
        r.stdout + r.stderr,
    )


with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'repo'
    state = create_project(root, CORE, git_backed=True)
    git(root, 'branch', '-M', 'main')
    before = state['trusted_revision']
    install_controlled_change(
        root,
        'CHG-9015',
        status='in_progress',
        attempt=True,
        before=before,
        outcome='in_progress',
        verification_profile=PROFILE,
    )
    git(root, 'add', 'specforge/changes')
    git(root, 'commit', '-m', 'start v3 governed implementation')
    target_before = git(root, 'rev-parse', 'HEAD').stdout.strip()

    (root / 'product.txt').write_text('two\n', encoding='utf-8', newline='\n')
    git(root, 'add', 'product.txt')
    git(root, 'commit', '-m', 'v3 material implementation')
    after = git(root, 'rev-parse', 'HEAD').stdout.strip()

    layout = discover_layout(root)
    built = build_git_integration_evidence(
        layout,
        {
            'system': 'git',
            'before': before,
            'after': after,
            'material_effects': True,
            'verification_profile': PROFILE,
        },
        'main',
        target_before,
    )
    check('v3-lifecycle-fixture-integration-built', built['valid'], str(built))
    install_controlled_change(
        root,
        'CHG-9015',
        status='validated',
        attempt=True,
        before=before,
        after=after,
        outcome='passed',
        integration=built['integration'],
        verification_profile=PROFILE,
    )
    git(root, 'add', 'specforge/changes')
    git(root, 'commit', '-m', 'record v3 integration evidence')

    r = run(root, 'transition', 'CHG-9015', '--to', 'completed')
    check('v3-integration-aware-completion-permitted', r.returncode == 0, r.stdout + r.stderr)

    attempt_path = root / 'specforge/changes/CHG-9015/implementation/IMP-9015-01.yaml'
    attempt = yaml.safe_load(attempt_path.read_text(encoding='utf-8'))
    attempt.pop('integration', None)
    attempt_path.write_text(yaml.safe_dump(attempt, sort_keys=False), encoding='utf-8', newline='\n')
    r = run(root, 'transition', 'CHG-9015', '--to', 'completed')
    out = result_json(r)
    check(
        'v3-completion-refused-without-integration-evidence',
        r.returncode != 0 and 'integration_evidence_required_by_current_material_profile' in out.get('blockers', []),
        r.stdout + r.stderr,
    )

print('Lifecycle tests PASSED')
