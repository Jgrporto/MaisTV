import { query } from '../db/postgres.mjs';
export const insertWebhookEvent = async ({ tenantId, provider = 'meta', phoneNumberId, eventKey, payload }) => {
  const result = await query(`INSERT INTO webhook_events (tenant_id, provider, phone_number_id, event_key, payload_json)
    VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT (provider,event_key) DO NOTHING RETURNING *`,
  [tenantId, provider, phoneNumberId || null, eventKey, JSON.stringify(payload)]);
  return { event: result.rows[0] || null, duplicate: result.rowCount === 0 };
};
export const markWebhookProcessed = async (id) => query("UPDATE webhook_events SET status='processed', processed_at=now(), attempts=attempts+1, error_message=NULL WHERE id=$1", [id]);
export const markWebhookFailed = async (id, error) => query("UPDATE webhook_events SET status='failed', attempts=attempts+1, error_message=$2 WHERE id=$1", [id, String(error?.message || error).slice(0, 2000)]);
