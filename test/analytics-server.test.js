import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function startCollector(dataDir, port) {
  const child = spawn(process.execPath, ['server/analytics-server.mjs'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANALYTICS_DATA_DIR: dataDir,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`collector exited ${code}: ${stderr}`)));
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('analytics collector listening')) resolve(child);
    });
  });
}

async function stopCollector(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}

const event = {
  schema_version: 1,
  event_id: 'durable-terminal-id',
  event_type: 'match_terminal',
  installation_id: 'installation-1',
  match_id: 'match-1',
  payload: { terminal_reason: 'player_win' },
};

async function postEvents(port, events) {
  const response = await fetch(`http://127.0.0.1:${port}/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  return { response, body: await response.json() };
}

async function createDiagnosticSession(port) {
  const response = await fetch(`http://127.0.0.1:${port}/diagnostics/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return { response, body: await response.json() };
}

async function postDiagnostics(port, code, token, events) {
  const response = await fetch(`http://127.0.0.1:${port}/diagnostics/${code}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ events }),
  });
  return { response, body: await response.json() };
}

test('collector only deduplicates durable appends and restores IDs after restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'thunderdome-analytics-'));
  const port = await availablePort();
  let collector;
  try {
    collector = await startCollector(dataDir, port);
    const first = await postEvents(port, [event]);
    assert.equal(first.response.status, 202);
    assert.deepEqual(first.body, { accepted: 1, duplicates: 0 });

    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(dataDir, `events-${day}.ndjson`);
    const afterFailure = { ...event, event_id: 'terminal-after-append-failure' };
    await chmod(eventPath, 0o400);
    const failed = await postEvents(port, [afterFailure]);
    assert.equal(failed.response.status, 400);
    await chmod(eventPath, 0o600);
    const retried = await postEvents(port, [afterFailure]);
    assert.equal(retried.response.status, 202);
    assert.deepEqual(retried.body, { accepted: 1, duplicates: 0 });

    const concurrent = { ...event, event_id: 'concurrent-terminal' };
    const concurrentResults = await Promise.all([
      postEvents(port, [concurrent]),
      postEvents(port, [concurrent]),
    ]);
    assert.equal(concurrentResults.reduce((sum, result) => sum + result.body.accepted, 0), 1);
    assert.equal(concurrentResults.reduce((sum, result) => sum + result.body.duplicates, 0), 1);
    await stopCollector(collector);

    collector = await startCollector(dataDir, port);
    const retry = await postEvents(port, [event]);
    assert.equal(retry.response.status, 202);
    assert.deepEqual(retry.body, { accepted: 0, duplicates: 1 });

    const lines = (await readFile(eventPath, 'utf8'))
      .trim()
      .split('\n');
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).event_id, event.event_id);
  } finally {
    if (collector) await stopCollector(collector);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('short-lived diagnostic sessions require a private writer token and remain readable by six-digit code', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'thunderdome-diagnostics-'));
  const port = await availablePort();
  let collector;
  try {
    collector = await startCollector(dataDir, port);
    const created = await createDiagnosticSession(port);
    assert.equal(created.response.status, 201);
    assert.match(created.body.code, /^\d{6}$/);
    assert.ok(created.body.write_token.length >= 24);

    const event = {
      seq: 1,
      type: 'render_probe_result',
      at: new Date().toISOString(),
      payload: { id: 'direct', average_rgb: [20, 30, 40], screenshot: 'data:image/jpeg;base64,abc' },
    };
    const missingToken = await postDiagnostics(port, created.body.code, null, [event]);
    assert.equal(missingToken.response.status, 401);
    const wrongToken = await postDiagnostics(port, created.body.code, 'wrong-token', [event]);
    assert.equal(wrongToken.response.status, 403);

    const accepted = await postDiagnostics(port, created.body.code, created.body.write_token, [event]);
    assert.equal(accepted.response.status, 202);
    assert.deepEqual(accepted.body, { accepted: 1, event_count: 1 });

    let report = await fetch(`http://127.0.0.1:${port}/diagnostics/${created.body.code}`).then(response => response.json());
    assert.equal(report.code, created.body.code);
    assert.equal(report.event_count, 1);
    assert.equal(report.events[0].type, event.type);
    assert.equal(report.events[0].payload.id, 'direct');
    assert.equal(report.write_token, undefined);

    await stopCollector(collector);
    collector = await startCollector(dataDir, port);
    report = await fetch(`http://127.0.0.1:${port}/diagnostics/${created.body.code}`).then(response => response.json());
    assert.equal(report.event_count, 1, 'diagnostics survive collector restart');

    const metadataPath = join(dataDir, 'diagnostics', `${created.body.code}.json`);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    metadata.expires_at = new Date(Date.now() - 1000).toISOString();
    await writeFile(metadataPath, JSON.stringify(metadata));
    const expired = await fetch(`http://127.0.0.1:${port}/diagnostics/${created.body.code}`);
    assert.equal(expired.status, 410);

    await createDiagnosticSession(port); // creation prunes expired sessions
    await assert.rejects(access(metadataPath));
    await assert.rejects(access(join(dataDir, 'diagnostics', `${created.body.code}.ndjson`)));
  } finally {
    if (collector) await stopCollector(collector);
    await rm(dataDir, { recursive: true, force: true });
  }
});
