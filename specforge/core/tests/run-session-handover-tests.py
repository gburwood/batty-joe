#!/usr/bin/env python3
from pathlib import Path
import json, os, subprocess, sys, tempfile, yaml

CORE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from portable_fixture import create_project, install_controlled_change

with tempfile.TemporaryDirectory(prefix='specforge-handover-') as td:
    root = Path(td) / 'repo'
    create_project(root, CORE, git_backed=True)
    install_controlled_change(root, 'CHG-9001', status='approved')
    tools = root / 'specforge/core/tools'
    env = os.environ.copy(); env['PYTHONDONTWRITEBYTECODE'] = '1'
    boot = subprocess.run([sys.executable, '-B', str(tools / 'specforge-lifecycle.py'), 'bootstrap', '--root', str(root), '--json'], capture_output=True, text=True, env=env)
    assert boot.returncode == 0, boot.stdout + boot.stderr
    data = json.loads(boot.stdout)
    expected_core = yaml.safe_load((CORE / 'core.yaml').read_text(encoding='utf-8'))['core_version']
    assert data['ready'] is True and data['blockers'] == []
    assert data['details']['project_format'] == 1 and data['details']['core_version'] == expected_core
    status = subprocess.run([sys.executable, '-B', str(tools / 'specforge-status.py'), '--root', str(root), '--json'], capture_output=True, text=True, env=env)
    assert status.returncode == 0, status.stdout + status.stderr
    report = json.loads(status.stdout)
    assert report['project']['id'] == 'PRJ-PORTABLE' and not report['gaps']
    change = next(item for item in report['changes']['open'] if item['id'] == 'CHG-9001')
    assert change['authority_state'] == 'approved'
    assert change['current_links']['proposal']['id'] == 'PROP-9001-01'
    assert change['effective_approval']['status'] == 'approved'
print('Session handover tests PASSED')
