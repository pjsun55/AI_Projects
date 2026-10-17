import test from 'node:test';
import assert from 'node:assert/strict';
import { affectedApps } from '../tools/changed-apps.mjs';

test('a commute change does not require the experimental lab tests', () => {
  assert.deepEqual(affectedApps(['commute-lingo/public/app.mjs']), { lab: false, commute: true });
  assert.deepEqual(affectedApps(['commute-lingo/package-lock.json']), { lab: false, commute: true });
});
test('lab changes stay separate, including its test dependencies', () => {
  assert.deepEqual(affectedApps(['ios-pwa-lab/public/app.js', 'ios-pwa-lab/package-lock.json']), { lab: true, commute: false });
  assert.deepEqual(affectedApps(['ios-pwa-lab/tests/browser/app.spec.js', 'commute-lingo/public/styles.css']), { lab: true, commute: true });
});
test('shared release control changes verify both applications', () => {
  for (const file of ['.github/workflows/ios-pwa-lab.yml', 'commute-lingo/tools/changed-apps.mjs', 'commute-lingo/tools/package-pages.mjs']) assert.deepEqual(affectedApps([file]), { lab: true, commute: true });
});
test('unrelated projects, similar prefixes and local documents cannot masquerade as app changes', () => {
  assert.deepEqual(affectedApps(['gdim-mobile/public/app.js', 'commute-lingo-backup/public/app.mjs', 'commute-lingo/VERIFICATION.md']), { lab: false, commute: false });
});
