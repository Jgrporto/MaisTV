const localEventClients = new Set();

const writeSseEvent = (res, eventName, payload = {}) => {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
};

export const publishLocalEvent = (eventName, payload = {}, options = {}) => {
  const nowIso = typeof options.nowIso === 'function' ? options.nowIso : () => new Date().toISOString();

  for (const client of Array.from(localEventClients)) {
    try {
      writeSseEvent(client, eventName, {
        ...payload,
        emitted_at: nowIso(),
      });
    } catch {
      localEventClients.delete(client);
    }
  }
};

export const handleCoreEventRoutes = async (req, res, context = {}, url) => {
  if (req.method !== 'GET' || url.pathname !== '/api/local/events/stream') {
    return false;
  }

  const requestOrigin = req.headers.origin;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': requestOrigin || '*',
    'Access-Control-Allow-Credentials': 'true',
    'X-Accel-Buffering': 'no',
    Vary: 'Origin',
  });

  const nowIso = typeof context.nowIso === 'function' ? context.nowIso : () => new Date().toISOString();
  writeSseEvent(res, 'ready', { ok: true, at: nowIso() });
  localEventClients.add(res);
  req.on('close', () => {
    localEventClients.delete(res);
  });

  return true;
};

export const handleCoreUtilityRoutes = async (req, res, context = {}, url) => {
  const sendJson = context.sendJson;
  if (typeof sendJson !== 'function') {
    throw new Error('sendJson context is required for core utility routes.');
  }

  if (req.method === 'GET' && url.pathname === '/api/local/health') {
    sendJson(res, 200, { ok: true, mode: 'local' });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/local/events/publish') {
    if (!context.isInternalLoopbackRequest?.(req)) {
      sendJson(res, 403, { error: 'Acesso interno obrigatorio.' });
      return true;
    }

    const payload = await context.readBody(req);
    const eventName = String(payload?.event || payload?.eventName || '').trim();
    const eventPayload = payload?.payload && typeof payload.payload === 'object' ? payload.payload : {};
    const allowedEvents = new Set([
      'conversation:message-upserted',
      'conversation:message-status-updated',
      'conversation:message-reaction-updated',
    ]);

    if (!allowedEvents.has(eventName)) {
      sendJson(res, 400, { error: 'Evento local invalido.' });
      return true;
    }
    context.publishLocalEvent(eventName, eventPayload);
    sendJson(res, 200, { ok: true, event: eventName });
    return true;
  }

  return false;
};
