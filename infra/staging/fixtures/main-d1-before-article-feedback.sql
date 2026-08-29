PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  workspace_id TEXT NOT NULL
);

CREATE TABLE recordings (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL
);

CREATE TABLE editorial_recording_scopes (
  recording_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (recording_id, user_id, workspace_id)
);

CREATE TABLE article_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL,
  parent_version_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  UNIQUE(id, user_id, workspace_id, article_id, recording_id),
  FOREIGN KEY (recording_id, user_id, workspace_id)
    REFERENCES editorial_recording_scopes(recording_id, user_id, workspace_id)
);

INSERT INTO users (id, email, workspace_id)
VALUES ('usr_rehearsal', 'private-person@example.test', 'ws_rehearsal');

INSERT INTO recordings (id, user_id, workspace_id, filename, r2_key)
VALUES (301, 'usr_rehearsal', 'ws_rehearsal', 'private-recording.m4a', 'users/usr_rehearsal/private-recording.m4a');

INSERT INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
VALUES (301, 'usr_rehearsal', 'ws_rehearsal');

INSERT INTO article_versions
  (id, user_id, workspace_id, article_id, recording_id, version_no, parent_version_id, title, body)
VALUES
  ('version_rehearsal_1', 'usr_rehearsal', 'ws_rehearsal', 'article_rehearsal', 301, 1, NULL,
   'Private article title', 'Private article body');
