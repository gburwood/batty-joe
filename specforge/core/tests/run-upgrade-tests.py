#!/usr/bin/env python3
from pathlib import Path
import hashlib, importlib.util, json, os, shutil, subprocess, sys, tempfile, yaml

CORE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path(__file__).resolve().parent))
from portable_fixture import create_project, git, install_controlled_change


def run(tool, args, cwd=None):
    env = os.environ.copy(); env['PYTHONDONTWRITEBYTECODE'] = '1'
    return subprocess.run([sys.executable, '-B', str(tool), *args], cwd=cwd, capture_output=True, text=True, env=env)

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def tree_digest(root):
    h = hashlib.sha256()
    for path in sorted(p for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts and not p.name.endswith(('.pyc', '.pyo'))):
        h.update(path.relative_to(root).as_posix().encode('utf-8')); h.update(b'\0'); h.update(path.read_bytes()); h.update(b'\0')
    return h.hexdigest()

def load_upgrade_module():
    tools = CORE / 'tools'
    sys.path.insert(0, str(tools))
    spec = importlib.util.spec_from_file_location('specforge_upgrade_under_test', tools / 'specforge-upgrade.py')
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

def recording_tempdirs(module):
    real = module.tempfile.TemporaryDirectory
    created = []
    class RecordingTemporaryDirectory:
        def __init__(self, *args, **kwargs): self.inner = real(*args, **kwargs)
        def __enter__(self):
            path = self.inner.__enter__(); created.append(Path(path).resolve()); return path
        def __exit__(self, *args): return self.inner.__exit__(*args)
    module.tempfile.TemporaryDirectory = RecordingTemporaryDirectory
    return created

def assert_external(paths, project):
    project = project.resolve()
    for path in paths:
        try: path.relative_to(project)
        except ValueError: continue
        raise AssertionError(f'rollback scratch created inside project: {path}')

def stage_distribution(project, version, formats):
    core = project / 'specforge-dist' / version / 'core'
    shutil.copytree(CORE, core, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo'))
    meta = yaml.safe_load((core / 'core.yaml').read_text(encoding='utf-8')); meta['core_version'] = version; meta.setdefault('compatibility', {})['project_formats'] = formats
    (core / 'core.yaml').write_text(yaml.safe_dump(meta, sort_keys=False), encoding='utf-8')
    pkg = yaml.safe_load((core / 'package.yaml').read_text(encoding='utf-8')); pkg['package']['version'] = version; pkg['compatibility']['project_formats'] = formats
    (core / 'package.yaml').write_text(yaml.safe_dump(pkg, sort_keys=False), encoding='utf-8')
    return core

with tempfile.TemporaryDirectory() as td:
    fixture = Path(td) / 'repo'
    create_project(fixture, CORE, git_backed=True)
    install_controlled_change(fixture, 'CHG-9002', status='completed', attempt=False)
    git(fixture, 'add', 'specforge/changes'); git(fixture, 'commit', '-m', 'portable preserved governance record')
    candidate = stage_distribution(fixture, '0.1.0-alpha.11-test', [1])
    tool = candidate / 'tools/specforge-upgrade.py'
    change = fixture / 'specforge/changes/CHG-9002.yaml'; before = digest(change)
    r = run(tool, ['upgrade', '--root', str(fixture), '--apply', '--json'])
    assert r.returncode == 0, r.stdout + r.stderr
    data = json.loads(r.stdout); assert data['applied'] and data['authority']['type'] == 'core_upgrade'; assert digest(change) == before
    guard = fixture / 'specforge/core/tools/specforge-authorization.py'
    r = run(guard, ['--root', str(fixture), '--json']); assert r.returncode == 0, r.stdout + r.stderr
    (fixture / 'README.md').write_text((fixture / 'README.md').read_text(encoding='utf-8') + '\nout-of-scope\n', encoding='utf-8')
    r = run(guard, ['--root', str(fixture), '--json']); assert r.returncode != 0 and 'managed_upgrade_scope_violation' in r.stdout

with tempfile.TemporaryDirectory() as td:
    base = Path(td)
    fixture = base / 'batty-joe-shaped'
    create_project(fixture, CORE, git_backed=True, declared_core_version='0.1.0-alpha.8')
    shutil.rmtree(fixture / 'specforge/packs'); shutil.rmtree(fixture / 'specforge/decisions')
    install_controlled_change(fixture, 'CHG-0008', status='completed', attempt=False)
    product = fixture / 'product.txt'; product_before = digest(product)
    change = fixture / 'specforge/changes/CHG-0008.yaml'; change_before = digest(change)
    git(fixture, 'add', '.'); git(fixture, 'commit', '-m', 'Batty Joe shaped alpha.8 baseline')
    candidate = base / 'candidate' / 'core'
    shutil.copytree(CORE, candidate, ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo'))
    tool = candidate / 'tools/specforge-upgrade.py'
    result = run(tool, ['upgrade', '--root', str(fixture), '--distribution', str(candidate), '--apply', '--json'])
    assert result.returncode == 0, result.stdout + result.stderr
    upgraded = json.loads(result.stdout)
    assert upgraded['applied'] and upgraded['current_core_version'] == '0.1.0-alpha.8'
    assert digest(product) == product_before and digest(change) == change_before
    assert not (fixture / 'specforge/packs').exists() and not (fixture / 'specforge/decisions').exists()
    validator = fixture / 'specforge/core/tools/validate-specforge.py'
    result = run(validator, ['--root', str(fixture)])
    assert result.returncode == 0, result.stdout + result.stderr
    git(fixture, 'add', '.'); git(fixture, 'commit', '-m', 'Apply managed Core upgrade')
    checkout = base / 'fresh-checkout'
    result = subprocess.run(['git', 'clone', '--quiet', '--local', '--no-hardlinks', str(fixture), str(checkout)], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr
    validator = checkout / 'specforge/core/tools/validate-specforge.py'
    result = run(validator, ['--root', str(checkout)])
    assert result.returncode == 0, result.stdout + result.stderr
    authority = yaml.safe_load((checkout / 'specforge/evidence/material-authority.yaml').read_text(encoding='utf-8'))
    assert authority['active_operation']['type'] == 'core_upgrade'

with tempfile.TemporaryDirectory() as td:
    fixture = Path(td) / 'rollback-existing-authority'
    create_project(fixture, CORE, git_backed=True)
    candidate = stage_distribution(fixture, '0.1.0-alpha.12-rollback-test', [1])
    upgrade = load_upgrade_module(); created = recording_tempdirs(upgrade)
    core_before = tree_digest(fixture / 'specforge/core')
    manifest_path = fixture / 'specforge/project.yaml'; manifest_before = manifest_path.read_bytes()
    authority_path = fixture / 'specforge/evidence/material-authority.yaml'; authority_before = authority_path.read_bytes()
    evidence_path = fixture / 'specforge/evidence/upgrades/core-0.1.0-alpha.11-to-0.1.0-alpha.12-rollback-test.yaml'
    def fail_after_authority(*_args, **_kwargs): raise RuntimeError('injected failure after authority establishment')
    upgrade.write_evidence = fail_after_authority
    try: upgrade.apply(fixture, candidate)
    except RuntimeError as exc: assert 'injected failure' in str(exc)
    else: raise AssertionError('controlled post-authority failure was not raised')
    assert tree_digest(fixture / 'specforge/core') == core_before
    assert manifest_path.read_bytes() == manifest_before
    assert authority_path.read_bytes() == authority_before
    assert not evidence_path.exists()
    assert_external(created, fixture)

with tempfile.TemporaryDirectory() as td:
    fixture = Path(td) / 'rollback-absent-authority'
    create_project(fixture, CORE, git_backed=True)
    authority_path = fixture / 'specforge/evidence/material-authority.yaml'
    authority_path.unlink(); git(fixture, 'add', '-u'); git(fixture, 'commit', '-m', 'fixture without material authority')
    candidate = stage_distribution(fixture, '0.1.0-alpha.12-no-authority-test', [1])
    upgrade = load_upgrade_module(); created = recording_tempdirs(upgrade)
    core_before = tree_digest(fixture / 'specforge/core')
    manifest_path = fixture / 'specforge/project.yaml'; manifest_before = manifest_path.read_bytes()
    upgrade.write_evidence = fail_after_authority
    try: upgrade.apply(fixture, candidate)
    except RuntimeError as exc: assert 'injected failure' in str(exc)
    else: raise AssertionError('controlled post-authority failure was not raised')
    assert tree_digest(fixture / 'specforge/core') == core_before
    assert manifest_path.read_bytes() == manifest_before
    assert not authority_path.exists()
    assert_external(created, fixture)

with tempfile.TemporaryDirectory() as td:
    fixture = Path(td) / 'external-scratch-success'
    create_project(fixture, CORE, git_backed=True)
    candidate = stage_distribution(fixture, '0.1.0-alpha.12-success-test', [1])
    upgrade = load_upgrade_module(); created = recording_tempdirs(upgrade)
    result = upgrade.apply(fixture, candidate)
    assert result['applied'] and result['authority']['type'] == 'core_upgrade'
    assert created
    assert_external(created, fixture)

print('Upgrade tests PASSED')
