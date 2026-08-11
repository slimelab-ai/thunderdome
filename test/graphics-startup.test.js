import test from 'node:test';
import assert from 'node:assert/strict';
import { graphicsFailureCopy } from '../src/graphics-startup.js';

test('Xbox graphics failure explains the full Edge quit recovery', () => {
  const copy = graphicsFailureCopy(true);
  assert.match(copy.title, /XBOX GRAPHICS DEVICE/);
  assert.ok(copy.steps.some(step => /choose Quit/i.test(step)));
  assert.match(copy.note, /fully quit/i);
  assert.match(copy.detail, /lowering.*quality will not fix/i);
});

test('desktop graphics failure offers general hardware acceleration guidance', () => {
  const copy = graphicsFailureCopy(false);
  assert.ok(copy.steps.some(step => /hardware acceleration/i.test(step)));
});
