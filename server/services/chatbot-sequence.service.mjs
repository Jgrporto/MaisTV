import crypto from 'node:crypto';

import { withTransaction } from '../db/postgres.mjs';
import { insertPendingOutbound } from '../repositories/messages.repository.mjs';
import { updateConversationLastOutbound } from '../repositories/conversations.repository.mjs';
import { recordChatbotEvent } from '../repositories/chatbot-flow.repository.mjs';
import { addJob } from '../queues/queues.mjs';
import { publishRealtimeEvent } from '../realtime/pubsub.mjs';
import { getLogger } from './logger.service.mjs';

const errorText = (error) => String(error?.message || error || 'Chatbot output failed.').slice(0, 2000);

const chatbotMetadata = (message = {}) => {
  const raw = message.raw_json && typeof message.raw_json === 'object' ? message.raw_json : {};
  if (raw.origin !== 'chatbot-postgres' || !raw.chatbotBatchId) return null;
  return {
    batchId: String(raw.chatbotBatchId),
    outputIndex: Number(raw.chatbotOutputIndex),
    outputCount: Number(raw.chatbotOutputCount),
    inboundMessageId: raw.inboundMessageId || null,
    flowId: raw.flowId || null,
    flowVersionId: raw.flowVersionId || null,
    sessionId: raw.sessionId || null,
    nodeId: raw.nodeId || null,
    botUserId: raw.requestedBy || 'chatbot-postgres',
  };
};

const eventIdentity = ({ batch, item = null, reason = null }) => ({
  batchId: batch.id,
  inboundMessageId: batch.inbound_message_id,
  flowId: batch.flow_id,
  flowVersionId: batch.flow_version_id,
  sessionId: batch.session_id,
  outputIndex: item?.output_index ?? null,
  reason,
});

const recordSequenceEvent = ({ client, batch, item = null, messageId = null, eventType, reason = null, extra = {} }) =>
  recordChatbotEvent({
    tenantId: batch.tenant_id,
    conversationId: batch.conversation_id,
    messageId: messageId || batch.inbound_message_id,
    flowId: batch.flow_id,
    flowVersionId: batch.flow_version_id,
    sessionId: batch.session_id,
    eventType,
    mode: 'live',
    payload: { ...eventIdentity({ batch, item, reason }), ...extra },
  }, client);

const createMessageForItem = async ({ client, batch, item, botUserId }) => {
  const output = item.payload && typeof item.payload === 'object' ? item.payload : {};
  const messageType = output.type === 'interactive' ? 'interactive' : 'text';
  const body = output.type === 'interactive'
    ? String(output.text || 'Selecione uma opcao:')
    : String(output.text || '');
  const message = await insertPendingOutbound({
    tenantId: batch.tenant_id,
    conversationId: batch.conversation_id,
    clientMessageId: `chatbot:${batch.tenant_id}:${batch.id}:${item.output_index}`,
    type: messageType,
    body,
    raw: {
      requestedBy: botUserId,
      origin: 'chatbot-postgres',
      chatbotBatchId: batch.id,
      chatbotOutputIndex: item.output_index,
      chatbotOutputCount: batch.total_outputs,
      inboundMessageId: batch.inbound_message_id,
      flowId: batch.flow_id,
      flowVersionId: batch.flow_version_id,
      sessionId: batch.session_id,
      nodeId: output.nodeId || null,
      chatbotOutput: output,
    },
  }, client);
  const conversation = await updateConversationLastOutbound(client, batch.conversation_id, message);
  await client.query(`
    UPDATE chatbot_output_items
    SET message_id=$4, status='queued', queued_at=COALESCE(queued_at,now()), updated_at=now()
    WHERE tenant_id=$1 AND batch_id=$2 AND output_index=$3
  `, [batch.tenant_id, batch.id, item.output_index, message.id]);
  if (batch.session_id) {
    await client.query(`
      UPDATE chatbot_sessions
      SET last_outbound_message_id=$3, updated_at=now()
      WHERE tenant_id=$1 AND id=$2
    `, [batch.tenant_id, batch.session_id, message.id]);
  }
  return { message, conversation };
};

const publishQueuedMessage = async ({ tenantId, conversation, message }) => {
  const eventScope = {
    tenantId,
    conversationId: conversation.id,
    queueId: conversation.queue_id,
    assignedAgentId: conversation.assigned_agent_id,
    customerPhone: conversation.contact_phone,
  };
  await publishRealtimeEvent({
    ...eventScope,
    type: 'new_message',
    data: { conversationId: conversation.id, message },
  });
  await publishRealtimeEvent({
    ...eventScope,
    type: 'conversation_updated',
    data: { conversationId: conversation.id, conversation },
  });
};

const failBatchForMessage = async ({ tenantId, message, error, eventType = 'output_failed' }) => {
  const metadata = chatbotMetadata(message);
  if (!metadata) return { handled: false, reason: 'not_chatbot_postgres' };
  const failure = errorText(error);
  return withTransaction(async (client) => {
    const result = await client.query(`
      SELECT b.*, i.id AS item_id, i.output_index, i.status AS item_status
      FROM chatbot_output_batches b
      JOIN chatbot_output_items i
        ON i.tenant_id=b.tenant_id AND i.batch_id=b.id AND i.message_id=$3
      WHERE b.tenant_id=$1 AND b.id=$2
      FOR UPDATE OF b, i
    `, [tenantId, metadata.batchId, message.id]);
    const row = result.rows[0];
    if (!row) return { handled: false, reason: 'batch_item_not_found' };
    if (row.item_status === 'sent' || row.status === 'completed') {
      return { handled: true, ignored: true, reason: 'already_sent' };
    }
    await client.query(`
      UPDATE chatbot_output_items
      SET status='failed', failed_at=COALESCE(failed_at,now()), error_message=$4, updated_at=now()
      WHERE tenant_id=$1 AND batch_id=$2 AND message_id=$3 AND status<>'sent'
    `, [tenantId, metadata.batchId, message.id, failure]);
    await client.query(`
      UPDATE chatbot_output_batches
      SET status='failed', error_message=$3, updated_at=now()
      WHERE tenant_id=$1 AND id=$2 AND status<>'completed'
    `, [tenantId, metadata.batchId, failure]);
    const batch = row;
    const item = { output_index: row.output_index };
    await recordSequenceEvent({ client, batch, item, messageId: message.id, eventType, reason: failure });
    await recordSequenceEvent({ client, batch, item, messageId: message.id, eventType: 'batch_failed', reason: failure });
    return { handled: true, failed: true, batchId: metadata.batchId, outputIndex: row.output_index };
  });
};

const enqueueMessage = async ({ tenantId, batchId, outputIndex, botUserId, conversation, message }) => {
  try {
    await addJob('outbound', 'send-message', {
      tenantId,
      messageId: message.id,
      userId: botUserId,
    }, { jobId: `outbound:${tenantId}:chatbot:${batchId}:${outputIndex}` });
    await publishQueuedMessage({ tenantId, conversation, message }).catch(async (error) => {
      const logger = await getLogger();
      logger.warn({
        tenantId,
        batchId,
        outputIndex,
        messageId: message.id,
        error: errorText(error),
      }, 'chatbot output queued but realtime publication failed');
    });
    return { queued: true, messageId: message.id };
  } catch (error) {
    await withTransaction(async (client) => {
      await client.query(`
        UPDATE messages SET status='failed', error_message=$3
        WHERE tenant_id=$1 AND id=$2 AND status='pending'
      `, [tenantId, message.id, errorText(error)]);
    });
    await failBatchForMessage({ tenantId, message, error });
    throw error;
  }
};

export const createChatbotOutputBatch = async ({
  client,
  tenantId,
  conversation,
  inboundMessage,
  decision,
  sessionId,
  outputs,
  botUserId,
}) => {
  const batchId = crypto.randomUUID();
  const batchResult = await client.query(`
    INSERT INTO chatbot_output_batches (
      id, tenant_id, conversation_id, inbound_message_id, flow_id,
      flow_version_id, session_id, status, current_index, total_outputs
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',0,$8)
    RETURNING *
  `, [
    batchId,
    tenantId,
    conversation.id,
    inboundMessage.id,
    decision.flowId,
    decision.versionId,
    sessionId,
    outputs.length,
  ]);
  const batch = batchResult.rows[0];
  const items = [];
  for (const [outputIndex, output] of outputs.entries()) {
    const itemResult = await client.query(`
      INSERT INTO chatbot_output_items (
        tenant_id, batch_id, conversation_id, output_index, output_type, payload
      ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
      RETURNING *
    `, [tenantId, batchId, conversation.id, outputIndex, output.type, JSON.stringify(output)]);
    const item = itemResult.rows[0];
    items.push(item);
    await recordSequenceEvent({ client, batch, item, eventType: 'output_planned' });
  }
  const first = await createMessageForItem({ client, batch, item: items[0], botUserId });
  await recordSequenceEvent({
    client,
    batch,
    item: items[0],
    messageId: first.message.id,
    eventType: 'batch_created',
    extra: { totalOutputs: outputs.length },
  });
  await recordSequenceEvent({ client, batch, item: items[0], messageId: first.message.id, eventType: 'output_queued' });
  return { batch, item: items[0], ...first, botUserId };
};

export const enqueueInitialChatbotOutput = (created) => enqueueMessage({
  tenantId: created.batch.tenant_id,
  batchId: created.batch.id,
  outputIndex: created.item.output_index,
  botUserId: created.botUserId,
  conversation: created.conversation,
  message: created.message,
});

export const handleChatbotOutboundSent = async ({ tenantId, message }) => {
  const metadata = chatbotMetadata(message);
  if (!metadata) return { handled: false, reason: 'not_chatbot_postgres' };
  const transition = await withTransaction(async (client) => {
    const result = await client.query(`
      SELECT b.*, i.id AS item_id, i.output_index, i.status AS item_status
      FROM chatbot_output_batches b
      JOIN chatbot_output_items i
        ON i.tenant_id=b.tenant_id AND i.batch_id=b.id AND i.message_id=$3
      WHERE b.tenant_id=$1 AND b.id=$2
      FOR UPDATE OF b, i
    `, [tenantId, metadata.batchId, message.id]);
    const row = result.rows[0];
    if (!row) return { handled: false, reason: 'batch_item_not_found' };
    if (row.status === 'failed') return { handled: true, ignored: true, reason: 'batch_failed' };
    if (row.item_status === 'sent') return { handled: true, ignored: true, reason: 'already_advanced' };

    await client.query(`
      UPDATE chatbot_output_items
      SET status='sent', sent_at=COALESCE(sent_at,now()), error_message=NULL, updated_at=now()
      WHERE tenant_id=$1 AND batch_id=$2 AND message_id=$3
    `, [tenantId, metadata.batchId, message.id]);
    const batch = row;
    const currentItem = { output_index: row.output_index };
    await recordSequenceEvent({ client, batch, item: currentItem, messageId: message.id, eventType: 'output_sent' });

    const nextResult = await client.query(`
      SELECT * FROM chatbot_output_items
      WHERE tenant_id=$1 AND batch_id=$2 AND output_index=$3 AND status='pending'
      FOR UPDATE
    `, [tenantId, metadata.batchId, row.output_index + 1]);
    const nextItem = nextResult.rows[0];
    if (!nextItem) {
      await client.query(`
        UPDATE chatbot_output_batches
        SET status='completed', current_index=total_outputs, error_message=NULL, updated_at=now()
        WHERE tenant_id=$1 AND id=$2
      `, [tenantId, metadata.batchId]);
      await recordSequenceEvent({ client, batch, item: currentItem, messageId: message.id, eventType: 'batch_completed' });
      return { handled: true, completed: true, batchId: metadata.batchId };
    }

    const next = await createMessageForItem({ client, batch, item: nextItem, botUserId: metadata.botUserId });
    await client.query(`
      UPDATE chatbot_output_batches SET current_index=$3, updated_at=now()
      WHERE tenant_id=$1 AND id=$2
    `, [tenantId, metadata.batchId, nextItem.output_index]);
    await recordSequenceEvent({ client, batch, item: nextItem, messageId: next.message.id, eventType: 'output_queued' });
    return {
      handled: true,
      completed: false,
      batchId: metadata.batchId,
      item: nextItem,
      botUserId: metadata.botUserId,
      ...next,
    };
  });

  if (transition.message) {
    await enqueueMessage({
      tenantId,
      batchId: transition.batchId,
      outputIndex: transition.item.output_index,
      botUserId: transition.botUserId,
      conversation: transition.conversation,
      message: transition.message,
    });
  }
  return transition;
};

export const handleChatbotOutboundFailed = async ({ tenantId, message, error }) => {
  const result = await failBatchForMessage({ tenantId, message, error });
  if (result.handled) {
    const logger = await getLogger();
    logger.warn({
      tenantId,
      messageId: message.id,
      batchId: result.batchId,
      outputIndex: result.outputIndex,
      error: errorText(error),
    }, 'chatbot sequential batch stopped after outbound failure');
  }
  return result;
};

export const isChatbotPostgresMessage = (message) => Boolean(chatbotMetadata(message));

export const getChatbotOutboundPermission = async ({ tenantId, message }) => {
  const metadata = chatbotMetadata(message);
  if (!metadata) return { chatbot: false, allowed: true };
  const result = await withTransaction(async (client) => client.query(`
    SELECT b.status AS batch_status, i.status AS item_status, i.output_index
    FROM chatbot_output_batches b
    JOIN chatbot_output_items i
      ON i.tenant_id=b.tenant_id AND i.batch_id=b.id AND i.message_id=$3
    WHERE b.tenant_id=$1 AND b.id=$2
    LIMIT 1
  `, [tenantId, metadata.batchId, message.id]));
  const row = result.rows[0];
  if (!row) return { chatbot: true, allowed: false, reason: 'batch_item_not_found', batchId: metadata.batchId };
  const allowed = row.batch_status === 'processing' && row.item_status === 'queued';
  return {
    chatbot: true,
    allowed,
    reason: allowed ? 'queued_current_item' : `batch_${row.batch_status}_item_${row.item_status}`,
    batchId: metadata.batchId,
    outputIndex: row.output_index,
  };
};
