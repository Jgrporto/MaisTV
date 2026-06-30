export const QUEUE_NAMES = Object.freeze({
  inbound: 'inbound_messages', outbound: 'outbound_messages', status: 'message_status',
  media: 'media_downloads', automations: 'automations', metrics: 'metrics', notifications: 'notifications',
});
export const DEFAULT_JOB_OPTIONS = Object.freeze({ attempts: 5, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: { count: 1_000 }, removeOnFail: false });
