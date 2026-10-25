"""Operator diagnostics are not autobiographical experiences or recall sources."""
import re,json
PATTERN=re.compile(r'CONTEXT_WINDOW_EXCEEDED|recorded_runtime_error|request_configuration|mnn-[a-z-]+|DSH\s*Agent.{0,8}异常|DSH.{0,8}(?:超限|异常|修复)|(?:MNN|ACR|Cognitive Compaction|Carryover).{0,35}(?:修复|恢复|重建|压缩|checkpoint)|上下文.{0,16}(?:那段|超|满|爆|压缩|修复|重建|上限|整理)|(?:撑爆|超限|修复|重建|压缩).{0,12}上下文|小[“"「]?手术|修的[是什哪].{0,8}(?:块|段)|(?:一百多万|1,000,000|1000000).{0,8}token',re.I)
def internal_diagnostic(text):return bool(PATTERN.search(text or ''))

def purge_diagnostics(memory):
    store,scope=memory.store,memory.scope
    store.db.execute('CREATE TABLE IF NOT EXISTS operator_hidden_sources(id TEXT PRIMARY KEY)')
    events=[json.loads(r[0]) for r in store.db.execute('SELECT body FROM events WHERE scope=?',(scope.key,))]
    hidden=[e['id'] for e in events if internal_diagnostic(e['content']) or e.get('metadata',{}).get('dsh_type') in ('turn/end','request/header')]
    watermarks=store.db.execute('SELECT kind,seq FROM watermarks WHERE scope=?',(scope.key,)).fetchall()
    with store.transaction():
        for identifier in hidden:
            store.db.execute('INSERT OR IGNORE INTO operator_hidden_sources VALUES(?)',(identifier,))
            store.forget_event(scope,identifier)
        affected={n['id'] for n in store.nodes(scope) if internal_diagnostic(json.dumps(n,ensure_ascii=False))}
        changed=True
        while changed:
            changed=False
            for n in store.nodes(scope):
                if n['id'] not in affected and set(n['metadata'].get('memory_refs',[]))&affected:affected.add(n['id']);changed=True
        for identifier in affected:
            store.db.execute('DELETE FROM lexical WHERE scope=? AND node_id=?',(scope.key,identifier));store.db.execute('DELETE FROM nodes WHERE scope=? AND id=?',(scope.key,identifier))
        store.db.execute('DELETE FROM receipts WHERE scope=?',(scope.key,));store.db.execute('DELETE FROM production_runs')
        for kind,seq in watermarks:store.db.execute('INSERT OR REPLACE INTO watermarks VALUES(?,?,?)',(scope.key,kind,seq))
        store._bump_index()
    return {'hiddenSources':len(hidden),'additionalRemovedNodes':len(affected)}
