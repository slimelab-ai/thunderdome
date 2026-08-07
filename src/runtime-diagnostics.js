import { DIAGNOSTIC_SESSION_STORAGE_KEY } from './diagnostic-session.js';

export function createRuntimeDiagnostics({
  storage = globalThis.sessionStorage,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => new Date(),
} = {}) {
  let session = null;
  try {
    const saved = JSON.parse(storage?.getItem(DIAGNOSTIC_SESSION_STORAGE_KEY) || 'null');
    if (saved?.code && saved?.write_token && Date.parse(saved.expires_at) > Date.now()) session = saved;
  } catch { /* an ordinary game tab simply has no live diagnostic session */ }
  if (!session || !fetchImpl) return null;

  let sequence = Number.isSafeInteger(session.sequence) ? session.sequence : 0;
  return {
    label: session.label || null,
    emit(type, payload = {}) {
      const record = { seq: ++sequence, type, at: now().toISOString(), payload };
      try {
        storage.setItem(DIAGNOSTIC_SESSION_STORAGE_KEY, JSON.stringify({ ...session, sequence }));
      } catch { /* reporting can continue without navigation persistence */ }
      return fetchImpl(`/api/diagnostics/${session.code}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.write_token}`,
        },
        cache: 'no-store',
        body: JSON.stringify({ events: [record] }),
      }).catch(() => null);
    },
  };
}
