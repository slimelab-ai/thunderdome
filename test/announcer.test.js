import test from 'node:test';
import assert from 'node:assert/strict';
import { Announcer } from '../src/announcer.js';

test('an urgent line waits for current speech without canceling the browser voice', () => {
  const previousWindow = globalThis.window;
  const previousSpeech = globalThis.speechSynthesis;
  let cancellations = 0;
  const speech = { cancel: () => cancellations++ };
  globalThis.window = { speechSynthesis: speech };
  globalThis.speechSynthesis = speech;
  const announcer = Object.assign(Object.create(Announcer.prototype), {
    _speechDisabled: false,
    _speaking: true,
    _gen: 4,
  });

  try {
    announcer._speak('FIGHT!', true);
    assert.deepEqual(announcer._pendingSpeech, { text: 'FIGHT!', gen: 4 });
    assert.equal(cancellations, 0);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousSpeech === undefined) delete globalThis.speechSynthesis;
    else globalThis.speechSynthesis = previousSpeech;
  }
});

test('Xbox clear avoids synchronous speech cancellation while desktop still cancels', () => {
  const previousWindow = globalThis.window;
  let cancellations = 0;
  globalThis.window = { speechSynthesis: { cancel: () => cancellations++ } };
  const wrap = { classList: { remove: () => {} } };
  const makeAnnouncer = protect => Object.assign(Object.create(Announcer.prototype), {
    _protectMainThread: protect,
    _speaking: true,
    _gen: 0,
    queue: [],
    showing: 1,
    wrap,
  });

  try {
    const xbox = makeAnnouncer(true);
    xbox.clear();
    assert.equal(cancellations, 0);
    assert.equal(xbox._speaking, true);

    const desktop = makeAnnouncer(false);
    desktop.clear();
    assert.equal(cancellations, 1);
    assert.equal(desktop._speaking, false);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
