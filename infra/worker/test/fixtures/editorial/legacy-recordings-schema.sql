PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  workspace_id TEXT NOT NULL
);

CREATE TABLE recordings (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UPLOADED'
);

INSERT INTO users (id, email, workspace_id)
VALUES ('usr_legacy', 'legacy@example.test', 'ws_legacy');

INSERT INTO recordings (id, user_id, filename, r2_key)
VALUES (7, 'usr_legacy', 'legacy.m4a', 'audio/legacy.m4a');
