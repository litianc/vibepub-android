-- Adds traceable, idempotent continue-revision requests and straight-line Article Versions.
CREATE TABLE IF NOT EXISTS article_revision_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  parent_version_id TEXT NOT NULL,
  feedback_id TEXT NOT NULL UNIQUE,
  client_request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  audio_sha256 TEXT NOT NULL,
  audio_key TEXT NOT NULL,
  request_key TEXT NOT NULL,
  transcript_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'processing', 'wechat_pending', 'completed', 'wechat_failed', 'failed'
  )),
  child_version_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, workspace_id, client_request_id),
  UNIQUE(parent_version_id),
  FOREIGN KEY (parent_version_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES article_versions(id, user_id, workspace_id, article_id, recording_id),
  FOREIGN KEY (child_version_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES article_versions(id, user_id, workspace_id, article_id, recording_id)
);

CREATE INDEX IF NOT EXISTS article_revision_requests_recording
  ON article_revision_requests(user_id, workspace_id, recording_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS article_versions_one_child_per_parent
  ON article_versions(parent_version_id)
  WHERE parent_version_id IS NOT NULL;
