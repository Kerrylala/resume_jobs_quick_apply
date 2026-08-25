import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packaged = JSON.parse(fs.readFileSync(
  path.join(root, 'extensions/application_assistant/site_rules.local.example.json'),
  'utf8'
));

function mappingFor(domain, fieldName, attribute = 'name') {
  return packaged[domain]?.field_rules?.find(rule => rule.match?.[attribute] === fieldName);
}

test('Greenhouse core identity fields use exact high-confidence mappings', () => {
  assert.equal(mappingFor('greenhouse.io', 'first_name')?.profile_key, 'first_name');
  assert.equal(mappingFor('greenhouse.io', 'last_name')?.profile_key, 'last_name');
  assert.equal(mappingFor('greenhouse.io', 'email')?.profile_key, 'email');
  assert.equal(mappingFor('greenhouse.io', 'phone')?.profile_key, 'phone');
  assert.equal(mappingFor('greenhouse.io', 'first_name', 'id')?.profile_key, 'first_name');
  assert.equal(mappingFor('greenhouse.io', 'last_name', 'id')?.profile_key, 'last_name');
  assert.equal(mappingFor('greenhouse.io', 'email', 'id')?.profile_key, 'email');
  assert.equal(mappingFor('greenhouse.io', 'phone', 'id')?.profile_key, 'phone');
  assert.equal(packaged['greenhouse.io'].resume_upload_enabled, false);
  assert.equal(packaged['greenhouse.io'].resume_upload_mode, 'disabled');
});

test('Lever core identity and public-link fields use exact mappings', () => {
  assert.equal(mappingFor('lever.co', 'name')?.profile_key, 'full_name');
  assert.equal(mappingFor('lever.co', 'email')?.profile_key, 'email');
  assert.equal(mappingFor('lever.co', 'phone')?.profile_key, 'phone');
  assert.equal(mappingFor('lever.co', 'location')?.profile_key, 'city');
  assert.equal(mappingFor('lever.co', 'urls[LinkedIn]')?.profile_key, 'linkedin');
  assert.equal(mappingFor('lever.co', 'urls[GitHub]')?.profile_key, 'github');
  assert.equal(mappingFor('lever.co', 'urls[Github]')?.profile_key, 'github');
  assert.equal(mappingFor('lever.co', 'urls[Portfolio]')?.profile_key, 'portfolio');
  assert.equal(packaged['lever.co'].resume_upload_enabled, false);
  assert.equal(packaged['lever.co'].resume_upload_mode, 'disabled');
});

test('real portal rules never authorize submit, authentication, or verification fields', () => {
  for (const domain of ['greenhouse.io', 'lever.co']) {
    const rules = packaged[domain];
    assert.equal(rules.checkbox_rules.length, 0);
    assert.equal(rules.radio_rules.length, 0);
    assert.ok(rules.never_fill.includes('password'));
    assert.ok(rules.never_fill.includes('captcha'));
    assert.ok(rules.never_fill.includes('submit application'));
    assert.equal(rules.field_rules.some(rule => /submit|password|captcha/i.test(rule.match?.name || '')), false);
  }
});
