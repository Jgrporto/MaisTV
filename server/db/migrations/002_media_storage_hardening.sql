ALTER TABLE media_files ADD COLUMN IF NOT EXISTS original_filename text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS sha256 text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS error_message text;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}';
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE media_files ADD COLUMN IF NOT EXISTS available_at timestamptz;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcription_json jsonb;

CREATE INDEX IF NOT EXISTS media_files_tenant_status_idx
  ON media_files (tenant_id, status, updated_at DESC);
