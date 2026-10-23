import importlib.util
import json
from pathlib import Path
import socket
import sqlite3
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('dsf', Path(__file__).resolve().parents[1] / 'scripts/dsf.py')
dsf = importlib.util.module_from_spec(spec); spec.loader.exec_module(dsf)

class DsfTests(unittest.TestCase):
    def fixture(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        root = Path(temp.name); data = root / 'data'; data.mkdir()
        (root / 'package.json').write_text('{"version":"1.5.0","description":"中文归档"}', encoding='utf-8')
        for name in dsf.PROMPTS:
            p = root / name; p.parent.mkdir(exist_ok=True); p.write_text('SYS initial', encoding='utf8')
        db = sqlite3.connect(data / 'bridge.sqlite'); db.execute('CREATE TABLE chat(text)'); db.execute("INSERT INTO chat VALUES('history')"); db.commit(); db.close()
        (data / 'cognitive/room').mkdir(parents=True); (data / 'cognitive/room/diary.txt').write_text('room')
        (root / '.runtime/home/sessions').mkdir(parents=True); (root / '.runtime/home/sessions/log.zstd').write_bytes(b'native-context')
        # Only paths are created for excluded credentials; contents are never opened by the archive.
        (root / '.runtime/home/.credentials.yaml').touch(); (root / 'DEEPSEEK_FRIEND.key').touch(); (data / 'weixin-credentials.json').touch()
        return root, data

    def test_roundtrip_history_context_room_and_before_restore_archive(self):
        root, data = self.fixture(); archive = dsf.snapshot(root, data); m = dsf.inspect(archive)
        self.assertFalse(m['credentialsIncluded']); self.assertIn('dsh/sessions/log.zstd', m['files']); self.assertFalse(any('credential' in x or x.endswith('.key') for x in m['files']))
        (data / 'cognitive/room/diary.txt').write_text('changed'); db = sqlite3.connect(data / 'bridge.sqlite'); db.execute("UPDATE chat SET text='changed'"); db.commit(); db.close()
        (root / '.runtime/home/storages/session_projcache').mkdir(parents=True); (root / '.runtime/home/storages/session_projcache/future.json').write_text('stale')
        before = dsf.restore(archive, root, data); self.assertTrue(before.exists()); self.assertNotEqual(archive, before)
        with sqlite3.connect(data / 'bridge.sqlite') as db: self.assertEqual(db.execute('SELECT text FROM chat').fetchone()[0], 'history')
        self.assertEqual((data / 'cognitive/room/diary.txt').read_text(), 'room'); self.assertTrue((data / 'weixin-credentials.json').exists())
        self.assertFalse((root / '.runtime/home/storages/session_projcache').exists())

    def test_checksums_paths_duplicates_and_versions(self):
        root, data = self.fixture(); archive = dsf.snapshot(root, data)
        bad = root / 'bad.DSF'
        with zipfile.ZipFile(archive) as src, zipfile.ZipFile(bad, 'w') as dst:
            for n in src.namelist(): dst.writestr(n, b'altered' if n == 'data/cognitive/room/diary.txt' else src.read(n))
        with self.assertRaises(ValueError): dsf.inspect(bad)
        for name in ['data/../outside.txt','data/cognitive/../../x','dsh/.credentials.yaml','data/credentials.json','data/cognitive/room/key.pem','C:/x','data\\cognitive\\x','dsh/llm-deepseek/token.json']:
            self.assertFalse(dsf.allowed(name))
        (root / 'package.json').write_text('{"version":"1.6.0"}')
        with self.assertRaisesRegex(ValueError, 'version-mismatch'): dsf.restore(archive, root, data)

    def test_live_runtime_and_bridge_lock_refuse_backup(self):
        root, data = self.fixture()
        with socket.socket() as server:
            server.bind(('127.0.0.1',0)); server.listen()
            with self.assertRaisesRegex(ValueError,'stop-dsh'):
                with dsf.offline(root,data,server.getsockname()[1]): pass
        lock = sqlite3.connect(data / 'instance-lock.sqlite'); lock.execute('BEGIN EXCLUSIVE')
        try:
            with self.assertRaises(sqlite3.OperationalError):
                with dsf.offline(root,data,1): pass
        finally: lock.close()

if __name__ == '__main__': unittest.main()
