CREATE OR REPLACE FUNCTION maistv_normalize_phone(input_phone text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  digits text := regexp_replace(COALESCE(input_phone,''), '[^0-9]', '', 'g');
BEGIN
  WHILE digits LIKE '00%' LOOP digits := substring(digits FROM 3); END LOOP;
  IF digits LIKE '0%' AND length(digits) >= 11 THEN digits := substring(digits FROM 2); END IF;
  IF digits LIKE '55%' AND length(digits) IN (12,13) THEN RETURN digits; END IF;
  IF length(digits) IN (10,11) THEN RETURN '55' || digits; END IF;
  IF length(digits) IN (8,9) THEN RETURN '5524' || digits; END IF;
  RETURN NULLIF(digits,'');
END;
$$;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS normalized_phone text NULL,
  ADD COLUMN IF NOT EXISTS last_inbound_route_key text NULL,
  ADD COLUMN IF NOT EXISTS last_inbound_phone_number_id text NULL,
  ADD COLUMN IF NOT EXISTS last_customer_message_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS last_24h_window_expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS standard_label text NULL,
  ADD COLUMN IF NOT EXISTS standard_label_source text NULL,
  ADD COLUMN IF NOT EXISTS standard_label_reason text NULL,
  ADD COLUMN IF NOT EXISTS standard_label_overridden boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS standard_label_updated_at timestamptz NULL;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS route_key text NULL,
  ADD COLUMN IF NOT EXISTS phone_number_id text NULL;

UPDATE messages SET
  route_key=COALESCE(
    route_key,raw_json->>'route_key',raw_json->>'meta_route_key',
    raw_json#>>'{legacy,route_key}',raw_json#>>'{legacy,meta_route_key}',
    raw_json#>>'{legacy,route_selector,routeKey}',raw_json#>>'{legacy,routeSelector,routeKey}'
  ),
  phone_number_id=COALESCE(
    phone_number_id,raw_json->>'phone_number_id',
    raw_json#>>'{legacy,phone_number_id}',raw_json#>>'{legacy,route_selector,phoneNumberId}',
    raw_json#>>'{legacy,routeSelector,phoneNumberId}'
  )
WHERE route_key IS NULL OR phone_number_id IS NULL;

UPDATE conversations
SET normalized_phone=maistv_normalize_phone(contact_phone),
    last_inbound_route_key=COALESCE(last_inbound_route_key,route_key),
    last_inbound_phone_number_id=COALESCE(last_inbound_phone_number_id,phone_number_id)
WHERE normalized_phone IS NULL
   OR last_inbound_route_key IS NULL
   OR last_inbound_phone_number_id IS NULL;

UPDATE conversations c
SET last_customer_message_at=latest.created_at,
    last_24h_window_expires_at=latest.created_at + interval '24 hours'
FROM (
  SELECT DISTINCT ON (tenant_id,conversation_id) tenant_id,conversation_id,created_at
  FROM messages
  WHERE direction='inbound'
  ORDER BY tenant_id,conversation_id,created_at DESC,id DESC
) latest
WHERE c.tenant_id=latest.tenant_id AND c.id=latest.conversation_id
  AND c.last_customer_message_at IS NULL;

CREATE TABLE IF NOT EXISTS conversation_merge_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  normalized_phone text NOT NULL,
  canonical_conversation_id uuid NOT NULL,
  merged_conversation_id uuid NOT NULL,
  merged_conversation_json jsonb NOT NULL,
  merged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id,merged_conversation_id)
);

DO $$
DECLARE
  duplicate_record record;
  canonical_id uuid;
  canonical_session_id uuid;
  duplicate_session_id uuid;
  duplicate_conversation_id uuid;
BEGIN
  FOR duplicate_record IN
    SELECT tenant_id,normalized_phone,array_agg(id ORDER BY updated_at DESC,last_message_at DESC NULLS LAST,id) AS ids
    FROM conversations
    WHERE normalized_phone IS NOT NULL
    GROUP BY tenant_id,normalized_phone
    HAVING count(*)>1
  LOOP
    canonical_id := duplicate_record.ids[1];
    FOR duplicate_conversation_id IN SELECT unnest(duplicate_record.ids[2:array_length(duplicate_record.ids,1)]) LOOP
      INSERT INTO conversation_merge_audit (
        tenant_id,normalized_phone,canonical_conversation_id,merged_conversation_id,merged_conversation_json
      )
      SELECT duplicate_record.tenant_id,duplicate_record.normalized_phone,canonical_id,id,to_jsonb(c)
      FROM conversations c WHERE c.id=duplicate_conversation_id
      ON CONFLICT (tenant_id,merged_conversation_id) DO NOTHING;

      UPDATE conversations canonical SET
        contact_name=COALESCE(NULLIF(canonical.contact_name,''),duplicate.contact_name),
        unread_count=canonical.unread_count+duplicate.unread_count,
        source_accounts_json=canonical.source_accounts_json||duplicate.source_accounts_json,
        created_at=LEAST(canonical.created_at,duplicate.created_at),
        updated_at=GREATEST(canonical.updated_at,duplicate.updated_at)
      FROM conversations duplicate
      WHERE canonical.id=canonical_id AND duplicate.id=duplicate_conversation_id;

      UPDATE messages SET conversation_id=canonical_id WHERE conversation_id=duplicate_conversation_id;
      UPDATE media_files SET conversation_id=canonical_id WHERE conversation_id=duplicate_conversation_id;

      INSERT INTO conversation_reads (tenant_id,conversation_id,user_id,last_read_message_id,last_read_at,created_at,updated_at)
      SELECT tenant_id,canonical_id,user_id,last_read_message_id,last_read_at,created_at,updated_at
      FROM conversation_reads WHERE conversation_id=duplicate_conversation_id
      ON CONFLICT (tenant_id,conversation_id,user_id) DO UPDATE SET
        last_read_message_id=COALESCE(EXCLUDED.last_read_message_id,conversation_reads.last_read_message_id),
        last_read_at=GREATEST(EXCLUDED.last_read_at,conversation_reads.last_read_at),
        updated_at=GREATEST(EXCLUDED.updated_at,conversation_reads.updated_at);
      DELETE FROM conversation_reads WHERE conversation_id=duplicate_conversation_id;

      SELECT id INTO canonical_session_id FROM chatbot_sessions
      WHERE tenant_id=duplicate_record.tenant_id AND conversation_id=canonical_id LIMIT 1;
      SELECT id INTO duplicate_session_id FROM chatbot_sessions
      WHERE tenant_id=duplicate_record.tenant_id AND conversation_id=duplicate_conversation_id LIMIT 1;
      IF duplicate_session_id IS NOT NULL THEN
        IF canonical_session_id IS NULL THEN
          UPDATE chatbot_sessions SET conversation_id=canonical_id WHERE id=duplicate_session_id;
          canonical_session_id := duplicate_session_id;
        ELSE
          UPDATE chatbot_events SET session_id=canonical_session_id WHERE session_id=duplicate_session_id;
          UPDATE chatbot_output_batches SET session_id=canonical_session_id WHERE session_id=duplicate_session_id;
          DELETE FROM chatbot_sessions WHERE id=duplicate_session_id;
        END IF;
      END IF;

      UPDATE chatbot_output_batches SET status='failed',error_message=COALESCE(error_message,'conversation_merged'),updated_at=now()
      WHERE conversation_id=duplicate_conversation_id AND status IN ('pending','processing')
        AND EXISTS (SELECT 1 FROM chatbot_output_batches active WHERE active.conversation_id=canonical_id AND active.status IN ('pending','processing'));
      UPDATE chatbot_output_batches SET conversation_id=canonical_id WHERE conversation_id=duplicate_conversation_id;
      UPDATE chatbot_output_items SET conversation_id=canonical_id WHERE conversation_id=duplicate_conversation_id;
      UPDATE chatbot_events SET conversation_id=canonical_id WHERE conversation_id=duplicate_conversation_id;
      UPDATE conversation_assignment_events SET conversation_id=canonical_id WHERE conversation_id=duplicate_conversation_id;
      DELETE FROM conversations WHERE id=duplicate_conversation_id;
    END LOOP;
  END LOOP;
END;
$$;

WITH latest AS (
  SELECT DISTINCT ON (tenant_id,conversation_id)
    tenant_id,conversation_id,id,body,type,created_at
  FROM messages ORDER BY tenant_id,conversation_id,created_at DESC,id DESC
), latest_inbound AS (
  SELECT DISTINCT ON (tenant_id,conversation_id)
    tenant_id,conversation_id,created_at,route_key,phone_number_id
  FROM messages WHERE direction='inbound'
  ORDER BY tenant_id,conversation_id,created_at DESC,id DESC
)
UPDATE conversations c
SET last_message_id=latest.id,last_message=latest.body,last_message_type=latest.type,last_message_at=latest.created_at,
    last_customer_message_at=latest_inbound.created_at,
    last_24h_window_expires_at=latest_inbound.created_at+interval '24 hours',
    last_inbound_route_key=COALESCE(latest_inbound.route_key,c.last_inbound_route_key),
    last_inbound_phone_number_id=COALESCE(latest_inbound.phone_number_id,c.last_inbound_phone_number_id)
FROM latest LEFT JOIN latest_inbound
  ON latest_inbound.tenant_id=latest.tenant_id AND latest_inbound.conversation_id=latest.conversation_id
WHERE c.tenant_id=latest.tenant_id AND c.id=latest.conversation_id;

CREATE UNIQUE INDEX IF NOT EXISTS conversations_tenant_normalized_phone_uidx
  ON conversations (tenant_id,normalized_phone) WHERE normalized_phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_standard_label_idx
  ON conversations (tenant_id,standard_label,queue_id);
CREATE INDEX IF NOT EXISTS conversations_customer_window_idx
  ON conversations (tenant_id,last_24h_window_expires_at);
CREATE INDEX IF NOT EXISTS conversations_last_customer_message_idx
  ON conversations (tenant_id,last_customer_message_at DESC);
CREATE INDEX IF NOT EXISTS messages_channel_idx
  ON messages (tenant_id,conversation_id,route_key,created_at DESC);

CREATE TABLE IF NOT EXISTS customer_profiles (
  tenant_id text NOT NULL,
  normalized_phone text NOT NULL,
  display_phone text NULL,
  standard_label text NOT NULL DEFAULT 'system-lead',
  standard_label_source text NOT NULL DEFAULT 'automatic',
  standard_label_reason text NULL,
  standard_label_overridden boolean NOT NULL DEFAULT false,
  standard_label_updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_customer_id text NULL,
  trial_id text NULL,
  trial_status text NULL,
  customer_due_date timestamptz NULL,
  customer_created_at timestamptz NULL,
  last_synced_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,normalized_phone)
);

CREATE INDEX IF NOT EXISTS customer_profiles_label_idx
  ON customer_profiles (tenant_id,standard_label,updated_at DESC);

INSERT INTO customer_profiles (
  tenant_id,normalized_phone,display_phone,standard_label,standard_label_source,standard_label_reason,last_synced_at
)
SELECT tenant_id,normalized_phone,contact_phone,'system-lead','automatic','migration_unknown_profile',now()
FROM conversations
WHERE normalized_phone IS NOT NULL
ON CONFLICT (tenant_id,normalized_phone) DO NOTHING;

UPDATE conversations c SET
  standard_label=p.standard_label,standard_label_source=p.standard_label_source,
  standard_label_reason=p.standard_label_reason,standard_label_overridden=p.standard_label_overridden,
  standard_label_updated_at=p.standard_label_updated_at
FROM customer_profiles p
WHERE p.tenant_id=c.tenant_id AND p.normalized_phone=c.normalized_phone AND c.standard_label IS NULL;

CREATE TABLE IF NOT EXISTS queue_label_mappings (
  tenant_id text NOT NULL,
  queue_id text NOT NULL,
  label_key text NOT NULL,
  priority integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,label_key),
  FOREIGN KEY (tenant_id,queue_id) REFERENCES support_queues(tenant_id,id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS queue_label_mappings_queue_idx
  ON queue_label_mappings (tenant_id,queue_id,is_active,priority);

ALTER TABLE support_queues
  ADD COLUMN IF NOT EXISTS description text NULL,
  ADD COLUMN IF NOT EXISTS icon_key text NOT NULL DEFAULT 'headphones',
  ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100;
