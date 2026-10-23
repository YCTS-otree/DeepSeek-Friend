"""Install the pinned official NapCat Windows application bundle locally; no global QQ changes."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import urllib.request
import zipfile

ROOT=Path(__file__).resolve().parents[1]
VERSION='4.18.41'
SHA256='51fbb10e7bcd56b0c2a6de86c37811e7518330e48a137ac689ab1e4d8627d3f0'
URL=f'https://github.com/NapNeko/NapCatQQ/releases/download/v{VERSION}/NapCat.Shell.Windows.Node.zip'

def install(archive=None,proxy='http://127.0.0.1:10808'):
    base=ROOT/'.runtime/qq-gateway';base.mkdir(parents=True,exist_ok=True)
    target=base/VERSION
    if (base/'installed.json').exists() and target.exists():
        if json.loads((base/'installed.json').read_text(encoding='utf8')).get('sha256')!=SHA256:raise ValueError('qq-install-marker')
        return target
    with tempfile.TemporaryDirectory(prefix='install-',dir=base) as temp:
        temp=Path(temp)
        source=Path(archive) if archive else temp/'bundle.zip'
        if not archive:
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}))
            with opener.open(URL,timeout=30) as response,source.open('wb') as out:shutil.copyfileobj(response,out)
        digest=hashlib.sha256()
        with source.open('rb') as stream:
            for chunk in iter(lambda:stream.read(1048576),b''):digest.update(chunk)
        if digest.hexdigest()!=SHA256:raise ValueError('qq-install-checksum')
        stage=temp/'files'
        with zipfile.ZipFile(source) as z:
            for entry in z.infolist():
                if not (stage/entry.filename).resolve().is_relative_to(stage.resolve()) or '\\' in entry.filename or (entry.external_attr>>16)&0o170000==0o120000:raise ValueError('qq-install-path')
            z.extractall(stage)
        if target.exists():
            # Accept only an existing byte-for-byte copy of the verified official bundle.
            for file in stage.rglob('*'):
                if file.is_file() and (not (target/file.relative_to(stage)).is_file() or file.read_bytes()!=(target/file.relative_to(stage)).read_bytes()):raise ValueError('qq-install-existing-differs')
        else:stage.rename(target)
        (base/'installed.json').write_text(json.dumps({'version':VERSION,'sha256':SHA256,'source':URL},indent=2),encoding='utf8')
    return target

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--archive');parser.add_argument('--proxy',default='http://127.0.0.1:10808');args=parser.parse_args()
    try:print('Installed: '+str(install(args.archive,args.proxy)))
    except Exception as e:print(str(e) if isinstance(e,ValueError) else 'qq-install-failed');raise SystemExit(1)
