import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LINES } from '../../src/announcer.js';
import { announcerSpokenText } from './spoken-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const work = await mkdtemp(path.join(tmpdir(), 'vulture-voice-'));
const lines = Object.entries(LINES).flatMap(([category, entries]) =>
  entries.map((text, index) => ({
    category,
    index,
    text,
    voiceText: announcerSpokenText(text),
  })));
const python = process.env.VOICE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const rawArgs = process.argv.slice(2);
const takeOption = name => {
  const at = rawArgs.indexOf(name);
  if (at < 0) return null;
  const value = rawArgs[at + 1];
  rawArgs.splice(at, 2);
  return value;
};
const engineAt = rawArgs.indexOf('--engine');
const engine = engineAt >= 0 ? rawArgs[engineAt + 1] : 'kokoro';
if (engineAt >= 0) rawArgs.splice(engineAt, 2);
const outputOption = takeOption('--output');
const onlyOption = takeOption('--only');
const startAt = Math.max(1, Number(takeOption('--start-at')) || 1);
const refreshEmphasisAt = rawArgs.indexOf('--refresh-emphasis');
const refreshEmphasis = refreshEmphasisAt >= 0;
if (refreshEmphasis) {
  rawArgs.splice(refreshEmphasisAt, 1);
  // The render input is narrowed to changed lines, so force means overwrite those
  // clips rather than needlessly rebuilding the entire voice bank.
  if (!rawArgs.includes('--force')) rawArgs.push('--force');
}
const jobsAt = rawArgs.indexOf('--jobs');
const requestedJobs = Math.max(1, Math.min(6, jobsAt >= 0 ? Number(rawArgs[jobsAt + 1]) || 1 : 1));
// Qwen uses one model per worker. Chatterbox is deliberately single-worker: its
// distilled decoder already keeps the GPU busy and extra model copies only add VRAM pressure.
const jobs = engine === 'qwen' ? Math.min(3, requestedJobs)
  : engine === 'chatterbox' ? 1 : requestedJobs;
if (jobsAt >= 0) rawArgs.splice(jobsAt, 2);
const output = outputOption ? path.resolve(root, outputOption) : path.join(root, 'public/assets/voice/vulture');
await mkdir(output, { recursive: true });

const run = (input) => new Promise((resolve, reject) => {
  const renderer = engine === 'qwen' ? 'render_qwen.py'
    : engine === 'chatterbox' ? 'render_chatterbox.py' : 'render.py';
  const engineArgs = engine === 'chatterbox'
    ? ['--reference', path.join(here, 'vulture-ref.wav')] : [];
  const child = spawn(python, [
    path.join(here, renderer), '--input', input, '--output', output,
    '--no-manifest', ...engineArgs, ...rawArgs,
  ], { cwd: root, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve() : reject(new Error(`voice renderer exited ${code}`)));
});

let renderLines = refreshEmphasis
  ? lines.filter(line => /\b[A-Z][A-Z']*[A-Z]\b/.test(line.text))
  : lines;
if (onlyOption) {
  const requested = new Set(onlyOption.split(',').map(value => value.trim()).filter(Boolean));
  renderLines = renderLines.filter(line => requested.has(line.category) ||
    requested.has(`${line.category}/${String(line.index + 1).padStart(2, '0')}`));
  if (!rawArgs.includes('--force')) rawArgs.push('--force');
}
renderLines = renderLines.slice(startAt - 1);
const batches = Array.from({ length: jobs }, () => []);
renderLines.forEach((line, index) => batches[index % jobs].push(line));
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
  const voice = option('--voice') || (engine === 'qwen' ? 'Ryan'
    : engine === 'chatterbox' ? 'Vulture reference voice' : 'am_michael');
  const speed = Number(option('--speed') || (engine === 'qwen' || engine === 'chatterbox' ? 1.0 : 1.04));
  const manifest = {
    format: 1,
    engine: engine === 'qwen' ? 'Qwen3-TTS-12Hz-1.7B-CustomVoice'
      : engine === 'chatterbox' ? 'Chatterbox-Turbo-350M' : 'Kokoro-82M-v1.0-ONNX',
    voice,
    speed,
    codec: 'Opus 48 kbps mono',
    lines: lines.map(line => ({
      ...line,
      file: `${line.category}/${String(line.index + 1).padStart(2, '0')}.opus`,
      subtitle: line.text,
    })),
  };
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
