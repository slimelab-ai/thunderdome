import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Announcer, AnnouncerVoiceBank, LINES, announcerClipUrl } from '../src/announcer.js';
import { ASSET_VERSION } from '../src/asset-version.js';
import { announcerSpokenText } from '../tools/voice/spoken-text.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('voice clips have stable category and line URLs', () => {
  assert.equal(announcerClipUrl('matchStart', 0), `/assets/voice/vulture/matchStart/01.opus?v=${ASSET_VERSION}`);
  assert.equal(announcerClipUrl('playerKill', 11), `/assets/voice/vulture/playerKill/12.opus?v=${ASSET_VERSION}`);
});

test('spoken announcer text removes subtitle capitalization without losing its wording', () => {
  assert.equal(
    announcerSpokenText("Ladies and gentlemen... it's KILLING TIME!"),
    "Ladies and gentlemen... it's Killing Time!",
  );
  assert.equal(announcerSpokenText("LET'S GO! GOLIATH IS DOWN!"), "Let's Go! Goliath Is Down!");
  assert.equal(
    announcerSpokenText('{killer} puts {victim} DOWN!'),
    'The hired gun puts the target Down!',
  );
  assert.equal(
    announcerSpokenText('BO-RING! RSVP: everyone nearby!'),
    'Boring! R. S. V. P.: everyone nearby!',
  );
});

test('a full circuit has enough commentary to avoid obvious event loops', () => {
  const total = Object.values(LINES).reduce((sum, lines) => sum + lines.length, 0);
  assert.ok(total >= 290, `voice catalog regressed to ${total} lines`);
  assert.ok(LINES.matchStart.length >= 20);
  assert.ok(LINES.firstBlood.length >= 15);
  assert.ok(LINES.playerKill.length >= 30);
  assert.ok(LINES.playerHeadshot.length >= 20);
  assert.ok(LINES.playerHurt.length >= 15);
});

test('every authored subtitle has a pre-rendered voice clip', async () => {
  await Promise.all(Object.entries(LINES).flatMap(([category, lines]) =>
    lines.map((_, index) => access(path.join(
      root, 'public/assets/voice/vulture', category, `${String(index + 1).padStart(2, '0')}.opus`,
    )))));
});

test('voice manifest copy stays synchronized with the authored subtitles', async () => {
  const manifest = JSON.parse(await readFile(path.join(
    root, 'public/assets/voice/vulture/manifest.json',
  ), 'utf8'));
  for (const line of manifest.lines) {
    assert.equal(line.text, LINES[line.category]?.[line.index]);
    assert.equal(line.subtitle, line.text);
    assert.equal(line.voiceText, announcerSpokenText(line.text));
  }
});

test('an urgent line waits for the current clip without interrupting it', () => {
  let plays = 0;
  const announcer = Object.assign(Object.create(Announcer.prototype), {
    _voiceBank: { play: () => { plays++; return true; } },
    _speaking: true,
    _gen: 4,
  });

  announcer._speak('matchStart', 0, true);
  assert.deepEqual(announcer._pendingSpeech, { category: 'matchStart', index: 0, gen: 4 });
  assert.equal(plays, 0);
});

test('clear stops a pre-rendered clip on every platform', () => {
  let stops = 0;
  const announcer = Object.assign(Object.create(Announcer.prototype), {
    _voiceBank: { stop: () => stops++ },
    _speaking: true,
    _gen: 0,
    _utterToken: 2,
    queue: [],
    showing: 1,
    wrap: { classList: { remove: () => {} } },
  });

  announcer.clear();
  assert.equal(stops, 1);
  assert.equal(announcer._speaking, false);
  assert.equal(announcer._utterToken, 3);
});

test('voice bank releases a finished HTML audio clip', async () => {
  let clip;
  class FakeAudio {
    constructor(url) { this.url = url; clip = this; this.listeners = {}; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    play() { return Promise.resolve(); }
    pause() {}
  }
  let ended = 0;
  const bank = new AnnouncerVoiceBank({ AudioCtor: FakeAudio });
  assert.equal(bank.play('win', 2, () => ended++), true);
  assert.equal(clip.url, `/assets/voice/vulture/win/03.opus?v=${ASSET_VERSION}`);
  clip.listeners.ended();
  assert.equal(ended, 1);
  assert.equal(bank.current, null);
});

test('voice bank pre-decodes clips and starts buffered playback without an HTML media element', async () => {
  let source;
  class FakeAudioContext {
    constructor() { this.destination = {}; }
    resume() { return Promise.resolve(); }
    decodeAudioData(encoded) { return Promise.resolve({ bytes: encoded.byteLength }); }
    createBufferSource() {
      source = { connect() {}, start() { this.started = true; }, stop() {}, disconnect() {} };
      return source;
    }
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
  }
  const bank = new AnnouncerVoiceBank({
    AudioCtor: null,
    AudioContextCtor: FakeAudioContext,
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(12) }),
  });

  assert.equal(await bank.preload('playerHeadshot', 3), true);
  assert.deepEqual(bank.readyIndices('playerHeadshot'), [3]);
  assert.equal(bank.play('playerHeadshot', 3), true);
  assert.equal(source.started, true);
  assert.equal(source.buffer.bytes, 12);
});
