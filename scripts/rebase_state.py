"""Stage-only fencing for an explicitly authorized historical-context replacement."""
from pathlib import Path
from contextlib import closing
import sqlite3,time
import hashlib

def clean_transport(staged,live,session,generation):
    """Carry only transport cursors, opaque duplicate hashes and operator controls.

    Never copy chat text, jobs/payloads, outbox bodies, thoughts or old memories.
    """
    staged,live=Path(staged).resolve(),Path(live).resolve()
    if staged==live or staged.is_relative_to(live) or live.is_relative_to(staged):raise ValueError('dsf-rebase-stage-required')
    with closing(sqlite3.connect(staged/'bridge.sqlite',uri=True)) as db:
        db.row_factory=sqlite3.Row;db.execute('ATTACH DATABASE ? AS live',((live/'bridge.sqlite').as_uri()+'?mode=ro',))
        db.execute('CREATE TABLE IF NOT EXISTS inbound_tombstones(digest TEXT PRIMARY KEY)')
        digests=[]
        for r in db.execute('SELECT account,user,message_id FROM live.jobs'):
            digests.append((hashlib.sha256('\0'.join(str(v) for v in r).encode()).hexdigest(),))
        db.executemany('INSERT OR IGNORE INTO inbound_tombstones VALUES(?)',digests)
        if db.execute("SELECT 1 FROM live.sqlite_master WHERE name='inbound_tombstones'").fetchone():db.execute('INSERT OR IGNORE INTO inbound_tombstones SELECT * FROM live.inbound_tombstones')
        for row in db.execute("SELECT key,value FROM live.meta WHERE key LIKE 'cursor:%' OR key LIKE 'poll:%'").fetchall():db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',tuple(row))
        for row in db.execute('SELECT session,kind FROM live.chat_sessions WHERE session!=?',(session,)).fetchall():
            db.execute("INSERT OR IGNORE INTO chat_sessions(session,title,created,archived,cursor,kind) VALUES(?,'[已清除正文] 弃用会话',?,1,-1,?)",(row['session'],int(time.time()*1000),row['kind']))
            db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',('erased-session:'+row['session'],'1'))
        db.execute("UPDATE jobs SET state='discarded',error='operator-clean-generation' WHERE state NOT IN ('done','discarded','rejected')")
        db.execute("UPDATE outbox SET state='cancelled',error='operator-clean-generation' WHERE state!='sent'")
        db.execute("UPDATE pending SET state='stale' WHERE state IN ('pending','answering')")
        db.execute("INSERT OR REPLACE INTO meta VALUES('mnn-generation',?)",(generation,));db.commit()
    with closing(sqlite3.connect(staged/'interaction.sqlite',uri=True)) as db:
        db.execute('ATTACH DATABASE ? AS live',((live/'interaction.sqlite').as_uri()+'?mode=ro',))
        for k,v in db.execute("SELECT k,v FROM live.settings WHERE k IN ('paused','continuous','reasoningEffort','maxTokens','continueDelayMs','channel:qq','channel:qq-groups','channel:internet')").fetchall():db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',(k,v))
        for table in ('contexts','reply_routes','reply_candidates','emissions'):db.execute('DELETE FROM '+table)
        db.execute("UPDATE alarms SET state='cancelled' WHERE state IN ('scheduled','running')");db.commit()
    return {'duplicateHashes':len(digests),'copiedChatBodies':0,'generation':generation}

def fence_transport(*_args,**_kwargs):
    raise ValueError('dsf-rebase-history-copy-disabled')
