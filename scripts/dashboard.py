"""Read-only local metrics, with an independent cached provider worker."""
from pathlib import Path
from contextlib import contextmanager
import json,sqlite3,threading,subprocess,time,os,re
from datetime import datetime
from zoneinfo import ZoneInfo
from scripts import dsf

@contextmanager
def read_db(file):
    db=None
    try:
        if Path(file).is_file():db=sqlite3.connect(Path(file).resolve().as_uri()+'?mode=ro',uri=True,timeout=.3);db.row_factory=sqlite3.Row
        yield db
    finally:
        if db:db.close()

def totals(rows):
    result={'input':0,'output':0,'cacheRead':0,'cacheWrite':0,'requests':0}
    for row in rows:
        try:v=json.loads(row['text'])
        except (ValueError,TypeError):continue
        for key,field in [('input','inputTokens'),('output','outputTokens'),('cacheRead','cacheReadTokens'),('cacheWrite','cacheWriteTokens')]:
            n=v.get(field,0)
            if type(n) is int and n>=0:result[key]+=n
        result['requests']+=1
    result['total']=sum(result[k] for k in ('input','output','cacheRead','cacheWrite'));return result

class Dashboard:
    def __init__(self,root,probe=None):
        self.root=Path(root).resolve();self.lock=threading.RLock();self.cache={};self.balance={};self.checked=0;self.running=False;self.closed=False;self.child=None;self.probe=probe or self._probe
        self.receipts={};self.receipt_checked=0
    def _probe(self,args):
        child=subprocess.Popen(['node','scripts/dashboard-probe.mjs'],cwd=self.root,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        with self.lock:
            if self.closed:child.terminate();return {}
            self.child=child
        try:
            out,_=child.communicate(json.dumps(args).encode(),timeout=12)
            if child.returncode or len(out)>65536:return {}
            return json.loads(out)
        except (subprocess.TimeoutExpired,ValueError):child.kill();child.communicate();return {}
        finally:
            with self.lock:self.child=None
    def close(self):
        with self.lock:
            self.closed=True
            if self.child and self.child.poll() is None:self.child.terminate()
    def _refresh(self,session,balance):
        try:
            try:value=self.probe({'session':session,'balance':balance})
            except (OSError,ValueError):value={}
            with self.lock:
                if session:self.cache[session]=value.get('native',{'status':'error','error':'dsh-metrics-unavailable','checkedAt':int(time.time()*1000)})
                if balance:self.balance=value.get('balance',{'status':'error','error':'balance-query-failed'});self.checked=time.monotonic()
                while len(self.cache)>16:self.cache.pop(next(iter(self.cache)))
        finally:
            with self.lock:self.running=False
    def _background_usage(self,data):
        if time.monotonic()-self.receipt_checked<60:return
        self.receipt_checked=time.monotonic();found={}
        for file in (data/'cognitive/mnn/runs').glob('*/provider/*.json'):
            try:
                if not file.resolve().is_relative_to((data/'cognitive/mnn').resolve()):continue
                stat=file.stat()
            except OSError:continue  # A completed run may be archived concurrently.
            if stat.st_size>8*1024*1024:continue
            stamp=(stat.st_mtime_ns,stat.st_size)
            previous=self.receipts.get(str(file))
            if previous and previous[0]==stamp:found[str(file)]=previous;continue
            try:
                r=json.loads(file.read_text(encoding='utf-8'));response=r.get('response',{})
                if r.get('success') and response.get('id'):found[str(file)]=(stamp,response['id'],response.get('usage',{}))
            except (OSError,ValueError,TypeError):continue
        self.receipts=found
    def snapshot(self,session=None):
        if session is not None and (not isinstance(session,str) or not re.fullmatch('[a-f0-9-]{36}',session)):raise ValueError('dashboard-session-invalid')
        data,_=dsf.settings(self.root);now=int(time.time()*1000);result={'updated':now,'timezone':'Asia/Shanghai','context':None,'warnings':[]}
        try:
            with read_db(data/'bridge.sqlite') as db:
                if db:
                    row=db.execute('SELECT session,title,kind,archived FROM chat_sessions WHERE session=?',(session,)).fetchone() if session else db.execute("SELECT session,title,kind,archived FROM chat_sessions WHERE archived=0 AND kind='conversation'").fetchone()
                    if session and not row:raise ValueError('dashboard-session-not-found')
                    if row:session=row['session'];result['session']=dict(row)
                    result['jobs']=[dict(r) for r in db.execute("SELECT state,count(*) count FROM jobs WHERE state NOT IN ('done','discarded') GROUP BY state")]
                    result['deliveries']=[dict(r) for r in db.execute("SELECT state,count(*) count FROM outbox WHERE state!='sent' GROUP BY state")]
                    poll=db.execute("SELECT value FROM meta WHERE key LIKE 'poll:%' ORDER BY value DESC LIMIT 1").fetchone();result['lastPoll']=poll[0] if poll else None
            with read_db(data/'interaction.sqlite') as db:
                if db:
                    settings={r['k']:json.loads(r['v']) for r in db.execute("SELECT k,v FROM settings WHERE k IN ('paused','continuous','reasoningEffort','maxTokens')")};result['runtime']={'paused':False,'continuous':True,'reasoningEffort':'high','maxTokens':8192,**settings}
                    start=int(datetime.now(ZoneInfo('Asia/Shanghai')).replace(hour=0,minute=0,second=0,microsecond=0).timestamp()*1000)
                    result['today']=totals(db.execute("SELECT text FROM private_records WHERE kind='usage' AND created>=?",(start,)))
                    row=db.execute("SELECT text,created FROM private_records WHERE kind='usage' AND session=? ORDER BY n DESC LIMIT 1",(session,)).fetchone()
                    result['lastRequest']={**totals([row]),'created':row['created']} if row else None
                    result['alarms']=db.execute("SELECT count(*) FROM alarms WHERE state='scheduled'").fetchone()[0]
            with read_db(data/'cognitive/mnn/pressure.sqlite') as db:
                if db:
                    row=db.execute('SELECT state,measurement,attempts,error,updated FROM pressure WHERE session=?',(session,)).fetchone()
                    if row:result['guardian']={**dict(row),'measurement':json.loads(row['measurement'])}
            with read_db(data/'cognitive/mnn/memory.sqlite') as db:
                if db:result['memory']={table:db.execute('SELECT count(*) FROM '+table).fetchone()[0] for table in ('events','nodes','edges')}
        except sqlite3.Error:result['warnings'].append('dashboard-local-metrics-unavailable')
        with self.lock:
            self._background_usage(data);seen=set();usage=[]
            for _,identifier,v in self.receipts.values():
                if identifier in seen:continue
                seen.add(identifier);usage.append({'text':json.dumps({'inputTokens':v.get('prompt_tokens',0),'outputTokens':v.get('completion_tokens',0)})})
            result['dreamingUsage']=totals(usage)
            ledger=data/'cognitive/mnn/usage-ledger.json'
            if ledger.is_file():
                try:
                    for r in json.loads(ledger.read_text(encoding='utf-8')):
                        if r['id'] not in seen:seen.add(r['id']);usage.append({'text':json.dumps({'inputTokens':r['usage'].get('prompt_tokens',0),'outputTokens':r['usage'].get('completion_tokens',0)})})
                    result['dreamingUsage']=totals(usage)
                except (OSError,ValueError,KeyError,TypeError):result['warnings'].append('dashboard-background-ledger-unavailable')
            native=self.cache.get(session,{'status':'loading'});result['native']=native;result['balance']={**self.balance,'stale':time.monotonic()-self.checked>=60} if self.balance else {'status':'loading'}
            refresh_balance=not self.checked or time.monotonic()-self.checked>=60
            if not self.closed and not self.running and (refresh_balance or session and now-native.get('checkedAt',0)>5000):
                self.running=True;threading.Thread(target=self._refresh,args=(session,refresh_balance),daemon=True).start()
        return result
