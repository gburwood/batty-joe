#!/usr/bin/env python3
from pathlib import Path
import hashlib, shutil, subprocess, yaml


def write_yaml(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True), encoding='utf-8', newline='\n')


def canonical_digest(path):
    text = path.read_bytes().decode('utf-8-sig').replace('\r\n', '\n').replace('\r', '\n')
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def git(root, *args, check=True):
    r = subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stdout + r.stderr)
    return r


def create_project(dst, core_root, git_backed=True, declared_core_version=None):
    dst.mkdir(parents=True, exist_ok=True)
    sf = dst / 'specforge'
    for rel in ('packs', 'changes', 'decisions', 'history', 'evidence'):
        (sf / rel).mkdir(parents=True, exist_ok=True)
    shutil.copytree(core_root, sf / 'core', ignore=shutil.ignore_patterns('__pycache__', '*.pyc', '*.pyo', '.pytest_cache'))
    meta = yaml.safe_load((sf / 'core/core.yaml').read_text(encoding='utf-8'))
    core_version = declared_core_version or meta['core_version']
    data_model = meta['data_model_version']
    if declared_core_version:
        meta['core_version'] = declared_core_version
        write_yaml(sf / 'core/core.yaml', meta)
        package_path = sf / 'core/package.yaml'
        package = yaml.safe_load(package_path.read_text(encoding='utf-8'))
        package['package']['version'] = declared_core_version
        write_yaml(package_path, package)
    manifest = {
        'specforge': {'project_format': 1, 'core_version': core_version, 'data_model_version': data_model},
        'project': {'id': 'PRJ-PORTABLE', 'name': 'Portable Core Test Fixture'},
        'specification': {
            'product_specification': './product.txt',
            'canonical_data_model': './model.txt',
            'current_version': '1.0.0',
        },
        'paths': {
            'core': './specforge/core', 'packs': './specforge/packs', 'schemas': './specforge/core/schemas',
            'rules': './specforge/core/rules', 'workflows': './specforge/core/workflows', 'tools': './specforge/core/tools',
            'tests': './specforge/core/tests', 'examples': './specforge/core/examples', 'changes': './specforge/changes',
            'decisions': './specforge/decisions', 'history': './specforge/history', 'evidence': './specforge/evidence',
        },
        'packs': [],
        'ownership': {
            'framework_owned': ['./specforge/core', './specforge/packs'],
            'project_owned': ['./specforge/project.yaml', './specforge/changes', './specforge/decisions', './specforge/history', './specforge/evidence'],
        },
        'policy': {
            'approval_mode': 'controlled', 'emergency_changes': 'allowed', 'trivial_change_exemption': 'allowed',
            'forensic_traceability': 'required', 'repository_completeness': 'required',
        },
    }
    write_yaml(sf / 'project.yaml', manifest)
    (sf / 'SPECFORGE.md').write_text('# Portable SpecForge test fixture\n', encoding='utf-8', newline='\n')
    (dst / 'product.txt').write_text('one\n', encoding='utf-8', newline='\n')
    (dst / 'model.txt').write_text('model\n', encoding='utf-8', newline='\n')
    (dst / 'README.md').write_text('portable fixture\n', encoding='utf-8', newline='\n')
    if not git_backed:
        return {'trusted_revision': None, 'head': None}
    git(dst, 'init'); git(dst, 'config', 'user.email', 'fixture@example.invalid'); git(dst, 'config', 'user.name', 'Portable Fixture')
    git(dst, 'add', '.'); git(dst, 'commit', '-m', 'fixture material baseline')
    trusted = git(dst, 'rev-parse', 'HEAD').stdout.strip()
    write_yaml(sf / 'evidence/material-authority.yaml', {'version': 1, 'trusted': {'provider': 'git', 'revision': trusted}})
    git(dst, 'add', 'specforge/evidence/material-authority.yaml'); git(dst, 'commit', '-m', 'record trusted material baseline')
    return {'trusted_revision': trusted, 'head': git(dst, 'rev-parse', 'HEAD').stdout.strip()}


def install_controlled_change(root, change_id='CHG-9001', status='approved', attempt=False, before=None, after=None, outcome='in_progress'):
    number = change_id.split('-')[-1]
    ia_id = f'IA-{number}-01'; prop_id = f'PROP-{number}-01'; apr_id = f'APR-{number}'; imp_id = f'IMP-{number}-01'
    base = root / 'specforge/changes'
    write_yaml(base / change_id / f'{ia_id}.yaml', {
        'id': ia_id, 'change': change_id, 'revision': 1, 'affected': {'capabilities': ['portable-test']}, 'summary': 'Portable synthetic impact analysis.'
    })
    prop_path = base / change_id / f'{prop_id}.yaml'
    write_yaml(prop_path, {
        'id': prop_id, 'change': change_id, 'revision': 1, 'status': 'awaiting_approval',
        'based_on_impact_analysis': [ia_id], 'proposed_specification_version': '1.0.1',
        'behaviour_summary': 'Portable synthetic governed change.',
        'requirement_changes': {'add': [], 'modify': [], 'deprecate': [], 'supersede': []},
        'acceptance_criteria': {'add': [{'id': f'AC-{number}-01', 'text': 'Portable fixture criterion.'}]},
        'approvals': [],
    })
    digest = canonical_digest(prop_path)
    write_yaml(base / change_id / 'approvals' / f'{apr_id}.yaml', {
        'id': apr_id, 'change': change_id, 'proposal': prop_id, 'decision': 'approved',
        'actor': {'type': 'human', 'id': 'fixture-product-owner'},
        'timestamp': '2026-01-01T00:00:00+00:00',
        'scope': {'proposed_specification_version': '1.0.1', 'proposal_sha256': digest},
        'evidence': {'proposal_digest_algorithm': 'sha256', 'proposal_digest': digest, 'proposal_identity': prop_id},
        'mechanism': {'type': 'test_fixture', 'reference': 'portable-governance'},
    })
    attempts = [imp_id] if attempt else []
    write_yaml(base / f'{change_id}.yaml', {
        'id': change_id, 'title': 'Portable synthetic change', 'classification': 'defect', 'status': status, 'priority': 'normal',
        'sources': [{'type': 'manual', 'reference': 'portable-test'}], 'request': {'summary': 'Portable synthetic governed change.'},
        'clarification': {'required': False}, 'relationships': {'depends_on': [], 'conflicts_with': [], 'related_to': [], 'supersedes': [], 'parent': None, 'children': []},
        'impact_analysis': {'current': ia_id}, 'proposal': {'current': prop_id}, 'approvals': [apr_id],
        'implementation': {'attempts': attempts}, 'requirements': {'affected': []}, 'release': {'completed_in': None},
        'governance': {'lifecycle_enforcement': 'controlled_v1', 'enforced_from_change': change_id},
    })
    if attempt:
        src = {'system': 'git'}
        if before is not None: src['before'] = before
        if after is not None: src['after'] = after
        write_yaml(base / change_id / 'implementation' / f'{imp_id}.yaml', {
            'id': imp_id, 'change': change_id, 'proposal': prop_id, 'attempt': 1,
            'actor': {'type': 'ai', 'id': 'portable-fixture'}, 'source_revision': src, 'outcome': outcome,
            'validation_checks': [{'name': 'portable-fixture-validation', 'required': True, 'status': 'passed' if outcome == 'passed' else 'blocked'}],
            'tests': {'status': 'passed' if outcome == 'passed' else 'pending', 'passed': ['portable-fixture'] if outcome == 'passed' else [], 'failed': []},
        })
    return {'change': change_id, 'impact': ia_id, 'proposal': prop_id, 'approval': apr_id, 'attempt': imp_id, 'proposal_path': prop_path}
