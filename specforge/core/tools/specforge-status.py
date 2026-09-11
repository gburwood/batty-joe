#!/usr/bin/env python3
"""Render current SpecForge project/bootstrap status from canonical repository evidence."""
from pathlib import Path
import argparse, json, sys
from specforge_project import canonical_artifact_digest, discover_layout, iter_record_files, load_yaml, relative

TERMINAL_CHANGE_STATUSES = {"completed", "rejected", "cancelled"}


def discover_records(layout):
    records={}
    for path in iter_record_files(layout):
        try: data=load_yaml(path)
        except Exception: continue
        if isinstance(data,dict) and data.get("id"):
            records[str(data["id"])]= {"data":data,"path":relative(layout,path),"file":path}
    return records


def record_ref(records,record_id):
    if not record_id: return None
    record=records.get(str(record_id))
    if not record: return {"id":record_id,"status":"missing"}
    return {"id":record_id,"status":"present","path":record["path"],"record":record["data"]}


def public_ref(item,extra_fields=()):
    if item is None: return None
    result={key:value for key,value in item.items() if key!="record"}
    if item.get("status")=="present":
        for field in extra_fields: result[field]=item["record"].get(field)
    return result


def manifest_artifact(layout,declared_path,label,gaps):
    if not declared_path:
        gaps.append(f"Manifest does not declare {label}"); return {"declared_path":declared_path,"status":"missing"}
    path=(layout.root/str(declared_path)).resolve()
    try: display_path=relative(layout,path)
    except Exception: display_path=str(path)
    status="present" if path.is_file() else "missing"
    if status=="missing": gaps.append(f"Missing {label} {declared_path}")
    return {"declared_path":declared_path,"path":display_path,"status":status}


def effective_approval(records,change_id,proposal_id,approval_ids,controlled):
    proposal=records.get(str(proposal_id))
    if not proposal: return {"status":"invalid" if controlled else "historical_unverified","reason":"current_proposal_missing"}
    actual=canonical_artifact_digest(proposal["file"]) if controlled else None
    saw_approval=False
    for approval_id in approval_ids or []:
        rec=records.get(str(approval_id))
        if not rec: continue
        a=rec["data"]
        if a.get("proposal")!=proposal_id or a.get("change")!=change_id: continue
        if a.get("decision")!="approved" or (a.get("actor") or {}).get("type")!="human": continue
        saw_approval=True
        if not controlled:
            return {"status":"historical_approved","approval":approval_id,"verification":"pre_controlled_v1"}
        expected=(a.get("evidence") or {}).get("proposal_digest") or (a.get("scope") or {}).get("proposal_sha256")
        if expected and expected==actual:
            return {"status":"approved","approval":approval_id,"proposal_digest":actual}
    if not controlled:
        return {"status":"historical_unverified","reason":"historical_human_approval_missing" if not saw_approval else "historical_approval_not_verifiable_under_current_contract"}
    return {"status":"invalid" if saw_approval else "unapproved","reason":"valid_exact_human_approval_missing" if saw_approval else "approval_missing"}


def authority_state(change_status,approval,controlled):
    if change_status in TERMINAL_CHANGE_STATUSES: return "completed" if change_status=="completed" else change_status
    if not controlled:
        return change_status or "historical"
    approved=approval.get("status")=="approved"
    if change_status in {"approved","in_progress","implemented","validated"}: return change_status if approved else "invalid"
    if approved: return "authorised"
    if approval.get("status")=="invalid": return "invalid"
    return "proposed"


def build_change_summary(records,change_id,change_record,gaps):
    data=change_record["data"]
    controlled=(data.get("governance") or {}).get("lifecycle_enforcement")=="controlled_v1"
    item={"id":change_id,"path":change_record["path"],"title":data.get("title"),"classification":data.get("classification"),"status":data.get("status"),"lifecycle_category":"terminal" if data.get("status") in TERMINAL_CHANGE_STATUSES else "open","governance_mode":"controlled_v1" if controlled else "historical","authority_state":None,"effective_approval":None,"current_links":{"impact_analysis":None,"proposal":None,"approvals":[],"implementation_attempts":[],"release":None}}
    impact_id=(data.get("impact_analysis") or {}).get("current")
    if impact_id:
        ref=record_ref(records,impact_id); item["current_links"]["impact_analysis"]=public_ref(ref,("change","revision"))
        if ref["status"]=="missing": gaps.append(f"{change_id}: Missing impact analysis {impact_id}")
        elif ref["record"].get("change")!=change_id: gaps.append(f"{change_id}: Impact analysis {impact_id} links to change {ref['record'].get('change')}")
    proposal_id=(data.get("proposal") or {}).get("current")
    if proposal_id:
        ref=record_ref(records,proposal_id); item["current_links"]["proposal"]=public_ref(ref,("change","revision","status"))
        if item["current_links"]["proposal"] and item["current_links"]["proposal"].get("status")!="missing": item["current_links"]["proposal"]["document_status"]=ref["record"].get("status")
        if ref["status"]=="missing": gaps.append(f"{change_id}: Missing proposal {proposal_id}")
        elif ref["record"].get("change")!=change_id: gaps.append(f"{change_id}: Proposal {proposal_id} links to change {ref['record'].get('change')}")
    for approval_id in data.get("approvals") or []:
        ref=record_ref(records,approval_id); item["current_links"]["approvals"].append(public_ref(ref,("change","proposal","decision","timestamp")))
        if ref["status"]=="missing": gaps.append(f"{change_id}: Missing approval {approval_id}")
        elif ref["record"].get("change")!=change_id: gaps.append(f"{change_id}: Approval {approval_id} links to change {ref['record'].get('change')}")
    approval=effective_approval(records,change_id,proposal_id,data.get("approvals") or [],controlled) if proposal_id else {"status":"unapproved" if controlled else "historical_unverified","reason":"current_proposal_missing"}
    item["effective_approval"]=approval; item["authority_state"]=authority_state(data.get("status"),approval,controlled)
    if item["current_links"]["proposal"]: item["current_links"]["proposal"]["effective_approval"]=approval.get("status")
    for attempt_id in ((data.get("implementation") or {}).get("attempts") or []):
        ref=record_ref(records,attempt_id); item["current_links"]["implementation_attempts"].append(public_ref(ref,("change","proposal","attempt","outcome","source_revision","tests")))
        if ref["status"]=="missing": gaps.append(f"{change_id}: Missing implementation attempt {attempt_id}")
        elif ref["record"].get("change")!=change_id: gaps.append(f"{change_id}: Implementation attempt {attempt_id} links to change {ref['record'].get('change')}")
    release_id=(data.get("release") or {}).get("completed_in")
    if release_id:
        ref=record_ref(records,release_id); item["current_links"]["release"]=public_ref(ref,("version","status"))
        if ref["status"]=="missing": gaps.append(f"{change_id}: Missing release {release_id}")
    return item


def build_status(root,event_limit=10):
    layout=discover_layout(root); manifest=layout.manifest; gaps=[]; records=discover_records(layout)
    sf=manifest.get("specforge") or {}; project=manifest.get("project") or {}; specification=manifest.get("specification") or {}; policy=manifest.get("policy") or {}
    changes=[build_change_summary(records,rid,rec,gaps) for rid,rec in records.items() if rid.startswith("CHG-")]; changes.sort(key=lambda x:x["id"])
    events=[]
    for rid,rec in records.items():
        if not rid.startswith("EVT-"): continue
        e=rec["data"]; events.append({"id":rid,"timestamp":e.get("timestamp"),"event_type":e.get("event_type"),"actor":e.get("actor"),"entity":e.get("entity"),"related":e.get("related"),"path":rec["path"]})
    events.sort(key=lambda x:(str(x.get("timestamp") or ""),x["id"]),reverse=True)
    if event_limit>=0: events=events[:event_limit]
    return {"project_root":str(layout.root),"project_format_mode":layout.mode,"manifest":relative(layout,layout.manifest_path),"project":{"id":project.get("id"),"name":project.get("name")},"specforge":{"project_format":sf.get("project_format"),"core_version":sf.get("core_version"),"data_model_version":sf.get("data_model_version"),"approval_mode":policy.get("approval_mode"),"forensic_traceability":policy.get("forensic_traceability"),"repository_completeness":policy.get("repository_completeness")},"specification":{"authoritative_version":specification.get("current_version"),"product_specification":manifest_artifact(layout,specification.get("product_specification"),"product specification",gaps),"canonical_data_model":manifest_artifact(layout,specification.get("canonical_data_model"),"canonical data model",gaps)},"packs":manifest.get("packs") or [],"changes":{"open":[x for x in changes if x["lifecycle_category"]=="open"],"terminal":[x for x in changes if x["lifecycle_category"]=="terminal"]},"recent_events":events,"gaps":gaps}


def link_label(link):
    if not link: return "<none>"
    suffix=""
    if link.get("status")=="missing": suffix=" [missing]"
    elif link.get("decision"): suffix=f" [{link['decision']}]"
    elif link.get("outcome"): suffix=f" [{link['outcome']}]"
    elif link.get("effective_approval"): suffix=f" [{link['effective_approval']}; document={link.get('document_status',link.get('status'))}]"
    return f"{link.get('id')}{suffix}"


def human(status):
    project=status["project"]; sf=status["specforge"]; specification=status["specification"]
    lines=["SpecForge project status",f"Project: {project.get('id')}  {project.get('name')}",f"Layout: {status.get('project_format_mode')}  Project format: {sf.get('project_format')}",f"Core: {sf.get('core_version')}  Data model: {sf.get('data_model_version')}",f"Approval mode: {sf.get('approval_mode')}",f"Authoritative specification: {specification.get('authoritative_version')}","","Open changes:"]
    if not status["changes"]["open"]: lines.append("  <none>")
    for change in status["changes"]["open"]:
        links=change["current_links"]; lines.append(f"  {change['id']} [{change.get('status')}; authority={change.get('authority_state')}] {change.get('title')}")
        lines.append(f"    impact: {link_label(links['impact_analysis'])}"); lines.append(f"    proposal: {link_label(links['proposal'])}"); lines.append(f"    approvals: {', '.join(link_label(x) for x in links['approvals']) or '<none>'}"); lines.append(f"    implementation: {', '.join(link_label(x) for x in links['implementation_attempts']) or '<none>'}"); lines.append(f"    release: {link_label(links['release'])}")
    lines.extend(["","Terminal changes:"])
    if not status["changes"]["terminal"]: lines.append("  <none>")
    for change in status["changes"]["terminal"]: lines.append(f"  {change['id']} [{change.get('status')}; authority={change.get('authority_state')}] {change.get('title')}")
    lines.extend(["","Recent forensic events:"])
    if not status["recent_events"]: lines.append("  <none>")
    for event in status["recent_events"]:
        entity=event.get("entity") or {}; lines.append(f"  {event.get('timestamp','?')}  {event['id']}  {event.get('event_type','?')}  {entity.get('id','?')}")
    lines.append("")
    if status["gaps"]: lines.append("Evidence gaps:"); lines.extend(f"  ! {gap}" for gap in status["gaps"])
    else: lines.append("Evidence gaps: none detected in explicit project/current links")
    return "\n".join(lines)


def main():
    parser=argparse.ArgumentParser(description="Render current SpecForge project/bootstrap status from canonical evidence."); parser.add_argument("--root",default="."); parser.add_argument("--json",action="store_true",dest="as_json"); parser.add_argument("--events",type=int,default=10); args=parser.parse_args()
    try: status=build_status(Path(args.root).resolve(),args.events)
    except Exception as exc: print(f"ERROR: Unable to read SpecForge project: {exc}",file=sys.stderr); return 1
    print(json.dumps(status,indent=2) if args.as_json else human(status)); return 0

if __name__=="__main__": sys.exit(main())
