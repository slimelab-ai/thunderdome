import { DIAGNOSTIC_SESSION_STORAGE_KEY } from './diagnostic-session.js';

export function runtimeDiagnosticsEnabled(search = globalThis.location?.search || '') {
  return new URLSearchParams(search).get('diagnostics') !== '0';
}

export function createRuntimeDiagnostics({
  storage = globalThis.sessionStorage,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => new Date(),
  autoCreate = false,
  flushDelayMs = 1_500,
} = {}) {
  let session = null;
  try {
    const saved = JSON.parse(storage?.getItem(DIAGNOSTIC_SESSION_STORAGE_KEY) || 'null');
    const availableUntil = saved?.retained_until || saved?.expires_at;
    if (saved?.code && saved?.write_token && Date.parse(availableUntil) > Date.now()) session = saved;
  } catch { /* an ordinary game tab simply has no live diagnostic session */ }
  if ((!session && !autoCreate) || !fetchImpl) return null;

  let sequence = Number.isSafeInteger(session?.sequence) ? session.sequence : 0;
  let uploadTail = Promise.resolve();
  let pendingEvents = [];
  let flushTimer = null;
  const persist = () => {
    if (!session) return;
    try {
      storage.setItem(DIAGNOSTIC_SESSION_STORAGE_KEY, JSON.stringify({ ...session, sequence }));
    } catch { /* reporting can continue without navigation persistence */ }
  };
  const updateLifetime = async response => {
    if (!response?.ok) return response;
    try {
      const lifetime = await response.json();
      if (lifetime?.expires_at) session.expires_at = lifetime.expires_at;
      if (lifetime?.retained_until) session.retained_until = lifetime.retained_until;
      persist();
    } catch { /* older collectors can acknowledge without a JSON lifetime */ }
    return response;
  };
  const ready = (session ? Promise.resolve(session) : fetchImpl('/api/diagnostics/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: '{}',
  }).then(async response => {
    if (!response.ok) throw new Error(`diagnostic session HTTP ${response.status}`);
    return response.json();
  })).then(activeSession => {
    session = activeSession;
    if (Number.isSafeInteger(session.sequence)) sequence = Math.max(sequence, session.sequence);
    persist();
    return {
      code: session.code,
      label: session.label || null,
      expires_at: session.expires_at,
      retained_until: session.retained_until,
    };
  }).catch(error => {
    console.warn('[diagnostics] session unavailable', error);
    return null;
  });
  const withSession = task => ready.then(active => active && session ? task() : null);
  const enqueue = task => {
    const result = uploadTail.then(task, task);
    uploadTail = result.catch(() => null);
    return result;
  };

  const scheduleFlush = () => {
    if (flushTimer != null || !pendingEvents.length) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushBatch();
    }, flushDelayMs);
  };
  const flushBatch = () => {
    if (flushTimer != null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!pendingEvents.length) return Promise.resolve(null);
    const batch = pendingEvents.splice(0, 50);
    const records = batch.map(entry => entry.record);
    const upload = enqueue(() => withSession(() => {
      persist();
      return fetchImpl(`/api/diagnostics/${session.code}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.write_token}`,
        },
        cache: 'no-store',
        keepalive: true,
        body: JSON.stringify({ events: records }),
      }).then(updateLifetime).catch(() => null);
    }));
    upload.then(
      result => batch.forEach(entry => entry.resolve(result)),
      () => batch.forEach(entry => entry.resolve(null)),
    ).finally(scheduleFlush);
    return upload;
  };
  const flush = () => flushBatch().then(result => (
    pendingEvents.length ? flush().then(() => result) : result
  ));

  return {
    get label() { return session?.label || null; },
    ready,
    heartbeat() {
      return flush().then(() => enqueue(() => withSession(() => fetchImpl(`/api/diagnostics/${session.code}/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.write_token}` },
        cache: 'no-store',
      }).then(updateLifetime).catch(() => null))));
    },
    flush,
    emit(type, payload = {}) {
      const record = { seq: ++sequence, type, at: now().toISOString(), payload };
      const result = new Promise(resolve => pendingEvents.push({ record, resolve }));
      if (pendingEvents.length >= 50) flushBatch();
      else scheduleFlush();
      return result;
    },
  };
}
