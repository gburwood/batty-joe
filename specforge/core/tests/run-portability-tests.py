#!/usr/bin/env python3
from pathlib import Path
import subprocess, sys, tempfile

CORE = Path(__file__).resolve().parents[1]
TESTS = CORE / 'tests'
sys.path.insert(0, str(TESTS))
from portable_fixture import create_project

TARGETS = sorted(path.name for path in TESTS.glob('run-*-tests.py') if path.name != 'run-portability-tests.py')

with tempfile.TemporaryDirectory(prefix='specforge-portability-') as td:
    host = Path(td) / 'minimal-host'
    create_project(host, CORE, git_backed=True)
    for name in TARGETS:
        script = host / 'specforge/core/tests' / name
        result = subprocess.run([sys.executable, '-B', str(script)], cwd=host, capture_output=True, text=True)
        if result.returncode:
            raise AssertionError(f'{name} failed in minimal independent host\n{result.stdout}\n{result.stderr}')
        print('PASS minimal-host-' + name.removeprefix('run-').removesuffix('.py'))

print('Portability regression tests PASSED')
