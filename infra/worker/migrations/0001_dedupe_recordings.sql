DELETE FROM recordings
WHERE EXISTS (
    SELECT 1
    FROM recordings AS better
    WHERE better.user_id = recordings.user_id
      AND better.filename = recordings.filename
      AND (
          better.updated_at > recordings.updated_at
          OR (
              better.updated_at = recordings.updated_at
              AND better.id < recordings.id
          )
      )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_recordings_user_filename
ON recordings(user_id, filename);
