import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const port = Number(process.env.PORT || 8080);
const dataDir = process.env.ANALYTICS_DATA_DIR || '/data';
const salt = process.env.ANALYTICS_IP_SALT || randomUUID();
const maxBytes = Number(process.env.ANALYTICS_MAX_BODY_BYTES || 1_000_000);

await mkdir(dataDir, { recursive: true });

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
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/events') return reply(res, 404, { error: 'not found' });
  try {
    const body = JSON.parse(await readBody(req));
    if (!Array.isArray(body.events) || body.events.length < 1 || body.events.length > 100) {
      return reply(res, 400, { error: 'events must contain 1-100 records' });
    }
    if (!body.events.every(validEvent)) return reply(res, 400, { error: 'invalid event' });
    const receivedAt = new Date().toISOString();
    const forwarded = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const sourceHash = createHash('sha256').update(`${salt}:${forwarded}`).digest('hex').slice(0, 24);
    const lines = body.events.map(event => JSON.stringify({
      ...event,
      received_at: receivedAt,
      source_hash: sourceHash,
    })).join('\n') + '\n';
    const day = receivedAt.slice(0, 10);
    await appendFile(join(dataDir, `events-${day}.ndjson`), lines, { encoding: 'utf8', mode: 0o640 });
    return reply(res, 202, { accepted: body.events.length });
  } catch (error) {
    return reply(res, error.message === 'body too large' ? 413 : 400, { error: error.message });
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`analytics collector listening on :${port}`);
});
