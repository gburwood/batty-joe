#!/usr/bin/env python3
"""Plan or apply ownership-aware Core upgrades from a candidate SpecForge distribution."""
from pathlib import Path
import argparse, json, shutil, subprocess, tempfile
import yaml

from specforge_project import discover_layout
from specforge_distribution import discover_distribution

STAGING_ROOTS=("specforge-dist/",)


def clean(root):
    r=subprocess.run(["git","-C",str(root),"status","--porcelain","--untracked-files=all"],capture_output=True,text=True)
    if r.returncode!=0: return False
    for line in r.stdout.splitlines():
        path=line[3:].strip().replace("\\","/") if len(line)>3 else ""
        if " -> " in path: path=path.split(" -> ",1)[1]
        if any(path.startswith(prefix) for prefix in STAGING_ROOTS): continue
        return False
    return True


def plan(root, distribution_path=None):
    try: layout=discover_layout(root)
    except Exception as e: return {"permitted":False,"blockers":[f"project_discovery_failed:{e}"]}
    if layout.mode!="project_format_1": return {"permitted":False,"blockers":["project_format_upgrade_required"]}
    try: distribution=discover_distribution(Path(distribution_path) if distribution_path else None,tool_file=Path(__file__))
    except Exception as e: return {"permitted":False,"blockers":[str(e)]}
    sf=layout.manifest.get("specforge") or {}; fmt=sf.get("project_format")
    blockers=[]
    if fmt not in distribution.project_formats: blockers.append("target_core_incompatible_with_project_format")
    current=sf.get("core_version"); target=distribution.version
    already_current=current==target
    return {
        "permitted":not blockers,
        "already_current":already_current,
        "current_core_version":current,
        "target_core_version":target,
        "project_format":fmt,
        "candidate_distribution":{"version":target,"package":str(distribution.package_path),"core":str(distribution.core_root)},
        "replace":[str(layout.core_root.relative_to(layout.root)).replace('\\','/')],
        "preserve":["specforge/project.yaml","specforge/changes","specforge/decisions","specforge/history","specforge/evidence"],
        "blockers":blockers,
    }


def evidence_path(layout,current,target):
    safe=lambda v:str(v).replace("/","_").replace("\\","_")
    return layout.root/"specforge"/"evidence"/"upgrades"/f"core-{safe(current)}-to-{safe(target)}.yaml"


def write_evidence(layout,p):
    path=evidence_path(layout,p["current_core_version"],p["target_core_version"])
    path.parent.mkdir(parents=True,exist_ok=True)
    payload={
        "operation":"core_upgrade",
        "from_core_version":p["current_core_version"],
        "to_core_version":p["target_core_version"],
        "project_format":p["project_format"],
        "candidate_distribution":p["candidate_distribution"],
        "replaced":p["replace"],
        "preserved":p["preserve"],
        "result":"upgraded",
    }
    path.write_text(yaml.safe_dump(payload,sort_keys=False,allow_unicode=True),encoding="utf-8",newline="\n")
    return str(path.relative_to(layout.root)).replace("\\","/")


def apply(root,distribution_path=None):
    p=plan(root,distribution_path)
    if not p.get("permitted") or p.get("already_current"): return p
    if not clean(root): p["permitted"]=False; p["blockers"]=["working_tree_not_clean"]; return p
    layout=discover_layout(root)
    distribution=discover_distribution(Path(distribution_path) if distribution_path else None,tool_file=Path(__file__))
    target=layout.core_root
    try:
        if target.resolve()==distribution.core_root.resolve():
            p["permitted"]=False; p["blockers"]=["candidate_distribution_is_installed_core"]
            return p
    except Exception: pass
    with tempfile.TemporaryDirectory(dir=str(layout.root)) as tmp:
        backup=Path(tmp)/"core-backup"; shutil.copytree(target,backup)
        manifest_before=layout.manifest_path.read_bytes()
        try:
            shutil.rmtree(target)
            shutil.copytree(distribution.core_root,target,ignore=shutil.ignore_patterns("__pycache__","*.pyc","*.pyo"))
            manifest=layout.manifest
            manifest.setdefault("specforge",{})["core_version"]=p["target_core_version"]
            layout.manifest_path.write_text(yaml.safe_dump(manifest,sort_keys=False,allow_unicode=True),encoding="utf-8",newline="\n")
            p["evidence"]=write_evidence(layout,p)
        except Exception:
            if target.exists(): shutil.rmtree(target)
            shutil.copytree(backup,target)
            layout.manifest_path.write_bytes(manifest_before)
            raise
    p["applied"]=True
    return p


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("command",choices=("plan","upgrade")); ap.add_argument("--root",default=".")
    ap.add_argument("--distribution"); ap.add_argument("--package",dest="legacy_package")
    ap.add_argument("--apply",action="store_true"); ap.add_argument("--json",action="store_true")
    a=ap.parse_args(); root=Path(a.root).resolve(); distribution=a.distribution or a.legacy_package
    out=plan(root,distribution) if a.command=="plan" or not a.apply else apply(root,distribution)
    print(json.dumps(out,indent=2) if a.json else out); return 0 if out.get("permitted") else 1
if __name__=="__main__": raise SystemExit(main())
