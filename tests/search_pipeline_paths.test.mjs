import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeSearchPreferences } from '../scripts/lib/search_preferences.mjs';
import { searchConfigurationFingerprint } from '../scripts/lib/workflow_state.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Dashboard scoring uses the configured runtime data directory and current Search Configuration', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-search-pipeline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  const profilePath = path.join(root, 'candidate-profile.json');
  fs.mkdirSync(dataDir, { recursive: true });
  const search = normalizeSearchPreferences({
    active_search_profile_id: 'runtime-search',
    workflow_meta: { configured_at: '2026-07-24T00:00:00.000Z' },
    search_profiles: [{
      id: 'runtime-search',
      name: 'Runtime Search',
      enabled: true,
      target_roles: ['Product Manager'],
      preferred_locations: ['Remote'],
      workplace_modes: ['remote'],
      seniority_levels: ['mid'],
      required_skills: [],
      preferred_skills: ['analytics'],
      excluded_keywords: [],
      excluded_companies: [],
      posted_within_days: 30,
      job_types: ['full_time'],
      minimum_salary: null,
      maximum_search_results: 10,
      maximum_jobs_to_open: 2
    }]
  }, { strict: true }).value;
  fs.writeFileSync(path.join(dataDir, 'search_preferences.json'), `${JSON.stringify(search, null, 2)}\n`);
  fs.writeFileSync(path.join(dataDir, 'job_leads.json'), `${JSON.stringify([{
    job_id: 'runtime-job',
    title: 'Product Manager',
    company: 'Synthetic Runtime Company',
    location: 'Remote',
    remote_policy: 'remote',
    seniority: 'mid',
    job_type: 'full_time',
    provider: 'greenhouse',
    url: 'https://boards.greenhouse.io/synthetic/jobs/runtime',
    description_text: 'Product analytics roadmapping'
  }], null, 2)}\n`);
  fs.writeFileSync(profilePath, `${JSON.stringify({
    approved_for_real_applications: false,
    work_background: { years_experience: '4', skills: ['analytics', 'roadmapping'] },
    education: { degree: 'Bachelor of Science' },
    job_preferences: { target_roles: ['Product Manager'] },
    identity: { city: 'Remote' },
    field_provenance: {
      skills: { source: 'resume_document', confidence: 0.8, user_confirmed: false }
    }
  }, null, 2)}\n`);

  execFileSync(process.execPath, ['scripts/score_jobs.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_PROFILE_PATH: profilePath
    },
    stdio: 'pipe'
  });

  const scored = JSON.parse(fs.readFileSync(path.join(dataDir, 'jobs_shortlist.json'), 'utf8'));
  assert.equal(scored.length, 1);
  assert.equal(scored[0].job_id, 'runtime-job');
  assert.equal(scored[0].search_configuration_fingerprint, searchConfigurationFingerprint(search));
  assert.ok(scored[0].scored_at);
  assert.equal(scored[0].score_breakdown.technical_match.status, 'matched');
  assert.equal(scored[0].score_breakdown.career_direction_match.status, 'matched');
  assert.ok(Number.isFinite(scored[0].score_breakdown.candidate_fit_score));
});
