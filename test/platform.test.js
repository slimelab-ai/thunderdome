import test from 'node:test';
import assert from 'node:assert/strict';
import { isXboxBrowser } from '../src/platform.js';
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

test('Xbox announcer stays near the native voice range', () => {
  const xbox = announcerSpeechProfile({ userAgent: 'Mozilla/5.0 (Xbox; Xbox One)' });
  const desktop = announcerSpeechProfile({ userAgent: 'Mozilla/5.0 (Windows NT 10.0)' });
  assert.ok(xbox.pitch >= 0.9);
  assert.ok(xbox.rate <= desktop.rate);
  assert.ok(desktop.pitch > 0.55, 'desktop voice also avoids the old extreme pitch shift');
});
