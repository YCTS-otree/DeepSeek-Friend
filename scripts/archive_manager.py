"""Local-only archive operations and server-timed, one-use restore confirmations."""
import json
import re
import secrets
import time
import zipfile
from pathlib import Path
from scripts import dsf


class ArchiveError(Exception):
    pass


class ArchiveManager:
    def __init__(self, controller, clock=time.monotonic):
        self.c = controller
        self.root = controller.root.resolve()
        self.folder = self.root / 'Archive'
        self.clock = clock
        self.plan = None
        self.operations = {}

    def path(self, name, trash=False):
        if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,160}\.DSF', name):
            raise ArchiveError('dsf-name-invalid')
        folder = self.folder / 'Trash' if trash else self.folder
        p = folder / name
        dsf.check_target(self.root, p)
        if not p.is_file() or p.is_symlink():
            raise ArchiveError('dsf-not-found')
        return p

    def metadata(self, file, verify=False):
        try:
            if verify:
                m = dsf.inspect(file)
            else:
                with zipfile.ZipFile(file) as z:
                    if z.getinfo('manifest.json').file_size > 8 * 1024**2:
                        raise ValueError()
                    m = json.loads(z.read('manifest.json'))
            current = json.loads((self.root / 'package.json').read_text(encoding='utf-8'))['version']
            return {'name': file.name, 'bytes': file.stat().st_size, 'createdAt': m.get('createdAt'),
                    'appVersion': m.get('appVersion'), 'dshVersion': m.get('dshVersion'),
                    'reason': m.get('reason', 'legacy'), 'files': len(m.get('files', {})),
                    'compatible': m.get('appVersion') == current and m.get('dshVersion') == '0.2.0-rc.2',
                    'verified': verify}
        except Exception:
            if verify:
                raise ArchiveError('dsf-verification-failed') from None
            return {'name': file.name, 'bytes': file.stat().st_size, 'invalid': True, 'compatible': False}

    def catalog(self):
        p = self.folder / 'catalog.json'
        dsf.check_target(self.root, p)
        try:
            value = json.loads(p.read_text(encoding='utf-8')) if p.exists() else {}
            if not isinstance(value, dict) or any(not isinstance(k, str) or not isinstance(v, str) for k,v in value.items()):
                raise ValueError()
            return value
        except (ValueError, OSError):
            raise ArchiveError('dsf-catalog-invalid') from None

    def list(self):
        labels = self.catalog()
        latest = next(reversed(self.operations.values()), None) if self.operations else None
        result = {'location': str(self.folder), 'files': [], 'trash': [], 'operation': {k:v for k,v in latest.copy().items() if k != 'args'} if latest else None}
        for key, folder in [('files', self.folder), ('trash', self.folder / 'Trash')]:
            dsf.check_target(self.root, folder)
            if folder.exists():
                for file in sorted(folder.glob('*.DSF'), reverse=True):
                    try:
                        p = self.path(file.name, key == 'trash')
                        result[key].append({**self.metadata(p), 'label': labels.get(file.name, '')})
                    except (ArchiveError, ValueError):
                        continue
        return result

    def _idle(self):
        if self.c.closed or self.c.state['busy']:
            raise ArchiveError('dsf-maintenance-busy')

    def command(self, action, args):
        if not isinstance(action, str) or not isinstance(args, dict) or 'id' in args and not isinstance(args['id'], str):
            raise ArchiveError('dsf-request-invalid')
        with self.c.lock:
            if action == 'list':
                return self.list()
            if action == 'status':
                op = self.operations.get(args.get('id'))
                if not op:
                    raise ArchiveError('dsf-operation-not-found')
                return {k: v for k, v in op.copy().items() if k not in ('args',)}
            self._idle()
            if action == 'create':
                return self.begin('create', {})
            if action == 'inspect':
                return self.metadata(self.path(args.get('name')), True)
            if action == 'label':
                name = self.path(args.get('name')).name
                label = args.get('label')
                if not isinstance(label, str) or len(label) > 160 or any(ord(ch) < 32 for ch in label):
                    raise ArchiveError('dsf-label-invalid')
                catalog = self.catalog(); catalog[name] = label
                temp = self.folder / 'catalog.partial'
                temp.write_text(json.dumps(catalog, ensure_ascii=False), encoding='utf-8')
                temp.replace(self.folder / 'catalog.json')
                return {'saved': True}
            if action in ('trash', 'untrash'):
                source = self.path(args.get('name'), action == 'untrash')
                folder = self.folder / 'Trash' if action == 'trash' else self.folder
                dsf.check_target(self.root, folder); folder.mkdir(exist_ok=True)
                target = folder / source.name; dsf.check_target(self.root, target)
                if target.exists():
                    raise ArchiveError('dsf-already-exists')
                if self.plan and self.plan['name'] == source.name:
                    self.plan = None
                source.rename(target)
                return {'saved': True}
            if action == 'restore-begin':
                file = self.path(args.get('name'))
                meta = self.metadata(file, True)
                if not meta['compatible']:
                    raise ArchiveError('dsf-app-version-mismatch')
                self.plan = {'id': secrets.token_hex(20), 'name': file.name, 'hash': dsf.digest(file),
                             'step': 1, 'nonce': secrets.token_hex(20), 'ready': self.clock() + 3,
                             'expires': self.clock() + 900}
                return self.view_plan()
            if action in ('restore-cancel', 'restore-confirm'):
                p = self.plan
                if not p or args.get('id') != p['id'] or self.clock() > p['expires']:
                    raise ArchiveError('dsf-confirmation-stale')
                if action == 'restore-cancel':
                    self.plan = None
                    return {'cancelled': True}
                if args.get('step') != p['step'] or args.get('nonce') != p['nonce']:
                    raise ArchiveError('dsf-confirmation-stale')
                if self.clock() < p['ready']:
                    raise ArchiveError('dsf-confirmation-too-early')
                if p['step'] < 3:
                    p.update(step=p['step'] + 1, nonce=secrets.token_hex(20), ready=self.clock() + 3)
                    return self.view_plan()
                self.plan = None  # The final confirmation is consumed before any operation starts.
                return self.begin('restore', {'name': p['name'], 'hash': p['hash']})
            raise ArchiveError('dsf-action-invalid')

    def view_plan(self):
        return {k: self.plan[k] for k in ('id', 'name', 'step', 'nonce')} | {'waitMs': 3000}

    def begin(self, kind, args):
        # Caller holds Controller.lock; worker is shared with start/stop commands.
        self._idle()
        op_id = secrets.token_hex(16)
        self.operations[op_id] = {'id': op_id, 'kind': kind, 'state': 'queued', 'progress': '等待维护', 'args': args}
        self.c.state['busy'] = True
        self.c.commands.put(('archive', op_id))
        # Bound completed metadata; never discard an active operation.
        for old in list(self.operations)[:-30]:
            if self.operations[old]['state'] in ('done', 'failed'):
                del self.operations[old]
        return {'archiveOperation': op_id}

    def feature(self, action, args):
        """Return a checkpoint operation only when existing boundaries actually expand."""
        if action not in ('internet-configure', 'qq-configure', 'qq-group-configure'):
            return None
        if action == 'qq-group-configure':
            if args.get('enabled') is not True:
                return None
            groups = self.c._sessions('qq-groups-list', {})
            target = next((g for g in groups['groups'] if g['id'] == args.get('groupId')), None)
            if not groups['connected'] or not target:
                raise ArchiveError('qq-group-not-joined')
            expanded = not target['enabled']
        else:
            status = self.c._sessions('channels-status', {})
            old = status['internet'] if action == 'internet-configure' else status['qq']['settings']
            if action == 'internet-configure' and (not isinstance(args.get('allowedHosts'), list) or not all(isinstance(v, str) for v in args['allowedHosts'])):
                return None  # The underlying config validator supplies the normal validation error.
            expanded = args.get('enabled') is True and (not old['enabled'] or
                       (action == 'internet-configure' and bool(set(args.get('allowedHosts', [])) - set(old['allowedHosts']))) or
                       (action == 'qq-configure' and args.get('url') != old['url']))
        if not expanded:
            return None
        with self.c.lock:
            return self.begin('feature', {'action': action, 'changes': args})

    def run(self, op_id):
        op = self.operations[op_id]
        before = {n: self.c._alive(n) for n in ('bridge', 'dsh')}
        stopped = False
        try:
            op.update(state='running', progress='停止项目 Bridge 与独立 DSH')
            args = op['args']
            if op['kind'] == 'restore':
                file = self.path(args['name'])
                if dsf.digest(file) != args['hash']:
                    raise ArchiveError('dsf-confirmation-target-changed')
                if not self.metadata(file, True)['compatible']:
                    raise ArchiveError('dsf-app-version-mismatch')
            self.c._stop_child('bridge'); self.c._stop_child('dsh'); stopped = True
            data, port = dsf.settings(self.root)
            with dsf.offline(self.root, data, port):
                op['progress'] = '保存并校验当前状态，失败则停止'
                if op['kind'] == 'restore':
                    current = dsf.restore(file, self.root, data, expected_digest=args['hash'])
                    op['result'] = {'restored': file.name, 'beforeArchive': current.name}
                else:
                    current = dsf.snapshot(self.root, data, reason='before-' + args['action'] if op['kind'] == 'feature' else 'manual-web')
                    dsf.inspect(current)
                    op['result'] = {'archive': current.name}
            op['progress'] = '恢复原来运行的项目服务'
            self.resume(before); stopped = False
            if op['kind'] == 'feature':
                op['progress'] = '应用已完成归档的功能设置'
                deadline = self.clock() + 40
                if before['bridge']:
                    while True:
                        try:
                            status = self.c._sessions('channels-status', {}, maintenance=True)
                            if args['action'] != 'qq-group-configure' or status['qq']['state'] == 'connected':
                                break
                        except Exception as ready_error:
                            if str(ready_error) not in ('bridge-not-ready', 'session-result-unknown', 'sessions-not-ready', 'session-not-ready'):
                                raise
                        if self.clock() > deadline:
                            raise ArchiveError('dsf-service-resume-timeout')
                        time.sleep(.2)
                op['result']['value'] = self.c._sessions(args['action'], args['changes'], maintenance=True)
            op.update(state='done', progress='已完成')
            self.c._log('launcher.archive-completed')
        except Exception as e:
            code = str(e)
            op.update(state='failed', error=code if re.fullmatch(r'(?:dsf|qq|dsh|session|launcher)-[a-z0-9-]+', code) else 'dsf-operation-failed', progress='已停止操作')
            self.c._log('launcher.archive-failed', op['error'])
        finally:
            if stopped:
                try:
                    self.resume(before)
                except Exception:
                    op['resumeError'] = 'dsf-service-resume-failed'
            op.pop('args', None)

    def resume(self, before):
        if not self.c.closed and (before['dsh'] or before['bridge']):
            self.c.cancel.clear()
            self.c._start(bridge=before['bridge'], qq=False)
