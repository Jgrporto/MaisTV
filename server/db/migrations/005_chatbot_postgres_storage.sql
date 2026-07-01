CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS chatbot_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  route_key text NULL,
  name text NOT NULL,
  description text NULL,
  status text NOT NULL DEFAULT 'draft',
  is_active boolean NOT NULL DEFAULT false,
  priority integer NOT NULL DEFAULT 100,
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_version_id uuid NULL,
  created_by text NULL,
  updated_by text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_flows_status_check CHECK (status IN ('draft', 'published', 'archived', 'disabled'))
);

CREATE TABLE IF NOT EXISTS chatbot_flow_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  flow_id uuid NOT NULL REFERENCES chatbot_flows(id) ON DELETE CASCADE,
  version integer NOT NULL,
  definition jsonb NOT NULL,
  checksum text NOT NULL,
  notes text NULL,
  created_by text NULL,
  published_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, flow_id, version),
  UNIQUE (tenant_id, flow_id, checksum)
);

ALTER TABLE chatbot_flows
  DROP CONSTRAINT IF EXISTS chatbot_flows_current_version_id_fkey;

ALTER TABLE chatbot_flows
  ADD CONSTRAINT chatbot_flows_current_version_id_fkey
  FOREIGN KEY (current_version_id) REFERENCES chatbot_flow_versions(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS chatbot_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  flow_id uuid NULL REFERENCES chatbot_flows(id) ON DELETE SET NULL,
  flow_version_id uuid NULL REFERENCES chatbot_flow_versions(id) ON DELETE SET NULL,
  current_node_id text NULL,
  status text NOT NULL DEFAULT 'active',
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  paused_reason text NULL,
  paused_by text NULL,
  last_inbound_message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  last_outbound_message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  last_interaction_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, conversation_id),
  CONSTRAINT chatbot_sessions_status_check CHECK (status IN ('active', 'paused', 'handoff', 'closed', 'expired'))
);

CREATE TABLE IF NOT EXISTS chatbot_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  conversation_id uuid NULL REFERENCES conversations(id) ON DELETE SET NULL,
  message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  flow_id uuid NULL REFERENCES chatbot_flows(id) ON DELETE SET NULL,
  flow_version_id uuid NULL REFERENCES chatbot_flow_versions(id) ON DELETE SET NULL,
  session_id uuid NULL REFERENCES chatbot_sessions(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  mode text NOT NULL DEFAULT 'dry-run',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chatbot_events_mode_check CHECK (mode IN ('dry-run', 'live', 'import', 'audit'))
);

CREATE INDEX IF NOT EXISTS chatbot_flows_tenant_route_active_idx
  ON chatbot_flows (tenant_id, route_key, is_active, status, priority);

CREATE INDEX IF NOT EXISTS chatbot_flow_versions_flow_idx
  ON chatbot_flow_versions (tenant_id, flow_id, version DESC);

CREATE INDEX IF NOT EXISTS chatbot_sessions_conversation_idx
  ON chatbot_sessions (tenant_id, conversation_id);

CREATE INDEX IF NOT EXISTS chatbot_events_conversation_idx
  ON chatbot_events (tenant_id, conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chatbot_events_flow_idx
  ON chatbot_events (tenant_id, flow_id, created_at DESC);
