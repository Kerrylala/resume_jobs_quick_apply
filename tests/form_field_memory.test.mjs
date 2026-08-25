// Field memory in the thin-bridge architecture.
//
// Learning lives on the BACKEND (scripts/lib/learning_candidates.mjs, with its
// own tests). The extension keeps no memory of its own: confirmed field-memory
// records travel to it inside the ApplicationExecutionSession, and only
// user-confirmed, active records may influence a fill. This file pins that
// boundary at the source level.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contentSource = fs.readFileSync(path.join(root, 'extensions/application_assistant/content.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(root, 'extensions/application_assistant/popup.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(root, 'extensions/application_assistant/background.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions/application_assistant/manifest.json'), 'utf8'));

test('the extension has no local learning store', () => {
  // The old architecture kept a field_memory module writing observations into
  // chrome.storage. The thin bridge must not: no module, no storage
  // permission, no storage API anywhere.
  assert.equal(fs.existsSync(path.join(root, 'extensions/application_assistant/field_memory.js')), false,
    'the extension-local field memory module must stay deleted');
  assert.equal(manifest.permissions.includes('storage'), false);
  for (const [name, source] of [['content.js', contentSource], ['popup.js', popupSource], ['background.js', backgroundSource]]) {
    assert.doesNotMatch(source, /chrome\.storage/, `${name} must never touch chrome.storage`);
  }
});

test('confirmed field memory reaches the extension only through the session', () => {
  assert.match(contentSource, /confirmed_form_field_memory/);
  // Only user-confirmed, active records may become rules — a suggestion that
  // was never confirmed must stay inert.
  assert.match(contentSource, /record\?\.user_confirmed !== true \|\| record\?\.status !== 'active'/);
  // The backend remains the owner of learning; the handoff carries the records.
  const serverSource = fs.readFileSync(path.join(root, 'dashboard/server.mjs'), 'utf8');
  assert.match(serverSource, /confirmed_form_field_memory:\s*readFormFieldMemory\(\)/);
});

test('release manifest does not expose private profiles or inject into every website', () => {
  assert.equal(Object.hasOwn(manifest, 'web_accessible_resources'), false);
  assert.equal(manifest.host_permissions.includes('http://*/*'), false);
  assert.equal(manifest.host_permissions.includes('https://*/*'), false);
  assert.ok(manifest.host_permissions.every(pattern =>
    pattern.includes('localhost') || pattern.includes('127.0.0.1')
      || pattern.includes('greenhouse.io') || pattern.includes('lever.co') || pattern.includes('ashbyhq.com') || pattern.includes('workdayjobs.com')
      || pattern.includes('smartrecruiters.com') || pattern.includes('apply.workable.com')
      || pattern.includes('nowcoder.com')
  ));
  assert.doesNotMatch(contentSource, /getURL\(['"]profile\.local\.json/);
});
