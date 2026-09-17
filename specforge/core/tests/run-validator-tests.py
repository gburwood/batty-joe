#!/usr/bin/env python3
from pathlib import Path
import subprocess, tempfile, shutil, sys, yaml

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / 'tools'
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from portable_fixture import create_project, git, install_controlled_change, write_yaml
from specforge_project import discover_layout
from specforge_integration import PROFILE, build_git_integration_evidence

VALIDATOR = ROOT / 'tools' / 'validate-specforge.py'
EXAMPLE = ROOT / 'examples' / 'minimal'


def run(path):
    return subprocess.run([sys.executable, str(VALIDATOR), str(path)], capture_output=True, text=True)


def expect_pass(path, label):
    r = run(path)
    assert r.returncode == 0, f"{label}\n{r.stdout}\n{r.stderr}"


def expect_fail(path, text, label):
    r = run(path)
    assert r.returncode != 0, f"{label}: unexpectedly passed"
    assert text in r.stdout, f"{label}: expected {text!r}\n{r.stdout}"


expect_pass(EXAMPLE, 'minimal example should validate')
expect_pass(ROOT, 'parent project should validate while excluding nested example project')

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / 'bad'
    shutil.copytree(EXAMPLE, bad)
    (bad / 'SPECFORGE.md').unlink()
    expect_fail(bad, 'Missing required file', 'missing bootstrap')

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / 'bad'
    shutil.copytree(EXAMPLE, bad)
    req = bad / 'spec/requirements/REQ-0001.yaml'
    data = yaml.safe_load(req.read_text())
    data['status'] = 'banana'
    req.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, 'Schema validation failed', 'schema validation')

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / 'bad'
    shutil.copytree(EXAMPLE, bad)
    req = bad / 'spec/requirements/REQ-0001.yaml'
    data = yaml.safe_load(req.read_text())
    data['introduced']['by_change'] = 'CHG-9999'
    req.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, 'Broken reference', 'broken reference')

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / 'bad'
    shutil.copytree(EXAMPLE, bad)
    prop = bad / 'changes/CHG-0001/PROP-0001-01.yaml'
    data = yaml.safe_load(prop.read_text())
    data['change'] = 'CHG-9999'
    prop.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, 'Broken reference', 'proposal/change link')

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / 'bad'
    shutil.copytree(EXAMPLE, bad)
    appr = bad / 'changes/CHG-0001/approvals/APR-0001.yaml'
    data = yaml.safe_load(appr.read_text())
    data['proposal'] = 'PROP-9999-01'
    appr.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, 'Broken reference', 'approval/proposal link')

with tempfile.TemporaryDirectory() as td:
    bad = Path(td) / 'bad'
    shutil.copytree(EXAMPLE, bad)
    manifest = bad / 'specforge.yaml'
    data = yaml.safe_load(manifest.read_text())
    data['paths']['changes'] = './does-not-exist'
    manifest.write_text(yaml.safe_dump(data, sort_keys=False))
    expect_fail(bad, 'Manifest path', 'missing manifest path')

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'portable'
    create_project(portable, ROOT, git_backed=True)
    shutil.rmtree(portable / 'specforge/packs')
    shutil.rmtree(portable / 'specforge/decisions')
    expect_pass(portable, 'absent empty collection roots should validate')
    manifest = portable / 'specforge/project.yaml'
    data = yaml.safe_load(manifest.read_text(encoding='utf-8'))
    data['packs'] = [{'id': 'missing-pack', 'version': '1.0.0', 'path': './specforge/packs/missing-pack', 'precedence': 1, 'extensions': []}]
    manifest.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
    expect_fail(portable, "Manifest path 'packs'", 'missing declared pack collection')


with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'v3-valid'
    state = create_project(root, ROOT, git_backed=True)
    git(root, 'branch', '-M', 'main')
    before = state['trusted_revision']
    install_controlled_change(
        root,
        'CHG-9016',
        status='in_progress',
        attempt=True,
        before=before,
        outcome='in_progress',
        verification_profile=PROFILE,
    )
    git(root, 'add', 'specforge/changes')
    git(root, 'commit', '-m', 'start validator v3 fixture')
    target_before = git(root, 'rev-parse', 'HEAD').stdout.strip()
    (root / 'product.txt').write_text('two\n', encoding='utf-8', newline='\n')
    git(root, 'add', 'product.txt')
    git(root, 'commit', '-m', 'validator v3 material')
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
    assert built['valid'], built
    install_controlled_change(
        root,
        'CHG-9016',
        status='completed',
        attempt=True,
        before=before,
        after=after,
        outcome='passed',
        integration=built['integration'],
        verification_profile=PROFILE,
    )
    write_yaml(root / 'specforge/evidence/material-authority.yaml', {
        'version': 1,
        'trusted': {'provider': 'git', 'revision': after},
    })
    git(root, 'add', 'specforge/changes', 'specforge/evidence/material-authority.yaml')
    git(root, 'commit', '-m', 'record completed v3 evidence and trusted material baseline')
    expect_pass(root, 'completed v3 integration evidence should validate statically')

    attempt_path = root / 'specforge/changes/CHG-9016/implementation/IMP-9016-01.yaml'
    attempt = yaml.safe_load(attempt_path.read_text(encoding='utf-8'))
    attempt['integration']['integrated_material']['revision'] = 'sha256:' + ('0' * 64)
    attempt_path.write_text(yaml.safe_dump(attempt, sort_keys=False), encoding='utf-8', newline='\n')
    expect_fail(root, 'integration_material_identity_mismatch', 'validator rejects tampered v3 material equivalence')

# --- CHG-1017: manifest/installed-core/package/self-referencing consistency ---

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'core-version-drift'
    create_project(portable, ROOT, git_backed=True)
    manifest = portable / 'specforge/project.yaml'
    data = yaml.safe_load(manifest.read_text(encoding='utf-8'))
    data['specforge']['core_version'] = '0.1.0-alpha.1-drift'
    manifest.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
    expect_fail(portable, 'Manifest specforge.core_version', 'core_version vs installed core.yaml mismatch')

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'data-model-version-drift'
    create_project(portable, ROOT, git_backed=True)
    manifest = portable / 'specforge/project.yaml'
    data = yaml.safe_load(manifest.read_text(encoding='utf-8'))
    data['specforge']['data_model_version'] = '0.1.0-alpha.1-drift'
    manifest.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
    expect_fail(portable, 'Manifest specforge.data_model_version', 'data_model_version vs installed core.yaml mismatch')

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'package-version-drift'
    create_project(portable, ROOT, git_backed=True)
    package = portable / 'specforge/core/package.yaml'
    data = yaml.safe_load(package.read_text(encoding='utf-8'))
    data['package']['version'] = '0.1.0-alpha.1-drift'
    package.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
    expect_fail(portable, "package.yaml's declared version", 'package/core version mismatch, independent of a correct project.yaml')

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'self-ref-product-spec-consistent'
    create_project(portable, ROOT, git_backed=True, self_referencing_product_specification=True)
    expect_pass(portable, 'consistent self-referencing product specification should validate')

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'self-ref-product-spec-embedded-mismatch'
    create_project(portable, ROOT, git_backed=True, self_referencing_product_specification=True)
    manifest = portable / 'specforge/project.yaml'
    data = yaml.safe_load(manifest.read_text(encoding='utf-8'))
    data['specification']['product_specification'] = './specforge/core/docs/specforge-core-product-spec-0.1.0-alpha.14.md'
    manifest.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
    expect_fail(portable, 'product_specification self-references', 'self-referencing product-spec embedded-version mismatch')

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'self-ref-product-spec-current-version-mismatch'
    create_project(portable, ROOT, git_backed=True, self_referencing_product_specification=True)
    manifest = portable / 'specforge/project.yaml'
    data = yaml.safe_load(manifest.read_text(encoding='utf-8'))
    data['specification']['current_version'] = '9.9.9-mismatch'
    manifest.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
    expect_fail(portable, 'product_specification self-references', 'self-referencing product-spec current_version mismatch')

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'self-ref-data-model-consistent-mixed'
    create_project(portable, ROOT, git_backed=True, self_referencing_canonical_data_model=True)
    expect_pass(portable, 'own product spec + Core canonical data model (mixed reference) should validate, current_version unconstrained')

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'self-ref-data-model-embedded-mismatch'
    create_project(portable, ROOT, git_backed=True, self_referencing_canonical_data_model=True)
    manifest = portable / 'specforge/project.yaml'
    data = yaml.safe_load(manifest.read_text(encoding='utf-8'))
    data['specification']['canonical_data_model'] = './specforge/core/docs/specforge-core-canonical-data-model-0.1.0-alpha.4.md'
    manifest.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
    expect_fail(portable, 'canonical_data_model self-references', 'self-referencing canonical-data-model embedded-version mismatch')

with tempfile.TemporaryDirectory() as td:
    portable = Path(td) / 'unmanaged-core-version-drift'
    create_project(portable, ROOT, git_backed=False)
    manifest = portable / 'specforge/project.yaml'
    data = yaml.safe_load(manifest.read_text(encoding='utf-8'))
    data['specforge']['core_version'] = '0.1.0-alpha.1-drift'
    manifest.write_text(yaml.safe_dump(data, sort_keys=False), encoding='utf-8')
    expect_fail(portable, 'Manifest specforge.core_version', 'unmanaged-folder core_version vs installed core.yaml mismatch')

print('Validator tests PASSED')
