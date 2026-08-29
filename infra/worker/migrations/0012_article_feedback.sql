-- Adds append-only user choices for immutable Article Versions.
CREATE TABLE IF NOT EXISTS article_feedback_events (
  server_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  version_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('adopted', 'not_adopted')),
  client_event_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, workspace_id, client_event_id),
  FOREIGN KEY (version_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES article_versions(id, user_id, workspace_id, article_id, recording_id)
);

CREATE INDEX IF NOT EXISTS article_feedback_events_recording_order
  ON article_feedback_events(user_id, workspace_id, recording_id, server_sequence);

CREATE TRIGGER IF NOT EXISTS article_feedback_events_append_only_update
BEFORE UPDATE ON article_feedback_events
BEGIN
  SELECT RAISE(ABORT, 'article_feedback_events_append_only');
END;

CREATE TRIGGER IF NOT EXISTS article_feedback_events_append_only_delete
BEFORE DELETE ON article_feedback_events
BEGIN
  SELECT RAISE(ABORT, 'article_feedback_events_append_only');
END;
