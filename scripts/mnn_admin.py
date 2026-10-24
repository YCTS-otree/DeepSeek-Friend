"""Offline installation/activation gate. Never loads authentication material."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
from contextlib import closing
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from scripts import dsf

class MnnInstallation:
    def __init__(self,root):self.root=Path(root).resolve();self.data=dsf.settings(self.root)[0];self.directory=self.data/'cognitive/mnn';self.marker=self.directory/'activation.json'
    def status(self):
        value=json.loads(self.marker.read_text(encoding='utf-8')) if self.marker.exists() else {'enabled':False,'paused':True,'guardian':{'soft':.85,'hard':.95,'resume':.60},'idleMinutes':15,'dreamingTime':'03:00','timezone':'Asia/Shanghai'}
        states=[];file=self.directory/'pressure.sqlite'
        if file.exists():
            with sqlite3.connect(file.as_uri()+'?mode=ro',uri=True) as db:states=[{'session':r[0],'state':r[1],'attempts':r[2],'error':r[3]} for r in db.execute('SELECT session,state,attempts,error FROM pressure')]
        return {**value,'states':states,'memoryNetwork':str(self.directory/'memory.sqlite'),'selfAutoCommit':False,'basicFallback':False}
    def verify_code(self):
        base=self.root/'vendor/dsf-mnn';manifest=json.loads((base/'SOURCE.json').read_text(encoding='utf-8'))
        for name,expected in manifest['files'].items():
            file=(base/name).resolve()
            if not file.is_relative_to(base.resolve()) or hashlib.sha256(file.read_bytes()).hexdigest()!=expected:raise ValueError('mnn-source-verification-failed')
        return manifest
    def verify_acceptance(self):
        file=self.root/'.research/mnn-v120/acceptance.json'
        if not file.exists():raise ValueError('mnn-isolated-acceptance-required')
        report=json.loads(file.read_text(encoding='utf-8'))
        if not all(report.get(key) for key in ('passed','restoreDrill','nativeCanary','fullProfile','longitudinal','retrievalNoRegression')):raise ValueError('mnn-isolated-acceptance-required')
        for name,expected in report.get('sourceFiles',{}).items():
            source=(self.root/name).resolve()
            if not source.is_relative_to(self.root) or hashlib.sha256(source.read_bytes()).hexdigest()!=expected:raise ValueError('mnn-acceptance-source-changed')
        if not report.get('sourceFiles'):raise ValueError('mnn-acceptance-source-changed')
        return report
    def configure(self,changes,backup):
        if set(changes)-{'enabled','paused','tokenizer','guardian','idleMinutes','dreamingTime','timezone'}:raise ValueError('mnn-config-invalid')
        old=self.status();enabled=changes.get('enabled',old['enabled'])
        if not isinstance(enabled,bool):raise ValueError('mnn-config-invalid')
        if 'paused' in changes and not isinstance(changes['paused'],bool):raise ValueError('mnn-config-invalid')
        guardian=changes.get('guardian',old.get('guardian',{}))
        if not isinstance(guardian,dict) or set(guardian)-{'soft','hard','resume','maxAttempts','retryMs','leaseMs'}:raise ValueError('mnn-config-invalid')
        if any(type(guardian.get(key,default)) not in (int,float) or not math.isfinite(guardian.get(key,default)) for key,default in [('resume',.60),('soft',.85),('hard',.95)]):raise ValueError('mnn-config-invalid')
        if not 0<guardian.get('resume',.60)<guardian.get('soft',.85)<guardian.get('hard',.95)<1:raise ValueError('mnn-config-invalid')
        for key,low,high in [('maxAttempts',1,5),('retryMs',1000,86400000),('leaseMs',10000,86400000)]:
            if key in guardian and (type(guardian[key]) is not int or not low<=guardian[key]<=high):raise ValueError('mnn-config-invalid')
        if 'idleMinutes' in changes and (not isinstance(changes['idleMinutes'],int) or not 1<=changes['idleMinutes']<=1440):raise ValueError('mnn-config-invalid')
        if 'dreamingTime' in changes:
            import re
            if not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d',changes['dreamingTime']):raise ValueError('mnn-config-invalid')
        if 'timezone' in changes:
            from zoneinfo import ZoneInfo
            try:ZoneInfo(changes['timezone'])
            except Exception:raise ValueError('mnn-config-invalid') from None
        if enabled and not old['enabled']:
            self.verify_acceptance();self.verify_code()
            if not backup or dsf.inspect(backup).get('reason')!='before-mnn-configure':raise ValueError('mnn-backup-required')
        tokenizer=Path(changes.get('tokenizer',old.get('tokenizer',self.root/'.runtime/mnn-tokenizer'))).resolve()
        if enabled and not all((tokenizer/n).is_file() for n in ('tokenizer.json','tokenizer_config.json')):raise ValueError('mnn-tokenizer-required')
        lock=self.root/'vendor/dsf-mnn/configs/tokenizer-lock.json'
        if enabled and lock.exists():
            for name,expected in json.loads(lock.read_text(encoding='utf-8'))['files'].items():
                if name not in ('tokenizer.json','tokenizer_config.json') or hashlib.sha256((tokenizer/name).read_bytes()).hexdigest()!=expected:raise ValueError('mnn-tokenizer-digest-mismatch')
        self.directory.mkdir(parents=True,exist_ok=True)
        # Turning off background work retains the sole MNN graph; no live legacy fallback.
        state={**old,**changes,'schema':'dsf-mnn-activation/1','integrationVersion':'1.2.0','runtimeVersion':'0.2.0-rc.2','enabled':old['enabled'] or enabled,'paused':changes.get('paused',not enabled if 'enabled' in changes else old.get('paused',True)),'tokenizer':str(tokenizer),'selfAutoCommit':False,'basicFallback':False}
        state.pop('states',None);state.pop('memoryNetwork',None)
        if state['enabled'] and not old['enabled'] and (self.data/'cognitive/cognitive.sqlite').exists():
            self.invoke('import',{'database':str(self.data/'cognitive/cognitive.sqlite')},tokenizer)
        partial=self.marker.with_suffix('.partial');partial.write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf-8');partial.replace(self.marker)
        return self.status()
    def invoke(self,action,args,tokenizer=None):
        from os import environ
        env={**environ,'PYTHONPATH':str(self.root/'vendor/dsf-mnn/src'),'PYTHONIOENCODING':'utf-8'}
        command=[sys.executable,'-m','dsf_mnn.production_cli','--directory',str(self.directory),'--dsf-root',str(self.root),'--tokenizer',str(tokenizer or self.root/'.runtime/mnn-tokenizer')]
        result=subprocess.run(command,input=json.dumps({'action':action,**args})+'\n',capture_output=True,text=True,encoding='utf-8',env=env,timeout=120)
        try:response=json.loads(result.stdout)
        except Exception:raise ValueError('mnn-install-worker-failed') from None
        if result.returncode or response.get('error'):raise ValueError('mnn-install-worker-failed')
        return response['result']

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['status','prepare','retry','install','pause','resume','rollback','restore-drill']);parser.add_argument('file',nargs='?');parser.add_argument('--session');parser.add_argument('--tokenizer');parser.add_argument('--soft',type=float);parser.add_argument('--hard',type=float);parser.add_argument('--resume-watermark',type=float);parser.add_argument('--idle-minutes',type=int);parser.add_argument('--dreaming-time');parser.add_argument('--timezone');args=parser.parse_args()
    root=Path(__file__).resolve().parents[1];manager=MnnInstallation(root)
    if args.action=='status':print(json.dumps(manager.status(),ensure_ascii=False));return
    if args.action=='rollback':
        if not args.file:raise ValueError('mnn-rollback-file-required')
        # Delegate to the existing three timed, interactive confirmations.
        raise SystemExit(subprocess.call([sys.executable,str(root/'scripts/dsf.py'),'restore',args.file,'--confirm-restore']))
    if args.action=='restore-drill':
        with tempfile.TemporaryDirectory(prefix='mnn-drill-',dir=root/'.research') as temp:
            fixture=Path(temp);(fixture/'package.json').write_text('{"version":"0.0.0"}');data=fixture/'data';(data/'cognitive/mnn').mkdir(parents=True)
            with closing(sqlite3.connect(data/'cognitive/mnn/memory.sqlite')) as db:db.execute('CREATE TABLE sample(value)');db.execute("INSERT INTO sample VALUES('before')");db.commit()
            archive=dsf.snapshot(fixture,data)
            with closing(sqlite3.connect(data/'cognitive/mnn/memory.sqlite')) as db:db.execute("UPDATE sample SET value='after'");db.commit()
            before=dsf.restore(archive,fixture,data)
            with closing(sqlite3.connect(data/'cognitive/mnn/memory.sqlite')) as db:ok=db.execute('SELECT value FROM sample').fetchone()[0]=='before'
            dsf.inspect(before)
            if not ok:raise ValueError('mnn-restore-drill-failed')
            print(json.dumps({'restoreDrill':True,'productionWritten':False}));return
    data,port=dsf.settings(root)
    with dsf.offline(root,data,port):
        if args.action=='retry':
            import re
            if not re.fullmatch('[a-f0-9-]{36}',args.session or ''):raise ValueError('mnn-session-required')
            file=manager.directory/'pressure.sqlite'
            if not file.exists():raise ValueError('mnn-retry-state')
            backup=dsf.snapshot(root,data,reason='before-mnn-retry');dsf.inspect(backup)
            with closing(sqlite3.connect(file)) as db:
                changed=db.execute("UPDATE pressure SET state='RECOVERY_PENDING',attempts=0,retry_at=0,owner=NULL,lease=0 WHERE session=? AND state IN ('REST_FAILED','RECOVERY_PENDING')",(args.session,)).rowcount;db.commit()
            if not changed:raise ValueError('mnn-retry-state')
            print(json.dumps({'retryPending':True,'backup':backup.name}));return
        if args.action=='prepare':
            import re
            if not re.fullmatch('[a-f0-9-]{36}',args.session or ''):raise ValueError('mnn-session-required')
            manager.verify_acceptance();manager.verify_code()
            tokenizer=Path(args.tokenizer or root/'.runtime/mnn-tokenizer').resolve()
            lock=json.loads((root/'vendor/dsf-mnn/configs/tokenizer-lock.json').read_text(encoding='utf-8'))
            for name,expected in lock['files'].items():
                if name not in ('tokenizer.json','tokenizer_config.json') or hashlib.sha256((tokenizer/name).read_bytes()).hexdigest()!=expected:raise ValueError('mnn-tokenizer-digest-mismatch')
            backup=dsf.snapshot(root,data,reason='before-mnn-prepare');dsf.inspect(backup)
            # Import once, without enabling any runtime hook or background work.
            if (data/'cognitive/cognitive.sqlite').exists():manager.invoke('import',{'database':str(data/'cognitive/cognitive.sqlite')},tokenizer)
            result=subprocess.run(['node',str(root/'scripts/mnn-repair.mjs'),args.session,str(data),str(tokenizer),backup.name,'--authorized-offline'],cwd=root,timeout=7200)
            if result.returncode:raise ValueError('mnn-formal-prepare-failed')
            return
        backup=dsf.snapshot(root,data,reason='before-mnn-configure');dsf.inspect(backup)
        changes={'enabled':True,'paused':args.action=='pause',**({'tokenizer':args.tokenizer} if args.tokenizer else {})}
        overrides={name:value/100 for name,value in [('soft',args.soft),('hard',args.hard),('resume',args.resume_watermark)] if value is not None}
        if overrides:changes['guardian']={**manager.status().get('guardian',{}),**overrides}
        for key,value in [('idleMinutes',args.idle_minutes),('dreamingTime',args.dreaming_time),('timezone',args.timezone)]:
            if value is not None:changes[key]=value
        result=manager.configure(changes,backup)
        print(json.dumps({'backup':backup.name,'status':result},ensure_ascii=False))

if __name__=='__main__':
    try:main()
    except ValueError as error:print(str(error) if str(error).startswith('mnn-') else 'mnn-operation-failed');raise SystemExit(1)
