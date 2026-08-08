import test from 'node:test';
import assert from 'node:assert/strict';
import { detectXboxBrowser, isXboxBrowser, requestBrowserFullscreen } from '../src/platform.js';

test('Xbox Edge signatures enable console compatibility mode', () => {
  assert.equal(isXboxBrowser({
    userAgent: 'Mozilla/5.0 (Xbox; Xbox One) AppleWebKit/537.36 Edge/44.18363.8131',
    platform: 'Xbox',
  }), true);
  assert.equal(isXboxBrowser({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140 Safari/537.36',
    platform: 'Win32',
  }), false);
  assert.equal(isXboxBrowser(
    { userAgent: 'desktop', platform: 'Win32' },
    { search: '?compat=xbox' },
  ), true);
});

test('current Xbox Edge is detected from its high-entropy model hint', async () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/147 Safari/537.36 Edg/147',
    platform: 'Win32',
    userAgentData: {
      async getHighEntropyValues(requested) {
        assert.deepEqual(requested, ['model']);
        return { model: 'Xbox' };
      },
    },
  };
  assert.equal(isXboxBrowser(nav), false);
  assert.equal(await detectXboxBrowser(nav), true);
  assert.equal(isXboxBrowser(nav), true, 'the resolved hint remains available to synchronous consumers');
});

test('denied client hints leave ordinary desktop Edge unchanged', async () => {
  const nav = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edg/147',
    platform: 'Win32',
    userAgentData: { async getHighEntropyValues() { throw new Error('denied'); } },
  };
  assert.equal(await detectXboxBrowser(nav), false);
});

test('fullscreen request is available to controller and pointer entry paths', async () => {
  const calls = [];
  const doc = {
    fullscreenElement: null,
    documentElement: { async requestFullscreen(options) { calls.push(options); } },
  };
  assert.equal(await requestBrowserFullscreen(doc), true);
  assert.deepEqual(calls, [{ navigationUI: 'hide' }]);
  doc.fullscreenElement = {};
  assert.equal(await requestBrowserFullscreen(doc), false);
  assert.equal(calls.length, 1);
});
