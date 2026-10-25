"""Stage-only fencing for an explicitly authorized historical-context replacement."""
from pathlib import Path
from contextlib import closing
import sqlite3,time

def fence_transport(staged,live,session,archived,cursor):
    staged,live=Path(staged).resolve(),Path(live).resolve()
    if staged==live or staged.is_relative_to(live) or live.is_relative_to(staged):raise ValueError('dsf-rebase-stage-required')
    with closing(sqlite3.connect(staged/'bridge.sqlite',uri=True)) as db:
        db.row_factory=sqlite3.Row;db.execute('ATTACH DATABASE ? AS live',((live/'bridge.sqlite').as_uri()+'?mode=ro',))
        original=db.execute('SELECT * FROM live.chat_sessions WHERE session=?',(session,)).fetchone()
        if not original or not db.execute('SELECT 1 FROM chat_sessions WHERE session=?',(session,)).fetchone():raise ValueError('dsf-rebase-session-missing')
        if db.execute('SELECT 1 FROM chat_sessions WHERE session=?',(archived,)).fetchone():raise ValueError('dsf-rebase-archive-exists')
        db.execute('BEGIN IMMEDIATE')
        db.execute("INSERT INTO chat_sessions(session,title,created,archived,cursor,kind) VALUES(?,?,?,1,?,'conversation')",(archived,'[弃用] 上下文彻底没得修了',int(time.time()*1000),original['cursor']))
        for r in db.execute('SELECT * FROM live.chat_entries WHERE session=? ORDER BY n',(session,)).fetchall():
            db.execute('INSERT INTO chat_entries(id,session,role,actor,text,created,job) VALUES(?,?,?,?,?,?,?)',('archive:'+archived+':'+r['id'],archived,r['role'],r['actor'],r['text'],r['created'],r['job']))
        job_columns=[r[1] for r in db.execute('PRAGMA table_info(jobs)')]
        inserted=0
        for row in db.execute('SELECT * FROM live.jobs').fetchall():
            v=dict(row);v.update(session=archived,state='discarded',error='operator-abandoned-rebase')
            inserted+=db.execute('INSERT OR IGNORE INTO jobs('+','.join(job_columns)+') VALUES('+','.join('?' for _ in job_columns)+')',[v[k] for k in job_columns]).rowcount
        db.execute("UPDATE jobs SET state='discarded',error='operator-abandoned-rebase' WHERE state NOT IN ('done','discarded','rejected')")
        columns=[r[1] for r in db.execute('PRAGMA table_info(outbox)')]
        for row in db.execute('SELECT * FROM live.outbox').fetchall():
            db.execute('INSERT OR REPLACE INTO outbox('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')',[row[k] for k in columns])
        db.execute("UPDATE outbox SET state='cancelled',error='operator-abandoned-rebase' WHERE state!='sent'")
        db.execute("UPDATE pending SET state='stale' WHERE state IN ('pending','answering')")
        for row in db.execute("SELECT key,value FROM live.meta WHERE key LIKE 'cursor:%' OR key LIKE 'poll:%' OR key LIKE 'typing:%'").fetchall():db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',tuple(row))
        for key,value in [('dsh-created:'+session,'1'),('dsh-created:'+archived,'1'),('chat-history-imported','1')]:db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',(key,value))
        db.execute('UPDATE chat_sessions SET cursor=? WHERE session=?',(cursor,session));db.execute('UPDATE conversations SET cursor=? WHERE session=?',(cursor,session))
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise ValueError('dsf-rebase-integrity')
        history=db.execute('SELECT count(*) FROM chat_entries WHERE session=?',(archived,)).fetchone()[0]
    with closing(sqlite3.connect(staged/'interaction.sqlite',uri=True)) as db:
        db.execute('ATTACH DATABASE ? AS live',((live/'interaction.sqlite').as_uri()+'?mode=ro',))
        # Transport/account/operator controls remain current. No abandoned notes,
        # thoughts, goals or memory are imported into the rebuilt active agent.
        for table in ('settings','contacts','address_book'):
            exists=db.execute("SELECT 1 FROM live.sqlite_master WHERE type='table' AND name=?",(table,)).fetchone()
            local=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",(table,)).fetchone()
            if exists and local:db.execute('INSERT OR REPLACE INTO '+table+' SELECT * FROM live.'+table)
        for table in ('contexts','reply_routes','reply_candidates','emissions'):db.execute('DELETE FROM '+table)
        db.execute("UPDATE alarms SET state='cancelled' WHERE state IN ('scheduled','running')")
        db.commit()
    return {'fencedJobs':inserted,'archivedMessages':history,'oldPendingReplayed':False}
