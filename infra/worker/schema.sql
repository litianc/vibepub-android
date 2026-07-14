DROP TABLE IF EXISTS recordings;

CREATE TABLE recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
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
    consumed_request_id TEXT,
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
    family_id TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    idle_expires_at TEXT,
    previous_refresh_token_hash TEXT,
    previous_generation INTEGER,
    previous_valid_until TEXT,
    previous_request_id_hash TEXT,
    previous_rotation_ciphertext TEXT,
    revocation_reason TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_access_token_hash ON sessions(access_token_hash);
CREATE INDEX idx_sessions_refresh_token_hash ON sessions(refresh_token_hash);
CREATE UNIQUE INDEX idx_sessions_family_generation ON sessions(family_id, generation);
CREATE UNIQUE INDEX idx_sessions_previous_request_id
    ON sessions(family_id, previous_request_id_hash)
    WHERE previous_request_id_hash IS NOT NULL;
CREATE INDEX idx_sessions_idle_expires_at ON sessions(idle_expires_at);

CREATE TRIGGER trg_sessions_revocation_reason_insert
BEFORE INSERT ON sessions
WHEN NEW.revocation_reason IS NOT NULL AND NEW.revocation_reason NOT IN (
    'logout_current', 'logout_all', 'refresh_token_reuse', 'idle_expired',
    'user_disabled', 'password_reset', 'admin_disabled', 'security_event'
)
BEGIN
    SELECT RAISE(ABORT, 'invalid session revocation reason');
END;

CREATE TRIGGER trg_sessions_revocation_reason_update
BEFORE UPDATE OF revocation_reason ON sessions
WHEN NEW.revocation_reason IS NOT NULL AND NEW.revocation_reason NOT IN (
    'logout_current', 'logout_all', 'refresh_token_reuse', 'idle_expired',
    'user_disabled', 'password_reset', 'admin_disabled', 'security_event'
)
BEGIN
    SELECT RAISE(ABORT, 'invalid session revocation reason');
END;

CREATE TRIGGER trg_sessions_revoked_requires_reason_insert
BEFORE INSERT ON sessions
WHEN NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS NULL
BEGIN
    SELECT RAISE(ABORT, 'revoked session requires reason');
END;

CREATE TRIGGER trg_sessions_revoked_requires_reason_update
BEFORE UPDATE OF revoked_at, revocation_reason ON sessions
WHEN NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS NULL
BEGIN
    SELECT RAISE(ABORT, 'revoked session requires reason');
END;

CREATE TABLE session_rotation_history (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    refresh_token_hash TEXT NOT NULL,
    request_id_hash TEXT,
    valid_until TEXT NOT NULL,
    retain_until TEXT NOT NULL,
    rotation_ciphertext TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    UNIQUE (session_id, generation)
);

CREATE UNIQUE INDEX idx_session_rotation_history_token
    ON session_rotation_history(refresh_token_hash);
CREATE UNIQUE INDEX idx_session_rotation_history_family_generation
    ON session_rotation_history(family_id, generation);
CREATE UNIQUE INDEX idx_session_rotation_history_family_request
    ON session_rotation_history(family_id, request_id_hash)
    WHERE request_id_hash IS NOT NULL;
CREATE INDEX idx_session_rotation_history_retain_until
    ON session_rotation_history(retain_until);

CREATE TRIGGER trg_session_rotation_history_identity_insert
BEFORE INSERT ON session_rotation_history
WHEN NOT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = NEW.session_id
      AND NEW.family_id = COALESCE(s.family_id, s.id)
)
BEGIN
    SELECT RAISE(ABORT, 'rotation history session family mismatch');
END;

CREATE TRIGGER trg_session_rotation_history_identity_update
BEFORE UPDATE OF session_id, family_id ON session_rotation_history
WHEN NOT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = NEW.session_id
      AND NEW.family_id = COALESCE(s.family_id, s.id)
)
BEGIN
    SELECT RAISE(ABORT, 'rotation history session family mismatch');
END;

CREATE TABLE session_revocation_audit (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    family_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN (
        'logout_current', 'logout_all', 'refresh_token_reuse', 'idle_expired',
        'user_disabled', 'password_reset', 'admin_disabled', 'security_event'
    )),
    request_id_hash TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES sessions(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_session_revocation_audit_family_id
    ON session_revocation_audit(family_id, created_at);
CREATE INDEX idx_session_revocation_audit_user_id
    ON session_revocation_audit(user_id, created_at);

CREATE TRIGGER trg_session_revocation_audit_identity_insert
BEFORE INSERT ON session_revocation_audit
WHEN NOT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = NEW.session_id
      AND NEW.family_id = COALESCE(s.family_id, s.id)
      AND NEW.user_id = s.user_id
)
BEGIN
    SELECT RAISE(ABORT, 'revocation audit session identity mismatch');
END;

CREATE TRIGGER trg_session_revocation_audit_identity_update
BEFORE UPDATE OF session_id, family_id, user_id ON session_revocation_audit
WHEN NOT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = NEW.session_id
      AND NEW.family_id = COALESCE(s.family_id, s.id)
      AND NEW.user_id = s.user_id
)
BEGIN
    SELECT RAISE(ABORT, 'revocation audit session identity mismatch');
END;

CREATE TRIGGER trg_sessions_child_identity_update
BEFORE UPDATE OF family_id, user_id ON sessions
WHEN EXISTS (
    SELECT 1 FROM session_rotation_history h
    WHERE h.session_id = OLD.id
      AND h.family_id != COALESCE(NEW.family_id, NEW.id)
) OR EXISTS (
    SELECT 1 FROM session_revocation_audit a
    WHERE a.session_id = OLD.id
      AND (
        a.family_id != COALESCE(NEW.family_id, NEW.id)
        OR a.user_id != NEW.user_id
      )
)
BEGIN
    SELECT RAISE(ABORT, 'session identity conflicts with child records');
END;

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
