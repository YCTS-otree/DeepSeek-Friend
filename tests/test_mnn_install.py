import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from scripts.archive_manager import ArchiveManager,ArchiveError
from scripts.mnn_admin import MnnInstallation
import test_archive_manager as helpers

class InstallationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        (self.root/'package.json').write_text('{"version":"1.12.0"}');(self.root/'config.json').write_text('{"dsh":{"baseUrl":"http://127.0.0.1:9"}}')
        self.c=helpers.FakeController(self.root);self.manager=ArchiveManager(self.c);self.install=MnnInstallation(self.root)
    def test_no_background_activation_before_all_isolated_acceptance(self):
        self.assertFalse(self.install.status()['enabled'])
        with self.assertRaisesRegex(ArchiveError,'acceptance-required'):self.manager.feature('mnn-configure',{'enabled':True})
        self.assertFalse(self.install.marker.exists());self.assertTrue(self.c.commands.empty())
    def test_backup_failure_does_not_install_or_activate(self):
        with patch.object(MnnInstallation,'verify_acceptance',return_value={}),patch.object(MnnInstallation,'verify_code',return_value={}):
            op=self.manager.feature('mnn-configure',{'enabled':True})
        with patch('scripts.dsf.snapshot',side_effect=OSError('synthetic disk failure')),patch.object(MnnInstallation,'configure') as configure:
            self.manager.run(op['archiveOperation']);configure.assert_not_called()
        self.assertEqual(self.manager.operations[op['archiveOperation']]['state'],'failed');self.assertFalse(self.install.marker.exists())
    def test_pause_keeps_the_single_memory_network_and_does_not_fall_back(self):
        self.install.directory.mkdir(parents=True)
        self.install.marker.write_text(json.dumps({'schema':'dsf-mnn-activation/1','enabled':True,'paused':False,'tokenizer':'unused'}))
        result=self.install.configure({'enabled':False},None)
        self.assertTrue(result['enabled']);self.assertTrue(result['paused']);self.assertFalse(result['basicFallback']);self.assertFalse(result['selfAutoCommit'])

    def test_malformed_guardian_config_never_creates_activation(self):
        for guardian in ({'soft':'85'},{'soft':True},{'hard':float('nan')},{'maxAttempts':'3'},{'leaseMs':1},{'resume':.96}):
            with self.subTest(guardian=guardian),self.assertRaisesRegex(ValueError,'mnn-config-invalid'):
                self.install.configure({'guardian':guardian},None)
        self.assertFalse(self.install.marker.exists())

    def test_vendor_manifest_contains_only_portable_source_files(self):
        project=Path(__file__).resolve().parents[1]
        manifest=MnnInstallation(project).verify_code()
        self.assertTrue(manifest['files'])
        for name in manifest['files']:
            self.assertFalse(any(part.startswith('.') or part=='__pycache__' for part in Path(name).parts),name)

    def test_legacy_snapshot_migrates_memories_without_changing_self_or_context_version(self):
        from scripts import dsf
        import sqlite3,zipfile
        from contextlib import closing
        data=self.root/'data';folder=data/'cognitive';folder.mkdir(parents=True)
        with closing(sqlite3.connect(folder/'cognitive.sqlite')) as db:
            db.executescript("CREATE TABLE raw_events(n,id,session,seq,source,text,at,actor); CREATE TABLE memories(id,kind,text,source,evidence,active);")
            db.execute("INSERT INTO raw_events VALUES(1,'raw-1','s','1','user_statement','port=3099',1792800000000,'{}')")
            db.execute("INSERT INTO memories VALUES('m-1','semantic','port=3099','user_statement','[\"raw-1\"]',1)");db.commit()
        self_dir=folder/'self';self_dir.mkdir();(self_dir/'self-state.json').write_text('{"version":"v0.1.0"}')
        source=dsf.snapshot(self.root,data);legacy=source.with_name('legacy.DSF')
        with zipfile.ZipFile(source) as old,zipfile.ZipFile(legacy,'w') as new:
            m=json.loads(old.read('manifest.json'));m['appVersion']='1.9.1';m['components']['cognitive_state']['version']=1;new.writestr('manifest.json',json.dumps(m))
            for name in m['files']:new.writestr(name,old.read(name))
        digest=dsf.digest(legacy);dsf.restore(legacy,self.root,data)
        with closing(sqlite3.connect(folder/'mnn/memory.sqlite')) as db:
            self.assertEqual(db.execute('SELECT count(*) FROM nodes').fetchone()[0],1)
            self.assertEqual(db.execute('SELECT count(*) FROM scopes').fetchone()[0],1)
        self.assertEqual((self_dir/'self-state.json').read_text(),'{"version":"v0.1.0"}');self.assertEqual(dsf.digest(legacy),digest)

if __name__=='__main__':unittest.main()
