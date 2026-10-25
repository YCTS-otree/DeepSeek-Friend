import unittest,tempfile,sqlite3
from pathlib import Path
from contextlib import closing
from scripts.rebase_state import fence_transport,clean_transport

def fixture(root,new):
    root.mkdir()
    with closing(sqlite3.connect(root/'bridge.sqlite')) as db:
        db.executescript('''CREATE TABLE chat_sessions(session PRIMARY KEY,title,created,archived,cursor,kind);
        CREATE TABLE chat_entries(n INTEGER PRIMARY KEY,id UNIQUE,session,role,actor,text,created,job);
        CREATE TABLE jobs(id PRIMARY KEY,session,state,error,message_id UNIQUE);
        CREATE TABLE outbox(id PRIMARY KEY,state,error);CREATE TABLE pending(state);
        CREATE TABLE meta(key PRIMARY KEY,value);CREATE TABLE conversations(session,cursor);''')
        db.execute("INSERT INTO chat_sessions VALUES('original','chat',1,0,10,'conversation')")
        db.execute("INSERT INTO chat_entries VALUES(1,'u','original','user','{}','hello',1,'j1')")
        db.execute("INSERT INTO jobs VALUES('j1','original',?,NULL,'m1')",('done' if new else 'waiting',))
        db.execute("INSERT INTO outbox VALUES('o1',?,NULL)",('sent' if new else 'pending',))
        db.execute("INSERT INTO meta VALUES('cursor:account',?)",('current' if new else 'old',))
        if new:
            db.execute("INSERT INTO jobs VALUES('j2','original','done',NULL,'m2')")
            db.execute("INSERT INTO outbox VALUES('o2','unknown','timeout')")
            db.execute("INSERT INTO chat_entries VALUES(2,'a','original','assistant','{}','reply',2,'j2')")
        db.commit()
    with closing(sqlite3.connect(root/'interaction.sqlite')) as db:
        db.executescript('CREATE TABLE settings(k PRIMARY KEY,v);CREATE TABLE contacts(id PRIMARY KEY);CREATE TABLE address_book(id PRIMARY KEY);CREATE TABLE alarms(state);')
        for name in ('contexts','reply_routes','reply_candidates','emissions'):db.execute('CREATE TABLE '+name+'(id)');db.execute('INSERT INTO '+name+' VALUES(1)')
        db.execute("INSERT INTO settings VALUES('paused',?)",('false' if new else 'true',));db.execute("INSERT INTO alarms VALUES('scheduled')");db.commit()

class RebaseTests(unittest.TestCase):
    def test_clean_rebase_carries_no_live_chat_or_job_bodies(self):
        with tempfile.TemporaryDirectory() as folder:
            stage,live=Path(folder)/'stage',Path(folder)/'live';fixture(stage,False);fixture(live,True)
            for p in [stage,live]:
                with closing(sqlite3.connect(p/'bridge.sqlite')) as db:
                    db.execute("ALTER TABLE jobs ADD COLUMN account DEFAULT 'acct'");db.execute("ALTER TABLE jobs ADD COLUMN user DEFAULT 'peer'");db.commit()
            with closing(sqlite3.connect(live/'bridge.sqlite')) as db:db.execute("UPDATE chat_entries SET text='post-MNN secret' WHERE role='assistant'");db.commit()
            result=clean_transport(stage,live,'original','epoch-new');self.assertEqual(result['copiedChatBodies'],0)
            with closing(sqlite3.connect(stage/'bridge.sqlite')) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM jobs WHERE id='j2'").fetchone()[0],0)
                self.assertEqual(db.execute("SELECT count(*) FROM chat_entries WHERE text='post-MNN secret'").fetchone()[0],0)
                self.assertEqual(db.execute('SELECT count(*) FROM inbound_tombstones').fetchone()[0],2)
                self.assertEqual(db.execute("SELECT value FROM meta WHERE key='mnn-generation'").fetchone()[0],'epoch-new')
    def test_history_copy_mode_is_disabled(self):
        with self.assertRaisesRegex(ValueError,'history-copy-disabled'):fence_transport('a','b','c','d',0)
    def test_live_state_cannot_be_used_as_staging(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError,'stage-required'):clean_transport(folder,folder,'a','epoch')
