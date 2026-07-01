CREATE TABLE IF NOT EXISTS conversation_reads (
  tenant_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  last_read_message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS conversation_reads_user_idx
  ON conversation_reads (tenant_id, user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS conversation_reads_conversation_idx
  ON conversation_reads (tenant_id, conversation_id);
