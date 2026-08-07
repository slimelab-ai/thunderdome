import test from 'node:test';
import assert from 'node:assert/strict';
import { detectXboxBrowser, isXboxBrowser } from '../src/platform.js';
import { announcerSpeechProfile } from '../src/announcer.js';

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

test('Xbox announcer stays near the native voice range', () => {
  const xbox = announcerSpeechProfile({ userAgent: 'Mozilla/5.0 (Xbox; Xbox One)' });
  const desktop = announcerSpeechProfile({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
  assert.ok(xbox.pitch >= 0.9);
  assert.ok(xbox.rate <= desktop.rate);
  assert.ok(desktop.pitch > 0.55, 'desktop voice also avoids the old extreme pitch shift');
});
