import test from 'node:test';
import assert from 'node:assert/strict';
import { nextTouchSprintState, TouchFireLatch, touchModeFromSignals } from '../src/touch.js';
import { normalizeTouchSettings } from '../src/touch-settings.js';

test('touch mode accepts real touch, coarse pointers, and emulated mobile user agents', () => {
  assert.equal(touchModeFromSignals({ maxTouchPoints: 1 }), true);
  assert.equal(touchModeFromSignals({ coarsePointer: true }), true);
  assert.equal(touchModeFromSignals({ mobileUserAgent: true }), true);
});

test('touch mode remains off on ordinary desktop signals', () => {
  assert.equal(touchModeFromSignals(), false);
});

test('a coarse console pointer does not enable the touch HUD', () => {
  assert.equal(touchModeFromSignals({ coarsePointer: true, excluded: true }), false);
});

test('touch query override wins over detected capabilities', () => {
  assert.equal(touchModeFromSignals({ override: '1' }), true);
  assert.equal(touchModeFromSignals({ override: '0', maxTouchPoints: 5, mobileUserAgent: true }), false);
});

test('touch settings accept known layouts and preserve an explicit zero assist', () => {
  assert.deepEqual(normalizeTouchSettings({ layout: 'claw', aimAssist: 0 }), {
    layout: 'claw',
    aimAssist: 0,
  });
  assert.equal(normalizeTouchSettings({ layout: 'unknown', aimAssist: 5 }).layout, 'thumbs');
  assert.equal(normalizeTouchSettings({ layout: 'left', aimAssist: 5 }).aimAssist, 1);
});

test('touch sprint requires a deliberate straight-forward slam', () => {
  assert.deepEqual(
    nextTouchSprintState({ magnitude: 0.95, dx: 0, dy: -0.95 }),
    { sprinting: false, blocked: false }
  );
  assert.deepEqual(
    nextTouchSprintState({ magnitude: 1, dx: 0.15, dy: -0.99 }),
    { sprinting: true, blocked: false }
  );
  assert.equal(
    nextTouchSprintState({ magnitude: 1, dx: 0.8, dy: -0.6 }).sprinting,
    false
  );
});

test('crouch or lean blocks auto sprint until the movement stick recenters', () => {
  const blocked = nextTouchSprintState({
    magnitude: 1, dx: 0, dy: -1, sprinting: true, stanceActive: true,
  });
  assert.deepEqual(blocked, { sprinting: false, blocked: true });
  assert.equal(
    nextTouchSprintState({ magnitude: 1, dx: 0, dy: -1, blocked: true }).sprinting,
    false
  );
  const reset = nextTouchSprintState({ magnitude: 0.2, dx: 0, dy: -0.2, blocked: true });
  assert.deepEqual(reset, { sprinting: false, blocked: false });
});

test('two fire buttons share one trigger without premature release', () => {
  const events = [];
  const latch = new TouchFireLatch(
    () => events.push('down'),
    () => events.push('up')
  );
  latch.press(1);
  latch.press(2);
  latch.release(1);
  assert.deepEqual(events, ['down']);
  latch.release(2);
  assert.deepEqual(events, ['down', 'up']);
});
