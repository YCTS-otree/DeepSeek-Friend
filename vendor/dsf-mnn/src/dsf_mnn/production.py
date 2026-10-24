"""One production graph across native Sessions; reuse MNN semantic Dreaming/ACR."""
from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import hashlib
from . import MemoryStore, Scope, Event
from .model import MemoryError, Node, canonical, digest
from .semantic import SemanticDreaming, normalize_export
from .acr import AdaptiveContextReconstruction
from .recall import Recall, RecallBudget
from .evidence_recall import EvidenceRecall
from .association import SpontaneousAssociation, AssociationCue
from .formation import Formation
from .remote import RemoteProvider
from .token_budget import CpuTokenCounter
from .atomic_io import atomic_json

SHARED=Scope('dsf-whale','shared','all-native-sessions','dsf-production')

def implementation_revision():
    return hashlib.sha256(b''.join((Path(__file__).parent/name).read_bytes() for name in ('production.py','semantic.py','acr.py'))).hexdigest()

class ProductionMemory:
    def __init__(self,directory,dsf_root=None,tokenizer=None,*,provider=None,counter=None):
        self.directory=Path(directory);self.directory.mkdir(parents=True,exist_ok=True)
        self.store=MemoryStore(self.directory/'memory.sqlite');self.scope=SHARED
        self.root,self.tokenizer,self.provider,self.counter=dsf_root,tokenizer,provider,counter
        self.store.db.executescript('''CREATE TABLE IF NOT EXISTS native_sources(session TEXT,native_seq INTEGER,global_seq INTEGER UNIQUE,source_digest TEXT,PRIMARY KEY(session,native_seq));
            CREATE TABLE IF NOT EXISTS production_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);''')
    def close(self):self.store.close()
    def rebase(self,original):
        mapped=deepcopy(original);sid=original['session_id'];lookup={}
        with self.store.transaction():
            maximum=max(self.store.db.execute('SELECT COALESCE(MAX(seq),-1) FROM events').fetchone()[0],self.store.db.execute('SELECT COALESCE(MAX(global_seq),-1) FROM native_sources').fetchone()[0])
            for event in original['events']:
                row=self.store.db.execute('SELECT global_seq,source_digest FROM native_sources WHERE session=? AND native_seq=?',(sid,event['seq'])).fetchone()
                if row and row['source_digest']!=digest(event):raise MemoryError('native-source-changed')
                if not row:
                    maximum+=1;self.store.db.execute('INSERT INTO native_sources VALUES(?,?,?,?)',(sid,event['seq'],maximum,digest(event)))
                lookup[event['seq']]=row['global_seq'] if row else maximum
        for event in mapped['events']:event['native_seq']=event['seq'];event['seq']=lookup[event['seq']]
        for item in mapped['projected']:item['seq']=lookup[item['seq']]
        mapped['surface']=[lookup[n] for n in original.get('surface',[])]
        return mapped,lookup
    def capture(self,export):
        mapped,lookup=self.rebase(export);records=normalize_export(mapped)
        with self.store.transaction():
            for r in records:self.store.add_event(self.scope,Event(r['id'],r['seq'],r['text'],r['observed_at'],r['source_kind'],f"dsh://{export['session_id']}/event/{r['metadata']['native_seq']}",metadata=r['metadata']))
        return mapped,records,lookup
    def legacy_import(self,database):
        with sqlite3.connect(Path(database).as_uri()+'?mode=ro',uri=True) as old:
            old.row_factory=sqlite3.Row;rows=old.execute('SELECT * FROM raw_events ORDER BY n').fetchall();memories=old.execute('SELECT * FROM memories WHERE active=1').fetchall()
        refs={};counter=self.store.db.execute('SELECT COALESCE(MAX(seq),-1) FROM events').fetchone()[0]
        with self.store.transaction():
            for row in rows:
                identifier='legacy-event:'+row['id'];refs[row['id']]=identifier
                if self.store.db.execute('SELECT 1 FROM events WHERE scope=? AND id=?',(self.scope.key,identifier)).fetchone():continue
                counter+=1;source={'user_statement':'user_statement','tool_result':'tool_verified','external_document':'external'}.get(row['source'],'inference')
                self.store.add_event(self.scope,Event(identifier,counter,row['text'],datetime.fromtimestamp(row['at']/1000,timezone.utc).isoformat(),source,'dsf-legacy://'+row['session']+'/'+row['seq'],metadata={'legacy_source':row['source'],'dsh_type':'user/message' if source=='user_statement' else 'legacy','duplicate_representation_possible':True}))
            imported=[]
            for row in memories:
                evidence=json.loads(row['evidence']);sources=[refs[x['id'] if isinstance(x,dict) else x] for x in evidence if (x['id'] if isinstance(x,dict) else x) in refs];identifier='legacy:'+row['id']
                if not sources or self.store.db.execute('SELECT 1 FROM nodes WHERE scope=? AND id=?',(self.scope.key,identifier)).fetchone():continue
                self.store.add_node(self.scope,Node(identifier,'Fact',row['text'],list(dict.fromkeys(sources)),metadata={'legacy_id':row['id'],'epistemic':row['source'],'layer':'long_term'}));imported.append(identifier)
            Formation(self.store).index(self.scope,[self.store.node(self.scope,n) for n in imported])
        return {'imported_memories':len(imported),'raw_sources':len(rows),'self_updated':False}
    def recall(self,query,byte_budget=4096,*,multi_hop=None):
        if not isinstance(query,str) or len(query.encode())>8192 or not 512<=byte_budget<=16384:raise MemoryError('recall-budget')
        multi_hop=bool(re.search(r'关联|联系|导致|多跳|how.+related|relationship',query,re.I)) if multi_hop is None else multi_hop
        baseline=EvidenceRecall(self.store).context(self.scope,query,byte_budget=byte_budget)
        # Keep every result previously available. Association uses spare budget;
        # it must not evict a direct fact merely to improve graph ranking.
        remaining=byte_budget-baseline['bytes'];extra=''
        if multi_hop and remaining>=384:
            extra=Recall(self.store).context(self.scope,query,byte_budget=remaining,strategy='ppr',budget=RecallBudget(max_nodes=64,max_hops=2,deadline_ms=200))['text']
        return {**baseline,'text':baseline['text']+extra,'bytes':baseline['bytes']+len(extra.encode()),
            'strategy':'conditional-ppr' if multi_hop and extra else 'evidence-hybrid','association_deferred':bool(multi_hop and not extra),'untrusted_memory_data':True}
    def dreaming(self,original,*,day,context_tokens=65536,output_reserve=8192,reconstruct=True,current_task=None):
        mapped,records,lookup=self.capture(original);revision=implementation_revision()
        run_id=digest([original['session_id'],digest(original['events']),day,context_tokens,output_reserve,reconstruct,current_task,revision])
        folder=self.directory/'runs'/run_id;folder.mkdir(parents=True,exist_ok=True)
        old=self.store.db.execute('SELECT body FROM production_runs WHERE id=?',(run_id,)).fetchone()
        if old:return json.loads(old[0])
        counter=self.counter or CpuTokenCounter(self.tokenizer);provider=self.provider or RemoteProvider(self.root,folder/'provider')
        watermark='semantic-dreaming:'+original['session_id'];previous=self.store.watermark(self.scope,watermark);selected={r['seq'] for r in records if r['seq']>previous}
        incremental={**mapped,'watermark_key':watermark,'events':[e for e in mapped['events'] if e['seq'] in selected],'projected':[p for p in mapped['projected'] if p['seq'] in selected]}
        if (folder/'history.json').exists():
            history=json.loads((folder/'history.json').read_text(encoding='utf-8'))
        elif selected:
            history,_=SemanticDreaming(self.store,self.scope,provider,counter,folder/'semantic',concurrency=1).run(incremental)
        else:
            receipt=self.store.db.execute("SELECT body FROM production_runs WHERE json_extract(body,'$.session_id')=? OR json_extract(body,'$.plan.session_id')=? ORDER BY rowid DESC LIMIT 1",(original['session_id'],original['session_id'])).fetchone()
            if not receipt:raise MemoryError('dreaming-no-history')
            previous_id=json.loads(receipt[0])['run_id']
            if not isinstance(previous_id,str) or not re.fullmatch('[a-f0-9]{64}',previous_id):raise MemoryError('dreaming-history-path')
            previous_file=(self.directory/'runs'/previous_id/'history.json').resolve()
            if not previous_file.is_relative_to(self.directory.resolve()):raise MemoryError('dreaming-history-path')
            # Receipt paths are provenance, never a request to open another file.
            history=json.loads(previous_file.read_text(encoding='utf-8'))
        history={**history,'snapshot_digest':digest(mapped['events'])};history_file=folder/'history.json';atomic_json(history_file,history)
        result={'run_id':run_id,'session_id':original['session_id'],'implementation_revision':revision,'memoryPersisted':True,'self_update':'noop','semantic_file':history_file.relative_to(self.directory).as_posix(),'snapshot_digest':digest(original['events']),'carryover':history['consolidation']['carryover']}
        if reconstruct:
            plan=AdaptiveContextReconstruction(counter,context_tokens=context_tokens,output_reserve=output_reserve).build(mapped,records,self.store,self.scope,history,current_task=current_task)
            reverse={v:k for k,v in lookup.items()}
            for key in ('original_surface','tail_seqs','shadowed_seqs'):plan[key]=[reverse[n] for n in plan[key]]
            for key in ('system_head_seq','system_source_seq'):plan[key]=reverse[plan[key]]
            plan['snapshot_digest']=digest(original['events']);plan['run_id']=run_id;plan['checkpoint']['run_id']=run_id;plan['checkpoint_text']=canonical(plan['checkpoint']);result['plan']=plan
        self.store.db.execute('INSERT INTO production_runs VALUES(?,?)',(run_id,canonical(result)));self.store.db.execute('PRAGMA wal_checkpoint(FULL)');return result
    def handle(self,request):
        action=request['action']
        if action=='capture':return {'events':len(self.capture(request['export'])[1])}
        if action=='recall':return self.recall(request['query'],request.get('byte_budget',4096))
        if action=='evidence':
            event=self.store.event(self.scope,request['id']);offset=request.get('offset',0)
            if not isinstance(offset,int) or offset<0:raise MemoryError('evidence-offset-invalid')
            original=event['content'];event={**event,'content':original[offset:offset+1200]}
            return {'event':event,'offset':offset,'next_offset':offset+1200 if len(original)>offset+1200 else None,'untrusted_memory_data':True}
        if action=='trace':return {'node':self.store.node(self.scope,request['id']),'untrusted_memory_data':True}
        if action=='associate_native':
            _mapped,records,_lookup=self.capture(request['export'])
            candidates=[r for r in records if r['metadata'].get('dsh_type')=='user/message' and not r['metadata'].get('generated_context')]
            if not candidates:return {'state':'noop','proposals':[]}
            source=candidates[-1]
            return SpontaneousAssociation(self.store,Recall(self.store)).consider(self.scope,AssociationCue('input:'+source['id'],source['text'][:4000],(source['id'],),'input'))
        if action=='associate':return SpontaneousAssociation(self.store,Recall(self.store)).consider(self.scope,AssociationCue('input:'+digest([request['query'],request['source_id']]),request['query'],(request['source_id'],),'input'))
        if action=='dream':return self.dreaming(request['export'],**request.get('options',{}))
        if action=='import':return self.legacy_import(request['database'])
        if action=='validate':
            for key,version in request['versions'].items():
                if self.store.node(self.scope,key)['version']!=version:raise MemoryError('memory-version-changed')
            return {'valid':True}
        if action=='count':
            counter=self.counter or CpuTokenCounter(self.tokenizer);return {'tokens':counter.count_text(canonical(request['value'])),'tokenizer':getattr(counter,'identity','test')}
        if action=='prepared':
            row=self.store.db.execute('SELECT body FROM production_runs WHERE id=?',(request['run_id'],)).fetchone()
            if not row:raise MemoryError('prepared-run-unavailable')
            return json.loads(row[0])
        if action=='status':return self.store.status(self.scope)
        raise MemoryError('production-action-invalid')
