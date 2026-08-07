import { DIAGNOSTIC_SESSION_STORAGE_KEY } from './diagnostic-session.js';

export function createRuntimeDiagnostics({
  storage = globalThis.sessionStorage,
  fetchImpl = globalThis.fetch?.bind(globalThis),
  now = () => new Date(),
} = {}) {
  let session = null;
  try {
    const saved = JSON.parse(storage?.getItem(DIAGNOSTIC_SESSION_STORAGE_KEY) || 'null');
    const availableUntil = saved?.retained_until || saved?.expires_at;
    if (saved?.code && saved?.write_token && Date.parse(availableUntil) > Date.now()) session = saved;
  } catch { /* an ordinary game tab simply has no live diagnostic session */ }
  if (!session || !fetchImpl) return null;

  let sequence = Number.isSafeInteger(session.sequence) ? session.sequence : 0;
  const persist = () => {
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
  return {
    label: session.label || null,
    heartbeat() {
      return fetchImpl(`/api/diagnostics/${session.code}/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.write_token}` },
        cache: 'no-store',
      }).then(updateLifetime).catch(() => null);
    },
    emit(type, payload = {}) {
      const record = { seq: ++sequence, type, at: now().toISOString(), payload };
      persist();
      return fetchImpl(`/api/diagnostics/${session.code}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${session.write_token}`,
        },
        cache: 'no-store',
        body: JSON.stringify({ events: [record] }),
      }).then(updateLifetime).catch(() => null);
    },
  };
}
