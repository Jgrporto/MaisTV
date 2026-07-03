import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attachSlowRouteLogger } from './slow-route-logger.mjs';

const createResponse = () => {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = new Map();
  res.locals = {};
  res.setHeader = (name, value) => res.headers.set(String(name).toLowerCase(), value);
  res.getHeader = (name) => res.headers.get(String(name).toLowerCase());
  res.write = () => true;
  res.end = () => {
    res.emit('finish');
  };
  return res;
};

const captureWarnings = async (callback) => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await callback();
  } finally {
    console.warn = originalWarn;
  }
  return warnings;
};

test('propagates a safe request id and redacts sensitive query values', async () => {
  const req = {
    method: 'GET',
    url: '/api/customers?token=secret-value&search=joao&password=hunter2',
    headers: { 'x-request-id': 'trace-123' },
  };
  const res = createResponse();

  const warnings = await captureWarnings(async () => {
    attachSlowRouteLogger(req, res, { thresholdMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.end('ok');
  });

  assert.equal(req.requestId, 'trace-123');
  assert.equal(res.getHeader('X-Request-Id'), 'trace-123');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /request_id=trace-123/);
  assert.match(warnings[0], /search=joao/);
  assert.doesNotMatch(warnings[0], /secret-value|hunter2/);
});

test('replaces an unsafe request id and reports bytes plus event-loop delay', async () => {
  const req = {
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-request-id': 'bad id\r\ninjected=true' },
  };
  const res = createResponse();

  const warnings = await captureWarnings(async () => {
    attachSlowRouteLogger(req, res, { thresholdMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.end('hello');
  });

  assert.match(req.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(res.getHeader('X-Request-Id'), req.requestId);
  assert.match(warnings[0], /bytes=5/);
  assert.match(warnings[0], /response_bytes=5/);
  assert.match(warnings[0], /event_loop_delay_ms=\d+(?:\.\d+)?/);
  assert.doesNotMatch(warnings[0], /injected=true/);
});

test('logs a large response independently of the slow-route threshold', async () => {
  const req = { method: 'GET', url: '/api/export', headers: {} };
  const res = createResponse();
  res.locals.perfTimings = {
    postgresMs: 2.5,
    store_ms: 3,
    transformMs: 4.25,
    serialize_ms: 1,
  };

  const warnings = await captureWarnings(async () => {
    attachSlowRouteLogger(req, res, {
      thresholdMs: 60_000,
      largeResponseBytes: 4,
    });
    res.end('hello');
  });

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[LARGE_RESPONSE\]/);
  assert.match(warnings[0], /bytes=5/);
  assert.match(warnings[0], /postgres_ms=2.5/);
  assert.match(warnings[0], /store_ms=3/);
  assert.match(warnings[0], /transform_ms=4.25/);
  assert.match(warnings[0], /serialize_ms=1/);
});

test('does not log long-lived SSE responses', async () => {
  const req = { method: 'GET', url: '/api/events/stream', headers: {} };
  const res = createResponse();
  res.setHeader('Content-Type', 'text/event-stream');

  const warnings = await captureWarnings(async () => {
    attachSlowRouteLogger(req, res, { thresholdMs: 1, largeResponseBytes: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    res.end('event: ping\n\n');
  });

  assert.deepEqual(warnings, []);
});
