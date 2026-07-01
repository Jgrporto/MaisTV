import { transcribeAudioMessage } from '../audio-transcription-service.js';
import { findMessageWithMedia } from '../repositories/messages.repository.mjs';
import { updateMessageTranscription } from '../repositories/media.repository.mjs';
import { getObject } from '../storage/storage.service.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { getLogger } from './logger.service.mjs';

const bodyToBuffer = async (body) => {
  if (!body) throw new Error('Storage returned an empty audio body.');
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

export const getChatTranscription = async (tenantId, messageId) => {
  const message = await findMessageWithMedia(tenantId, messageId);
  if (!message) return null;
  return { message, transcription: message.transcription_json || {} };
};

export const startChatTranscription = async ({ tenantId, messageId, force = false }) => {
  const logger = await getLogger();
  const message = await findMessageWithMedia(tenantId, messageId);
  if (!message) throw Object.assign(new Error('Message not found.'), { statusCode: 404 });
  if (message.type !== 'audio' || !message.storage_key || message.media_status !== 'available') {
    throw Object.assign(new Error('Audio media is not available for transcription.'), { statusCode: 409 });
  }

  const now = new Date().toISOString();
  const processing = {
    status: 'processing', text: '', error: '', model: process.env.WHISPER_MODEL || 'tiny',
    language: process.env.WHISPER_LANGUAGE || 'pt', startedAt: now, updatedAt: now,
  };
  await updateMessageTranscription({ tenantId, messageId, transcription: processing });

  setImmediate(() => {
    void transcribeAudioMessage({
      message: {
        ...message,
        transcription: message.transcription_json || null,
        attachments: [{ type: 'audio', mimeType: message.media_mime_type || 'audio/ogg' }],
      },
      force,
      downloadAudioBuffer: async () => {
        const object = await getObject(message.storage_key);
        return { buffer: await bodyToBuffer(object.Body), mimeType: object.ContentType || message.media_mime_type || 'audio/ogg' };
      },
      updateMessageTranscription: async (transcription) => {
        await updateMessageTranscription({ tenantId, messageId, transcription });
      },
    }).then(async (transcription) => {
      await publishRealtimeEvent({
        tenantId,
        conversationId: message.conversation_id,
        queueId: message.queue_id,
        assignedAgentId: message.assigned_agent_id,
        type: 'media_updated',
        data: { conversationId: message.conversation_id, messageId, mediaId: message.media_id, status: 'available', transcription },
      });
      logger.info({ tenantId, messageId }, 'audio transcription completed');
    }).catch(async (error) => {
      await publishRealtimeEvent({
        tenantId,
        conversationId: message.conversation_id,
        queueId: message.queue_id,
        assignedAgentId: message.assigned_agent_id,
        type: 'media_updated',
        data: { conversationId: message.conversation_id, messageId, mediaId: message.media_id, status: 'available', transcriptionFailed: true },
      }).catch(() => {});
      logger.error({ tenantId, messageId, err: error }, 'audio transcription failed');
    });
  });
  return processing;
};
