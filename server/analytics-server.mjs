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

await mkdir(dataDir, { recursive: true });
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

const salt = await loadOrCreateSalt();
await pruneExpiredFiles();
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
}), 6 * 60 * 60 * 1000);
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

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
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
  if (req.method !== 'POST' || req.url !== '/events') return reply(res, 404, { error: 'not found' });
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
    const forwarded = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const sourceHash = createHash('sha256').update(`${salt}:${forwarded}`).digest('hex').slice(0, 24);
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
