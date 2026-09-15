#!/usr/bin/env python3
from pathlib import Path
import json, subprocess, sys, tempfile

CORE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from portable_fixture import create_project, git, install_controlled_change, write_yaml


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True)

def expect(cond, name, detail=''):
    if not cond:
        print('FAIL:', name); print(detail); raise SystemExit(1)
    print('PASS:', name)

with tempfile.TemporaryDirectory(prefix='specforge-auth-') as td:
    project = Path(td) / 'project'
    state = create_project(project, CORE, git_backed=True)
    trusted = state['trusted_revision']
    install_controlled_change(project, 'CHG-9001', status='approved', attempt=False)
    git(project, 'add', 'specforge/changes'); git(project, 'commit', '-m', 'portable governed fixture')
    guard = project / 'specforge/core/tools/specforge-authorization.py'
    def guard_run(*extra): return run(sys.executable, '-B', str(guard), *extra, '--root', str(project), '--json')

    expect(guard_run().returncode == 0, 'clean-project-valid')
    readme = project / 'README.md'; original = readme.read_text(encoding='utf-8')
    readme.write_text(original + '\nunauthorized edit\n', encoding='utf-8')
    u = guard_run(); expect(u.returncode != 0, 'unauthorized-material-blocked', u.stdout); expect('README.md' in u.stdout, 'unauthorized-path-reported', u.stdout)
    git(project, 'add', 'README.md'); git(project, 'commit', '-m', 'unauthorized commit'); u = guard_run(); expect(u.returncode != 0, 'unauthorized-commit-remains-blocked', u.stdout)

    git(project, 'reset', '--hard', trusted)
    write_yaml(project / 'specforge/evidence/material-authority.yaml', {'version': 1, 'trusted': {'provider': 'git', 'revision': trusted}})
    install_controlled_change(project, 'CHG-9001', status='in_progress', attempt=True, before=trusted, outcome='in_progress')
    git(project, 'add', 'specforge/evidence/material-authority.yaml', 'specforge/changes'); git(project, 'commit', '-m', 'start authorized implementation')
    readme.write_text(original + '\nauthorized edit\n', encoding='utf-8')
    a = guard_run(); expect(a.returncode == 0, 'authorized-material-permitted', a.stdout); expect(json.loads(a.stdout).get('authorized') is True, 'active-authorization-reported', a.stdout)
    git(project, 'add', 'README.md'); git(project, 'commit', '-m', 'authorized material')
    acc = guard_run('accept'); expect(acc.returncode == 0, 'trusted-baseline-advances-after-clean-commit', acc.stdout)
    expect(guard_run().returncode == 0, 'accepted-state-valid')

print('Authorization regression tests PASSED')
