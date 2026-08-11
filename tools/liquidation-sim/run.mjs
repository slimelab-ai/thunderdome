#!/usr/bin/env node
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyze } from './analyze.mjs';
import { simulateWar } from './simulator.mjs';

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const matches = Math.max(1, Number(option('matches', 10)));
const seed = Number(option('seed', Date.now()));
const output = resolve(option('output', 'data/synthetic-liquidation'));
const batchId = new Date().toISOString().replaceAll(':', '-');
const batchDir = resolve(output, batchId);
const eventsPath = resolve(batchDir, 'events.ndjson');
await mkdir(batchDir, { recursive: true });

const events = [];
const wars = [];
for (let index = 0; index < matches; index++) {
  const warEvents = [];
  const war = simulateWar({ seed: seed + index, onEvent: event => warEvents.push({ match_index: index + 1, ...event }) });
  events.push(...warEvents);
  wars.push({ match_index: index + 1, ...war });
  await appendFile(eventsPath, `${warEvents.map(event => JSON.stringify(event)).join('\n')}\n`);
  process.stdout.write(`war ${index + 1}/${matches}: ${war.winner}, ${war.rounds} rounds, ${war.reason}\n`);
}

const { result, markdown } = analyze(events, wars);
await writeFile(resolve(batchDir, 'wars.json'), `${JSON.stringify(wars, null, 2)}\n`);
await writeFile(resolve(batchDir, 'summary.json'), `${JSON.stringify(result, null, 2)}\n`);
await writeFile(resolve(batchDir, 'REPORT.md'), markdown);
process.stdout.write(`\n${markdown}\nData: ${batchDir}\n`);
