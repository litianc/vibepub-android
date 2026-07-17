DROP TABLE IF EXISTS recordings;

CREATE TABLE recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL DEFAULT 'vibepub-dogfood',
    filename TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'UPLOADED', -- 'UPLOADED', 'TRANSCRIBED', 'FAILED'
    duration_ms INTEGER,
    raw_text TEXT,
    article_title TEXT,
    article_content TEXT,
    processing_stage TEXT,
    wechat_url TEXT,
    wechat_draft_id TEXT,
    cover_image_url TEXT,
    source_type TEXT DEFAULT 'RECORDING',
    style_profile_id TEXT,
    style_profile_version TEXT,
    layout_profile_id TEXT,
    layout_profile_version TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, filename)
);

CREATE INDEX idx_recordings_user_id ON recordings(user_id);
CREATE INDEX idx_recordings_filename ON recordings(filename);
CREATE UNIQUE INDEX recordings_scope_identity ON recordings(id, user_id, workspace_id);

CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_iterations INTEGER NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    email_verified_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_workspace_id ON users(workspace_id);

CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    token_hash TEXT NOT NULL UNIQUE,
    invited_by_user_id TEXT,
    expires_at TEXT NOT NULL,
    accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_invitations_email ON invitations(email);
CREATE INDEX idx_invitations_token_hash ON invitations(token_hash);

CREATE TABLE email_verification_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_email_verification_user_id ON email_verification_tokens(user_id);

CREATE TABLE password_reset_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_password_reset_user_id ON password_reset_tokens(user_id);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    access_token_hash TEXT NOT NULL UNIQUE,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    access_expires_at TEXT NOT NULL,
    refresh_expires_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_access_token_hash ON sessions(access_token_hash);
CREATE INDEX idx_sessions_refresh_token_hash ON sessions(refresh_token_hash);

CREATE TABLE publishing_accounts (
    user_id TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'wechat',
    app_id TEXT NOT NULL,
    app_secret_ciphertext TEXT NOT NULL,
    proxy_url TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, type),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE article_versions (
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

CREATE INDEX idx_article_versions_article_order
  ON article_versions(user_id, workspace_id, article_id, version_no);

CREATE TABLE editorial_reviews (
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

CREATE TABLE visual_plans (
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

CREATE TRIGGER article_versions_append_only_update
BEFORE UPDATE ON article_versions
BEGIN
    SELECT RAISE(ABORT, 'article_versions_append_only');
END;

CREATE TRIGGER article_versions_append_only_delete
BEFORE DELETE ON article_versions
BEGIN
    SELECT RAISE(ABORT, 'article_versions_append_only');
END;

CREATE TRIGGER editorial_reviews_append_only_update
BEFORE UPDATE ON editorial_reviews
BEGIN
    SELECT RAISE(ABORT, 'editorial_reviews_append_only');
END;

CREATE TRIGGER editorial_reviews_append_only_delete
BEFORE DELETE ON editorial_reviews
BEGIN
    SELECT RAISE(ABORT, 'editorial_reviews_append_only');
END;

CREATE TRIGGER visual_plans_append_only_update
BEFORE UPDATE ON visual_plans
BEGIN
    SELECT RAISE(ABORT, 'visual_plans_append_only');
END;

CREATE TRIGGER visual_plans_append_only_delete
BEFORE DELETE ON visual_plans
BEGIN
    SELECT RAISE(ABORT, 'visual_plans_append_only');
END;
