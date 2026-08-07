import test from 'node:test';
import assert from 'node:assert/strict';
import { UI } from '../src/ui.js';

function fakeEntry() {
  return {
    className: '',
    innerHTML: '',
    style: {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    remove() { throw new Error('pooled killfeed entries must never be removed'); },
  };
}

test('killfeed reuses five fixed entries and expires them without DOM removal', () => {
  const callbacks = [];
  const entries = Array.from({ length: 5 }, fakeEntry);
  const ui = Object.assign(Object.create(UI.prototype), {
    _killfeedSequence: 0,
    _killfeedSlots: entries.map(entry => ({ entry, sequence: -1, fadeToken: 0 })),
    _killfeedSetTimeout: callback => { callbacks.push(callback); },
  });

  for (let i = 0; i < 6; i++) ui.killfeed('YOU', `TARGET ${i}`, i === 5, true);

  assert.equal(ui._killfeedSlots.length, 5);
  assert.match(entries[0].innerHTML, /TARGET 5/);
  assert.match(entries[0].innerHTML, /headshot/);
  assert.equal(entries[0].className, 'kf-entry friendly');

  callbacks[0]();
  assert.equal(entries[0].style.opacity, '1', 'an old timer cannot fade a reused slot');
  callbacks.slice(1).forEach(callback => callback());
  assert.equal(entries[0].style.opacity, '0', 'the current reused entry is faded by its current timer');
  assert.equal(entries[0].attributes['aria-hidden'], 'true');
});
