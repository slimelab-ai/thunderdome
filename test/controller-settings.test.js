import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeControllerSettings, responseCurvePoints } from '../src/controller-settings.js';
import { DEFAULT_CONTROLLER_SETTINGS, STICK } from '../src/input.js';

test('controller settings normalize corrupt and out-of-range saved values', () => {
  assert.deepEqual(normalizeControllerSettings({}), DEFAULT_CONTROLLER_SETTINGS);
  assert.deepEqual(normalizeControllerSettings({
    sensitivity: 99,
    cursorSensitivity: 99,
    exponent: 0.2,
    aimAssist: -4,
  }), {
    sensitivity: 1.5,
    cursorSensitivity: 1.5,
    exponent: 1.2,
    aimAssist: 0,
  });
});

test('response curve visualizer includes the deadzone and selected exponent', () => {
  const linear = responseCurvePoints(1, 100);
  const soft = responseCurvePoints(2.5, 100);
  assert.equal(linear[0].output, 0);
  assert.equal(linear.at(-1).output, 1);
  assert.equal(soft.at(-1).output, 1);
  const insideDeadzone = Math.floor(STICK.deadzone * 100);
  assert.equal(soft[insideDeadzone].output, 0);
  assert.ok(soft[50].output < linear[50].output);
});
