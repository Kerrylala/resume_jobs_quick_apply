import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOfflineDemoDiscovery } from '../scripts/lib/offline_demo_jobs.mjs';
import { normalizeSearchPreferences } from '../scripts/lib/search_preferences.mjs';

test('offline Dashboard demo creates one current-search localhost job without external side effects', () => {
  const searchPreferences = normalizeSearchPreferences({
    active_search_profile_id: 'qa-search',
    search_profiles: [{
      id: 'qa-search',
      name: 'QA Search',
      enabled: true,
      target_roles: [{ keyword: 'Software Engineer', weight: 100, enabled: true }],
      preferred_locations: [{ keyword: 'Remote', weight: 100, enabled: true }],
      workplace_modes: ['remote'],
      seniority_levels: ['mid'],
      required_skills: ['JavaScript'],
      preferred_skills: ['Node.js'],
      excluded_keywords: [],
      excluded_companies: [],
      posted_within_days: 30,
      job_types: ['full_time'],
      minimum_salary: null,
      maximum_search_results: 10,
      maximum_jobs_to_open: 1
    }],
    workflow_meta: { configured_at: '2026-07-24T00:00:00.000Z' }
  }).value;

  const result = buildOfflineDemoDiscovery({
    searchPreferences,
    dashboardPort: 18770,
    now: '2026-07-24T00:00:00.000Z'
  });

  assert.equal(result.job.title, 'Software Engineer');
  assert.equal(result.job.location, 'Remote');
  assert.match(result.job.description_text, /JavaScript/);
  assert.match(result.job.description_text, /Node\.js/);
  assert.equal(result.job.url, 'http://127.0.0.1:18770/mock-ats/jobs/123456');
  assert.equal(result.job.source, 'offline_demo_fixture');
  assert.deepEqual(result.job.tags, ['offline_demo', 'synthetic', 'localhost_only']);
  assert.equal(result.job.submit_allowed, false);
  assert.equal(result.job.upload_resume_allowed, false);
  assert.equal(result.job.final_submit_allowed, false);
  assert.equal(result.searchRun.status, 'completed');
  assert.equal(result.searchRun.network_accessed, false);
  assert.equal(
    result.searchRun.search_configuration_fingerprint,
    result.job.search_configuration_fingerprint
  );
  assert.equal(result.providerHealth.offline_demo_fixture.localhost_only, true);
});
