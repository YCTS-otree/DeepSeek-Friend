import importlib.util
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('package_release',ROOT/'scripts/package-release.py')
package=importlib.util.module_from_spec(spec);spec.loader.exec_module(package)

class PackagingTests(unittest.TestCase):
    def temporary(self):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);return Path(t.name)

    def test_excluded_paths_are_never_opened_and_symlinks_never_followed(self):
        root=self.temporary()
        for name in ('data/qq-connection.json','.runtime/home/.credentials.yaml','DEEPSEEK_FRIEND.key','data/qq-gateway/login.json','.runtime/qq-gateway/4.18.41/napcat/config/login.json','.runtime/qq-gateway/4.18.41/guild1.db','.research/secret.txt'):
            f=root/name;f.parent.mkdir(parents=True,exist_ok=True);f.touch();self.assertTrue(package.excluded(name))
        (root/'data/history.log').write_text('retain history')
        selected=list(package.files_under(root,'data'))
        self.assertEqual([name for _,name in selected],['data/history.log'])
        try:(root/'data/link').symlink_to(root/'DEEPSEEK_FRIEND.key')
        except OSError:return
        self.assertEqual([name for _,name in package.files_under(root,'data')],['data/history.log'])

    def test_copy_database_preserves_history_but_removes_credentials_including_free_pages(self):
        root=self.temporary();src=root/'bridge.sqlite';dest=root/'export.sqlite'
        db=sqlite3.connect(src)
        db.executescript('CREATE TABLE jobs(id,payload);CREATE TABLE meta(key,value);CREATE TABLE uploads(filekey,aes);CREATE TABLE chat_entries(text);')
        secret='SYNTHETIC_CONTEXT_ONLY_123456'
        db.execute('INSERT INTO jobs VALUES(?,?)',('same-request',json.dumps({'text':'history','context':secret,'image':{'context_token':secret}})))
        db.execute("INSERT INTO meta VALUES('cursor:bot',?)",(secret,));db.execute('INSERT INTO uploads VALUES(?,?)',(secret,secret));db.execute("INSERT INTO chat_entries VALUES('unchanged chat')");db.commit();db.close()
        counts=package.copy_db(src,dest)
        out=sqlite3.connect(dest);self.addCleanup(out.close)
        self.assertEqual(counts['chat_entries'],1);self.assertEqual(out.execute('SELECT text FROM chat_entries').fetchone()[0],'unchanged chat')
        self.assertIsNone(json.loads(out.execute('SELECT payload FROM jobs').fetchone()[0])['context'])
        self.assertEqual(out.execute('SELECT count(*) FROM uploads').fetchone()[0],0)
        self.assertNotIn(secret.encode(),dest.read_bytes())
        original=sqlite3.connect(src);self.addCleanup(original.close);self.assertEqual(json.loads(original.execute('SELECT payload FROM jobs').fetchone()[0])['context'],secret)

    def test_embedded_tokens_urls_and_fts_are_scrubbed_but_regular_text_survives(self):
        root=self.temporary();src=root/'cognitive.sqlite';dest=root/'copy.sqlite';db=sqlite3.connect(src)
        db.executescript('CREATE TABLE raw_events(id,scope,text);CREATE VIRTUAL TABLE raw_fts USING fts5(id UNINDEXED,scope UNINDEXED,text);')
        secret='sk-'+'SYNTHETIC_TEST_VALUE'*3
        db.execute('INSERT INTO raw_events VALUES(?,?,?)',('a','shared','经历 '+secret));db.execute('INSERT INTO raw_fts VALUES(?,?,?)',('a','shared','经历 '+secret));db.commit();db.close()
        package.copy_db(src,dest)
        self.assertNotIn(secret.encode(),dest.read_bytes())
        self.assertNotIn('abc123',package.scrub_text('https://gchat.qpic.cn/x?rkey=abc123&x=1'))
        self.assertEqual(package.scrub({'token':7,'usage':{'output_tokens':123},'text':'正常记忆'})['text'],'正常记忆')

    def test_package_manifest_detects_tampering_and_preserves_history_manifest(self):
        root=self.temporary();stage=root/'stage';stage.mkdir();(stage/'history.log').write_text('same history')
        target=root/'friend.zip';package.make_archive(stage,target,'friend',{'appVersion':'1.8.1','stateCounts':{'chat_entries':2}})
        self.assertEqual(package.verify(target)['stateCounts']['chat_entries'],2)
        with zipfile.ZipFile(target,'a') as z:z.writestr('unlisted.txt','tamper')
        with self.assertRaises(ValueError):package.verify(target)

    def test_zstd_sessions_keep_header_and_all_records_without_exposing_text(self):
        root=self.temporary();plain=root/'session.jsonl';encoded=root/'session.v4.jsonl.zstd';decoded=root/'decoded.jsonl'
        records=[{'version':4,'id':'test-session'},{'type':'user','text':'固定历史'}]
        plain.write_text('\n'.join(json.dumps(r) for r in records)+'\n')
        package.run_codec(ROOT,'encode',plain,encoded);package.run_codec(ROOT,'decode',encoded,decoded)
        self.assertEqual([json.loads(s) for s in decoded.read_text().splitlines()],records)

if __name__=='__main__':unittest.main()
