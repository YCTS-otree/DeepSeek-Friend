"""Repair lost conversational continuity under the existing offline DSF gate."""
from pathlib import Path
import sys,json,re,subprocess
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from scripts import dsf

def apply(session):
    if not re.fullmatch('[a-f0-9-]{36}',session):raise ValueError('mnn-session-required')
    data,port=dsf.settings(ROOT)
    with dsf.offline(ROOT,data,port):
        backup=dsf.snapshot(ROOT,data,reason='before-conversation-continuity-repair');dsf.inspect(backup)
        marker=data/'cognitive/mnn/activation.json';value=json.loads(marker.read_text(encoding='utf-8'));value['privateRepairPending']=True
        def save():
            temp=marker.with_suffix('.partial');temp.write_text(json.dumps(value,indent=2),encoding='utf-8');temp.replace(marker)
        save()
        result=subprocess.run(['node','scripts/mnn-continuity-repair.mjs',session,str(data),backup.name,'--authorized-offline'],cwd=ROOT,timeout=240)
        if result.returncode:raise ValueError('mnn-continuity-repair-failed')
        value['privateRepairPending']=False;value['integrationVersion']='1.2.2';save();print(json.dumps({'backup':backup.name,'success':True}))

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('--session',required=True);p.add_argument('--apply',action='store_true');a=p.parse_args()
    if not a.apply:raise SystemExit('mnn-explicit-apply-required')
    apply(a.session)
