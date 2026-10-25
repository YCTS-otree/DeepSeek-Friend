"""Explicit destructive purge of a rejected lineage, then rebuild from clean DSF.

Only --apply can mutate. Keys/credentials and upstream research baselines are never opened.
"""
from pathlib import Path
from contextlib import closing
from datetime import datetime
import argparse,json,sqlite3,subprocess,sys,uuid,zipfile,shutil
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from scripts import dsf
from scripts.rebase_state import clean_transport

def write(file,value):
    temp=file.with_suffix('.partial');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(file)

def remove_checked(path,base):
    original=Path(path);base=base.resolve()
    if original.is_symlink() or any(p.is_symlink() for p in original.parents if p!=base and p.is_relative_to(base)):raise ValueError('dsf-purge-path-refused')
    path=original.resolve()
    if path==base or not path.is_relative_to(base):raise ValueError('dsf-purge-path-refused')
    if path.is_dir():shutil.rmtree(path)
    else:path.unlink(missing_ok=True)

def prepare(source):
    source=source.resolve();folder=(ROOT/'Archive').resolve()
    if source.parent!=folder:raise ValueError('dsf-clean-source-path')
    manifest=dsf.inspect(source)
    if any('/mnn/' in n for n in manifest['files']):raise ValueError('dsf-clean-source-not-pre-mnn')
    data,port=dsf.settings(ROOT)
    operation=ROOT/'.maintenance';operation.mkdir(exist_ok=True)
    epoch=str(uuid.uuid4());stage=operation/('stage-'+epoch);stage.mkdir()
    subprocess.run(['node','--input-type=module','-e',"import {secureDirectory} from './src/security.js';secureDirectory(process.argv[1]);",str(operation)],cwd=ROOT,check=True,capture_output=True)
    with zipfile.ZipFile(source) as z:
        for name in manifest['files']:
            target=stage/'.runtime/home'/name.removeprefix('dsh/') if name.startswith('dsh/') else stage/name.removeprefix('prompts/') if name.startswith('prompts/') else stage/name
            target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(z.read(name))
    (stage/'package.json').write_text((ROOT/'package.json').read_text(encoding='utf-8'),encoding='utf-8')
    runtime=dsf.dsf_compat.dsh_version(ROOT)
    if runtime!='0.2.0-rc.2':raise ValueError('mnn-clean-runtime-unverified')
    sdk=stage/'.runtime/node_modules/@deepseek-ai/dsh/package.json';sdk.parent.mkdir(parents=True);sdk.write_text(json.dumps({'version':runtime}),encoding='utf-8')
    (stage/'config.json').write_text(json.dumps({'dataDir':str(stage/'data'),'dsh':{'baseUrl':'http://127.0.0.1:3088'}}),encoding='utf-8')
    fence=clean_transport(stage/'data',data,'ea38d96b-7c50-4478-87f2-a9bc9512ba5f',epoch)
    old=data/'cognitive/mnn/activation.json';settings=json.loads(old.read_text(encoding='utf-8')) if old.exists() else {}
    activation={k:settings[k] for k in ['tokenizer','guardian','idleMinutes','dreamingTime','timezone'] if k in settings}
    activation.update(schema='dsf-mnn-activation/1',integrationVersion=json.loads((ROOT/'vendor/dsf-mnn/SOURCE.json').read_text(encoding='utf-8'))['integrationVersion'],runtimeVersion='0.2.0-rc.2',enabled=True,paused=False,generation=epoch,privateRepairPending=True,selfAutoCommit=False,basicFallback=False)
    mnn=stage/'data/cognitive/mnn';mnn.mkdir();write(mnn/'activation.json',activation)
    with closing(sqlite3.connect(stage/'data/cognitive/cognitive.sqlite')) as db:
        db.execute("UPDATE tasks SET state='cancelled' WHERE state IN ('pending','running')");db.commit()
    for name in ['SELF_MODEL.md','manifest.json']:
        if (data/'cognitive/historical/v0.1.0'/name).read_bytes()!=(stage/'data/cognitive/historical/v0.1.0'/name).read_bytes():raise ValueError('dsf-historical-self-mismatch')
    meta={'generation':epoch,'baseline':source.name,'baselineDigest':dsf.digest(source),'baselineCreated':manifest['createdAt'],'stage':str(stage),'fence':fence,'phase':'prepared','reason':'清除全部接入 MNN 后的旧聊天及派生物，防止后台回灌'}
    with dsf.offline(ROOT,data,port):
        seed=dsf.snapshot(stage,stage/'data',reason='clean-generation-seed-pre-mnn-data-only');dsf.inspect(seed)
        target=folder/('clean-seed-'+seed.name);shutil.copyfile(seed,target);dsf.inspect(target)
        # Existing restore keeps a temporary safety copy. It too is permanently
        # purged below before any LLM gets the new input.
        before=dsf.restore(target,ROOT,data,expected_digest=dsf.digest(target));dsf.inspect(before)
        meta['seed']=target.name;deleted=[];cut=datetime.fromisoformat(manifest['createdAt'])
        for p in sorted(folder.rglob('*.DSF')):
            if p==source or p==target:continue
            m=dsf.inspect(p)
            if datetime.fromisoformat(m['createdAt'])>cut:
                deleted.append({'name':p.relative_to(folder).as_posix(),'sha256':dsf.digest(p),'bytes':p.stat().st_size});remove_checked(p,folder)
        # Remove operational copies that have held rejected chats. Keep source
        # code, SDKs, tokenizer assets, synthetic research and the immutable upstream baseline.
        removed=[]
        for p in list((ROOT/'.research').iterdir()):
            if p.name.startswith(('continuity-','privacy-','pre-mnn-rebase','rebase-audit','rebase-invalid','after-eight-native-audit')) or p.name=='continuity-inspect.json':
                removed.append(p.relative_to(ROOT).as_posix());remove_checked(p,ROOT/'.research')
        for p in list((ROOT/'.research/mnn-v120').glob('formal-*')):
            removed.append(p.relative_to(ROOT).as_posix());remove_checked(p,ROOT/'.research')
        for p in [folder/'operator-audit',ROOT/'.runtime/home/cache/attachments',ROOT/'.runtime/home/storages/workspace.json',data/'recovery-forward-job.json',data/'model-smoke']:
            if p.exists():removed.append(p.relative_to(ROOT).as_posix());remove_checked(p,ROOT)
        meta.update(deletedSnapshots=deleted,removedCopies=removed,phase='purged')
        write(operation/'current.json',meta)
    print(json.dumps({'generation':epoch,'phase':'purged','deletedSnapshots':len(deleted),'removedCopies':len(removed),'copiedChatBodies':0}))

def dream():
    file=ROOT/'.maintenance/current.json';meta=json.loads(file.read_text(encoding='utf-8'))
    if meta['phase']!='purged':raise ValueError('dsf-clean-phase-invalid')
    data,port=dsf.settings(ROOT)
    with dsf.offline(ROOT,data,port):
        result=subprocess.run(['node','scripts/mnn-repair.mjs','ea38d96b-7c50-4478-87f2-a9bc9512ba5f',str(data),str(ROOT/'.runtime/mnn-tokenizer'),meta['seed'],'--authorized-offline'],cwd=ROOT,timeout=7200)
        if result.returncode:raise ValueError('dsf-clean-dream-failed')
        marker=data/'cognitive/mnn/activation.json';activation=json.loads(marker.read_text(encoding='utf-8'));activation['privateRepairPending']=False;write(marker,activation)
        final=dsf.snapshot(ROOT,data,reason='after-purged-lineage-fresh-generation-dreaming');dsf.inspect(final)
        meta.update(phase='dreamed',snapshot=final.name);write(file,meta)
    print(json.dumps({'phase':'dreamed','snapshot':final.name,'generation':meta['generation']}))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','dream']);p.add_argument('--source',type=Path);p.add_argument('--apply',action='store_true');a=p.parse_args()
    if not a.apply:raise SystemExit('dsf-explicit-destructive-apply-required')
    if a.action=='prepare':
        if not a.source:raise SystemExit('dsf-clean-source-required')
        prepare(a.source)
    else:dream()
