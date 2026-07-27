-- Wave 1 additive projection only. The v2 editorial ledger remains canonical.
-- This migration intentionally does not rename or remove historical DO classes.
CREATE TABLE IF NOT EXISTS publication_runs (
  run_id TEXT PRIMARY KEY,
  source_run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  source_manifest_hash TEXT NOT NULL,
  source_state TEXT NOT NULL,
  source_state_revision INTEGER NOT NULL DEFAULT 0,
  schema_version TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  agent_versions_json TEXT NOT NULL,
  skill_pins_json TEXT NOT NULL,
  state TEXT NOT NULL,
  run_status TEXT NOT NULL,
  state_revision INTEGER NOT NULL DEFAULT 0 CHECK (state_revision >= 0),
  progress_percent INTEGER NOT NULL CHECK (progress_percent BETWEEN 0 AND 100),
  resume_state TEXT,
  last_successful_state TEXT NOT NULL,
  last_successful_progress_percent INTEGER NOT NULL CHECK (last_successful_progress_percent BETWEEN 0 AND 100),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  next_action TEXT,
  error_code TEXT,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_event_id TEXT NOT NULL,
  last_event_type TEXT NOT NULL,
  last_event_idempotency_key TEXT NOT NULL,
  last_event_payload_hash TEXT NOT NULL,
  last_event_created_at TEXT NOT NULL,
  CHECK (run_id = source_run_id),
  CHECK (state_revision > 0 OR (
    state = 'queued' AND run_status = 'active' AND progress_percent = 0 AND
    resume_state IS NULL AND last_successful_state = 'queued' AND
    last_successful_progress_percent = 0 AND
    last_event_id = run_id || ':event:0' AND
    last_event_type = 'run_queued' AND
    last_event_idempotency_key = run_id || ':event:0' AND
    last_event_payload_hash = payload_hash AND
    last_event_created_at = created_at
  )),
  CHECK (last_successful_state IN ('queued', 'transcribing', 'transcript_ready', 'writing', 'draft_generated', 'reviewing', 'revising', 'reviewed', 'content_frozen', 'visual_planning', 'visual_generating', 'visual_ready', 'formatting', 'visual_qa', 'draft_syncing', 'draft_verifying', 'draft_ready')),
  CHECK (
    (state = 'retrying' AND run_status = 'retrying' AND resume_state = last_successful_state AND resume_state IN ('queued', 'transcribing', 'transcript_ready', 'writing', 'draft_generated', 'reviewing', 'revising', 'reviewed', 'content_frozen', 'visual_planning', 'visual_generating', 'visual_ready', 'formatting', 'visual_qa', 'draft_syncing', 'draft_verifying', 'draft_ready') AND progress_percent = last_successful_progress_percent) OR
    (state = 'needs_action' AND run_status = 'needs_action' AND resume_state IS NULL AND progress_percent = last_successful_progress_percent) OR
    (state = 'failed' AND run_status = 'failed' AND resume_state IS NULL AND progress_percent = last_successful_progress_percent) OR
    (state = 'cancelled' AND run_status = 'cancelled' AND resume_state IS NULL AND progress_percent = last_successful_progress_percent) OR
    (state = 'draft_ready' AND run_status = 'ready' AND resume_state IS NULL AND progress_percent = 100 AND last_successful_state = 'draft_ready' AND last_successful_progress_percent = 100) OR
    (state NOT IN ('retrying', 'needs_action', 'failed', 'cancelled', 'draft_ready') AND run_status = 'active' AND resume_state IS NULL AND last_successful_state = state AND last_successful_progress_percent = progress_percent)
  ),
  UNIQUE(user_id, workspace_id, article_id, idempotency_key),
  UNIQUE(run_id, user_id, workspace_id, recording_id),
  UNIQUE(source_run_id, user_id, workspace_id, article_id, recording_id),
  FOREIGN KEY (source_run_id, user_id, workspace_id, article_id, recording_id)
    REFERENCES editorial_runs(run_id, user_id, workspace_id, article_id, recording_id)
);

CREATE INDEX IF NOT EXISTS publication_runs_recording
  ON publication_runs(user_id, workspace_id, recording_id, state_revision DESC);

DROP TRIGGER IF EXISTS publication_runs_initial_revision;
CREATE TRIGGER publication_runs_initial_revision
BEFORE INSERT ON publication_runs
WHEN NEW.state_revision <> 0
BEGIN SELECT RAISE(ABORT, 'publication_runs_initial_revision_invalid'); END;

CREATE TABLE IF NOT EXISTS publication_current_runs (
  recording_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  current_run_id TEXT NOT NULL,
  current_run_created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (recording_id, user_id, workspace_id),
  FOREIGN KEY (current_run_id, user_id, workspace_id, recording_id)
    REFERENCES publication_runs(run_id, user_id, workspace_id, recording_id)
);

CREATE TABLE IF NOT EXISTS publication_run_events (
  event_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  event_type TEXT NOT NULL,
  state TEXT NOT NULL,
  publication_stage TEXT NOT NULL,
  progress_percent INTEGER NOT NULL CHECK (progress_percent BETWEEN 0 AND 100),
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_action TEXT,
  error_code TEXT,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, revision),
  UNIQUE(run_id, idempotency_key),
  FOREIGN KEY (run_id, user_id, workspace_id, recording_id)
    REFERENCES publication_runs(run_id, user_id, workspace_id, recording_id)
);

CREATE INDEX IF NOT EXISTS publication_run_events_page
  ON publication_run_events(run_id, revision ASC);

CREATE TABLE IF NOT EXISTS publication_run_actions (
  action_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('retry', 'cancel', 'confirm', 'abandon', 'resume')),
  action_contract_version TEXT NOT NULL DEFAULT 'publication-human-action.v1',
  action_origin TEXT NOT NULL CHECK (action_origin IN ('system', 'human')),
  expected_state_revision INTEGER NOT NULL CHECK (expected_state_revision >= 0),
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  intent_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(run_id, idempotency_key),
  UNIQUE(run_id, expected_state_revision, action_origin),
  FOREIGN KEY (run_id, user_id, workspace_id, recording_id)
    REFERENCES publication_runs(run_id, user_id, workspace_id, recording_id)
);

CREATE INDEX IF NOT EXISTS publication_run_actions_scope
  ON publication_run_actions(user_id, workspace_id, run_id, created_at);

DROP TRIGGER IF EXISTS publication_runs_projection_update;
CREATE TRIGGER publication_runs_projection_update
BEFORE UPDATE ON publication_runs
WHEN
  NEW.run_id <> OLD.run_id OR
  NEW.source_run_id <> OLD.source_run_id OR
  NEW.user_id <> OLD.user_id OR
  NEW.workspace_id <> OLD.workspace_id OR
  NEW.article_id <> OLD.article_id OR
  NEW.recording_id <> OLD.recording_id OR
  NEW.source_manifest_hash <> OLD.source_manifest_hash OR
  NEW.source_state <> OLD.source_state OR
  NEW.source_state_revision <> OLD.source_state_revision OR
  NEW.schema_version <> OLD.schema_version OR
  NEW.workflow_version <> OLD.workflow_version OR
  NEW.policy_version <> OLD.policy_version OR
  NEW.agent_versions_json <> OLD.agent_versions_json OR
  NEW.skill_pins_json <> OLD.skill_pins_json OR
  NEW.idempotency_key <> OLD.idempotency_key OR
  NEW.payload_hash <> OLD.payload_hash OR
  NEW.created_at <> OLD.created_at OR
  NEW.last_event_id = OLD.last_event_id OR
  NEW.last_event_idempotency_key = OLD.last_event_idempotency_key OR
  NEW.last_event_payload_hash = OLD.last_event_payload_hash OR
  NEW.last_event_created_at <= OLD.last_event_created_at OR
  NEW.run_status NOT IN ('active', 'retrying', 'needs_action', 'failed', 'cancelled', 'ready') OR
  (OLD.state = 'needs_action' AND
    (OLD.next_action = 'reconcile_external_side_effect' OR OLD.error_code = 'external_side_effect_unknown') AND
    NEW.state IN ('retrying', 'cancelled')) OR
  NEW.state_revision <> OLD.state_revision + 1 OR
  NEW.updated_at <= OLD.updated_at OR
  NEW.last_successful_progress_percent < OLD.last_successful_progress_percent OR
  (NEW.state = 'draft_ready' AND (NEW.run_status <> 'ready' OR NEW.progress_percent <> 100 OR NEW.last_successful_state <> 'draft_ready' OR NEW.last_successful_progress_percent <> 100)) OR
  (NEW.state = 'retrying' AND (NEW.run_status <> 'retrying' OR NEW.resume_state IS NULL OR NEW.progress_percent <> NEW.last_successful_progress_percent)) OR
  (NEW.state = 'needs_action' AND (NEW.run_status <> 'needs_action' OR NEW.progress_percent <> NEW.last_successful_progress_percent)) OR
  (NEW.state = 'failed' AND (NEW.run_status <> 'failed' OR NEW.progress_percent <> NEW.last_successful_progress_percent)) OR
  (NEW.state = 'cancelled' AND (NEW.run_status <> 'cancelled' OR NEW.progress_percent <> NEW.last_successful_progress_percent)) OR
  (NEW.state NOT IN ('retrying', 'needs_action', 'failed', 'cancelled', 'draft_ready') AND
    (NEW.run_status <> 'active' OR NEW.last_successful_state <> NEW.state OR NEW.last_successful_progress_percent <> NEW.progress_percent)) OR
  NOT (
    NEW.state = OLD.state OR
    (OLD.state = 'queued' AND NEW.state IN ('transcribing', 'failed', 'cancelled')) OR
    (OLD.state = 'transcribing' AND NEW.state IN ('transcript_ready', 'failed', 'cancelled')) OR
    (OLD.state = 'transcript_ready' AND NEW.state IN ('writing', 'failed', 'cancelled')) OR
    (OLD.state = 'writing' AND NEW.state IN ('draft_generated', 'failed', 'cancelled')) OR
    (OLD.state = 'draft_generated' AND NEW.state IN ('reviewing', 'failed', 'cancelled')) OR
    (OLD.state = 'reviewing' AND NEW.state IN ('revising', 'reviewed', 'needs_action', 'failed', 'cancelled')) OR
    (OLD.state = 'revising' AND NEW.state IN ('reviewing', 'needs_action', 'failed', 'cancelled')) OR
    (OLD.state = 'reviewed' AND NEW.state IN ('content_frozen', 'failed', 'cancelled')) OR
    (OLD.state = 'content_frozen' AND NEW.state IN ('visual_planning', 'failed', 'cancelled')) OR
    (OLD.state = 'visual_planning' AND NEW.state IN ('visual_generating', 'failed', 'cancelled')) OR
    (OLD.state = 'visual_generating' AND NEW.state IN ('visual_ready', 'needs_action', 'failed', 'cancelled')) OR
    (OLD.state = 'visual_ready' AND NEW.state IN ('formatting', 'failed', 'cancelled')) OR
    (OLD.state = 'formatting' AND NEW.state IN ('visual_qa', 'failed', 'cancelled')) OR
    (OLD.state = 'visual_qa' AND NEW.state IN ('draft_syncing', 'failed', 'cancelled')) OR
    (OLD.state = 'draft_syncing' AND NEW.state IN ('draft_verifying', 'needs_action', 'failed', 'cancelled')) OR
    (OLD.state = 'draft_verifying' AND NEW.state IN ('draft_ready', 'needs_action', 'failed', 'cancelled')) OR
    (OLD.state IN ('failed', 'needs_action') AND NEW.state = 'retrying') OR
    (OLD.state = 'retrying' AND NEW.state = OLD.resume_state) OR
    (OLD.state = 'retrying' AND NEW.state IN ('failed', 'cancelled')) OR
    (NEW.state = 'needs_action' AND OLD.state NOT IN ('draft_ready', 'failed', 'cancelled')) OR
    (NEW.state = 'cancelled' AND OLD.state NOT IN ('draft_ready', 'failed', 'cancelled'))
  )
BEGIN
  SELECT RAISE(ABORT, 'publication_runs_projection_update_invalid');
END;

CREATE TRIGGER IF NOT EXISTS publication_run_events_append_only_update
BEFORE UPDATE ON publication_run_events
BEGIN SELECT RAISE(ABORT, 'publication_run_events_append_only'); END;

CREATE TRIGGER IF NOT EXISTS publication_run_events_append_only_delete
BEFORE DELETE ON publication_run_events
BEGIN SELECT RAISE(ABORT, 'publication_run_events_append_only'); END;

CREATE TRIGGER IF NOT EXISTS publication_run_actions_append_only_update
BEFORE UPDATE ON publication_run_actions
BEGIN SELECT RAISE(ABORT, 'publication_run_actions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS publication_run_actions_append_only_delete
BEFORE DELETE ON publication_run_actions
BEGIN SELECT RAISE(ABORT, 'publication_run_actions_append_only'); END;

CREATE TRIGGER IF NOT EXISTS publication_run_actions_projection_insert
BEFORE INSERT ON publication_run_actions
WHEN NOT EXISTS (
  SELECT 1 FROM publication_runs p
  WHERE p.run_id = NEW.run_id
    AND p.user_id = NEW.user_id
    AND p.workspace_id = NEW.workspace_id
    AND p.recording_id = NEW.recording_id
    AND (
      (NEW.action_origin = 'human' AND NEW.action IN ('confirm', 'abandon', 'resume')
        AND p.state_revision = NEW.expected_state_revision
        AND p.state = 'needs_action'
        AND p.run_status = 'needs_action'
        AND p.next_action = NEW.action) OR
      (NEW.action_origin = 'system' AND NEW.action IN ('retry', 'cancel', 'resume')
        AND p.state_revision = NEW.expected_state_revision + 1
        AND p.last_event_type = 'action_' || NEW.action
        AND p.last_event_idempotency_key = NEW.idempotency_key
        AND p.last_event_payload_hash = NEW.payload_hash)
    )
)
BEGIN SELECT RAISE(ABORT, 'publication_run_action_projection_mismatch'); END;

CREATE TRIGGER IF NOT EXISTS publication_runs_append_only_delete
BEFORE DELETE ON publication_runs
BEGIN SELECT RAISE(ABORT, 'publication_runs_append_only'); END;

CREATE TRIGGER IF NOT EXISTS publication_run_events_projection_insert
BEFORE INSERT ON publication_run_events
WHEN NOT EXISTS (
  SELECT 1 FROM publication_runs p
  WHERE p.run_id = NEW.run_id
    AND p.user_id = NEW.user_id
    AND p.workspace_id = NEW.workspace_id
    AND p.recording_id = NEW.recording_id
    AND p.state_revision = NEW.revision
    AND p.state = NEW.state
    AND p.progress_percent = NEW.progress_percent
    AND p.retry_count = NEW.retry_count
    AND COALESCE(p.next_action, '') = COALESCE(NEW.next_action, '')
    AND COALESCE(p.error_code, '') = COALESCE(NEW.error_code, '')
    AND NEW.event_id = p.last_event_id
    AND NEW.event_type = p.last_event_type
    AND NEW.idempotency_key = p.last_event_idempotency_key
    AND NEW.payload_hash = p.last_event_payload_hash
    AND NEW.created_at = p.last_event_created_at
    AND NEW.publication_stage = CASE
      CASE WHEN p.state IN ('retrying', 'needs_action', 'failed', 'cancelled') THEN p.last_successful_state ELSE p.state END
      WHEN 'queued' THEN 'upload'
      WHEN 'transcribing' THEN 'transcription'
      WHEN 'transcript_ready' THEN 'transcription'
      WHEN 'writing' THEN 'writing'
      WHEN 'draft_generated' THEN 'writing'
      WHEN 'reviewing' THEN 'review'
      WHEN 'revising' THEN 'review'
      WHEN 'reviewed' THEN 'review'
      WHEN 'content_frozen' THEN 'review'
      WHEN 'visual_planning' THEN 'visual'
      WHEN 'visual_generating' THEN 'visual'
      WHEN 'visual_ready' THEN 'visual'
      WHEN 'formatting' THEN 'publishing'
      WHEN 'visual_qa' THEN 'publishing'
      WHEN 'draft_syncing' THEN 'publishing'
      WHEN 'draft_verifying' THEN 'publishing'
      WHEN 'draft_ready' THEN 'ready'
      ELSE ''
    END
)
BEGIN SELECT RAISE(ABORT, 'publication_run_event_projection_mismatch'); END;

CREATE TRIGGER IF NOT EXISTS publication_current_runs_identity_update
BEFORE UPDATE ON publication_current_runs
WHEN NEW.recording_id <> OLD.recording_id OR NEW.user_id <> OLD.user_id OR
  NEW.workspace_id <> OLD.workspace_id OR NEW.updated_at <= OLD.updated_at OR
  NEW.current_run_created_at < OLD.current_run_created_at OR
  (NEW.current_run_created_at = OLD.current_run_created_at AND NEW.current_run_id < OLD.current_run_id)
BEGIN SELECT RAISE(ABORT, 'publication_current_runs_identity_update_invalid'); END;

-- Forward-fix the old D1 producer allowlist without changing historical rows or
-- the v2 migration tag. D1 applies this migration once; fresh/existing
-- compatibility is verified by migration tests. This is not a rerunnable no-op.
DROP TRIGGER IF EXISTS editorial_artifacts_append_only_update;
DROP TRIGGER IF EXISTS editorial_artifacts_append_only_delete;
ALTER TABLE editorial_artifacts RENAME TO editorial_artifacts_wave1_legacy;
CREATE TABLE editorial_artifacts (
  artifact_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  article_id TEXT NOT NULL,
  recording_id INTEGER NOT NULL,
  schema_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  producer_agent_role TEXT NOT NULL CHECK (producer_agent_role IN ('editorial_coordinator', 'writing', 'editorial_review', 'illustration', 'cover', 'visual_production', 'wechat_publishing')),
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
INSERT INTO editorial_artifacts (
  artifact_id, run_id, user_id, workspace_id, article_id, recording_id,
  schema_version, kind, producer_agent_role, producer_agent_version,
  skill_id, skill_version, workflow_version, policy_version,
  input_artifact_ids_json, payload_hash, storage_ref, created_at
)
SELECT artifact_id, run_id, user_id, workspace_id, article_id, recording_id,
  schema_version, kind, producer_agent_role, producer_agent_version,
  skill_id, skill_version, workflow_version, policy_version,
  input_artifact_ids_json, payload_hash, storage_ref, created_at
FROM editorial_artifacts_wave1_legacy;
DROP TABLE editorial_artifacts_wave1_legacy;
CREATE INDEX IF NOT EXISTS editorial_artifacts_run ON editorial_artifacts(run_id, created_at);
CREATE TRIGGER IF NOT EXISTS editorial_artifacts_append_only_update
BEFORE UPDATE ON editorial_artifacts
BEGIN SELECT RAISE(ABORT, 'editorial_artifacts_append_only'); END;
CREATE TRIGGER IF NOT EXISTS editorial_artifacts_append_only_delete
BEFORE DELETE ON editorial_artifacts
BEGIN SELECT RAISE(ABORT, 'editorial_artifacts_append_only'); END;
