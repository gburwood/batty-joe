#!/usr/bin/env python3
from pathlib import Path
import hashlib, json, os, shutil, subprocess, sys, tempfile, yaml

CORE=Path(__file__).resolve().parents[1]
ROOT=CORE.parents[1]


def run(tool,args,cwd=None):
    env=os.environ.copy(); env["PYTHONDONTWRITEBYTECODE"]="1"
    return subprocess.run([sys.executable,"-B",str(tool),*args],cwd=cwd,capture_output=True,text=True,env=env)

def git(root,*args):
    return subprocess.run(["git","-C",str(root),*args],capture_output=True,text=True,check=True)

def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()

def copy_project(dst):
    shutil.copytree(ROOT,dst,ignore=shutil.ignore_patterns(".git","__pycache__","*.pyc","*.pyo",".pytest_cache","specforge-dist"))
    git(dst,"init"); git(dst,"config","user.email","fixture@example.invalid"); git(dst,"config","user.name","Fixture"); git(dst,"add","."); git(dst,"commit","-m","fixture")

def stage_distribution(project,version,formats):
    core=project/"specforge-dist"/version/"core"
    shutil.copytree(CORE,core,ignore=shutil.ignore_patterns("__pycache__","*.pyc","*.pyo"))
    core_meta=yaml.safe_load((core/"core.yaml").read_text(encoding="utf-8")); core_meta["core_version"]=version; core_meta.setdefault("compatibility",{})["project_formats"]=formats
    (core/"core.yaml").write_text(yaml.safe_dump(core_meta,sort_keys=False),encoding="utf-8",newline="\n")
    pkg=yaml.safe_load((core/"package.yaml").read_text(encoding="utf-8")); pkg["package"]["version"]=version; pkg["compatibility"]["project_formats"]=formats
    (core/"package.yaml").write_text(yaml.safe_dump(pkg,sort_keys=False),encoding="utf-8",newline="\n")
    return core

if not (ROOT/"specforge"/"project.yaml").is_file():
    print("Upgrade tests SKIPPED (project format 1 required)"); raise SystemExit(0)

with tempfile.TemporaryDirectory() as td:
    fixture=Path(td)/"repo"; copy_project(fixture); candidate=stage_distribution(fixture,"0.1.0-alpha.6-test",[1]); tool=candidate/"tools"/"specforge-upgrade.py"
    manifest=fixture/"specforge"/"project.yaml"; change=fixture/"specforge"/"changes"/"CHG-1007.yaml"
    change_before=digest(change); before=yaml.safe_load(manifest.read_text(encoding="utf-8")); fmt_before=before["specforge"]["project_format"]
    r=run(tool,["plan","--root",str(fixture),"--json"]); assert r.returncode==0,r.stdout+r.stderr
    p=json.loads(r.stdout); assert p["permitted"] and not p["already_current"]; assert p["target_core_version"]=="0.1.0-alpha.6-test"
    assert "specforge-dist" in p["candidate_distribution"]["core"]
    r=run(tool,["upgrade","--root",str(fixture),"--apply","--json"]); assert r.returncode==0,r.stdout+r.stderr
    p=json.loads(r.stdout); assert p["applied"] and p["evidence"]
    after=yaml.safe_load(manifest.read_text(encoding="utf-8")); assert after["specforge"]["core_version"]=="0.1.0-alpha.6-test"; assert after["specforge"]["project_format"]==fmt_before
    assert digest(change)==change_before,"project-owned change mutated during Core upgrade"
    shutil.rmtree(fixture/"specforge-dist")
    assert (fixture/p["evidence"]).is_file(),"upgrade evidence depended on staging directory"

with tempfile.TemporaryDirectory() as td:
    fixture=Path(td)/"repo"; copy_project(fixture); candidate=stage_distribution(fixture,"0.1.0-incompatible",[99]); tool=candidate/"tools"/"specforge-upgrade.py"; before=digest(fixture/"specforge"/"project.yaml")
    r=run(tool,["upgrade","--root",str(fixture),"--apply","--json"]); assert r.returncode!=0
    data=json.loads(r.stdout); assert "target_core_incompatible_with_project_format" in data["blockers"]
    assert digest(fixture/"specforge"/"project.yaml")==before

with tempfile.TemporaryDirectory() as td:
    fixture=Path(td)/"repo"; copy_project(fixture); candidate=stage_distribution(fixture,"0.1.0-mismatch",[1]); tool=candidate/"tools"/"specforge-upgrade.py"
    pkg=yaml.safe_load((candidate/"package.yaml").read_text(encoding="utf-8")); pkg["package"]["version"]="different"; (candidate/"package.yaml").write_text(yaml.safe_dump(pkg,sort_keys=False),encoding="utf-8")
    r=run(tool,["plan","--root",str(fixture),"--json"]); assert r.returncode!=0
    assert "distribution_core_version_mismatch" in " ".join(json.loads(r.stdout)["blockers"])

print("Upgrade tests PASSED")
