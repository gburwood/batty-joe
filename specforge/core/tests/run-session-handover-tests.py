#!/usr/bin/env python3
from pathlib import Path
import json, os, shutil, subprocess, sys, tempfile

TEST_ROOT=Path(__file__).resolve().parents[1]
CORE_ROOT=TEST_ROOT if (TEST_ROOT/"tools"/"specforge-lifecycle.py").is_file() else TEST_ROOT/"specforge"/"core"
sys.path.insert(0,str(CORE_ROOT/"tools"))
from specforge_project import project_root
ROOT=project_root(Path(__file__).resolve())
if not (ROOT/"specforge"/"project.yaml").is_file():
    print("Session handover tests SKIPPED (project format 1 required)"); raise SystemExit(0)

with tempfile.TemporaryDirectory() as td:
    fixture=Path(td)/"repo"
    shutil.copytree(ROOT,fixture,ignore=shutil.ignore_patterns(".git","__pycache__","*.pyc","*.pyo",".pytest_cache"))
    tools=fixture/"specforge"/"core"/"tools"
    env=os.environ.copy(); env["PYTHONDONTWRITEBYTECODE"]="1"
    boot=subprocess.run([sys.executable,"-B",str(tools/"specforge-lifecycle.py"),"bootstrap","--root",str(fixture),"--json"],capture_output=True,text=True,env=env)
    assert boot.returncode==0,boot.stdout+boot.stderr
    b=json.loads(boot.stdout); assert b["ready"] is True and b["blockers"]==[]
    assert b["details"]["project_format"]==1 and b["details"]["core_version"]=="0.1.0-alpha.7"
    assert b["details"]["packs"]["permitted"] is True
    status=subprocess.run([sys.executable,"-B",str(tools/"specforge-status.py"),"--root",str(fixture),"--json"],capture_output=True,text=True,env=env)
    assert status.returncode==0,status.stdout+status.stderr
    s=json.loads(status.stdout); assert s["project"]["id"]=="PRJ-0001" and not s["gaps"]
    open_changes={x["id"]:x for x in s["changes"]["open"]}; assert "CHG-1008" in open_changes
    c=open_changes["CHG-1008"]; links=c["current_links"]
    assert c["authority_state"]=="in_progress" and c["effective_approval"]["status"]=="approved"
    assert links["proposal"]["id"]=="PROP-1008-01" and links["proposal"]["effective_approval"]=="approved"
    assert any(x.get("id")=="APR-1009" and x.get("decision")=="approved" for x in links["approvals"])
    assert any(x.get("id")=="IMP-1008-01" for x in links["implementation_attempts"])

print("Session handover tests PASSED")
