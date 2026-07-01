ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS assigned_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS assignment_status text NOT NULL DEFAULT 'unassigned',
  ADD COLUMN IF NOT EXISTS last_assignment_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS route_key text NULL,
  ADD COLUMN IF NOT EXISTS phone_number_id text NULL,
  ADD COLUMN IF NOT EXISTS last_read_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_read_message_id uuid NULL REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_read_by text NULL;

UPDATE conversations
SET assignment_status=CASE
  WHEN status='closed' THEN 'closed'
  WHEN assigned_agent_id IS NOT NULL AND assigned_agent_id<>'' THEN 'assigned'
  WHEN queue_id IS NOT NULL AND queue_id<>'' THEN 'queued'
  ELSE 'unassigned'
END
WHERE assignment_status='unassigned';

UPDATE conversations
SET route_key=COALESCE(
      NULLIF(active_route_selector_json->>'routeKey',''),
      NULLIF(active_route_selector_json->>'route_key',''),
      NULLIF(default_route_selector_json->>'routeKey',''),
      NULLIF(default_route_selector_json->>'route_key','')
    ),
    phone_number_id=COALESCE(
      NULLIF(active_route_selector_json->>'phoneNumberId',''),
      NULLIF(active_route_selector_json->>'phone_number_id',''),
      NULLIF(default_route_selector_json->>'phoneNumberId',''),
      NULLIF(default_route_selector_json->>'phone_number_id','')
    )
WHERE route_key IS NULL OR phone_number_id IS NULL;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_assignment_status_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_assignment_status_check
  CHECK (assignment_status IN ('unassigned','queued','assigned','closed','transferred'));

CREATE TABLE IF NOT EXISTS support_queues (
  tenant_id text NOT NULL,
  id text NOT NULL,
  name text NOT NULL,
  service_id text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id)
);

CREATE TABLE IF NOT EXISTS queue_route_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  route_key text NOT NULL,
  phone_number_id text NOT NULL DEFAULT '',
  queue_id text NOT NULL,
  service_id text NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,route_key,phone_number_id),
  FOREIGN KEY (tenant_id,queue_id) REFERENCES support_queues(tenant_id,id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS queue_memberships (
  tenant_id text NOT NULL,
  queue_id text NOT NULL,
  user_id text NOT NULL,
  user_name text NULL,
  is_active boolean NOT NULL DEFAULT true,
  is_assignable boolean NOT NULL DEFAULT true,
  last_assigned_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,queue_id,user_id),
  FOREIGN KEY (tenant_id,queue_id) REFERENCES support_queues(tenant_id,id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_presence (
  tenant_id text NOT NULL,
  user_id text NOT NULL,
  user_name text NULL,
  user_email text NULL,
  role text NULL,
  status text NOT NULL DEFAULT 'offline',
  paused_until timestamptz NULL,
  pause_reason text NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,user_id),
  CONSTRAINT agent_presence_status_check CHECK (status IN ('online','paused','offline'))
);

CREATE TABLE IF NOT EXISTS conversation_assignment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  from_queue_id text NULL,
  to_queue_id text NULL,
  from_agent_id text NULL,
  to_agent_id text NULL,
  actor_user_id text NULL,
  reason text NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_assignment_queue_idx
  ON conversations (tenant_id,assignment_status,queue_id,updated_at DESC)
  WHERE assignment_status IN ('queued','unassigned');

CREATE INDEX IF NOT EXISTS conversations_assignment_agent_idx
  ON conversations (tenant_id,assigned_agent_id,assignment_status,last_assignment_at DESC)
  WHERE assigned_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS queue_route_mappings_lookup_idx
  ON queue_route_mappings (tenant_id,route_key,phone_number_id,is_active);

CREATE INDEX IF NOT EXISTS queue_memberships_agent_idx
  ON queue_memberships (tenant_id,user_id,is_active,queue_id);

CREATE INDEX IF NOT EXISTS agent_presence_available_idx
  ON agent_presence (tenant_id,status,paused_until,last_seen_at DESC);

CREATE INDEX IF NOT EXISTS conversation_assignment_events_conversation_idx
  ON conversation_assignment_events (tenant_id,conversation_id,created_at DESC);
