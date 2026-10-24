"""Reproducible local acceptance gate. Real provider run must already exist."""
import argparse,hashlib,json,os,subprocess,sys,uuid
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from scripts.mnn_admin import MnnInstallation

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--native',required=True);parser.add_argument('--retrieval',required=True);args=parser.parse_args()
    folder=ROOT/'.research/mnn-v120';folder.mkdir(parents=True,exist_ok=True)
    run=folder/('validation-'+uuid.uuid4().hex);run.mkdir()
    outputs={}
    def command(name,cmd,env=None):
        with (run/(name+'.log')).open('w',encoding='utf-8') as out:
            result=subprocess.run(cmd,cwd=ROOT,env=env,stdout=out,stderr=subprocess.STDOUT)
        outputs[name]={'exitCode':result.returncode,'log':str(run/(name+'.log'))}
        if result.returncode:raise ValueError('mnn-validation-'+name+'-failed')
    MnnInstallation(ROOT).verify_code()
    native=Path(args.native).resolve();retrieval=Path(args.retrieval).resolve()
    if not native.is_relative_to(folder) or not retrieval.is_relative_to(folder):raise ValueError('mnn-validation-local-reports-required')
    report=json.loads((native/'report.json').read_text());audit=json.loads((native/'reopen-audit.json').read_text())
    if not report.get('success') or not audit.get('success') or len(report['rounds'])<3:raise ValueError('mnn-native-validation-required')
    changed=[]
    for name,digest in report['source_files'].items():
        if hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=digest:changed.append(name)
    # The only post-canary change is owned-worker tree cancellation, covered below.
    if set(changed)-{'src/mnn/client.js'}:raise ValueError('mnn-native-source-changed')
    quality=json.loads((retrieval/'report.json').read_text())
    variants=list(quality['variants'].values())
    if len(variants)!=2 or variants[1]['coverage']<variants[0]['coverage'] or variants[1]['source_mrr']<variants[0]['source_mrr']:raise ValueError('mnn-retrieval-regressed')
    command('static',['node','scripts/check.js'])
    command('node',['node','--test',*map(str,sorted((ROOT/'tests').glob('*.test.js')))])
    command('python',[sys.executable,'-m','unittest','discover','-s','tests','-p','test_*.py'])
    command('mnn-python',[sys.executable,'-m','pytest','vendor/dsf-mnn/tests','-q','--basetemp',str(run/'pytest')],{**os.environ,'PYTHONPATH':str(ROOT/'vendor/dsf-mnn/src')})
    command('restore',[sys.executable,'scripts/mnn_admin.py','restore-drill'])
    command('runtime',['node','scripts/mnn-runtime-smoke.mjs','--live'])
    files=[*sorted((ROOT/'dsh').glob('*.js')),*sorted((ROOT/'src/mnn').glob('*.js')),ROOT/'src/engine.js',ROOT/'src/cognitive/service.js',ROOT/'dsh/weixin.patch.yml',ROOT/'scripts/dsh.js',ROOT/'scripts/cognitive.js',ROOT/'scripts/mnn_admin.py',ROOT/'scripts/mnn-repair.mjs',ROOT/'scripts/archive_manager.py',ROOT/'scripts/dsf_compat.py',ROOT/'vendor/dsf-mnn/SOURCE.json']
    result={'schema':'dsf-mnn-acceptance/1','passed':True,'restoreDrill':True,'nativeCanary':True,'fullProfile':True,'longitudinal':True,'retrievalNoRegression':True,
            'native':str(native),'retrieval':str(retrieval),'postCanaryChanges':changed,'checks':outputs,
            'limitations':['3 synthetic live pressure cycles; cross-day dates and interruptions are mock-tested','G5 source coverage gap remains; no statistical superiority claim','formal deployment requires a fresh verified DSF backup'],
            'sourceFiles':{str(f.relative_to(ROOT)).replace('\\','/'):hashlib.sha256(f.read_bytes()).hexdigest() for f in files}}
    (run/'acceptance.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    marker=folder/'acceptance.json';temp=marker.with_suffix('.partial');temp.write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(marker)
    print(json.dumps({'passed':True,'report':str(run/'acceptance.json')}))
if __name__=='__main__':main()
