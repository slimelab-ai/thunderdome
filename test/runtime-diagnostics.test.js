import test from 'node:test';
import assert from 'node:assert/strict';
import { DIAGNOSTIC_SESSION_STORAGE_KEY } from '../src/diagnostic-session.js';
import { createRuntimeDiagnostics } from '../src/runtime-diagnostics.js';

test('game runtime resumes the existing one-time diagnostic session', async () => {
  const writes = [];
  const requests = [];
  const saved = {
    code: '753160', label: 'STORMY-FOX', write_token: 'secret', sequence: 122,
    expires_at: '2099-01-01T00:00:00.000Z',
  };
  const storage = {
    getItem: key => key === DIAGNOSTIC_SESSION_STORAGE_KEY ? JSON.stringify(saved) : null,
    setItem: (key, value) => writes.push([key, JSON.parse(value)]),
  };
  const reporter = createRuntimeDiagnostics({
    storage,
    now: () => new Date('2026-08-07T02:00:00.000Z'),
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return { ok: true, json: async () => ({
        expires_at: '2099-01-02T00:00:00.000Z',
        retained_until: '2099-01-15T00:00:00.000Z',
      }) };
    },
  });
  assert.equal(reporter.label, 'STORMY-FOX');
  await reporter.emit('game_frame_hitch', { duration_ms: 180 });
  assert.equal(writes[0][1].sequence, 123);
  assert.equal(requests[0][0], '/api/diagnostics/753160');
  assert.equal(requests[0][1].headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(requests[0][1].body).events[0], {
    seq: 123,
    type: 'game_frame_hitch',
    at: '2026-08-07T02:00:00.000Z',
    payload: { duration_ms: 180 },
  });
  assert.equal(writes.at(-1)[1].retained_until, '2099-01-15T00:00:00.000Z');
  await reporter.heartbeat();
  assert.equal(requests[1][0], '/api/diagnostics/753160/heartbeat');
});

test('game runtime can renew a retained diagnostic session after its active window', async () => {
  const requests = [];
  const saved = {
    code: '753160', label: 'STORMY-FOX', write_token: 'secret', sequence: 122,
    expires_at: '2026-08-06T00:00:00.000Z',
    retained_until: '2026-08-20T00:00:00.000Z',
  };
  const reporter = createRuntimeDiagnostics({
    storage: {
      getItem: () => JSON.stringify(saved),
      setItem: () => {},
    },
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(reporter.label, 'STORMY-FOX');
  await reporter.heartbeat();
  assert.equal(requests[0][0], '/api/diagnostics/753160/heartbeat');
});

test('ordinary game tabs do not create diagnostic sessions', () => {
  const reporter = createRuntimeDiagnostics({
    storage: { getItem: () => null },
    fetchImpl: async () => { throw new Error('must not send'); },
  });
  assert.equal(reporter, null);
});
