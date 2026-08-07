import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, appendFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const port = Number(process.env.PORT || 8080);
const dataDir = process.env.ANALYTICS_DATA_DIR || '/data';
const maxBytes = Number(process.env.ANALYTICS_MAX_BODY_BYTES || 1_000_000);
const retentionDays = Math.max(1, Number(process.env.ANALYTICS_RETENTION_DAYS || 90));
const saltPath = join(dataDir, '.source-salt');
const diagnosticsDir = join(dataDir, 'diagnostics');
const diagnosticsTtlMs = Math.max(60_000, Number(process.env.DIAGNOSTICS_TTL_MS || 6 * 60 * 60 * 1000));
const diagnosticsMaxEvents = Math.max(100, Number(process.env.DIAGNOSTICS_MAX_EVENTS || 1000));

await mkdir(dataDir, { recursive: true });
await mkdir(diagnosticsDir, { recursive: true });
await access(dataDir, constants.R_OK | constants.W_OK);

async function loadOrCreateSalt() {
  if (process.env.ANALYTICS_IP_SALT) return process.env.ANALYTICS_IP_SALT;
  try {
    return (await readFile(saltPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const generated = randomBytes(32).toString('hex');
  try {
    await writeFile(saltPath, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return (await readFile(saltPath, 'utf8')).trim();
  }
}

async function pruneExpiredFiles() {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const names = await readdir(dataDir);
  let removed = 0;
  for (const name of names) {
    const match = /^events-(\d{4}-\d{2}-\d{2})\.ndjson$/.exec(name);
    if (!match || Date.parse(`${match[1]}T00:00:00Z`) >= cutoff) continue;
    await unlink(join(dataDir, name));
    removed++;
  }
  if (removed) console.log(`analytics retention removed ${removed} expired file(s)`);
}

async function pruneExpiredDiagnostics() {
  const now = Date.now();
  const names = await readdir(diagnosticsDir);
  let removed = 0;
  for (const name of names) {
    const match = /^(\d{6})\.json$/.exec(name);
    if (!match) continue;
    try {
      const metadata = JSON.parse(await readFile(join(diagnosticsDir, name), 'utf8'));
      if (Date.parse(metadata.expires_at) > now) continue;
    } catch {
      // A broken metadata file is not a usable session; remove it with its events.
    }
    await unlink(join(diagnosticsDir, name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await unlink(join(diagnosticsDir, `${match[1]}.ndjson`)).catch(error => { if (error.code !== 'ENOENT') throw error; });
    removed++;
  }
  if (removed) console.log(`diagnostics retention removed ${removed} expired session(s)`);
}

const salt = await loadOrCreateSalt();
await pruneExpiredFiles();
await pruneExpiredDiagnostics();
const recentEventIds = new Set();
const recentEventOrder = [];
const metrics = { accepted: 0, duplicates: 0, rejected: 0, last_received_at: null };
let ingestionTail = Promise.resolve();
function rememberEventId(id) {
  if (recentEventIds.has(id)) return false;
  recentEventIds.add(id);
  recentEventOrder.push(id);
  if (recentEventOrder.length > 50000) recentEventIds.delete(recentEventOrder.shift());
  return true;
}

async function restoreRecentEventIds() {
  const names = (await readdir(dataDir))
    .filter(name => /^events-\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
    .sort()
    .reverse();
  const restored = [];
  for (const name of names) {
    const lines = (await readFile(join(dataDir, name), 'utf8')).trim().split('\n').reverse();
    for (const line of lines) {
      if (!line) continue;
      try {
        const eventId = JSON.parse(line)?.event_id;
        if (typeof eventId === 'string') restored.push(eventId);
      } catch {
        // One malformed historical line must not prevent collector startup.
      }
      if (restored.length >= 50000) break;
    }
    if (restored.length >= 50000) break;
  }
  for (const eventId of restored.reverse()) rememberEventId(eventId);
}

function serializeIngestion(task) {
  const result = ingestionTail.then(task, task);
  ingestionTail = result.catch(() => {});
  return result;
}

await restoreRecentEventIds();
const pruneTimer = setInterval(() => pruneExpiredFiles().catch(error => {
  console.error('analytics retention failed', error);
}).then(() => pruneExpiredDiagnostics()).catch(error => {
  console.error('diagnostics retention failed', error);
}), 30 * 60 * 1000);
pruneTimer.unref();

function reply(res, status, body = '') {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(body && JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validEvent(event) {
  return event && typeof event === 'object' &&
    typeof event.event_id === 'string' &&
    typeof event.event_type === 'string' &&
    typeof event.installation_id === 'string' &&
    event.schema_version === 1;
}

function sourceHashFor(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  return createHash('sha256').update(`${salt}:${forwarded}`).digest('hex').slice(0, 24);
}

function diagnosticTokenHash(token) {
  return createHash('sha256').update(`${salt}:diagnostic:${token}`).digest('hex');
}

function validDiagnosticEvent(event) {
  return event && typeof event === 'object' &&
    Number.isSafeInteger(event.seq) && event.seq > 0 &&
    typeof event.type === 'string' && event.type.length >= 1 && event.type.length <= 80 &&
    typeof event.at === 'string' && event.at.length <= 80 &&
    event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload);
}

function diagnosticError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function loadDiagnosticSession(code) {
  try {
    const metadata = JSON.parse(await readFile(join(diagnosticsDir, `${code}.json`), 'utf8'));
    if (Date.parse(metadata.expires_at) <= Date.now()) throw diagnosticError(410, 'diagnostic session expired');
    return metadata;
  } catch (error) {
    if (error.status) throw error;
    if (error.code === 'ENOENT') throw diagnosticError(404, 'diagnostic session not found');
    throw error;
  }
}

async function createDiagnosticSession(req) {
  await pruneExpiredDiagnostics();
  const active = (await readdir(diagnosticsDir)).filter(name => /^\d{6}\.json$/.test(name));
  if (active.length >= 250) throw diagnosticError(503, 'too many active diagnostic sessions');
  const writeToken = randomBytes(24).toString('base64url');
  for (let attempt = 0; attempt < 30; attempt++) {
    const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, '0');
    const createdAt = new Date().toISOString();
    const metadata = {
      code,
      token_hash: diagnosticTokenHash(writeToken),
      source_hash: sourceHashFor(req),
      created_at: createdAt,
      expires_at: new Date(Date.now() + diagnosticsTtlMs).toISOString(),
      last_received_at: null,
      event_count: 0,
    };
    try {
      await writeFile(join(diagnosticsDir, `${code}.json`), JSON.stringify(metadata), {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      return { code, write_token: writeToken, created_at: createdAt, expires_at: metadata.expires_at };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw diagnosticError(503, 'could not allocate diagnostic code');
}

async function appendDiagnosticEvents(req, code) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) throw diagnosticError(401, 'diagnostic write token required');
  const body = JSON.parse(await readBody(req));
  if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) {
    throw diagnosticError(400, 'events must contain 1-50 diagnostic records');
  }
  if (!body.events.every(validDiagnosticEvent)) throw diagnosticError(400, 'invalid diagnostic event');

  return serializeIngestion(async () => {
    const metadata = await loadDiagnosticSession(code);
    if (diagnosticTokenHash(auth.slice(7)) !== metadata.token_hash) {
      throw diagnosticError(403, 'invalid diagnostic write token');
    }
    if (metadata.event_count + body.events.length > diagnosticsMaxEvents) {
      throw diagnosticError(413, 'diagnostic event limit reached');
    }
    const receivedAt = new Date().toISOString();
    const lines = body.events.map(event => JSON.stringify({ ...event, received_at: receivedAt })).join('\n') + '\n';
    await appendFile(join(diagnosticsDir, `${code}.ndjson`), lines, { encoding: 'utf8', mode: 0o600 });
    metadata.event_count += body.events.length;
    metadata.last_received_at = receivedAt;
    await writeFile(join(diagnosticsDir, `${code}.json`), JSON.stringify(metadata), { encoding: 'utf8', mode: 0o600 });
    return { accepted: body.events.length, event_count: metadata.event_count };
  });
}

async function readDiagnosticEvents(code) {
  return serializeIngestion(async () => {
    const metadata = await loadDiagnosticSession(code);
    let events = [];
    try {
      const text = await readFile(join(diagnosticsDir, `${code}.ndjson`), 'utf8');
      events = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return {
      code: metadata.code,
      created_at: metadata.created_at,
      expires_at: metadata.expires_at,
      last_received_at: metadata.last_received_at,
      event_count: metadata.event_count,
      events,
    };
  });
}

async function readLatestDiagnosticEvents(req) {
  await pruneExpiredDiagnostics();
  const requester = sourceHashFor(req);
  const metadata = [];
  for (const name of await readdir(diagnosticsDir)) {
    if (!/^\d{6}\.json$/.test(name)) continue;
    try {
      const candidate = JSON.parse(await readFile(join(diagnosticsDir, name), 'utf8'));
      if (candidate.source_hash === requester && Date.parse(candidate.expires_at) > Date.now()) metadata.push(candidate);
    } catch {
      // Ignore a session whose metadata is incomplete while retention cleans it up.
    }
  }
  metadata.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  if (!metadata.length) throw diagnosticError(404, 'no diagnostic session found for this connection');
  return readDiagnosticEvents(metadata[0].code);
}

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (req.method === 'GET' && pathname === '/health') {
    try {
      await access(dataDir, constants.R_OK | constants.W_OK);
      return reply(res, 200, {
        ok: true,
        storage: 'writable',
        retention_days: retentionDays,
        delivery: metrics,
      });
    } catch {
      return reply(res, 503, { ok: false, storage: 'unavailable' });
    }
  }
  if (req.method === 'POST' && pathname === '/diagnostics/session') {
    try {
      return reply(res, 201, await createDiagnosticSession(req));
    } catch (error) {
      return reply(res, error.status || 400, { error: error.message });
    }
  }
  if (req.method === 'GET' && pathname === '/diagnostics/latest') {
    try {
      return reply(res, 200, await readLatestDiagnosticEvents(req));
    } catch (error) {
      return reply(res, error.status || 500, { error: error.message });
    }
  }
  const diagnosticMatch = /^\/diagnostics\/(\d{6})$/.exec(pathname);
  if (diagnosticMatch && req.method === 'POST') {
    try {
      return reply(res, 202, await appendDiagnosticEvents(req, diagnosticMatch[1]));
    } catch (error) {
      return reply(res, error.status || (error.message === 'body too large' ? 413 : 400), { error: error.message });
    }
  }
  if (diagnosticMatch && req.method === 'GET') {
    try {
      return reply(res, 200, await readDiagnosticEvents(diagnosticMatch[1]));
    } catch (error) {
      return reply(res, error.status || 500, { error: error.message });
    }
  }
  if (req.method !== 'POST' || pathname !== '/events') return reply(res, 404, { error: 'not found' });
  try {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 100) {
      metrics.rejected++;
      return reply(res, 400, { error: 'events must contain 1-100 records' });
    }
    if (!body.events.every(validEvent)) {
      metrics.rejected++;
      return reply(res, 400, { error: 'invalid event' });
    }
    const receivedAt = new Date().toISOString();
    const sourceHash = sourceHashFor(req);
    const result = await serializeIngestion(async () => {
      const batchEventIds = new Set();
      const uniqueEvents = body.events.filter(event => {
        if (recentEventIds.has(event.event_id) || batchEventIds.has(event.event_id)) return false;
        batchEventIds.add(event.event_id);
        return true;
      });
      const duplicates = body.events.length - uniqueEvents.length;
      const lines = uniqueEvents.map(event => JSON.stringify({
        ...event,
        received_at: receivedAt,
        source_hash: sourceHash,
      })).join('\n') + '\n';
      const day = receivedAt.slice(0, 10);
      if (uniqueEvents.length) {
        await appendFile(join(dataDir, `events-${day}.ndjson`), lines, { encoding: 'utf8', mode: 0o640 });
        for (const event of uniqueEvents) rememberEventId(event.event_id);
      }
      metrics.accepted += uniqueEvents.length;
      metrics.duplicates += duplicates;
      metrics.last_received_at = receivedAt;
      return { accepted: uniqueEvents.length, duplicates };
    });
    return reply(res, 202, result);
  } catch (error) {
    metrics.rejected++;
    return reply(res, error.message === 'body too large' ? 413 : 400, { error: error.message });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`analytics collector listening on :${port}`);
});
