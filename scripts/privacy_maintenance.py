"""Explicit operator repair. Does not delete or rewrite native raw Session events."""
from pathlib import Path
import sys,json,sqlite3,shutil,uuid,subprocess
from contextlib import closing
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT));sys.path.insert(0,str(ROOT/'vendor/dsf-mnn/src'))
from scripts import dsf
from dsf_mnn.production import ProductionMemory
from dsf_mnn.visibility import purge_diagnostics,internal_diagnostic

def apply(session):
    import re
    if not re.fullmatch('[a-f0-9-]{36}',session):raise ValueError('privacy-session-invalid')
    data,port=dsf.settings(ROOT)
    with dsf.offline(ROOT,data,port):
        backup=dsf.snapshot(ROOT,data,reason='before-private-memory-and-context-repair');dsf.inspect(backup)
        directory=data/'cognitive/mnn';marker=directory/'activation.json'
        if marker.exists():
            value=json.loads(marker.read_text(encoding='utf-8'));value['privateRepairPending']=True
            partial=marker.with_suffix('.partial');partial.write_text(json.dumps(value,indent=2),encoding='utf-8');partial.replace(marker)
        memory=ProductionMemory(directory)
        try:result=purge_diagnostics(memory)
        finally:memory.close()
        runs=(directory/'runs').resolve();audit=(ROOT/'Archive'/'operator-audit'/uuid.uuid4().hex).resolve()
        if runs.exists():
            if not runs.is_relative_to(data.resolve()) or not audit.is_relative_to((ROOT/'Archive').resolve()):raise ValueError('privacy-path-invalid')
            ledger=directory/'usage-ledger.json';entries=json.loads(ledger.read_text(encoding='utf-8')) if ledger.exists() else []
            for file in runs.glob('*/provider/*.json'):
                if not file.resolve().is_relative_to(runs) or file.stat().st_size>8*1024*1024:continue
                value=json.loads(file.read_text(encoding='utf-8'));response=value.get('response',{})
                if value.get('success') and response.get('id'):entries.append({'id':response['id'],'usage':response.get('usage',{})})
            ledger.write_text(json.dumps(list({r['id']:r for r in entries}.values())),encoding='utf-8')
            audit.parent.mkdir(exist_ok=True);shutil.move(str(runs),str(audit))
        legacy=data/'cognitive/cognitive.sqlite'
        if legacy.exists():
            with closing(sqlite3.connect(legacy)) as db:
                for table in ('memories','diaries','goals'):
                    columns={r[1] for r in db.execute('PRAGMA table_info('+table+')')}
                    if not {'id','text'}.issubset(columns):continue
                    for identifier,text in db.execute('SELECT id,text FROM '+table).fetchall():
                        if internal_diagnostic(text):
                            if table=='memories':db.execute('UPDATE memories SET active=0 WHERE id=?',(identifier,))
                            else:db.execute('UPDATE '+table+" SET text='[本机维护记录已隐藏]' WHERE id=?",(identifier,))
                db.commit()
        file=data/'cognitive/room/第二天.md'
        if file.is_file():
            paragraphs=file.read_text(encoding='utf-8').split('\n\n');changed=[]
            for p in paragraphs:
                if internal_diagnostic(p):
                    changed.append('今天有一段时间没有交谈。后来 OTREE 回来问「醒了吗」，我们又接上了之前的话题。那段空白没有直接的经历记录，不替它补写原因。' if '凌晨到中午' in p else '')
                elif p.startswith('一，我不是永远在线的'):changed.append('一，今天中间有一段时间没有交谈。后来又与 OTREE 和 Bridge 继续了之前的话题。')
                else:changed.append(p)
            temp=file.with_suffix('.partial');temp.write_text('\n\n'.join(p for p in changed if p),encoding='utf-8');temp.replace(file)
        result.update(backup=backup.name,rawHistoryDeleted=False,selfChanged=False)
        report=ROOT/'.research/privacy-maintenance.json';report.write_text(json.dumps(result,indent=2),encoding='utf-8')
        command=['node','scripts/mnn-repair.mjs',session,str(data),str(ROOT/'.runtime/mnn-tokenizer'),backup.name,'--authorized-offline','--private-context']
        run=subprocess.run(command,cwd=ROOT,timeout=180)
        if run.returncode:raise ValueError('privacy-native-reconstruction-failed')
        marker=directory/'activation.json'
        if marker.exists():
            value=json.loads(marker.read_text(encoding='utf-8'));value['integrationVersion']='1.2.1';value['privateHistoryFilter']=True;value['privateRepairPending']=False
            partial=marker.with_suffix('.partial');partial.write_text(json.dumps(value,indent=2),encoding='utf-8');partial.replace(marker)
        print(json.dumps(result))

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--session',required=True);parser.add_argument('--apply',action='store_true');args=parser.parse_args()
    if not args.apply:raise SystemExit('privacy-explicit-apply-required')
    apply(args.session)
