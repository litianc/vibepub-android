ALTER TABLE recordings ADD COLUMN workspace_id TEXT;

UPDATE recordings
SET workspace_id = COALESCE(
  (SELECT workspace_id FROM users WHERE users.id = recordings.user_id),
  'vibepub-dogfood'
)
WHERE workspace_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS recordings_scope_identity
  ON recordings(id, user_id, workspace_id);

CREATE TABLE IF NOT EXISTS article_versions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  version_no INTEGER NOT NULL CHECK (version_no > 0),
  parent_version_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('initial', 'revision', 'human_final', 'legacy_snapshot')),
  source_job_id TEXT,
  source_hash TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  cover_json TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  title_candidates_json TEXT NOT NULL,
  selected_title TEXT NOT NULL,
  cover_title_json TEXT NOT NULL,
  claim_ledger_json TEXT NOT NULL,
  visual_plan_json TEXT NOT NULL,
  formatting_skill_id TEXT,
  formatting_skill_version TEXT,
  content_html_hash TEXT,
  html_warnings_json TEXT NOT NULL,
  generation_status TEXT NOT NULL CHECK (generation_status IN ('generated', 'review_pending', 'reviewed', 'frozen')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, workspace_id, article_id, version_no),
  UNIQUE(user_id, workspace_id, article_id, idempotency_key),
  UNIQUE(id, user_id, workspace_id, article_id, recording_id),
  FOREIGN KEY (recording_id, user_id, workspace_id)
    REFERENCES recordings(id, user_id, workspace_id),
  FOREIGN KEY (parent_version_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES article_versions(id, user_id, workspace_id, article_id, recording_id)
);

CREATE INDEX IF NOT EXISTS article_versions_article_order
  ON article_versions(user_id, workspace_id, article_id, version_no);

CREATE TABLE IF NOT EXISTS editorial_reviews (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  input_version_id TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('pass', 'revise', 'block')),
  reviewer_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, workspace_id, article_id, idempotency_key),
  FOREIGN KEY (input_version_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES article_versions(id, user_id, workspace_id, article_id, recording_id)
);

CREATE TABLE IF NOT EXISTS visual_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  version_id TEXT NOT NULL,
  items_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, workspace_id, article_id, idempotency_key),
  UNIQUE(version_id),
  FOREIGN KEY (version_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES article_versions(id, user_id, workspace_id, article_id, recording_id)
);

CREATE TRIGGER IF NOT EXISTS article_versions_append_only_update
BEFORE UPDATE ON article_versions
BEGIN
  SELECT RAISE(ABORT, 'article_versions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS article_versions_append_only_delete
BEFORE DELETE ON article_versions
BEGIN
  SELECT RAISE(ABORT, 'article_versions_append_only');
END;

CREATE TRIGGER IF NOT EXISTS editorial_reviews_append_only_update
BEFORE UPDATE ON editorial_reviews
BEGIN
  SELECT RAISE(ABORT, 'editorial_reviews_append_only');
END;

CREATE TRIGGER IF NOT EXISTS editorial_reviews_append_only_delete
BEFORE DELETE ON editorial_reviews
BEGIN
  SELECT RAISE(ABORT, 'editorial_reviews_append_only');
END;

CREATE TRIGGER IF NOT EXISTS visual_plans_append_only_update
BEFORE UPDATE ON visual_plans
BEGIN
  SELECT RAISE(ABORT, 'visual_plans_append_only');
END;

CREATE TRIGGER IF NOT EXISTS visual_plans_append_only_delete
BEFORE DELETE ON visual_plans
BEGIN
  SELECT RAISE(ABORT, 'visual_plans_append_only');
END;
