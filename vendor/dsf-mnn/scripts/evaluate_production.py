"""Fixed-query source retrieval comparison; no training or LLM judge."""
import argparse,hashlib,json,sqlite3,sys,time
from pathlib import Path
from uuid import uuid4
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
from dsf_mnn import Scope
from dsf_mnn.production import ProductionMemory
from dsf_mnn.evidence_recall import EvidenceRecall

def main():
    p=argparse.ArgumentParser();p.add_argument('work',type=Path);p.add_argument('output',type=Path);a=p.parse_args();work=a.work.resolve();out=a.output.resolve()/('retrieval-'+uuid4().hex);out.mkdir(parents=True)
    gold_file=work/'quality-gold-v2.json';gold=json.loads(gold_file.read_text(encoding='utf-8'));source=work/'cognitive-v2/after-grounding.sqlite'
    report={'schema':'dsf-mnn-production-retrieval/1','gold_sha256':hashlib.sha256(gold_file.read_bytes()).hexdigest(),'cases':len(gold),'budget_bytes':4096,'source_ranking_not_answer_accuracy':True,'variants':{}}
    for variant in ('v1.1-evidence-hybrid','conditional'):
        cases=[]
        for item in gold:
            directory=out/(variant+'-'+item['id']);directory.mkdir()
            with sqlite3.connect(source.as_uri()+'?mode=ro',uri=True) as original:
                with sqlite3.connect(directory/'memory.sqlite') as copy:original.backup(copy)
            memory=ProductionMemory(directory)
            try:
                rows=memory.store.db.execute('SELECT body FROM scopes').fetchall();assert len(rows)==1
                memory.scope=Scope(**json.loads(rows[0][0]));start=time.perf_counter()
                result=EvidenceRecall(memory.store).context(memory.scope,item['question']) if variant.startswith('v1.1') else memory.recall(item['question'])
                references=[]
                for line in result['text'].splitlines():
                    row=json.loads(line)
                    for ref in ([row['source_ref']] if 'source_ref' in row else row.get('source_refs',[])):
                        if ref not in references:references.append(ref)
                rank=references.index(item['source_ref'])+1 if item['source_ref'] in references else None
                case={'gold_id':item['id'],'correct_source_rank':rank,'latency_ms':(time.perf_counter()-start)*1000,'bytes':result['bytes'],'strategy':result.get('strategy','evidence-hybrid'),'context':result['text'],'references':references}
                (directory/'case.json').write_text(json.dumps(case,ensure_ascii=False,indent=2),encoding='utf-8');cases.append({k:v for k,v in case.items() if k not in ('context','references')})
            finally:memory.close()
        report['variants'][variant]={'coverage':sum(c['correct_source_rank'] is not None for c in cases)/len(cases),'source_mrr':sum(1/c['correct_source_rank'] if c['correct_source_rank'] else 0 for c in cases)/len(cases),'cases':cases}
    old,new=(report['variants'][x] for x in ('v1.1-evidence-hybrid','conditional'))
    report['regressions']=[a['gold_id'] for a,b in zip(old['cases'],new['cases']) if a['correct_source_rank'] is not None and b['correct_source_rank'] is None]
    report['no_regression']=not report['regressions'] and new['coverage']>=old['coverage'] and new['source_mrr']>=old['source_mrr']
    (out/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'output':str(out),'cases':len(gold),'variants':{k:{'coverage':v['coverage'],'source_mrr':v['source_mrr']} for k,v in report['variants'].items()},'no_regression':report['no_regression']}))
if __name__=='__main__':main()
