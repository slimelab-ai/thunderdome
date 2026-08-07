import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LINES } from '../../src/announcer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const work = await mkdtemp(path.join(tmpdir(), 'vulture-voice-'));
const lines = Object.entries(LINES).flatMap(([category, entries]) =>
  entries.map((text, index) => ({ category, index, text })));
const spokenText = (text) => {
  let result = text.replaceAll('{victim}', 'the target').replaceAll('{killer}', 'the hired gun')
    .replace('Hired muscle the hired gun', 'The hired gun')
    .replace('the target, meet floor', 'the target meets the floor')
    .replace('the target just became the most valuable target', 'That fighter just became the most valuable target');
  return result ? result[0].toUpperCase() + result.slice(1) : result;
};
const python = process.env.VOICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const rawArgs = process.argv.slice(2);
const jobsAt = rawArgs.indexOf('--jobs');
const jobs = Math.max(1, Math.min(6, jobsAt >= 0 ? Number(rawArgs[jobsAt + 1]) || 1 : 1));
if (jobsAt >= 0) rawArgs.splice(jobsAt, 2);
const output = path.join(root, 'public/assets/voice/vulture');
await mkdir(output, { recursive: true });

const run = (input) => new Promise((resolve, reject) => {
  const child = spawn(python, [
    path.join(here, 'render.py'), '--input', input, '--output', output,
    '--no-manifest', ...rawArgs,
  ], { cwd: root, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`voice renderer exited ${code}`)));
});

const batches = Array.from({ length: jobs }, () => []);
lines.forEach((line, index) => batches[index % jobs].push(line));
const inputs = await Promise.all(batches.map(async (batch, index) => {
  const input = path.join(work, `lines-${index}.json`);
  await writeFile(input, JSON.stringify(batch));
  return input;
}));

try {
  await Promise.all(inputs.map(run));
  const option = name => {
    const at = rawArgs.indexOf(name);
    return at >= 0 ? rawArgs[at + 1] : null;
  };
  const voice = option('--voice') || 'am_michael';
  const speed = Number(option('--speed') || 1.04);
  const manifest = {
    format: 1,
    engine: 'Kokoro-82M-v1.0-ONNX',
    voice,
    speed,
    codec: 'Opus 48 kbps mono',
    lines: lines.map(line => ({
      ...line,
      file: `${line.category}/${String(line.index + 1).padStart(2, '0')}.opus`,
      subtitle: line.text,
      voiceText: spokenText(line.text),
    })),
  };
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
