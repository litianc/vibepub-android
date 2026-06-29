DROP TABLE IF EXISTS recordings;

CREATE TABLE recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'UPLOADED', -- 'UPLOADED', 'TRANSCRIBED', 'FAILED'
    raw_text TEXT,
    article_title TEXT,
    article_content TEXT,
    processing_stage TEXT,
    wechat_url TEXT,
    wechat_draft_id TEXT,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, filename)
);

CREATE INDEX idx_recordings_user_id ON recordings(user_id);
CREATE INDEX idx_recordings_filename ON recordings(filename);
