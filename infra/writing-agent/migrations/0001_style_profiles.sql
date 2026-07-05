CREATE TABLE IF NOT EXISTS style_profiles (
    id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private',
    active_version_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    PRIMARY KEY (id, workspace_id)
);

CREATE TABLE IF NOT EXISTS style_profile_versions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    version_label TEXT NOT NULL,
    body TEXT NOT NULL,
    source_count INTEGER NOT NULL DEFAULT 0,
    source_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (profile_id, workspace_id) REFERENCES style_profiles(id, workspace_id)
);

CREATE TABLE IF NOT EXISTS style_source_imports (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_url TEXT,
    title TEXT,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'ready',
    used_in_profile_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS style_distillation_jobs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    profile_id TEXT,
    version_id TEXT,
    status TEXT NOT NULL,
    source_ids_json TEXT NOT NULL DEFAULT '[]',
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_style_profiles_workspace ON style_profiles(workspace_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_style_profile_versions_profile ON style_profile_versions(workspace_id, profile_id, created_at);
CREATE INDEX IF NOT EXISTS idx_style_source_imports_workspace ON style_source_imports(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_style_distillation_jobs_workspace ON style_distillation_jobs(workspace_id, created_at);
