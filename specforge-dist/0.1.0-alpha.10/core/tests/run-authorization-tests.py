#!/usr/bin/env python3
from pathlib import Path
import json, shutil, subprocess, sys, tempfile, yaml
ROOT=Path(__file__).resolve().parents[3]

def run(*args,cwd=None): return subprocess.run(args,cwd=cwd,capture_output=True,text=True)
def expect(cond,name,detail=''):
    if not cond:
        print('FAIL:',name); print(detail); raise SystemExit(1)
    print('PASS:',name)
def write_yaml(path,data):
    path.parent.mkdir(parents=True,exist_ok=True); path.write_text(yaml.safe_dump(data,sort_keys=False),encoding='utf-8')

with tempfile.TemporaryDirectory(prefix='specforge-auth-') as td:
    project=Path(td)/'project'; shutil.copytree(ROOT,project,ignore=shutil.ignore_patterns('.git','specforge-dist','__pycache__','*.pyc'))
    change_path=project/'specforge/changes/CHG-1010.yaml'; attempt_path=project/'specforge/changes/CHG-1010/implementation/IMP-1010-01.yaml'
    change=yaml.safe_load(change_path.read_text(encoding='utf-8')); change['status']='approved'; change.setdefault('implementation',{})['attempts']=[]; write_yaml(change_path,change)
    git=lambda *args: run('git',*args,cwd=project)
    expect(git('init').returncode==0,'git-init'); git('config','user.email','specforge-tests@example.invalid'); git('config','user.name','SpecForge Tests'); git('add','.'); expect(git('commit','-m','baseline').returncode==0,'git-commit-baseline')
    head=git('rev-parse','HEAD').stdout.strip(); authority=project/'specforge/evidence/material-authority.yaml'; write_yaml(authority,{'version':1,'trusted':{'provider':'git','revision':head}})
    guard=project/'specforge/core/tools/specforge-authorization.py'
    def guard_run(*extra): return run(sys.executable,str(guard),*extra,'--root',str(project),'--json')
    expect(guard_run().returncode==0,'clean-project-valid')
    readme=project/'README.md'; original=readme.read_text(encoding='utf-8'); readme.write_text(original+'\nunauthorized edit\n',encoding='utf-8')
    u=guard_run(); expect(u.returncode!=0,'unauthorized-material-blocked',u.stdout); expect('README.md' in u.stdout,'unauthorized-path-reported',u.stdout)
    git('add','README.md'); git('commit','-m','unauthorized commit'); u=guard_run(); expect(u.returncode!=0,'unauthorized-commit-remains-blocked',u.stdout)
    git('reset','--hard',head)
    change=yaml.safe_load(change_path.read_text(encoding='utf-8')); change['status']='in_progress'; change['implementation']['attempts']=['IMP-1010-01']; write_yaml(change_path,change)
    attempt=yaml.safe_load(attempt_path.read_text(encoding='utf-8')); attempt['source_revision']={'system':'git','before':head}; attempt['outcome']='in_progress'; write_yaml(attempt_path,attempt)
    readme.write_text(original+'\nauthorized edit\n',encoding='utf-8'); a=guard_run(); expect(a.returncode==0,'authorized-material-permitted',a.stdout); expect(json.loads(a.stdout).get('authorized') is True,'active-authorization-reported',a.stdout)
    git('add','.'); git('commit','-m','authorized material'); acc=guard_run('accept'); expect(acc.returncode==0,'trusted-baseline-advances-after-clean-commit',acc.stdout)
    expect(guard_run().returncode==0,'accepted-state-valid')
print('Authorization regression tests PASSED')
