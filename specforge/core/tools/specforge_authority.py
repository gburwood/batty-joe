from pathlib import Path
import subprocess, yaml
from specforge_project import canonical_artifact_digest, git_worktree_root, is_governance_bookkeeping_path, iter_record_files, load_yaml, material_snapshot

def run_git(layout,*args):
    return subprocess.run(['git','-C',str(layout.root),*args],capture_output=True,text=True)

def authority_path(layout):
    evidence=(layout.manifest.get('paths') or {}).get('evidence','./specforge/evidence')
    return (layout.root/evidence/'material-authority.yaml').resolve()

def load_authority(layout):
    p=authority_path(layout)
    if not p.is_file(): return None
    d=load_yaml(p); return d if isinstance(d,dict) else None

def save_authority(layout,data):
    p=authority_path(layout); p.parent.mkdir(parents=True,exist_ok=True)
    p.write_text(yaml.safe_dump(data,sort_keys=False,allow_unicode=True),encoding='utf-8',newline='\n'); return p

def current_identity(layout):
    if git_worktree_root(layout) is not None:
        r=run_git(layout,'rev-parse','HEAD')
        if r.returncode==0: return {'provider':'git','revision':r.stdout.strip()}
    s=material_snapshot(layout); return {'provider':'specforge_snapshot','revision':s['revision']}

def material_differences(layout,provider,reference):
    if provider=='specforge_snapshot':
        return [] if material_snapshot(layout)['revision']==reference else ['<snapshot-material-drift>']
    differences=set()
    r=run_git(layout,'diff','--name-only',reference,'--')
    if r.returncode==0: differences.update(x.strip() for x in r.stdout.splitlines() if x.strip())
    r=run_git(layout,'ls-files','--others','--exclude-standard')
    if r.returncode==0: differences.update(x.strip() for x in r.stdout.splitlines() if x.strip())
    out=[]
    for rel in sorted(differences):
        if is_governance_bookkeeping_path(layout.root/rel,layout): continue
        rel=rel.replace('\\','/')
        if rel.startswith('specforge-dist/') or '__pycache__' in Path(rel).parts or rel.endswith('.pyc'): continue
        out.append(rel)
    return out

def records(layout):
    out={}
    for p in iter_record_files(layout):
        try: d=load_yaml(p)
        except Exception: continue
        if isinstance(d,dict) and d.get('id'): out[str(d['id'])]=(d,p)
    return out

def exact_approval(layout,recs,change):
    pid=(change.get('proposal') or {}).get('current'); pr=recs.get(str(pid))
    if not pr: return None
    digest=canonical_artifact_digest(pr[1])
    for aid in change.get('approvals') or []:
        item=recs.get(str(aid))
        if not item: continue
        a=item[0]
        if a.get('change')!=change.get('id') or a.get('proposal')!=pid or a.get('decision')!='approved': continue
        if (a.get('actor') or {}).get('type')!='human': continue
        expected=(a.get('evidence') or {}).get('proposal_digest') or (a.get('scope') or {}).get('proposal_sha256')
        if expected==digest: return {'approval':aid,'proposal':pid}
    return None

def active_implementations(layout,recs):
    items=[]
    for rid,(chg,_) in recs.items():
        if not rid.startswith('CHG-') or (chg.get('governance') or {}).get('lifecycle_enforcement')!='controlled_v1': continue
        if chg.get('status') not in {'in_progress','implemented','validated'}: continue
        ap=exact_approval(layout,recs,chg)
        if not ap: continue
        for iid in ((chg.get('implementation') or {}).get('attempts') or []):
            rec=recs.get(str(iid))
            if not rec: continue
            imp=rec[0]
            if imp.get('change')!=rid or imp.get('proposal')!=ap['proposal'] or imp.get('outcome') not in {'in_progress','passed'}: continue
            src=imp.get('source_revision') or {}; before=src.get('before'); provider=str(src.get('system') or src.get('provider') or '').lower().replace('-','_')
            if before: items.append({'type':'implementation','change':rid,'attempt':iid,'before':before,'provider':provider or None,'approval':ap['approval']})
    return items

def upgrade_scope_ok(layout,diffs):
    core=str(layout.core_root.relative_to(layout.root)).replace('\\','/').rstrip('/')+'/'; manifest=str(layout.manifest_path.relative_to(layout.root)).replace('\\','/')
    return all(p.startswith(core) or p==manifest for p in diffs)

def evaluate(layout):
    authority=load_authority(layout); details={'project_format_mode':layout.mode}; blockers=[]
    if not authority: return {'valid':False,'authorized':False,'blockers':['trusted_material_baseline_missing'],'details':details}
    trusted=authority.get('trusted') or {}; provider=str(trusted.get('provider') or '').lower().replace('-','_'); revision=trusted.get('revision')
    if provider not in {'git','specforge_snapshot'} or not revision: return {'valid':False,'authorized':False,'blockers':['trusted_material_baseline_invalid'],'details':details}
    if provider=='git' and git_worktree_root(layout) is None: return {'valid':False,'authorized':False,'blockers':['trusted_material_provider_unavailable:git'],'details':details}
    diffs=material_differences(layout,provider,revision); impls=active_implementations(layout,records(layout)); valid_impl=[x for x in impls if x.get('before')==revision and x.get('provider') in {None,provider}]
    op=authority.get('active_operation') or {}; upgrade=op.get('type')=='core_upgrade' and op.get('before')==revision
    details.update({'provider':provider,'trusted_revision':revision,'current_identity':current_identity(layout)['revision'],'material_differences':diffs,'active_implementations':impls,'active_operation':op or None})
    if not diffs: return {'valid':True,'authorized':bool(valid_impl or upgrade),'blockers':[],'details':details}
    if len(valid_impl)>1: blockers.append('multiple_active_material_authorizations')
    elif len(valid_impl)==1: details['authorized_by']=valid_impl[0]
    elif upgrade:
        if provider=='git' and not upgrade_scope_ok(layout,diffs): blockers.append('managed_upgrade_scope_violation')
        else: details['authorized_by']=op
    else: blockers.append('unauthorized_material_changes')
    if blockers:
        for p in diffs: blockers.append('unauthorized_material_path:'+p)
    return {'valid':not blockers,'authorized':not blockers and bool(diffs),'blockers':sorted(set(blockers)),'details':details}

def establish_upgrade_authority(layout,current,target):
    identity=current_identity(layout); authority=load_authority(layout) or {'version':1,'trusted':identity}; trusted=authority.get('trusted') or {}
    if trusted.get('provider')!=identity['provider'] or trusted.get('revision')!=identity['revision']: raise RuntimeError('trusted_material_baseline_does_not_match_current_clean_state')
    authority['active_operation']={'type':'core_upgrade','id':f'core-{current}-to-{target}','provider':identity['provider'],'before':identity['revision'],'from_core_version':current,'to_core_version':target,'scope':'framework_core_and_manifest'}
    save_authority(layout,authority); return authority['active_operation']

def accept(layout):
    check=evaluate(layout)
    if not check.get('valid'): return {'accepted':False,'blockers':check.get('blockers') or []}
    authority=load_authority(layout); identity=current_identity(layout)
    if identity['provider']=='git':
        dirty=material_differences(layout,'git','HEAD')
        if dirty: return {'accepted':False,'blockers':['material_worktree_not_clean']+['material_path:'+p for p in dirty]}
    authority['trusted']=identity; authority.pop('active_operation',None); save_authority(layout,authority)
    return {'accepted':True,'provider':identity['provider'],'trusted_revision':identity['revision'],'blockers':[]}
