import json
from contextlib import contextmanager
from pathlib import Path
import queue
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from scripts import dsf
from scripts.archive_manager import ArchiveManager, ArchiveError


@contextmanager
def database(path):
    db=sqlite3.connect(path)
    try:
        with db:
            yield db
    finally:
        db.close()


class FakeController:
    def __init__(self, root):
        self.root = root; self.lock = threading.RLock(); self.commands = queue.Queue()
        self.closed = False; self.state = {'busy': False}; self.cancel = threading.Event()
        self.calls = []; self.owned = {'bridge': False, 'dsh': False}
        self.internet = {'enabled': False, 'allowedHosts': []}

    def _alive(self, name): return self.owned[name]
    def _stop_child(self, name): self.calls.append(('stop', name))
    def _start(self, **args): self.calls.append(('start', args))
    def _log(self, *args): pass
    def _sessions(self, action, args, maintenance=False):
        if action == 'channels-status':
            return {'internet': self.internet, 'qq': {'settings': {'enabled': True, 'url': 'ws://127.0.0.1:3001'}, 'state': 'connected'}}
        if action == 'qq-groups-list':
            return {'connected': True, 'groups': [{'id': '1131809600', 'enabled': False}]}
        self.calls.append(('apply', action, args)); return {'saved': True}


class ArchiveTests(unittest.TestCase):
    def test_idle_recompression_preserves_manifest_restore_and_never_grows_archive(self):
        import os, time, zipfile
        # Use compressible fixture material, never production conversations.
        room=self.data/'cognitive/room';room.mkdir(parents=True);(room/'sample.txt').write_text('repeated sample line\n'*40000)
        archive=dsf.snapshot(self.root,self.data);original=dsf.inspect(archive);size=archive.stat().st_size
        os.utime(archive,(time.time()-90000,time.time()-90000))
        with patch.object(self.m,'idle',return_value=True):self.assertTrue(self.m.compress_one())
        self.assertEqual(dsf.inspect(archive),original);self.assertLessEqual(archive.stat().st_size,size)
        self.assertFalse(list(self.m.folder.glob('*.compressing')))
        dsf.restore(archive,self.root,self.data)
        self.assertEqual((room/'sample.txt').read_text(),'repeated sample line\n'*40000)

    def test_compression_skips_fresh_archives_and_interruption_preserves_original(self):
        import os,time
        original=self.archive.read_bytes()
        with patch.object(self.m,'idle',return_value=True):self.assertFalse(self.m.compress_one())
        os.utime(self.archive,(time.time()-90000,time.time()-90000))
        with patch.object(self.m,'idle',side_effect=[True,False]):
            with self.assertRaises(ArchiveError):self.m.compress_one()
        self.assertEqual(self.archive.read_bytes(),original);self.assertIsNone(self.m.compressing)
        self.assertFalse(list(self.m.folder.glob('*.compressing')))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.data = self.root / 'data'; self.data.mkdir()
        (self.root / 'package.json').write_text('{"version":"1.9.0"}')
        (self.root / 'config.json').write_text('{"dsh":{"baseUrl":"http://127.0.0.1:9"}}')
        with database(self.data / 'bridge.sqlite') as db:
            db.execute('CREATE TABLE sample(value)'); db.execute("INSERT INTO sample VALUES('old')")
        self.c = FakeController(self.root); self.now = 100.0
        self.m = ArchiveManager(self.c, clock=lambda: self.now)
        self.archive = dsf.snapshot(self.root, self.data)

    def begin(self): return self.m.command('restore-begin', {'name': self.archive.name})
    def confirm(self, p): return self.m.command('restore-confirm', {k: p[k] for k in ('id', 'step', 'nonce')})
    def execute_op(self, result):
        self.m.run(result['archiveOperation']); self.c.state['busy'] = False
        return self.m.command('status', {'id': result['archiveOperation']})
    def value(self):
        with database(self.data / 'bridge.sqlite') as db: return db.execute('SELECT value FROM sample').fetchone()[0]

    def test_three_separate_server_delays_nonce_replay_and_current_backup(self):
        p = self.begin()
        for step in (1, 2, 3):
            self.assertEqual(p['step'], step)
            with self.assertRaisesRegex(ArchiveError, 'too-early'): self.confirm(p)
            self.now += 2.999
            with self.assertRaisesRegex(ArchiveError, 'too-early'): self.confirm(p)
            self.now += .002; old = p; p = self.confirm(p)
            with self.assertRaisesRegex(ArchiveError, 'stale|busy'): self.confirm(old)
        with database(self.data / 'bridge.sqlite') as db: db.execute("UPDATE sample SET value='current'")
        status = self.execute_op(p); self.assertEqual(status['state'], 'done'); self.assertEqual(self.value(), 'old')
        saved = self.m.path(status['result']['beforeArchive']); self.assertNotEqual(saved, self.archive)
        self.assertEqual(dsf.inspect(saved)['reason'], 'before-restore')
        import zipfile
        with zipfile.ZipFile(saved) as z:
            dbfile = self.root / 'before.sqlite'; dbfile.write_bytes(z.read('data/bridge.sqlite'))
        with database(dbfile) as db: self.assertEqual(db.execute('SELECT value FROM sample').fetchone()[0], 'current')

    def test_cancellation_target_change_and_version_mismatch(self):
        p = self.begin(); self.m.command('restore-cancel', {'id': p['id']})
        self.now += 10
        with self.assertRaisesRegex(ArchiveError, 'stale'): self.confirm(p)
        p = self.begin()
        for _ in range(3): self.now += 3; p = self.confirm(p)
        with self.archive.open('ab') as f: f.write(b'changed')
        status = self.execute_op(p); self.assertEqual(status['error'], 'dsf-confirmation-target-changed'); self.assertEqual(self.c.calls, [])
        (self.root / 'package.json').write_text('{"version":"2.0.0"}')
        self.assertEqual(self.begin()['step'], 1)  # Same formats remain compatible across application versions.

    def test_snapshot_failure_never_restores_and_resumes_owned_services(self):
        p = self.begin()
        for _ in range(3): self.now += 3; p = self.confirm(p)
        self.c.owned = {'dsh': True, 'bridge': True}
        with patch.object(dsf, 'snapshot', side_effect=OSError('fixture-only')):
            status = self.execute_op(p)
        self.assertEqual(status['state'], 'failed'); self.assertEqual(self.value(), 'old')
        self.assertIn(('start', {'bridge': True, 'qq': False}), self.c.calls)

    def test_restore_selection_is_pinned_through_all_three_confirmations(self):
        p=self.m.command('restore-begin',{'name':self.archive.name,'components':['room']})
        with database(self.data/'bridge.sqlite') as db:db.execute("UPDATE sample SET value='current'")
        for _ in range(3):
            self.now+=3
            p=self.m.command('restore-confirm',{**p,'components':['bridge_state']})
        status=self.execute_op(p)
        self.assertEqual(status['state'],'done');self.assertEqual(status['result']['components'],['room'])
        self.assertEqual(self.value(),'current')

    def test_feature_boundary_checkpoint_is_verified_before_apply(self):
        self.assertIsNone(self.m.feature('internet-configure', {'enabled': False, 'allowedHosts': []}))
        op = self.m.feature('internet-configure', {'enabled': True, 'allowedHosts': ['example.org']})
        self.assertFalse(any(c[0] == 'apply' for c in self.c.calls))
        status = self.execute_op(op); self.assertEqual(status['state'], 'done')
        self.assertEqual(dsf.inspect(self.m.path(status['result']['archive']))['reason'], 'before-internet-configure')
        self.assertEqual(self.c.calls[-1][0], 'apply')
        self.c.internet = {'enabled': True, 'allowedHosts': ['example.org']}
        self.assertIsNone(self.m.feature('internet-configure', {'enabled': True, 'allowedHosts': ['example.org']}))
        self.assertIsNotNone(self.m.feature('internet-configure', {'enabled': True, 'allowedHosts': ['example.org', 'other.org']}))

    def test_failed_feature_checkpoint_cannot_enable_anything(self):
        op = self.m.feature('qq-group-configure', {'enabled': True, 'groupId': '1131809600'})
        with patch.object(dsf, 'snapshot', side_effect=OSError('fixture-only')): status = self.execute_op(op)
        self.assertEqual(status['state'], 'failed'); self.assertFalse(any(c[0] == 'apply' for c in self.c.calls))

    def test_list_labels_and_recoverable_trash_reject_arbitrary_paths(self):
        self.m.command('label', {'name': self.archive.name, 'label': '<说明>测试'})
        self.assertEqual(self.m.list()['files'][0]['label'], '<说明>测试')
        self.m.command('trash', {'name': self.archive.name}); self.assertEqual(len(self.m.list()['files']), 0)
        self.assertEqual(len(self.m.list()['trash']), 1)
        self.m.command('untrash', {'name': self.archive.name}); self.assertEqual(len(self.m.list()['files']), 1)
        for name in ('../x.DSF', 'C:/x.DSF', 'file.key', 'Trash/x.DSF'):
            with self.assertRaises(ArchiveError): self.m.path(name)

    def test_authenticated_http_download_and_confirmation_cannot_skip_server_wait(self):
        import http.client
        from launcher import LocalServer
        self.c.archives = self.m
        server = LocalServer(('127.0.0.1', 0), self.c)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            def request(method, url, data=None, headers=None):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
                try:
                    connection.request(method, url, json.dumps(data) if data is not None else None, headers or {})
                    response = connection.getresponse(); return response.status, response.read(), dict(response.getheaders())
                finally: connection.close()
            _,_,headers = request('GET','/?ticket='+server.ticket)
            auth={'Cookie':headers['Set-Cookie'].split(';')[0],'Origin':server.origin,'X-CSRF-Token':server.csrf,'Content-Type':'application/json'}
            self.assertEqual(request('GET','/api/archive-download?name='+self.archive.name)[0],403)
            self.assertEqual(request('POST','/api/archives',{'action':'list'}, {'Content-Type':'application/json'})[0],403)
            bad={**auth,'Origin':'https://evil.invalid'}
            self.assertEqual(request('POST','/api/archives',{'action':'create'},bad)[0],403)
            status,body,_=request('GET','/api/archive-download?name='+self.archive.name,headers=auth)
            self.assertEqual(status,200); self.assertEqual(body,self.archive.read_bytes())
            self.assertEqual(request('GET','/api/archive-download?name=../package.json',headers=auth)[0],404)
            status,body,_=request('POST','/api/archives',{'action':'restore-begin','args':{'name':self.archive.name}},auth)
            self.assertEqual(status,200); plan=json.loads(body)
            status,body,_=request('POST','/api/archives',{'action':'restore-confirm','args':plan},auth)
            self.assertEqual(status,409);self.assertEqual(json.loads(body)['error'],'dsf-confirmation-too-early')
        finally:server.shutdown();thread.join();server.server_close()

    def test_real_launcher_worker_serializes_archive_and_service_actions(self):
        from launcher import Controller, LauncherError
        import time
        c=Controller(root=self.root); entered=threading.Event(); release=threading.Event(); original=dsf.snapshot
        def snapshot(*args,**kwargs): entered.set(); release.wait(3); return original(*args,**kwargs)
        try:
            with patch.object(dsf,'snapshot',side_effect=snapshot):
                op=c.archives.command('create',{})['archiveOperation'];self.assertTrue(entered.wait(3))
                for action in ('start','stop'):
                    with self.assertRaisesRegex(LauncherError,'maintenance-busy'):c.enqueue(action)
                release.set();deadline=time.monotonic()+4
                while c.archives.operations[op]['state'] not in ('done','failed') and time.monotonic()<deadline:time.sleep(.02)
                self.assertEqual(c.archives.operations[op]['state'],'done')
        finally:release.set();c.close()

    def test_cli_flag_requires_three_delays_and_does_not_accept_noninteractive_restore(self):
        import io
        from contextlib import redirect_stdout
        with patch.object(dsf,'ROOT',self.root),patch('sys.argv',['dsf','restore',str(self.archive),'--confirm-restore']),patch.object(dsf.sys,'stdin') as stdin,patch.object(dsf.time,'sleep') as sleep,patch('builtins.input',return_value='确认回滚') as answer,redirect_stdout(io.StringIO()):
            stdin.isatty.return_value=False
            with self.assertRaisesRegex(ValueError,'interactive-confirmation'):dsf.main()
            self.assertEqual(sleep.call_count,0)
            stdin.isatty.return_value=True;dsf.main()
            self.assertEqual([c.args for c in sleep.call_args_list],[(3,),(3,),(3,)]);self.assertEqual(answer.call_count,3)


if __name__ == '__main__': unittest.main()
