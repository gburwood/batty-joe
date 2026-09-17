#!/usr/bin/env python3
from copy import deepcopy
from pathlib import Path
import sys
import tempfile

CORE = Path(__file__).resolve().parents[1]
TOOLS = CORE / 'tools'
sys.path.insert(0, str(TOOLS))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from portable_fixture import create_project, git
from specforge_project import discover_layout, material_snapshot
from specforge_integration import (
    PROFILE,
    build_git_integration_evidence,
    build_snapshot_integration_evidence,
    capture_target,
    material_snapshot_for_git_revision,
    verify_integration_evidence,
)


def check(name, condition, detail=''):
    if not condition:
        if detail:
            print(detail)
        raise AssertionError(name)
    print('PASS', name)


def source_revision(before, after):
    return {
        'system': 'git',
        'before': before,
        'after': after,
        'material_effects': True,
        'verification_profile': PROFILE,
    }


def init_git_case(td):
    root = Path(td) / 'repo'
    state = create_project(root, CORE, git_backed=True)
    git(root, 'branch', '-M', 'main')
    return root, state


def implement_feature(root, text='two\n'):
    before = git(root, 'rev-parse', 'main').stdout.strip()
    git(root, 'checkout', '-b', 'feature')
    (root / 'product.txt').write_text(text, encoding='utf-8', newline='\n')
    git(root, 'add', 'product.txt')
    git(root, 'commit', '-m', 'feature material implementation')
    after = git(root, 'rev-parse', 'HEAD').stdout.strip()
    return before, after


def implementation_record(source, integration):
    return {
        'source_revision': source,
        'integration': integration,
    }


# Direct/fast-forward integration: the implementation commit itself may be the target-line revision.
with tempfile.TemporaryDirectory() as td:
    root, state = init_git_case(td)
    target_before, source_after = implement_feature(root)
    git(root, 'checkout', 'main')
    git(root, 'merge', '--ff-only', 'feature')
    layout = discover_layout(root)
    captured = capture_target(layout, target_before)
    check('capture-target-resolves-pre-integration-state', captured['captured'] and captured['target_before'] == target_before)
    built = build_git_integration_evidence(layout, source_revision(state['trusted_revision'], source_after), 'main', target_before)
    check('direct-integration-builds', built['valid'], str(built))
    check('direct-integration-selects-source-commit', built['integration']['integrated_revision'] == source_after)
    verified = verify_integration_evidence(layout, implementation_record(source_revision(state['trusted_revision'], source_after), built['integration']), mode='transition')
    check('direct-integration-verifies', verified['valid'], str(verified))


# Normal merge: first-parent target transition must identify the merge commit, not the same-tree source commit.
with tempfile.TemporaryDirectory() as td:
    root, state = init_git_case(td)
    target_before, source_after = implement_feature(root)
    git(root, 'checkout', 'main')
    git(root, 'merge', '--no-ff', 'feature', '-m', 'merge governed implementation')
    merge_commit = git(root, 'rev-parse', 'HEAD').stdout.strip()
    layout = discover_layout(root)
    built = build_git_integration_evidence(layout, source_revision(state['trusted_revision'], source_after), 'main', target_before)
    check('normal-merge-builds', built['valid'], str(built))
    check('normal-merge-discovers-target-merge-not-source', built['integration']['integrated_revision'] == merge_commit and merge_commit != source_after)
    attack = build_git_integration_evidence(
        layout,
        source_revision(state['trusted_revision'], source_after),
        'main',
        target_before,
        integrated_revision=source_after,
    )
    check('arbitrary-same-tree-source-commit-rejected', not attack['valid'] and 'integration_revision_not_mechanically_discovered_target_transition' in attack['blockers'])
    verified = verify_integration_evidence(layout, implementation_record(source_revision(state['trusted_revision'], source_after), built['integration']), mode='transition')
    check('normal-merge-verifies', verified['valid'], str(verified))
    tampered = deepcopy(built['integration'])
    tampered['integrated_material']['revision'] = 'sha256:' + ('0' * 64)
    rejected = verify_integration_evidence(layout, implementation_record(source_revision(state['trusted_revision'], source_after), tampered), mode='transition')
    check('stored-equivalence-claim-cannot-override-material-mismatch', not rejected['valid'] and 'integration_material_identity_mismatch' in rejected['blockers'])

    # AC-1015-10: a real commit with matching material but outside the accepted current lineage is rejected.
    git(root, 'checkout', '-b', 'off-target', target_before)
    (root / 'product.txt').write_text('two\n', encoding='utf-8', newline='\n')
    git(root, 'add', 'product.txt')
    git(root, 'commit', '-m', 'same material outside accepted target lineage')
    off_target = git(root, 'rev-parse', 'HEAD').stdout.strip()
    off_material = material_snapshot_for_git_revision(discover_layout(root), off_target)
    git(root, 'checkout', 'main')
    off_line = deepcopy(built['integration'])
    off_line['integrated_revision'] = off_target
    off_line['integrated_material'] = {
        'provider': 'specforge_snapshot',
        'revision': off_material['snapshot']['revision'],
        'file_count': off_material['snapshot']['file_count'],
    }
    rejected = verify_integration_evidence(
        discover_layout(root),
        implementation_record(source_revision(state['trusted_revision'], source_after), off_line),
        mode='transition',
    )
    check(
        'integrated-revision-outside-current-lineage-rejected',
        not rejected['valid'] and 'integrated_revision_not_on_current_project_lineage' in rejected['blockers'],
        str(rejected),
    )


# Squash integration: source-after ancestry is intentionally not required on the accepted line.
with tempfile.TemporaryDirectory() as td:
    root, state = init_git_case(td)
    target_before, source_after = implement_feature(root)
    git(root, 'checkout', 'main')
    git(root, 'merge', '--squash', 'feature')
    git(root, 'commit', '-m', 'squash governed implementation')
    squash_commit = git(root, 'rev-parse', 'HEAD').stdout.strip()
    check('squash-source-not-ancestor-of-target', git(root, 'merge-base', '--is-ancestor', source_after, squash_commit, check=False).returncode != 0)
    layout = discover_layout(root)
    built = build_git_integration_evidence(layout, source_revision(state['trusted_revision'], source_after), 'main', target_before)
    check('squash-integration-builds', built['valid'], str(built))
    check('squash-discovers-integrated-revision', built['integration']['integrated_revision'] == squash_commit)
    verified = verify_integration_evidence(layout, implementation_record(source_revision(state['trusted_revision'], source_after), built['integration']), mode='transition')
    check('batty-joe-chg0012-squash-topology-verifies-without-repair-merge', verified['valid'], str(verified))

    historical = implementation_record(source_revision(state['trusted_revision'], '0' * 40), deepcopy(built['integration']))
    static = verify_integration_evidence(layout, historical, mode='static')
    check('static-v3-survives-unreachable-source-object-using-persisted-material-proof', static['valid'], str(static))
    live = verify_integration_evidence(layout, historical, mode='transition')
    check('transition-v3-still-requires-live-source-evidence', not live['valid'] and 'source_revision_after_not_git_commit' in live['blockers'])


# Rebase-style integration: target advances with governance-only material, source commit is rewritten, then target fast-forwards.
with tempfile.TemporaryDirectory() as td:
    root, state = init_git_case(td)
    _original_target, source_after = implement_feature(root)
    git(root, 'checkout', 'main')
    history = root / 'specforge/history/EVT-rebase-fixture.yaml'
    history.write_text('fixture: governance-only target advance\n', encoding='utf-8', newline='\n')
    git(root, 'add', 'specforge/history/EVT-rebase-fixture.yaml')
    git(root, 'commit', '-m', 'governance-only target advance')
    target_before = git(root, 'rev-parse', 'HEAD').stdout.strip()
    git(root, 'checkout', 'feature')
    git(root, 'rebase', 'main')
    rebased_after = git(root, 'rev-parse', 'HEAD').stdout.strip()
    git(root, 'checkout', 'main')
    git(root, 'merge', '--ff-only', 'feature')
    check('rebase-rewrites-source-commit', rebased_after != source_after)
    check('original-source-not-ancestor-after-rebase', git(root, 'merge-base', '--is-ancestor', source_after, rebased_after, check=False).returncode != 0)
    layout = discover_layout(root)
    built = build_git_integration_evidence(layout, source_revision(state['trusted_revision'], source_after), 'main', target_before)
    check('rebase-integration-builds-from-original-reviewed-source-material', built['valid'], str(built))
    check('rebase-discovers-rewritten-target-revision', built['integration']['integrated_revision'] == rebased_after)
    verified = verify_integration_evidence(layout, implementation_record(source_revision(state['trusted_revision'], source_after), built['integration']), mode='transition')
    check('rebase-integration-verifies', verified['valid'], str(verified))


# Integration containing additional material must not be accepted as equivalent.
with tempfile.TemporaryDirectory() as td:
    root, state = init_git_case(td)
    target_before, source_after = implement_feature(root)
    git(root, 'checkout', 'main')
    git(root, 'merge', '--squash', 'feature')
    (root / 'extra.txt').write_text('not reviewed\n', encoding='utf-8', newline='\n')
    git(root, 'add', 'extra.txt')
    git(root, 'commit', '-m', 'squash with extra material')
    layout = discover_layout(root)
    built = build_git_integration_evidence(layout, source_revision(state['trusted_revision'], source_after), 'main', target_before)
    check('changed-integrated-material-rejected', not built['valid'] and 'integration_material_not_found_on_target_first_parent_path' in built['blockers'])


# Missing or false target provenance fails closed.
with tempfile.TemporaryDirectory() as td:
    root, state = init_git_case(td)
    target_before, source_after = implement_feature(root)
    git(root, 'checkout', 'main')
    git(root, 'merge', '--squash', 'feature')
    git(root, 'commit', '-m', 'squash governed implementation')
    layout = discover_layout(root)
    missing = build_git_integration_evidence(layout, source_revision(state['trusted_revision'], source_after), 'main', '0' * 40)
    check('missing-target-before-fails-closed', not missing['valid'] and 'integration_target_before_not_git_commit' in missing['blockers'])


# Git checkout normalization must not create false material drift. Commit-to-commit identity
# stays byte-exact, while live capture uses Git's provider-native diff semantics.
with tempfile.TemporaryDirectory() as td:
    root, state = init_git_case(td)
    git(root, 'config', 'core.autocrlf', 'true')
    target_before, source_after = implement_feature(root)
    git(root, 'checkout', 'main')
    git(root, 'merge', '--ff-only', 'feature')
    # Force a checkout through Git's configured text conversion on platforms where it applies.
    git(root, 'checkout', '--', 'product.txt')
    layout = discover_layout(root)
    revision = material_snapshot_for_git_revision(layout, source_after)
    check('arbitrary-git-revision-materialises', revision['valid'], str(revision))
    built = build_git_integration_evidence(
        layout, source_revision(state['trusted_revision'], source_after), 'main', target_before
    )
    verified = verify_integration_evidence(
        layout,
        implementation_record(source_revision(state['trusted_revision'], source_after), built['integration']),
        mode='transition',
    )
    check('git-autocrlf-checkout-does-not-create-false-material-drift', verified['valid'], str(verified))


# Provider-neutral direct snapshot integration remains supported without Git.
with tempfile.TemporaryDirectory() as td:
    root = Path(td) / 'snapshot-project'
    create_project(root, CORE, git_backed=False)
    layout = discover_layout(root)
    before = material_snapshot(layout)['revision']
    (root / 'product.txt').write_text('two\n', encoding='utf-8', newline='\n')
    after = material_snapshot(layout)['revision']
    source = {
        'system': 'specforge_snapshot',
        'before': before,
        'after': after,
        'material_effects': True,
        'verification_profile': PROFILE,
    }
    built = build_snapshot_integration_evidence(layout, source)
    check('snapshot-direct-integration-builds', built['valid'], str(built))
    verified = verify_integration_evidence(layout, implementation_record(source, built['integration']), mode='transition')
    check('snapshot-direct-integration-verifies', verified['valid'], str(verified))
    equal = dict(source)
    equal['before'] = after
    rejected = build_snapshot_integration_evidence(layout, equal)
    check('snapshot-material-effects-must-advance', not rejected['valid'] and 'source_revision_not_advanced' in rejected['blockers'])

print('Integration evidence tests PASSED')
