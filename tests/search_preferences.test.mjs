import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SearchPreferencesValidationError,
  activeSearchProfile,
  normalizeSearchPreferences
} from '../scripts/lib/search_preferences.mjs';

const legacy = {
  target_roles: ['Product Manager'],
  target_cities: ['Shanghai'],
  remote_ok: true,
  hybrid_ok: false,
  onsite_ok: true,
  seniority_allowed: ['junior', 'mid'],
  positive_keywords: ['analytics'],
  negative_keywords: ['director'],
  min_salary: 20000
};
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('legacy preferences become one active profile without losing compatibility fields', () => {
  const { value } = normalizeSearchPreferences(legacy, { strict: true });
  assert.equal(value.search_profiles.length, 1);
  assert.equal(value.active_search_profile_id, 'default');
  assert.deepEqual(value.target_cities, ['Shanghai']);
  assert.equal(value.remote_ok, true);
  assert.equal(value.hybrid_ok, false);
  assert.equal(value.min_salary, 20000);
});

test('a named profile exposes every G1 search constraint', () => {
  const input = {
    active_search_profile_id: 'pm_remote',
    search_profiles: [{
      id: 'pm_remote',
      name: 'Remote PM',
      enabled: true,
      target_roles: ['Product Manager'],
      preferred_locations: ['Singapore'],
      workplace_modes: ['remote'],
      seniority_levels: ['junior', 'mid'],
      required_skills: ['roadmapping'],
      preferred_skills: ['analytics'],
      excluded_keywords: ['director'],
      excluded_companies: ['Example Corp'],
      posted_within_days: 14,
      job_types: ['full_time'],
      minimum_salary: 5000,
      maximum_search_results: 25,
      maximum_jobs_to_open: 3,
      show_unseen_only: true,
      include_previously_seen: true,
      do_not_repeat_rejected: true,
      repeat_after_days: 21,
      maximum_results_per_company: 2,
      minimum_source_diversity: 3
    }]
  };
  const { value } = normalizeSearchPreferences(input, { strict: true });
  assert.equal(activeSearchProfile(value).name, 'Remote PM');
  assert.equal(value.maximum_jobs_to_open, 3);
  assert.deepEqual(value.excluded_companies, ['Example Corp']);
  assert.deepEqual(value.required_skills, ['roadmapping']);
  assert.equal(value.show_unseen_only, true);
  assert.equal(value.include_previously_seen, false);
  assert.equal(value.repeat_after_days, 21);
  assert.equal(value.maximum_results_per_company, 2);
  assert.equal(value.minimum_source_diversity, 3);
});

test('multiple profiles and a copied profile remain in the same source object', () => {
  const base = normalizeSearchPreferences(legacy).value.search_profiles[0];
  const copy = { ...structuredClone(base), id: 'default_copy', name: 'Default Search Copy', enabled: false };
  const { value } = normalizeSearchPreferences({
    active_search_profile_id: base.id,
    search_profiles: [base, copy]
  }, { strict: true });
  assert.equal(value.search_profiles.length, 2);
  assert.equal(value.search_profiles[1].enabled, false);
});

test('invalid enums report the precise field', () => {
  const input = normalizeSearchPreferences(legacy).value;
  input.search_profiles[0].workplace_modes = ['teleport'];
  assert.throws(
    () => normalizeSearchPreferences(input, { strict: true }),
    error => error instanceof SearchPreferencesValidationError
      && error.issues.some(issue => issue.field.endsWith('.workplace_modes'))
  );
});

test('maximum jobs cannot exceed result limit', () => {
  const input = normalizeSearchPreferences(legacy).value;
  input.search_profiles[0].maximum_search_results = 2;
  input.search_profiles[0].maximum_jobs_to_open = 3;
  assert.throws(
    () => normalizeSearchPreferences(input, { strict: true }),
    error => error.issues.some(issue => issue.field.endsWith('.maximum_jobs_to_open'))
  );
});

test('duplicate ids and a disabled active profile are rejected', () => {
  const base = normalizeSearchPreferences(legacy).value.search_profiles[0];
  assert.throws(
    () => normalizeSearchPreferences({
      active_search_profile_id: base.id,
      search_profiles: [base, { ...base, enabled: false }]
    }, { strict: true }),
    error => error.issues.some(issue => issue.message.includes('duplicate profile id'))
  );
  assert.throws(
    () => normalizeSearchPreferences({
      active_search_profile_id: base.id,
      search_profiles: [{ ...base, enabled: false }]
    }, { strict: true }),
    error => error.issues.some(issue => issue.message.includes('enabled profile'))
  );
});

test('dangerous automation flags remain locked', () => {
  const { value, warnings } = normalizeSearchPreferences({
    ...legacy,
    safety: { auto_approve: true, auto_submit: true, auto_upload_resume: true }
  }, { strict: true });
  assert.deepEqual(value.safety, {
    auto_approve: false,
    auto_submit: false,
    auto_upload_resume: false,
    require_manual_review_before_application: true,
    // Uploading the tailored resume during an authorized fill is the one
    // automation the user may keep on; Submit itself never is.
    resume_upload_policy: 'auto',
    resume_format_preference: 'auto',
    // Per-category sensitive-question policy defaults: everything asks every
    // time, EEO demographics stay fully manual. CAPTCHA/login/submit have no
    // policy on purpose — they are hard-off.
    sensitive_policies: {
      work_authorization: 'ask',
      sponsorship: 'ask',
      eeo_demographics: 'manual',
      salary: 'ask',
      relocation: 'ask',
      start_date: 'ask',
      background_check: 'ask',
      other_sensitive: 'ask'
    }
  });
  assert.equal(warnings.length, 3);
});

test('resume upload policy accepts only its closed vocabulary', () => {
  const { value, warnings } = normalizeSearchPreferences({
    ...legacy,
    safety: { resume_upload_policy: 'always_yolo', resume_format_preference: 'rtf' }
  }, { strict: true });
  assert.equal(value.safety.resume_upload_policy, 'auto');
  assert.equal(value.safety.resume_format_preference, 'auto');
  assert.equal(warnings.filter(line => line.includes('resume_')).length, 2);
  const off = normalizeSearchPreferences({
    ...legacy,
    safety: { resume_upload_policy: 'never', resume_format_preference: 'pdf' }
  }, { strict: true });
  assert.equal(off.value.safety.resume_upload_policy, 'never');
  assert.equal(off.value.safety.resume_format_preference, 'pdf');
});

test('the existing Dashboard exposes the G1 profile editor and save entry', () => {
  const html = fs.readFileSync(path.join(PROJECT_ROOT, 'dashboard/public/index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PROJECT_ROOT, 'dashboard/public/app.js'), 'utf8');
  for (const marker of [
    'createSearchProfileBtn',
    'copySearchProfileBtn',
    'searchProfileSelect',
    'workplace_modes',
    'seniority_levels',
    'required_skills',
    'preferred_skills',
    'excluded_companies',
    'posted_within_days',
    'job_types',
    'minimum_salary',
    'maximum_search_results',
    'maximum_jobs_to_open',
    'show_unseen_only',
    'include_previously_seen',
    'do_not_repeat_rejected',
    'repeat_after_days',
    'maximum_results_per_company',
    'minimum_source_diversity'
  ]) {
    assert.match(html, new RegExp(marker));
  }
  assert.match(app, /createSearchProfile\(false\)/);
  assert.match(app, /createSearchProfile\(true\)/);
  assert.match(app, /\/api\/settings\/search-preferences/);
  assert.match(html, /id="sortJobs"/);
  assert.match(html, /id="jobSelectionStatus"/);
  assert.match(app, /score_breakdown/);
  assert.match(app, /toggleJobSelection/);
  assert.match(app, /maximum_jobs_to_open/);
  assert.match(html, /id="saveAnswerMemoryBtn"/);
  assert.match(app, /\/api\/settings\/question-answer/);
  assert.match(app, /content_hash/);
  assert.match(app, /approved_at/);
  assert.match(html, /id="resumeUploadFile"/);
  assert.match(html, /id="registerResumeFileBtn"/);
  assert.match(app, /\/api\/settings\/resume-upload/);
  assert.match(app, /confirmed_local_copy: true/);
  assert.match(app, /data-approve-resume-index/);
  assert.match(app, /\/approve/);
  assert.match(app, /data-analyze-resume-index/);
  assert.match(app, /\/analyze/);
  assert.match(app, /confirmed_local_analysis: true/);
  assert.match(html, /Upload automatically runs local parsing and creates an unapproved Profile draft for review/);
  assert.match(app, /next_view|switchView\('profile'\)/);
  assert.match(app, /data-apply-resume-suggestions/);
  assert.match(app, /\/apply-suggestions/);
  assert.match(app, /confirmed_apply: true/);
  assert.match(app, /Profile approval was revoked/);
  assert.match(html, /id="packageResumeSelect"/);
  assert.match(html, /id="rebuildPackageResumeBtn"/);
  assert.match(app, /resume_recommendation/);
  assert.match(app, /rebuildPackageWithSelectedResume/);
  assert.match(app, /\.replaceAll\('"', '&quot;'\)/);
  assert.match(app, /It does not attach, upload, or submit the resume/);
  assert.match(html, /id="candidateFactsSettings"/);
  assert.match(html, /id="confirmCandidateFactsBtn"/);
  assert.match(app, /\/api\/settings\/candidate-profile\/confirm/);
  assert.match(app, /This does not enable real-site autofill, resume upload, or final submission/);
});
