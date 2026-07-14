ALTER TABLE sessions ADD COLUMN family_id TEXT;
ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN last_used_at TEXT;
ALTER TABLE sessions ADD COLUMN idle_expires_at TEXT;
ALTER TABLE sessions ADD COLUMN previous_refresh_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN previous_generation INTEGER;
ALTER TABLE sessions ADD COLUMN previous_valid_until TEXT;
ALTER TABLE sessions ADD COLUMN previous_request_id_hash TEXT;
ALTER TABLE sessions ADD COLUMN previous_rotation_ciphertext TEXT;
ALTER TABLE sessions ADD COLUMN revocation_reason TEXT;
ALTER TABLE password_reset_tokens ADD COLUMN consumed_request_id TEXT;

UPDATE sessions
SET family_id = id,
    last_used_at = COALESCE(updated_at, created_at),
    idle_expires_at = refresh_expires_at
WHERE family_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_family_generation
    ON sessions(family_id, generation);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_previous_request_id
    ON sessions(family_id, previous_request_id_hash)
    WHERE previous_request_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_idle_expires_at
    ON sessions(idle_expires_at);

CREATE TRIGGER IF NOT EXISTS trg_sessions_revocation_reason_insert
BEFORE INSERT ON sessions
WHEN NEW.revocation_reason IS NOT NULL AND NEW.revocation_reason NOT IN (
    'logout_current', 'logout_all', 'refresh_token_reuse', 'idle_expired',
    'user_disabled', 'password_reset', 'admin_disabled', 'security_event'
)
BEGIN
    SELECT RAISE(ABORT, 'invalid session revocation reason');
END;

CREATE TRIGGER IF NOT EXISTS trg_sessions_revocation_reason_update
BEFORE UPDATE OF revocation_reason ON sessions
WHEN NEW.revocation_reason IS NOT NULL AND NEW.revocation_reason NOT IN (
    'logout_current', 'logout_all', 'refresh_token_reuse', 'idle_expired',
    'user_disabled', 'password_reset', 'admin_disabled', 'security_event'
)
BEGIN
    SELECT RAISE(ABORT, 'invalid session revocation reason');
END;

CREATE TRIGGER IF NOT EXISTS trg_sessions_revoked_requires_reason_insert
BEFORE INSERT ON sessions
WHEN NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS NULL
BEGIN
    SELECT RAISE(ABORT, 'revoked session requires reason');
END;

CREATE TRIGGER IF NOT EXISTS trg_sessions_revoked_requires_reason_update
BEFORE UPDATE OF revoked_at, revocation_reason ON sessions
WHEN NEW.revoked_at IS NOT NULL AND NEW.revocation_reason IS NULL
BEGIN
    SELECT RAISE(ABORT, 'revoked session requires reason');
END;

CREATE TABLE IF NOT EXISTS session_rotation_history (
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

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_rotation_history_token
    ON session_rotation_history(refresh_token_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_rotation_history_family_generation
    ON session_rotation_history(family_id, generation);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_rotation_history_family_request
    ON session_rotation_history(family_id, request_id_hash)
    WHERE request_id_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_session_rotation_history_retain_until
    ON session_rotation_history(retain_until);

CREATE TRIGGER IF NOT EXISTS trg_session_rotation_history_identity_insert
BEFORE INSERT ON session_rotation_history
WHEN NOT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = NEW.session_id
      AND NEW.family_id = COALESCE(s.family_id, s.id)
)
BEGIN
    SELECT RAISE(ABORT, 'rotation history session family mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_session_rotation_history_identity_update
BEFORE UPDATE OF session_id, family_id ON session_rotation_history
WHEN NOT EXISTS (
    SELECT 1 FROM sessions s
    WHERE s.id = NEW.session_id
      AND NEW.family_id = COALESCE(s.family_id, s.id)
)
BEGIN
    SELECT RAISE(ABORT, 'rotation history session family mismatch');
END;

CREATE TABLE IF NOT EXISTS session_revocation_audit (
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

CREATE INDEX IF NOT EXISTS idx_session_revocation_audit_family_id
    ON session_revocation_audit(family_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_revocation_audit_user_id
    ON session_revocation_audit(user_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_session_revocation_audit_identity_insert
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

CREATE TRIGGER IF NOT EXISTS trg_session_revocation_audit_identity_update
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

CREATE TRIGGER IF NOT EXISTS trg_sessions_child_identity_update
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
