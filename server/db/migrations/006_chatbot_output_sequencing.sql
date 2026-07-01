CREATE TABLE IF NOT EXISTS chatbot_output_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  inbound_message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  flow_id uuid NOT NULL REFERENCES chatbot_flows(id) ON DELETE RESTRICT,
  flow_version_id uuid NOT NULL REFERENCES chatbot_flow_versions(id) ON DELETE RESTRICT,
  session_id uuid NULL REFERENCES chatbot_sessions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  current_index integer NOT NULL DEFAULT 0,
  total_outputs integer NOT NULL DEFAULT 0,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_output_batches_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  CONSTRAINT chatbot_output_batches_output_count_check
    CHECK (current_index >= 0 AND total_outputs >= 0 AND current_index <= total_outputs)
);

CREATE TABLE IF NOT EXISTS chatbot_output_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  batch_id uuid NOT NULL REFERENCES chatbot_output_batches(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  output_index integer NOT NULL,
  output_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  queued_at timestamptz NULL,
  sent_at timestamptz NULL,
  failed_at timestamptz NULL,
  error_message text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, batch_id, output_index),
  CONSTRAINT chatbot_output_items_status_check
    CHECK (status IN ('pending', 'queued', 'sent', 'failed')),
  CONSTRAINT chatbot_output_items_index_check CHECK (output_index >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_output_batches_inbound_uidx
  ON chatbot_output_batches (tenant_id, inbound_message_id)
  WHERE inbound_message_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_output_batches_active_conversation_uidx
  ON chatbot_output_batches (tenant_id, conversation_id)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS chatbot_output_batches_conversation_idx
  ON chatbot_output_batches (tenant_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chatbot_output_items_batch_idx
  ON chatbot_output_items (tenant_id, batch_id, output_index);

CREATE UNIQUE INDEX IF NOT EXISTS chatbot_output_items_message_uidx
  ON chatbot_output_items (tenant_id, message_id)
  WHERE message_id IS NOT NULL;
