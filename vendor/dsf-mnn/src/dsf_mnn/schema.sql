CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version','1');
INSERT INTO meta VALUES ('index_generation','0');
CREATE TABLE scopes (scope TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE events (
 scope TEXT NOT NULL REFERENCES scopes(scope), id TEXT NOT NULL, seq INTEGER NOT NULL,
 body TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(scope,id), UNIQUE(scope,seq)
);
CREATE TABLE nodes (
 scope TEXT NOT NULL REFERENCES scopes(scope), id TEXT NOT NULL, type TEXT NOT NULL,
 status TEXT NOT NULL, version INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,id)
);
CREATE TABLE node_sources (
 scope TEXT NOT NULL, node_id TEXT NOT NULL, event_id TEXT NOT NULL,
 PRIMARY KEY(scope,node_id,event_id),
 FOREIGN KEY(scope,node_id) REFERENCES nodes(scope,id) ON DELETE CASCADE,
 FOREIGN KEY(scope,event_id) REFERENCES events(scope,id)
);
CREATE TABLE history (
 scope TEXT NOT NULL, node_id TEXT NOT NULL, version INTEGER NOT NULL,
 body TEXT NOT NULL, reason TEXT NOT NULL, evidence TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(scope,node_id,version),
 FOREIGN KEY(scope,node_id) REFERENCES nodes(scope,id) ON DELETE CASCADE
);
CREATE TABLE edges (
 scope TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
 relation_type TEXT NOT NULL, weight REAL NOT NULL, confidence REAL NOT NULL,
 inference INTEGER NOT NULL, status TEXT NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(scope,id),
 FOREIGN KEY(scope,source_id) REFERENCES nodes(scope,id) ON DELETE CASCADE,
 FOREIGN KEY(scope,target_id) REFERENCES nodes(scope,id) ON DELETE CASCADE
);
CREATE INDEX edge_source ON edges(scope,source_id,status);
CREATE INDEX edge_target ON edges(scope,target_id,status);
CREATE TABLE edge_sources (
 scope TEXT NOT NULL, edge_id TEXT NOT NULL, event_id TEXT NOT NULL,
 PRIMARY KEY(scope,edge_id,event_id),
 FOREIGN KEY(scope,edge_id) REFERENCES edges(scope,id) ON DELETE CASCADE,
 FOREIGN KEY(scope,event_id) REFERENCES events(scope,id)
);
CREATE TABLE embeddings (
 scope TEXT NOT NULL, node_id TEXT NOT NULL, space TEXT NOT NULL,
 dimension INTEGER NOT NULL, vector BLOB NOT NULL, content_digest TEXT NOT NULL,
 PRIMARY KEY(scope,node_id,space),
 FOREIGN KEY(scope,node_id) REFERENCES nodes(scope,id) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE lexical USING fts5(scope UNINDEXED, node_id UNINDEXED, tokens, tokenize='unicode61');
CREATE TABLE receipts (
 scope TEXT NOT NULL REFERENCES scopes(scope), id TEXT NOT NULL, kind TEXT NOT NULL,
 digest TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,id)
);
CREATE TABLE watermarks (
 scope TEXT NOT NULL REFERENCES scopes(scope), kind TEXT NOT NULL, seq INTEGER NOT NULL,
 PRIMARY KEY(scope,kind)
);
CREATE TABLE metrics (
 scope TEXT NOT NULL REFERENCES scopes(scope), name TEXT NOT NULL, value REAL NOT NULL,
 PRIMARY KEY(scope,name)
);
