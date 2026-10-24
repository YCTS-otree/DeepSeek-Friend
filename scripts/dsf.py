"""DSF v2 (reads v1): offline, checksummed, credential-free project state snapshots."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import sys
import uuid
import zipfile
try:
    from scripts import dsf_compat
except ModuleNotFoundError:  # Direct python scripts/dsf.py execution.
    import dsf_compat

ROOT = Path(__file__).resolve().parents[1]
DATA_ITEMS = ('bridge.sqlite', 'interaction.sqlite', 'cognitive', 'testing', 'media')
DSH_ITEMS = ('sessions', 'attachments', 'llm-deepseek')
PROMPTS = ('SYS_Prompt.txt', 'cognitive/CORE.md')

def allowed(name):
    p = PurePosixPath(name)
    if '\\' in name or ':' in name or p.is_absolute() or '..' in p.parts or str(p) != name or len(p.parts) < 2:
        return False
    if any(x.startswith('.') or x.lower().endswith(('.key', '.pem', '-wal', '-shm')) or 'credential' in x.lower() or x.lower() in ('id_rsa', 'id_ed25519') for x in p.parts):
        return False
    if any(x.endswith(('.', ' ')) or any(ord(c) < 32 for c in x) or x.split('.')[0].upper() in ('CON','NUL','PRN','AUX',*[f'COM{i}' for i in range(1,10)],*[f'LPT{i}' for i in range(1,10)]) for x in p.parts):
        return False
    return (p.parts[0] == 'data' and p.parts[1] in DATA_ITEMS or p.parts[0] == 'dsh' and p.parts[1] in DSH_ITEMS
            and (p.parts[0] != 'dsh' or p.parts[1] != 'llm-deepseek' or name == 'dsh/llm-deepseek/files-v3.json') or p.parts[0] == 'prompts' and '/'.join(p.parts[1:]) in PROMPTS)

def settings(root):
    file = Path(os.environ.get('BRIDGE_CONFIG', root / 'config.json'))
    config = json.loads(file.read_text(encoding='utf-8')) if file.exists() else {}
    data = Path(os.environ.get('BRIDGE_DATA_DIR', config.get('dataDir', 'data')))
    if not data.is_absolute():
        data = file.resolve().parent / data
    from urllib.parse import urlsplit
    return data.resolve(), urlsplit(config.get('dsh', {}).get('baseUrl', 'http://127.0.0.1:3088')).port or 3088

@contextmanager
def offline(root, data, port):
    # Hold the same SQLite lock as Bridge for the entire snapshot/restore.
    data.mkdir(parents=True, exist_ok=True)
    lock = sqlite3.connect(data / 'instance-lock.sqlite', timeout=0)
    try:
        lock.execute('BEGIN EXCLUSIVE')
        with socket.socket() as sock:
            sock.settimeout(.4)
            if sock.connect_ex(('127.0.0.1', port)) == 0:
                raise ValueError('dsf-stop-dsh-first')
        yield
    finally:
        lock.close()

def snapshot(root=ROOT, data=None, output=None, reason='manual'):
    root = Path(root).resolve(); data = Path(data).resolve() if data else settings(root)[0]
    folder = root / 'Archive'; folder.mkdir(exist_ok=True)
    check_target(root, folder)
    check_target(root, data)
    if os.name == 'nt' and (root / 'src/security.js').exists():
        subprocess.run(['node', '--input-type=module', '-e', "import {secureDirectory} from './src/security.js'; secureDirectory('Archive');"], cwd=root, check=True, capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        folder.chmod(0o700)
    output = Path(output) if output else folder / (datetime.now().strftime('%Y%m%d-%H%M%S-') + uuid.uuid4().hex[:8] + '.DSF')
    check_target(root, output)
    if output.exists():
        raise ValueError('dsf-already-exists')
    with tempfile.TemporaryDirectory(prefix='dsf-', dir=folder) as temp:
        temp = Path(temp); entries = {}
        sources = [(data / x, 'data/' + x) for x in DATA_ITEMS] + [(root / '.runtime/home' / x, 'dsh/' + x) for x in DSH_ITEMS] + [(root / x, 'prompts/' + x) for x in PROMPTS]
        for source, target in sources:
            check_target(root, source)
            files = sorted(source.rglob('*')) if source.is_dir() else [source]
            for file in files:
                name = target + '/' + file.relative_to(source).as_posix() if source.is_dir() else target
                if source.is_symlink() or file.is_symlink() or not file.is_file() or not allowed(name):
                    continue
                dest = temp / name; dest.parent.mkdir(parents=True, exist_ok=True)
                if file.suffix == '.sqlite':
                    src = sqlite3.connect(file.as_uri() + '?mode=ro', uri=True); dst = sqlite3.connect(dest)
                    try:
                        src.backup(dst)
                    finally:
                        dst.close(); src.close()
                else:
                    shutil.copyfile(file, dest)
                entries[name] = {'bytes': dest.stat().st_size, 'sha256': digest(dest)}
        manifest = {'format': 'DeepSeek:Friend State', 'schemaVersion': 2, 'createdAt': datetime.now(timezone.utc).isoformat(), 'appVersion': json.loads((root / 'package.json').read_text(encoding='utf-8'))['version'], 'dshVersion': dsf_compat.dsh_version(root), 'components': dsf_compat.current_components(root), 'credentialsIncluded': False, 'reason': reason, 'files': entries}
        partial = output.with_suffix('.partial')
        try:
            with zipfile.ZipFile(partial, 'x', zipfile.ZIP_DEFLATED) as archive:
                archive.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
                for name in entries:
                    archive.write(temp / name, name)
            os.replace(partial, output)
        finally:
            partial.unlink(missing_ok=True)
    return output

def digest(file):
    h = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def check_target(root, target):
    if target.resolve() == root or not target.resolve().is_relative_to(root):
        raise ValueError('dsf-target-outside-project')
    for parent in [target, *target.parents]:
        if parent == root: break
        if parent.is_symlink(): raise ValueError('dsf-symlink-target')

def inspect(file):
    with zipfile.ZipFile(file) as z:
        infos = z.infolist()
        if len(infos) > 20000 or sum(i.file_size for i in infos) > 4 * 1024**3 or len({i.filename.casefold() for i in infos}) != len(infos):
            raise ValueError('dsf-limits-or-duplicates')
        if z.getinfo('manifest.json').file_size > 8 * 1024**2:
            raise ValueError('dsf-manifest-limit')
        manifest = json.loads(z.read('manifest.json'))
        if manifest.get('schemaVersion') not in (1, 2) or manifest.get('format') != 'DeepSeek:Friend State' or manifest.get('credentialsIncluded') is not False:
            raise ValueError('dsf-incompatible')
        files = manifest['files']
        if manifest['schemaVersion'] == 2:
            components = manifest.get('components')
            if not isinstance(components, dict) or not components or any(k not in dsf_compat.DEFINITIONS for k in components):
                raise ValueError('dsf-component-inventory')
            for descriptor in components.values():
                if not isinstance(descriptor, dict) or not isinstance(descriptor.get('format'), str) or not isinstance(descriptor.get('version'), (str, int)) or isinstance(descriptor.get('version'), bool):
                    raise ValueError('dsf-component-descriptor')
            if any(dsf_compat.component_for(n) not in components for n in files):
                raise ValueError('dsf-component-inventory')
        if {i.filename for i in infos} != {'manifest.json', *files}:
            raise ValueError('dsf-inventory')
        for name, meta in files.items():
            info = z.getinfo(name)
            if not allowed(name) or (info.external_attr >> 16) & 0o170000 == 0o120000 or info.file_size != meta['bytes']:
                raise ValueError('dsf-path-or-size')
            h = hashlib.sha256()
            with z.open(info) as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    h.update(block)
            if h.hexdigest() != meta['sha256']:
                raise ValueError('dsf-checksum')
        return manifest

def restore_targets(root, data, stage, selected):
    targets = []
    if 'bridge_state' in selected:
        targets += [(data / n, 'data/' + n) for n in ('bridge.sqlite-wal', 'bridge.sqlite-shm', 'interaction.sqlite-wal', 'interaction.sqlite-shm', 'bridge.sqlite', 'interaction.sqlite', 'media')]
    if 'dsh_context' in selected:
        targets += [(root / '.runtime/home' / n, 'dsh/' + n) for n in DSH_ITEMS]
        targets.append((root / '.runtime/home/storages/session_projcache', 'derived/session_projcache'))
    if 'cognitive_state' in selected:
        folder = data / 'cognitive'; check_target(root, folder)
        incoming = stage / 'data/cognitive'
        names = {p.name for base in (folder, incoming) if base.is_dir() for p in base.iterdir() if p.name != 'room'}
        for name in sorted(names):
            archive_name = 'data/cognitive/' + name
            base = archive_name[:-4] if archive_name.endswith(('-wal', '-shm')) else archive_name
            if allowed(base): targets.append((folder / name, archive_name))
    if 'room' in selected: targets.append((data / 'cognitive/room', 'data/cognitive/room'))
    if 'test_state' in selected: targets.append((data / 'testing', 'data/testing'))
    if 'prompts' in selected: targets += [(root / n, 'prompts/' + n) for n in PROMPTS]
    for target, _name in targets: check_target(root, target)
    return targets


def restore(file, root=ROOT, data=None, expected_digest=None, components=None):
    root = Path(root).resolve(); data = Path(data).resolve() if data else settings(root)[0]
    manifest = inspect(file)
    report = dsf_compat.compatibility(manifest, root, components)
    if not report['canRestore']: raise ValueError('dsf-component-migration-required')
    selected = report['selected']
    # Always preserve today's state before replacing any component.
    before = snapshot(root, data, reason='before-restore')
    inspect(before)  # A failed current-state backup must never be followed by replacement.
    if expected_digest is not None and digest(Path(file)) != expected_digest:
        raise ValueError('dsf-confirmation-target-changed')
    with tempfile.TemporaryDirectory(prefix='restore-', dir=root / 'Archive') as temp:
        temp = Path(temp); stage = temp / 'stage'; saved = temp / 'saved'; stage.mkdir(); moved = []; applied = []
        with zipfile.ZipFile(file) as z:
            for name in manifest['files']:
                if dsf_compat.component_for(name) not in selected: continue
                dest = stage / name; dest.parent.mkdir(parents=True, exist_ok=True)
                with z.open(name) as source, dest.open('wb') as destination: shutil.copyfileobj(source, destination)
        dsf_compat.apply_migrations(manifest, root, selected, stage)
        for path in stage.rglob('*'):
            if path.is_symlink() or path.is_file() and (not allowed(path.relative_to(stage).as_posix()) or dsf_compat.component_for(path.relative_to(stage).as_posix()) not in selected):
                raise ValueError('dsf-migration-output-invalid')
        targets = restore_targets(root, data, stage, selected)
        try:
            for target, name in targets:
                if target.is_symlink():
                    raise ValueError('dsf-symlink-target')
                if target.exists():
                    backup = saved / name; backup.parent.mkdir(parents=True, exist_ok=True); shutil.move(str(target), backup); moved.append((backup, target))
                if (stage / name).exists():
                    target.parent.mkdir(parents=True, exist_ok=True); shutil.move(str(stage / name), target); applied.append(target)
        except Exception:
            for target in reversed(applied):
                if target.is_dir(): shutil.rmtree(target)
                else: target.unlink(missing_ok=True)
            for old, target in reversed(moved): shutil.move(str(old), target)
            raise
    return before

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('action', choices=['create','inspect','restore','plan']); parser.add_argument('file', nargs='?'); parser.add_argument('--components', help='Comma-separated component IDs to restore'); parser.add_argument('--confirm-restore', action='store_true'); args = parser.parse_args()
    selected = args.components.split(',') if args.components else None
    if args.action == 'plan':
        print(json.dumps(dsf_compat.compatibility(inspect(args.file), ROOT, selected), ensure_ascii=False)); return
    if args.action == 'inspect':
        m = inspect(args.file); print(json.dumps({k: v for k,v in m.items() if k != 'files'}, ensure_ascii=False)); return
    data, port = settings(ROOT)
    with offline(ROOT, data, port):
        if args.action == 'restore':
            if not args.confirm_restore: raise ValueError('dsf-confirm-restore-required')
            if not sys.stdin.isatty(): raise ValueError('dsf-interactive-confirmation-required')
            plan = dsf_compat.compatibility(inspect(args.file), ROOT, selected)
            if not plan['canRestore']: raise ValueError('dsf-component-migration-required')
            selected = plan['selected']
            pinned_digest = digest(Path(args.file))
            print('恢复组件：' + '、'.join(row['label'] for row in plan['components'] if row['selected']), flush=True)
            for step in (1, 2, 3):
                print('回滚确认 ' + str(step) + '/3：' + str(Path(args.file).name) + '；3 秒后可确认。', flush=True)
                time.sleep(3)
                if input('输入“确认回滚”继续，其他输入取消：').strip() != '确认回滚':
                    raise ValueError('dsf-restore-cancelled')
            print('Before restore: ' + str(restore(args.file, ROOT, data, expected_digest=pinned_digest, components=selected)))
        else: print('Archive: ' + str(snapshot(ROOT, data)))

if __name__ == '__main__':
    try: main()
    except Exception as e:
        print(str(e) if isinstance(e, ValueError) and str(e).startswith('dsf-') else 'dsf-operation-failed'); raise SystemExit(1)
