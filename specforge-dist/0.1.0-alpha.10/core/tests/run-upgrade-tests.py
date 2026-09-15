#!/usr/bin/env python3
from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,tempfile,yaml
CORE=Path(__file__).resolve().parents[1]; ROOT=CORE.parents[1]
def run(tool,args,cwd=None):
    env=os.environ.copy(); env['PYTHONDONTWRITEBYTECODE']='1'; return subprocess.run([sys.executable,'-B',str(tool),*args],cwd=cwd,capture_output=True,text=True,env=env)
def git(root,*args): return subprocess.run(['git','-C',str(root),*args],capture_output=True,text=True,check=True)
def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def copy_project(dst):
    shutil.copytree(ROOT,dst,ignore=shutil.ignore_patterns('.git','__pycache__','*.pyc','*.pyo','.pytest_cache','specforge-dist'))
    git(dst,'init'); git(dst,'config','user.email','fixture@example.invalid'); git(dst,'config','user.name','Fixture'); git(dst,'add','.'); git(dst,'commit','-m','fixture')
    head=git(dst,'rev-parse','HEAD').stdout.strip()
    p=dst/'specforge/evidence/material-authority.yaml'; p.parent.mkdir(parents=True,exist_ok=True); p.write_text(yaml.safe_dump({'version':1,'trusted':{'provider':'git','revision':head}},sort_keys=False),encoding='utf-8')
    git(dst,'add','specforge/evidence/material-authority.yaml'); git(dst,'commit','-m','record authority baseline')
def stage_distribution(project,version,formats):
    core=project/'specforge-dist'/version/'core'; shutil.copytree(CORE,core,ignore=shutil.ignore_patterns('__pycache__','*.pyc','*.pyo')); meta=yaml.safe_load((core/'core.yaml').read_text()); meta['core_version']=version; meta.setdefault('compatibility',{})['project_formats']=formats; (core/'core.yaml').write_text(yaml.safe_dump(meta,sort_keys=False)); pkg=yaml.safe_load((core/'package.yaml').read_text()); pkg['package']['version']=version; pkg['compatibility']['project_formats']=formats; (core/'package.yaml').write_text(yaml.safe_dump(pkg,sort_keys=False)); return core
if not (ROOT/'specforge/project.yaml').is_file(): print('Upgrade tests SKIPPED'); raise SystemExit(0)
with tempfile.TemporaryDirectory() as td:
    fixture=Path(td)/'repo'; copy_project(fixture); candidate=stage_distribution(fixture,'0.1.0-alpha.10-test',[1]); tool=candidate/'tools/specforge-upgrade.py'; manifest=fixture/'specforge/project.yaml'; change=fixture/'specforge/changes/CHG-1007.yaml'; before=digest(change)
    r=run(tool,['upgrade','--root',str(fixture),'--apply','--json']); assert r.returncode==0,r.stdout+r.stderr; data=json.loads(r.stdout); assert data['applied'] and data['authority']['type']=='core_upgrade'; assert digest(change)==before
    guard=fixture/'specforge/core/tools/specforge-authorization.py'; r=run(guard,['--root',str(fixture),'--json']); assert r.returncode==0,r.stdout+r.stderr
    (fixture/'README.md').write_text((fixture/'README.md').read_text()+"\nout-of-scope\n"); r=run(guard,['--root',str(fixture),'--json']); assert r.returncode!=0 and 'managed_upgrade_scope_violation' in r.stdout
print('Upgrade tests PASSED')
