import json
from pathlib import Path
import sqlite3
import unittest
import zipfile
from contextlib import closing
from unittest.mock import patch
import test_dsf as dsf_tests
dsf = dsf_tests.dsf

compat = dsf.dsf_compat


class ComponentTests(unittest.TestCase):
    def fixture(self): return dsf_tests.DsfTests.fixture(self)

    def rewrite(self, file, edit):
        target = file.with_name('changed-' + file.name)
        with zipfile.ZipFile(file) as src, zipfile.ZipFile(target, 'w') as dst:
            manifest = json.loads(src.read('manifest.json')); edit(manifest)
            dst.writestr('manifest.json', json.dumps(manifest))
            for name in src.namelist():
                if name != 'manifest.json': dst.writestr(name, src.read(name))
        return target

    def db_value(self, file):
        with closing(sqlite3.connect(file)) as db: return db.execute('SELECT value FROM memory').fetchone()[0]

    def seed_cognitive(self, data, value='old'):
        file=data/'cognitive/cognitive.sqlite'
        with closing(sqlite3.connect(file)) as db:
            db.execute('CREATE TABLE IF NOT EXISTS memory(value)');db.execute('DELETE FROM memory');db.execute('INSERT INTO memory VALUES(?)',(value,));db.commit()
        return file

    def test_creator_patch_minor_and_major_versions_are_not_data_gates(self):
        root,data=self.fixture();(root/'package.json').write_text('{"version":"1.9.1"}')
        archive=dsf.snapshot(root,data)
        for version in ('1.10.0','1.11.0','2.0.0'):
            (root/'package.json').write_text(json.dumps({'version':version}))
            self.assertTrue(compat.compatibility(dsf.inspect(archive),root)['canRestore'])
        (data/'cognitive/room/diary.txt').write_text('current')
        self.assertTrue(dsf.restore(archive,root,data,components=['room']).exists())
        self.assertEqual((data/'cognitive/room/diary.txt').read_text(),'room')

    def test_dsh_mismatch_does_not_invalidate_room_or_memory(self):
        root,data=self.fixture();memory=self.seed_cognitive(data);archive=dsf.snapshot(root,data)
        (root/'.runtime/node_modules/@deepseek-ai/dsh/package.json').write_text('{"version":"0.3.0"}')
        (root/'.runtime/home/sessions/log.zstd').write_bytes(b'current-native-context')
        self.seed_cognitive(data,'current');(data/'cognitive/room/diary.txt').write_text('current-room')
        manifest=dsf.inspect(archive);report=compat.compatibility(manifest,root)
        rows={r['id']:r for r in report['components']}
        self.assertFalse(rows['dsh_context']['canRestore']);self.assertTrue(rows['room']['canRestore'])
        self.assertEqual(rows['dsh_context']['status'],'migration-required')
        with self.assertRaisesRegex(ValueError,'migration-required'):dsf.restore(archive,root,data)
        dsf.restore(archive,root,data,components=['room'])
        self.assertEqual(self.db_value(memory),'current');self.assertEqual((root/'.runtime/home/sessions/log.zstd').read_bytes(),b'current-native-context')
        dsf.restore(archive,root,data,components=['cognitive_state'])
        self.assertEqual(self.db_value(memory),'old');self.assertEqual((root/'.runtime/home/sessions/log.zstd').read_bytes(),b'current-native-context')

    def test_cognitive_atomic_group_preserves_unselected_room_and_prompt(self):
        root,data=self.fixture();memory=self.seed_cognitive(data);self_dir=data/'cognitive/self';self_dir.mkdir()
        (self_dir/'self-state.json').write_text('{"version":"v0.1.0"}')
        archive=dsf.snapshot(root,data);self.seed_cognitive(data,'current')
        (self_dir/'self-state.json').write_text('{"version":"current"}');(data/'cognitive/room/diary.txt').write_text('current room')
        (root/'SYS_Prompt.txt').write_text('current prompt')
        dsf.restore(archive,root,data,components=['cognitive_state'])
        self.assertEqual(self.db_value(memory),'old');self.assertEqual(json.loads((self_dir/'self-state.json').read_text())['version'],'v0.1.0')
        self.assertEqual((data/'cognitive/room/diary.txt').read_text(),'current room');self.assertEqual((root/'SYS_Prompt.txt').read_text(),'current prompt')

    def test_mapping_and_context_must_be_selected_together(self):
        root,data=self.fixture();archive=dsf.snapshot(root,data)
        for chosen in (['dsh_context'],['bridge_state'],[],['room','room'],['other'],[['room']]):
            with self.assertRaises(ValueError):dsf.restore(archive,root,data,components=chosen)
        self.assertEqual(len(list((root/'Archive').glob('*.DSF'))),1)

    def test_legacy_v1_infers_layout_without_rewriting_original(self):
        root,data=self.fixture();archive=dsf.snapshot(root,data)
        def legacy(m):m.update(schemaVersion=1,appVersion='1.9.1');m.pop('components')
        legacy_file=self.rewrite(archive,legacy);digest=dsf.digest(legacy_file)
        report=compat.compatibility(dsf.inspect(legacy_file),root,['room'])
        room=next(r for r in report['components'] if r['id']=='room')
        self.assertTrue(report['canRestore']);self.assertEqual(room['migrations'],['legacy-v1-component-metadata'])
        dsf.restore(legacy_file,root,data,components=['room']);self.assertEqual(dsf.digest(legacy_file),digest)

    def test_registered_migration_runs_in_stage_and_unsupported_migration_is_explicit(self):
        root,data=self.fixture();archive=dsf.snapshot(root,data);manifest=dsf.inspect(archive)
        target=compat.current_components(root);target['room']={**target['room'],'version':2}
        key=('room','room-files',1,'room-files',2)
        with patch.object(compat,'current_components',return_value=target),patch.dict(compat.MIGRATIONS):
            report=compat.compatibility(manifest,root,['room']);self.assertFalse(report['canRestore'])
            def migrate(stage):(stage/'data/cognitive/room/diary.txt').write_text('migrated-v2')
            compat.register_migration(*key,'room-v1-to-v2',migrate)
            self.assertTrue(compat.compatibility(manifest,root,['room'])['canRestore'])
            dsf.restore(archive,root,data,components=['room'])
            self.assertEqual((data/'cognitive/room/diary.txt').read_text(),'migrated-v2')

    def test_migration_failure_never_modifies_live_components(self):
        root,data=self.fixture();archive=dsf.snapshot(root,data);target=compat.current_components(root);target['room']['version']=2
        (data/'cognitive/room/diary.txt').write_text('current')
        def fail(_stage):raise RuntimeError('fixture failure')
        with patch.object(compat,'current_components',return_value=target),patch.dict(compat.MIGRATIONS):
            compat.register_migration('room','room-files',1,'room-files',2,'failing-migration',fail)
            with self.assertRaisesRegex(ValueError,'migration-failed'):dsf.restore(archive,root,data,components=['room'])
        self.assertEqual((data/'cognitive/room/diary.txt').read_text(),'current')
        self.assertEqual(len(list((root/'Archive').glob('*.DSF'))),2)

    def test_migration_cannot_write_unselected_component(self):
        root,data=self.fixture();archive=dsf.snapshot(root,data);target=compat.current_components(root);target['room']['version']=2
        def outside(stage):(stage/'data/bridge.sqlite').write_bytes(b'must-not-apply')
        with patch.object(compat,'current_components',return_value=target),patch.dict(compat.MIGRATIONS):
            compat.register_migration('room','room-files',1,'room-files',2,'outside-scope',outside)
            with self.assertRaisesRegex(ValueError,'output-invalid'):dsf.restore(archive,root,data,components=['room'])
        with closing(sqlite3.connect(data/'bridge.sqlite')) as db:self.assertEqual(db.execute('SELECT text FROM chat').fetchone()[0],'history')

    def test_new_manifest_requires_ownership_for_all_files(self):
        root,data=self.fixture();archive=dsf.snapshot(root,data)
        changed=self.rewrite(archive,lambda m:m['components'].pop('room'))
        with self.assertRaisesRegex(ValueError,'component-inventory'):dsf.inspect(changed)

    def test_memory_architecture_migration_does_not_require_other_format_bumps(self):
        root,data=self.fixture();memory=self.seed_cognitive(data)
        native=root/'.runtime/home/sessions/log.zstd';original_context=native.read_bytes()
        self_dir=data/'cognitive/self';self_dir.mkdir();(self_dir/'self-state.json').write_text('{"version":"v0.1.0"}')
        archive=dsf.snapshot(root,data);target=compat.current_components(root);target['cognitive_state']['version']=2
        (root/'package.json').write_text('{"version":"9.0.0"}')
        native.write_bytes(b'current context');(data/'cognitive/room/diary.txt').write_text('current room');self.seed_cognitive(data,'current')
        invoked=[]
        def migrate(stage):
            invoked.append('memory-only')
            with closing(sqlite3.connect(stage/'data/cognitive/cognitive.sqlite')) as db:
                db.execute("UPDATE memory SET value='old-migrated'");db.commit()
        with patch.object(compat,'current_components',return_value=target),patch.dict(compat.MIGRATIONS):
            report=compat.compatibility(dsf.inspect(archive),root)
            rows={r['id']:r for r in report['components']}
            self.assertEqual(rows['dsh_context']['status'],'compatible');self.assertEqual(rows['room']['status'],'compatible')
            self.assertFalse(report['canRestore'])
            compat.register_migration('cognitive_state','cognitive-state',1,'cognitive-state',2,'memory-architecture-v2',migrate)
            report=compat.compatibility(dsf.inspect(archive),root)
            self.assertTrue(report['canRestore']);self.assertEqual(next(r for r in report['components'] if r['id']=='cognitive_state')['status'],'migration-planned')
            dsf.restore(archive,root,data)
        self.assertEqual(invoked,['memory-only']);self.assertEqual(self.db_value(memory),'old-migrated')
        self.assertEqual(native.read_bytes(),original_context);self.assertEqual((data/'cognitive/room/diary.txt').read_text(),'room')
        self.assertEqual((self_dir/'self-state.json').read_text(),'{"version":"v0.1.0"}')


if __name__=='__main__':unittest.main()
