#!/usr/bin/env python3
from pathlib import Path
import hashlib, json, subprocess, sys, tempfile, yaml

CORE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from portable_fixture import create_project, install_controlled_change

def run(root, *args):
    tool = root / 'specforge/core/tools/specforge-status.py'
    return subprocess.run([sys.executable, '-B', str(tool), '--root', str(root), *args], capture_output=True, text=True)

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

with tempfile.TemporaryDirectory(prefix='specforge-status-') as td:
    root = Path(td) / 'repo'
    create_project(root, CORE, git_backed=True)
    install_controlled_change(root, 'CHG-9001', status='approved')
    install_controlled_change(root, 'CHG-9002', status='completed')
    result = run(root, '--json'); assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    expected_core = yaml.safe_load((CORE / 'core.yaml').read_text(encoding='utf-8'))['core_version']
    assert report['project']['id'] == 'PRJ-PORTABLE'
    assert report['specforge']['core_version'] == expected_core
    assert any(item['id'] == 'CHG-9002' for item in report['changes']['terminal'])
    open_change = next(item for item in report['changes']['open'] if item['id'] == 'CHG-9001')
    assert open_change['current_links']['impact_analysis']['id'] == 'IA-9001-01'
    assert open_change['current_links']['proposal']['id'] == 'PROP-9001-01'
    assert open_change['effective_approval']['status'] == 'approved'
    result = run(root); assert result.returncode == 0, result.stderr
    for token in ('SpecForge project status', 'PRJ-PORTABLE', 'CHG-9001', 'PROP-9001-01', 'APR-9001'):
        assert token in result.stdout, token
    tracked = root / 'specforge/changes/CHG-9001.yaml'; before = digest(tracked)
    assert run(root, '--json').returncode == 0 and digest(tracked) == before
    data = yaml.safe_load(tracked.read_text(encoding='utf-8')); data['impact_analysis']['current'] = 'IA-9999-01'
    tracked.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
    broken = json.loads(run(root, '--json').stdout)
    assert 'CHG-9001: Missing impact analysis IA-9999-01' in broken['gaps']
print('Status tests PASSED')
