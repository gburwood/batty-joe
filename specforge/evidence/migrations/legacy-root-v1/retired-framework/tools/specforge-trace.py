#!/usr/bin/env python3
from pathlib import Path
import argparse, json, sys, datetime
try:
    import yaml
except ImportError:
    print("ERROR: PyYAML is required: pip install pyyaml", file=sys.stderr); sys.exit(2)

def norm(v):
    if isinstance(v, dict): return {k:norm(x) for k,x in v.items()}
    if isinstance(v, list): return [norm(x) for x in v]
    if isinstance(v,(datetime.datetime,datetime.date)): return v.isoformat()
    return v

def load(path):
    with path.open(encoding="utf-8") as f: return norm(yaml.safe_load(f))

def nested(path, root):
    cur=path.parent
    while cur != root and root in cur.parents:
        if (cur/"specforge.yaml").exists(): return True
        cur=cur.parent
    return False

def discover(root):
    rec={}
    for p in root.rglob("*.yaml"):
        if p.name=="specforge.yaml" or nested(p,root): continue
        try: d=load(p)
        except Exception: continue
        if isinstance(d,dict) and d.get("id"):
            rec[str(d["id"])]={"data":d,"path":str(p.relative_to(root)).replace("\\","/")}
    return rec

def ref(records, rid, expected=None):
    if not rid: return {"id":rid,"status":"missing"}
    r=records.get(str(rid))
    if not r: return {"id":rid,"status":"missing"}
    return {"id":rid,"status":"present","path":r["path"],"record":r["data"]}

def build_trace(root, change_id):
    records=discover(root)
    c=records.get(change_id)
    if not c:
        raise KeyError(change_id)
    d=c["data"]
    out={"project_root":str(root),"change":{"id":change_id,"path":c["path"],"status":d.get("status"),
        "title":d.get("title"),"classification":d.get("classification")},
        "sources":d.get("sources") or [],
        "request":d.get("request"),
        "impact_analysis":[],
        "proposals":[],
        "approvals":[],
        "implementation_attempts":[],
        "events":[],
        "release":None,
        "gaps":[]}

    ia=(d.get("impact_analysis") or {}).get("current")
    if ia:
        x=ref(records,ia); out["impact_analysis"].append({k:v for k,v in x.items() if k!="record"})
        if x["status"]=="missing": out["gaps"].append(f"Missing impact analysis {ia}")

    prop=(d.get("proposal") or {}).get("current")
    if prop:
        x=ref(records,prop); out["proposals"].append({k:v for k,v in x.items() if k!="record"})
        if x["status"]=="missing": out["gaps"].append(f"Missing proposal {prop}")

    for aid in d.get("approvals") or []:
        x=ref(records,aid); out["approvals"].append({k:v for k,v in x.items() if k!="record"})
        if x["status"]=="missing": out["gaps"].append(f"Missing approval {aid}")

    for iid in ((d.get("implementation") or {}).get("attempts") or []):
        x=ref(records,iid)
        item={k:v for k,v in x.items() if k!="record"}
        if x["status"]=="present":
            rd=x["record"]; item["outcome"]=rd.get("outcome"); item["source_revision"]=rd.get("source_revision"); item["tests"]=rd.get("tests")
        out["implementation_attempts"].append(item)
        if x["status"]=="missing": out["gaps"].append(f"Missing implementation attempt {iid}")

    # Events are linked explicitly either by primary entity or related change.
    ev=[]
    for rid,r in records.items():
        if not rid.startswith("EVT-"): continue
        ed=r["data"]; entity=ed.get("entity") or {}; related=ed.get("related") or {}
        if entity.get("id")==change_id or related.get("change")==change_id:
            ev.append({"id":rid,"timestamp":ed.get("timestamp"),"event_type":ed.get("event_type"),
                       "entity":entity,"related":related,"path":r["path"]})
    out["events"]=sorted(ev,key=lambda x:(str(x.get("timestamp") or ""),x["id"]))

    rel=(d.get("release") or {}).get("completed_in")
    if rel:
        x=ref(records,rel); out["release"]={k:v for k,v in x.items() if k!="record"}
        if x["status"]=="missing": out["gaps"].append(f"Missing release {rel}")
    return out

def human(t):
    lines=[f"SpecForge forensic trace: {t['change']['id']}",
           f"Title: {t['change'].get('title')}",f"Status: {t['change'].get('status')}","",
           "Evidence chain:"]
    for s in t["sources"]:
        lines.append(f"  SOURCE  {s.get('type','?')}  {s.get('reference','?')}")
    if t.get("request"): lines.append(f"  REQUEST {t['request'].get('summary','')}")
    for x in t["impact_analysis"]: lines.append(f"  IMPACT  {x['id']} [{x['status']}]")
    for x in t["proposals"]: lines.append(f"  PROPOSAL {x['id']} [{x['status']}]")
    for x in t["approvals"]: lines.append(f"  APPROVAL {x['id']} [{x['status']}]")
    for x in t["implementation_attempts"]:
        lines.append(f"  IMPLEMENT {x['id']} [{x['status']}] outcome={x.get('outcome')}")
        sr=x.get("source_revision") or {}
        if sr.get("after"): lines.append(f"    SOURCE REVISION {sr['after']}")
    if t["release"]: lines.append(f"  RELEASE {t['release']['id']} [{t['release']['status']}]")
    else: lines.append("  RELEASE <none recorded>")
    lines.append("")
    lines.append("Forensic events:")
    for e in t["events"]: lines.append(f"  {e.get('timestamp','?')}  {e['id']}  {e.get('event_type','?')}")
    lines.append("")
    if t["gaps"]:
        lines.append("Evidence gaps:")
        lines.extend("  ! "+g for g in t["gaps"])
    else: lines.append("Evidence gaps: none detected in explicit change links")
    return "\n".join(lines)

ap=argparse.ArgumentParser(description="Reconstruct explicit SpecForge forensic evidence for a change.")
ap.add_argument("change_id")
ap.add_argument("--root",default=".")
ap.add_argument("--json",action="store_true",dest="as_json")
args=ap.parse_args()
root=Path(args.root).resolve()
try: trace=build_trace(root,args.change_id)
except KeyError:
    print(f"ERROR: Unknown change {args.change_id}",file=sys.stderr); sys.exit(1)
print(json.dumps(trace,indent=2) if args.as_json else human(trace))
