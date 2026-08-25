import assert from 'node:assert/strict';
import test from 'node:test';

import { PORTAL_ADAPTERS, isLeverApplicationUrl, resolvePortalAdapter } from '../scripts/lib/portal_adapters.mjs';

test('priority portals resolve from synthetic URLs without network access', () => {
  assert.equal(resolvePortalAdapter('https://boards.greenhouse.io/synthetic/jobs/1').portal, 'greenhouse');
  assert.equal(resolvePortalAdapter('https://jobs.lever.co/synthetic/role').portal, 'lever');
  assert.equal(resolvePortalAdapter('https://tenant.myworkdayjobs.com/en-US/jobs/role').portal, 'workday');
});

test('Lever application-page detection accepts only public HTTPS /apply pages', () => {
  const applicationUrl = 'https://jobs.lever.co/synthetic/11111111-1111-4111-8111-111111111111/apply';
  assert.equal(isLeverApplicationUrl(applicationUrl), true);
  assert.equal(isLeverApplicationUrl(applicationUrl.replace('/apply', '')), false);
  assert.equal(isLeverApplicationUrl(applicationUrl.replace('https:', 'http:')), false);
  assert.equal(isLeverApplicationUrl('https://example.com/synthetic/role/apply'), false);
  assert.equal(resolvePortalAdapter(applicationUrl).application_page_detected, true);
  assert.equal(resolvePortalAdapter(applicationUrl.replace('/apply', '')).application_page_detected, false);
});

test('portal capabilities preserve user control over risky actions', () => {
  for (const portal of ['greenhouse', 'lever', 'workday']) {
    const capabilities = PORTAL_ADAPTERS[portal].capabilities;
    assert.equal(capabilities.fill_safe_known_fields, true);
    assert.equal(capabilities.learn_field_mappings, true);
    assert.equal(capabilities.attach_resume, 'explicit_user_action_only');
    assert.equal(capabilities.handle_login, false);
    assert.equal(capabilities.handle_captcha_or_mfa, false);
    assert.equal(capabilities.final_submit, false);
  }
});

test('Workday is honestly marked as detector-only discovery with limited dynamic form support', () => {
  assert.equal(PORTAL_ADAPTERS.workday.discovery, 'detector_only');
  assert.equal(PORTAL_ADAPTERS.workday.maturity, 'limited_dynamic_form_preview');
});

test('expected portal fields are unique and include the resume gate', () => {
  for (const portal of ['greenhouse', 'lever', 'workday']) {
    const fields = PORTAL_ADAPTERS[portal].expected_fields;
    assert.equal(new Set(fields.map((field) => field.key)).size, fields.length);
    assert.ok(fields.some((field) => field.key === 'resume_file' && field.required));
  }
});
