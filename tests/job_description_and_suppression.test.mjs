import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDiscoveryPolicy,
  filterRejectedJobs,
  isSuppressedFromDefaultResults,
  mergeJobRecords,
  normalizeJobRecord
} from '../scripts/lib/job_records.mjs';
import { scoreJob } from '../scripts/score_jobs.mjs';

const SCORING_CONFIG = {
  scoring_config_version: 'synthetic-suppression-v1',
  target_roles: [{ keyword: 'Product Manager', weight: 100, enabled: true, aliases: [], terms: ['Product Manager'] }],
  preferred_locations: [{ keyword: 'Remote', weight: 100, enabled: true, aliases: [], terms: ['Remote'] }],
  preferred_companies: [],
  excluded_keywords: [],
  excluded_companies: [],
  required_skills: [],
  preferred_skills: [],
  workplace_modes: ['remote'],
  seniority_levels: ['mid'],
  posted_within_days: 30,
  job_types: ['full_time'],
  minimum_salary: null,
  maximum_jobs_to_open: 2,
  safety: { auto_approve: false, auto_submit: false, auto_upload_resume: false },
  scoring_weights: { base: 60, strong_role_match: 25, preferred_location: 10, preferred_company: 0 },
  thresholds: { shortlist_candidate: 80, manual_review_candidate: 65, keep_in_queue: 50 }
};

function discoveredJob(overrides = {}) {
  return {
    job_id: 'suppress-job-1',
    title: 'Product Manager',
    company: 'Synthetic Labs',
    location: 'Remote',
    url: 'https://boards.greenhouse.io/synthetic/jobs/9999',
    provider: 'greenhouse',
    ...overrides
  };
}

test('internal discovery markers never become the job description', () => {
  const marker = normalizeJobRecord(discoveredJob({
    description_text: '',
    notes: 'public_career_page_link_discovery'
  }));
  assert.equal(marker.description_text, '');
  assert.equal(marker.description_available, false);

  const real = normalizeJobRecord(discoveredJob({
    description_text: 'Own the roadmap for a synthetic analytics product.'
  }));
  assert.equal(real.description_available, true);

  const snippetOnly = normalizeJobRecord(discoveredJob({
    description_text: '',
    search_snippet: 'Synthetic snippet about the product role.'
  }));
  assert.equal(snippetOnly.description_available, true);

  const whitespace = normalizeJobRecord(discoveredJob({
    description_text: '   ',
    notes: 'standardized_from_legacy; detector=x'
  }));
  assert.equal(whitespace.description_available, false);
});

test('a content-free page cannot satisfy description evidence or dodge the penalty', () => {
  const base = discoveredJob({ posted_at: new Date().toISOString(), confidence: 0.95, info_quality: { score: 60 } });
  const markerOnly = scoreJob(normalizeJobRecord({ ...base, description_text: '', notes: 'public_career_page_link_discovery' }), SCORING_CONFIG);
  const withDescription = scoreJob(normalizeJobRecord({
    ...base,
    description_text: 'Product Manager owning roadmap and analytics for a synthetic remote team. '.repeat(4)
  }), SCORING_CONFIG);

  assert.equal(markerOnly.direct_posting_reasons.includes('has_description_text'), false);
  assert.ok(markerOnly.score_components.some(item => item.name === 'missing_description_penalty'));
  assert.equal(withDescription.score_components.some(item => item.name === 'missing_description_penalty'), false);
  assert.ok(withDescription.score > markerOnly.score);
});

test('board and navigation pages stay non-approvable even with a marker in notes', () => {
  const board = scoreJob(normalizeJobRecord(discoveredJob({
    url: 'https://example.test/jobs/search?q=product',
    page_type: 'aggregator_search',
    title: 'Search Jobs | Example Board',
    description_text: '',
    notes: 'public_career_page_link_discovery'
  })), SCORING_CONFIG);
  assert.equal(board.approval_safety.safe_to_approve, false);

  const careersHome = scoreJob(normalizeJobRecord(discoveredJob({
    url: 'https://careers.example.test/',
    page_type: 'company_careers_home',
    title: 'Careers at Example',
    description_text: '',
    notes: 'public_career_page_link_discovery'
  })), SCORING_CONFIG);
  assert.equal(careersHome.approval_safety.safe_to_approve, false);
});

test('rejected jobs stay suppressed across repeated discovery cycles and restore brings them back', () => {
  const now = '2026-08-15T00:00:00.000Z';
  const first = mergeJobRecords([], [discoveredJob()], { now });
  assert.equal(first.jobs.length, 1);
  const jobId = first.jobs[0].job_id;

  const rediscovered = mergeJobRecords(first.jobs, [discoveredJob()], { now: '2026-08-16T00:00:00.000Z' });
  assert.equal(rediscovered.jobs.length, 1);
  assert.equal(rediscovered.jobs[0].times_seen, 2);
  assert.equal(rediscovered.jobs[0].job_id, jobId);

  const suppressed = applyDiscoveryPolicy(rediscovered.jobs, {
    statusByJob: { [jobId]: 'rejected' },
    now: '2026-08-16T00:00:00.000Z'
  });
  const suppressedJob = suppressed.jobs.find(job => job.job_id === jobId);
  assert.equal(suppressedJob.discovery_rank.eligible, false);
  assert.equal(suppressedJob.discovery_rank.deferred_reason, 'rejected_history');
  assert.equal(suppressed.current_jobs.some(job => job.job_id === jobId), false);

  const thirdCycle = mergeJobRecords(suppressed.jobs, [discoveredJob()], { now: '2026-08-17T00:00:00.000Z' });
  assert.equal(thirdCycle.jobs.length, 1);

  const restored = applyDiscoveryPolicy(thirdCycle.jobs, {
    statusByJob: { [jobId]: 'pending' },
    preferences: { repeat_after_days: 0 },
    now: '2026-08-17T00:00:00.000Z'
  });
  const restoredJob = restored.jobs.find(job => job.job_id === jobId);
  assert.equal(restoredJob.discovery_rank.eligible, true);
});

test('the read-time policy suppresses rejected, applied, and in-progress jobs from default views', () => {
  assert.equal(isSuppressedFromDefaultResults({ lifecycleStatus: 'rejected' }), true);
  assert.equal(isSuppressedFromDefaultResults({ lifecycleStatus: 'applied' }), true);
  assert.equal(isSuppressedFromDefaultResults({ applicationStatus: 'PACKAGE_READY' }), true);
  assert.equal(isSuppressedFromDefaultResults({ applicationStatus: 'MANUALLY_SUBMITTED' }), true);
  assert.equal(isSuppressedFromDefaultResults({ lifecycleStatus: 'saved' }), false);
  assert.equal(isSuppressedFromDefaultResults({}), false);

  const rows = [
    { job_id: 'a', lifecycle_status: 'rejected' },
    { job_id: 'b', lifecycle_status: 'saved' },
    { job_id: 'c' }
  ];
  assert.deepEqual(filterRejectedJobs(rows).map(job => job.job_id), ['b', 'c']);
  assert.equal(filterRejectedJobs(rows, { includeRejected: true }).length, 3);
});
