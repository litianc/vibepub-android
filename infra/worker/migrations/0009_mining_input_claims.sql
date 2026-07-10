CREATE TABLE IF NOT EXISTS mining_input_claims (
    user_id TEXT NOT NULL,
    target_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('processing', 'completed')),
    claim_id TEXT NOT NULL,
    lease_expires_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, target_key)
);

CREATE INDEX IF NOT EXISTS idx_mining_input_claims_processing_lease
ON mining_input_claims(state, lease_expires_at);
