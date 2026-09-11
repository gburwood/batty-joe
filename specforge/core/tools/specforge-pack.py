#!/usr/bin/env python3
"""Resolve installed SpecForge packs deterministically and enforce Core invariants."""
from pathlib import Path
import argparse, json, sys
from specforge_project import discover_layout, load_yaml

ALLOWED_EXTENSIONS={"schemas","rules","workflows","vocabulary","templates"}
FORBIDDEN_OVERRIDE_KEYS={"approval","approval_mode","canonical_integrity","forensic_traceability","lifecycle","repository_completeness","source_of_truth"}


def resolve(root):
    layout=discover_layout(root)
    packs=layout.manifest.get("packs") or []
    blockers=[]; resolved=[]; seen_ids=set(); seen_precedence=set()
    if layout.mode!="project_format_1" and packs:
        blockers.append("packs_require_project_format_1")
    packs_root=(layout.root/((layout.manifest.get("paths") or {}).get("packs") or "specforge/packs")).resolve()
    fmt=(layout.manifest.get("specforge") or {}).get("project_format")
    core=(layout.manifest.get("specforge") or {}).get("core_version")
    for item in packs:
        if not isinstance(item,dict):
            blockers.append("pack_entry_invalid"); continue
        pid=item.get("id"); version=item.get("version"); path_value=item.get("path"); precedence=item.get("precedence"); extensions=item.get("extensions") or []
        if not pid or not version or not path_value or not isinstance(precedence,int):
            blockers.append(f"pack_metadata_incomplete:{pid or '<unknown>'}"); continue
        if pid in seen_ids: blockers.append(f"pack_id_duplicate:{pid}")
        seen_ids.add(pid)
        if precedence in seen_precedence: blockers.append(f"pack_precedence_duplicate:{precedence}")
        seen_precedence.add(precedence)
        unknown=sorted(set(extensions)-ALLOWED_EXTENSIONS)
        if unknown: blockers.append(f"pack_extension_not_allowed:{pid}:{','.join(unknown)}")
        pack_path=(layout.root/path_value).resolve()
        try: pack_path.relative_to(packs_root)
        except ValueError: blockers.append(f"pack_outside_packs_root:{pid}")
        meta_path=pack_path/"pack.yaml"
        if not meta_path.is_file():
            blockers.append(f"pack_metadata_missing:{pid}"); continue
        try: meta=load_yaml(meta_path)
        except Exception as exc:
            blockers.append(f"pack_metadata_invalid:{pid}:{exc}"); continue
        if meta.get("id")!=pid: blockers.append(f"pack_identity_mismatch:{pid}")
        if str(meta.get("version"))!=str(version): blockers.append(f"pack_version_mismatch:{pid}")
        compat=meta.get("compatibility") or {}
        formats=compat.get("project_formats") or []
        if formats and fmt not in formats: blockers.append(f"pack_project_format_incompatible:{pid}")
        cores=compat.get("core_versions") or []
        if cores and core not in cores: blockers.append(f"pack_core_incompatible:{pid}")
        overrides=meta.get("overrides") or {}
        forbidden=sorted(set(overrides).intersection(FORBIDDEN_OVERRIDE_KEYS))
        if forbidden: blockers.append(f"pack_core_invariant_override_forbidden:{pid}:{','.join(forbidden)}")
        resolved.append({"id":pid,"version":version,"path":path_value,"precedence":precedence,"extensions":extensions})
    resolved.sort(key=lambda x:(x["precedence"],x["id"]))
    return {"permitted":not blockers,"packs":resolved,"blockers":sorted(set(blockers))}


def main():
    ap=argparse.ArgumentParser(); ap.add_argument("--root",default="."); ap.add_argument("--json",action="store_true")
    a=ap.parse_args(); out=resolve(Path(a.root).resolve())
    print(json.dumps(out,indent=2) if a.json else out)
    return 0 if out["permitted"] else 1
if __name__=="__main__": raise SystemExit(main())
