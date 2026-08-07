import test from 'node:test';
import assert from 'node:assert/strict';
import { DIAGNOSTIC_SESSION_STORAGE_KEY } from '../src/diagnostic-session.js';
import { createRuntimeDiagnostics, runtimeDiagnosticsEnabled } from '../src/runtime-diagnostics.js';

test('runtime diagnostics are on for every game build unless explicitly disabled', () => {
  assert.equal(runtimeDiagnosticsEnabled(''), true);
  assert.equal(runtimeDiagnosticsEnabled('?diagnostics=1'), true);
  assert.equal(runtimeDiagnosticsEnabled('?diagnostics=0'), false);
  assert.equal(runtimeDiagnosticsEnabled('?mode=circuits&diagnostics=0'), false);
});

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
  assert.ok(writes.some(([, value]) => value.sequence === 123));
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

test('dev game tabs create a cross-platform diagnostic session and queue early events', async () => {
  const writes = [];
  const requests = [];
  const reporter = createRuntimeDiagnostics({
    autoCreate: true,
    storage: {
      getItem: () => null,
      setItem: (key, value) => writes.push([key, JSON.parse(value)]),
    },
    now: () => new Date('2026-08-07T21:30:00.000Z'),
    fetchImpl: async (url, options) => {
      requests.push([url, options]);
      if (url === '/api/diagnostics/session') return {
        ok: true,
        json: async () => ({
          code: '482013', label: 'BRIGHT-OTTER', write_token: 'new-secret',
          expires_at: '2026-08-08T21:30:00.000Z',
          retained_until: '2026-08-21T21:30:00.000Z',
        }),
      };
      return { ok: true, json: async () => ({}) };
    },
  });

  const emitted = reporter.emit('game_runtime_started', { platform: 'Win32' });
  assert.equal(reporter.label, null);
  assert.equal((await reporter.ready).label, 'BRIGHT-OTTER');
  await emitted;

  assert.equal(requests[0][0], '/api/diagnostics/session');
  assert.equal(requests[1][0], '/api/diagnostics/482013');
  assert.equal(requests[1][1].headers.authorization, 'Bearer new-secret');
  assert.deepEqual(JSON.parse(requests[1][1].body).events[0], {
    seq: 1,
    type: 'game_runtime_started',
    at: '2026-08-07T21:30:00.000Z',
    payload: { platform: 'Win32' },
  });
  assert.equal(writes.at(-1)[1].label, 'BRIGHT-OTTER');
});
