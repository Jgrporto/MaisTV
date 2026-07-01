CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, provider text NOT NULL,
  phone_number_id text, event_key text NOT NULL, payload_json jsonb NOT NULL, status text NOT NULL DEFAULT 'received',
  attempts integer NOT NULL DEFAULT 0, error_message text, received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (provider, event_key)
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, customer_id text, contact_name text,
  contact_phone text NOT NULL, avatar_url text, status text NOT NULL DEFAULT 'open', priority text NOT NULL DEFAULT 'normal',
  queue_id text, service_id text, assigned_agent_id text, assigned_agent_name text, last_message_id uuid,
  last_message text, last_message_type text, last_message_at timestamptz, unread_count integer NOT NULL DEFAULT 0,
  manual_unread boolean NOT NULL DEFAULT false, is_pinned boolean NOT NULL DEFAULT false, tags_json jsonb NOT NULL DEFAULT '[]',
  labels_json jsonb NOT NULL DEFAULT '[]', source_accounts_json jsonb NOT NULL DEFAULT '[]',
  active_route_selector_json jsonb, default_route_selector_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, contact_phone)
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  provider_message_id text, client_message_id text, direction text NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender_type text NOT NULL, type text NOT NULL DEFAULT 'text', body text, status text NOT NULL DEFAULT 'pending',
  media_id uuid, reply_to_message_id uuid, raw_json jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz, delivered_at timestamptz, read_at timestamptz,
  UNIQUE (tenant_id, client_message_id)
);

CREATE TABLE IF NOT EXISTS message_statuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  provider_message_id text NOT NULL, status text NOT NULL, raw_json jsonb, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_message_id, status)
);

CREATE TABLE IF NOT EXISTS media_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, provider_media_id text,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE, message_id uuid,
  type text NOT NULL, mime_type text, size_bytes bigint, storage_key text, thumbnail_key text,
  status text NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_media_id)
);

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_last_message_id_fkey;
ALTER TABLE conversations ADD CONSTRAINT conversations_last_message_id_fkey FOREIGN KEY (last_message_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_media_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_media_id_fkey FOREIGN KEY (media_id) REFERENCES media_files(id) ON DELETE SET NULL;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_reply_to_message_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_reply_to_message_id_fkey FOREIGN KEY (reply_to_message_id) REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE media_files DROP CONSTRAINT IF EXISTS media_files_message_id_fkey;
ALTER TABLE media_files ADD CONSTRAINT media_files_message_id_fkey FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS messages_provider_id_uq ON messages (tenant_id, provider_message_id) WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_tenant_status_cursor_idx ON conversations (tenant_id, status, last_message_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_tenant_conversation_cursor_idx ON messages (tenant_id, conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS messages_latest_inbound_idx ON messages (tenant_id, conversation_id, created_at DESC, id DESC) WHERE direction = 'inbound';
CREATE INDEX IF NOT EXISTS conversations_tenant_phone_idx ON conversations (tenant_id, contact_phone);
CREATE INDEX IF NOT EXISTS conversations_tenant_agent_status_idx ON conversations (tenant_id, assigned_agent_id, status);
CREATE INDEX IF NOT EXISTS conversations_tenant_queue_status_idx ON conversations (tenant_id, queue_id, status);
CREATE INDEX IF NOT EXISTS webhook_events_status_idx ON webhook_events (status, received_at);
CREATE INDEX IF NOT EXISTS media_files_message_idx ON media_files (tenant_id, message_id);
