-- This migration is intentionally additive and re-runnable.
-- Existing databases may not have recordings.workspace_id; the scope table is the
-- compatibility source for the editorial contract and avoids conditional ALTER TABLE.

CREATE TABLE IF NOT EXISTS editorial_recording_scopes (
  recording_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT 'vibepub-dogfood',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (recording_id, user_id, workspace_id),
  UNIQUE (recording_id, user_id),
  FOREIGN KEY (recording_id) REFERENCES recordings(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT OR IGNORE INTO editorial_recording_scopes (recording_id, user_id, workspace_id)
SELECT recordings.id, recordings.user_id,
       COALESCE(users.workspace_id, 'vibepub-dogfood')
FROM recordings
LEFT JOIN users ON users.id = recordings.user_id;

CREATE INDEX IF NOT EXISTS editorial_recording_scopes_user
  ON editorial_recording_scopes(user_id, workspace_id, recording_id);

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
    REFERENCES editorial_recording_scopes(recording_id, user_id, workspace_id),
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
  producer_role TEXT NOT NULL CHECK (producer_role = 'editorial_review'),
  producer_version TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS editorial_version_states (
  version_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('draft_generated', 'review_pending', 'reviewed', 'revision_pending', 'content_frozen', 'visuals_generating', 'rendering', 'visual_qa', 'draft_sync', 'completed', 'failed')),
  state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(version_id, user_id, workspace_id, article_id, recording_id),
  FOREIGN KEY (version_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES article_versions(id, user_id, workspace_id, article_id, recording_id)
);

CREATE TABLE IF NOT EXISTS editorial_state_transition_requests (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  expected_revision INTEGER NOT NULL,
  result_revision INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(version_id, idempotency_key),
  FOREIGN KEY (version_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES article_versions(id, user_id, workspace_id, article_id, recording_id)
);

CREATE TABLE IF NOT EXISTS editorial_runs (
  run_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  agent_versions_json TEXT NOT NULL,
  skill_pins_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned', 'running', 'completed', 'failed')),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, workspace_id, article_id, idempotency_key),
  UNIQUE(run_id, user_id, workspace_id, article_id, recording_id),
  FOREIGN KEY (recording_id, user_id, workspace_id)
    REFERENCES editorial_recording_scopes(recording_id, user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS editorial_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  producer_agent_role TEXT NOT NULL CHECK (producer_agent_role IN ('editorial_coordinator', 'writing', 'editorial_review', 'illustration', 'cover')),
  producer_agent_version TEXT NOT NULL,
  skill_id TEXT,
  skill_version TEXT,
  workflow_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  input_artifact_ids_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  storage_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, kind, payload_hash),
  FOREIGN KEY (run_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES editorial_runs(run_id, user_id, workspace_id, article_id, recording_id)
);

CREATE INDEX IF NOT EXISTS editorial_runs_scope
  ON editorial_runs(user_id, workspace_id, article_id, created_at);
CREATE INDEX IF NOT EXISTS editorial_artifacts_run
  ON editorial_artifacts(run_id, created_at);

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

CREATE TRIGGER IF NOT EXISTS editorial_runs_append_only_update
BEFORE UPDATE ON editorial_runs
BEGIN
  SELECT RAISE(ABORT, 'editorial_runs_append_only');
END;

CREATE TRIGGER IF NOT EXISTS editorial_runs_append_only_delete
BEFORE DELETE ON editorial_runs
BEGIN
  SELECT RAISE(ABORT, 'editorial_runs_append_only');
END;

CREATE TRIGGER IF NOT EXISTS editorial_artifacts_append_only_update
BEFORE UPDATE ON editorial_artifacts
BEGIN
  SELECT RAISE(ABORT, 'editorial_artifacts_append_only');
END;

CREATE TRIGGER IF NOT EXISTS editorial_artifacts_append_only_delete
BEFORE DELETE ON editorial_artifacts
BEGIN
  SELECT RAISE(ABORT, 'editorial_artifacts_append_only');
END;
