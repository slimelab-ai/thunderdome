import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
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
