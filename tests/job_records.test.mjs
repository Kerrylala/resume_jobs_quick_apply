import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDiscoveryPolicy,
  canonicalizeJobUrl,
  categorizeJobSource,
  mergeJobRecords,
  normalizeJobRecord,
  rankJobsByFreshness
} from '../scripts/lib/job_records.mjs';
import greenhouse from '../providers/greenhouse.mjs';
import { discoverJobs } from '../scripts/discover_jobs.mjs';

test('canonical URLs discard tracking, fragments, duplicate slashes and trailing slash', () => {
  assert.equal(
    canonicalizeJobUrl('https://www.example.com//jobs/42/?utm_source=x&msclkid=y&ref_src=z&b=2&a=1#apply'),
    'https://example.com/jobs/42?a=1&b=2'
  );
});

test('normalization creates stable ids and standard fields', () => {
  const first = normalizeJobRecord({
    source: 'fixture',
    source_job_id: '42',
    title: '  Product   Manager ',
    company: ' Example ',
    location: ' Remote ',
    country: 'Singapore',
    remote_policy: 'remote',
    salary: { minimum: 8000, maximum: 12000, currency: 'SGD', period: 'month' },
    requirements: ['Product strategy', 'Analytics'],
    posted_at: '2025-12-31',
    url: 'https://example.com/jobs/42?utm_campaign=a',
    description: ' Build products ',
    seniority: 'mid'
  }, { now: '2026-01-01T00:00:00.000Z' });
  const second = normalizeJobRecord({
    source: 'other',
    url: 'https://example.com/jobs/42'
  }, { now: '2026-02-01T00:00:00.000Z' });
  assert.equal(first.job_id, second.job_id);
  assert.equal(first.status, 'discovered');
  assert.equal(first.title, 'Product Manager');
  assert.equal(first.source_job_id, '42');
  assert.equal(first.first_seen_at, '2026-01-01T00:00:00.000Z');
  assert.equal(first.source_type, 'public_page');
  assert.equal(first.country, 'Singapore');
  assert.equal(first.remote, 'remote');
  assert.equal(first.salary.currency, 'SGD');
  assert.deepEqual(first.requirements, ['Product strategy', 'Analytics']);
  assert.equal(first.posted_date, '2025-12-31');
  assert.equal(first.first_seen, '2026-01-01T00:00:00.000Z');
  assert.equal(first.last_seen, '2026-01-01T00:00:00.000Z');
  assert.equal(first.times_seen, 1);
  assert.equal(first.discovery_status, 'new');
  assert.deepEqual(first.discovery_memory, {
    first_seen: '2026-01-01T00:00:00.000Z',
    last_seen: '2026-01-01T00:00:00.000Z',
    times_seen: 1,
    status: 'new',
    source: 'fixture'
  });
});

test('every normalized job keeps transparent discovery evidence', () => {
  const job = normalizeJobRecord({
    source: 'searxng_public_search',
    provider: 'greenhouse',
    title: 'Product Manager',
    company: 'Example',
    location: 'Remote',
    url: 'https://job-boards.greenhouse.io/example/jobs/42',
    search_query: 'Product Manager Remote careers',
    search_time: '2026-08-10T01:02:03.000Z',
    why_discovered: 'Matched a saved Product Manager search.'
  }, { now: '2026-08-10T01:02:03.000Z' });
  assert.deepEqual(job.discovery, {
    source: 'searxng_public_search',
    query: 'Product Manager Remote careers',
    searched_at: '2026-08-10T01:02:03.000Z',
    why_discovered: 'Matched a saved Product Manager search.',
    provider: 'greenhouse',
    // Full provenance: mechanism + exact page, so the UI can always answer
    // "这个岗位从哪里来的？".
    discovered_by: 'ats',
    discovered_at: '2026-08-10T01:02:03.000Z',
    original_url: 'https://job-boards.greenhouse.io/example/jobs/42'
  });
  assert.equal(job.source_market, 'global');
  assert.equal(job.source_category, 'ats');
  assert.equal(job.source_category_label, 'Public application forms');
});

test('China and global source categories use the product taxonomy', () => {
  assert.deepEqual(categorizeJobSource({ country: 'China', source_type: 'company_career_page' }), {
    market: 'china', category: 'company_career', label: 'Company careers'
  });
  assert.deepEqual(categorizeJobSource({ location: '上海', source_type: 'user_provided_url' }), {
    market: 'china', category: 'user_imported_urls', label: 'User imported URLs'
  });
  assert.deepEqual(categorizeJobSource({ country: 'China', source_type: 'job_board' }), {
    market: 'china', category: 'public_job_pages', label: 'Public job pages'
  });
  assert.deepEqual(categorizeJobSource({ provider: 'lever', source_type: 'user_provided_url' }), {
    market: 'global', category: 'user_imported_urls', label: 'User imported URLs'
  });
});

test('discovery policy preserves history while deferring repeats and terminal lifecycle states', () => {
  const now = '2026-08-12T00:00:00.000Z';
  const jobs = [
    normalizeJobRecord({ job_id: 'new-a', company: 'One', source_type: 'company_career_page', url: 'https://one.example/jobs/a' }, { now }),
    normalizeJobRecord({ job_id: 'seen-b', company: 'Two', provider: 'lever', url: 'https://jobs.lever.co/two/b', discovery_status: 'previously_seen', times_seen: 2, last_seen: '2026-08-11T00:00:00.000Z' }, { now }),
    normalizeJobRecord({ job_id: 'rejected-c', company: 'Three', url: 'https://three.example/jobs/c' }, { now })
  ];
  const result = applyDiscoveryPolicy(jobs, {
    preferences: { repeat_after_days: 14, maximum_results_per_company: 3, minimum_source_diversity: 2 },
    statusByJob: { 'rejected-c': 'rejected' },
    now
  });
  assert.equal(result.jobs.length, 3);
  assert.deepEqual(result.current_jobs.map(job => job.job_id), ['new-a']);
  assert.deepEqual(result.deferred_jobs.map(job => job.discovery_rank.deferred_reason).sort(), ['rejected_history', 'repeat_wait']);
  assert.equal(result.quality.current_result_count, 1);
  assert.equal(result.quality.deferred_count, 2);
});

test('discovery policy prioritizes source diversity and enforces a per-company current-result limit', () => {
  const jobs = [
    normalizeJobRecord({ job_id: 'a1', company: 'One', source_type: 'company_career_page', url: 'https://one.example/jobs/1' }),
    normalizeJobRecord({ job_id: 'a2', company: 'One', source_type: 'company_career_page', url: 'https://one.example/jobs/2' }),
    normalizeJobRecord({ job_id: 'b1', company: 'Two', provider: 'lever', source_type: 'ats', url: 'https://jobs.lever.co/two/1' })
  ];
  const result = applyDiscoveryPolicy(jobs, {
    preferences: { repeat_after_days: 0, maximum_results_per_company: 1, minimum_source_diversity: 2 }
  });
  assert.deepEqual(result.current_jobs.map(job => job.job_id), ['a1', 'b1']);
  assert.equal(result.quality.source_diversity_count, 2);
  assert.equal(result.quality.source_diversity_met, true);
  assert.equal(result.quality.company_limit_deferred_count, 1);
  assert.equal(result.jobs.length, 3);
});

test('new jobs without posted dates keep provider order despite normalization timestamps', () => {
  const jobs = [
    normalizeJobRecord({ job_id: 'provider-first', company: 'First', url: 'https://first.example/jobs/1' }, { now: '2026-08-12T00:00:00.000Z' }),
    normalizeJobRecord({ job_id: 'provider-second', company: 'Second', url: 'https://second.example/jobs/2' }, { now: '2026-08-12T00:00:00.900Z' })
  ];
  assert.deepEqual(rankJobsByFreshness(jobs).map(job => job.job_id), ['provider-first', 'provider-second']);
});

test('legacy job ids are preserved for shortlist and review compatibility', () => {
  const normalized = normalizeJobRecord({
    job_id: 'legacy_job_42',
    url: 'https://example.com/jobs/42'
  });
  assert.equal(normalized.job_id, 'legacy_job_42');
});

test('multi-source duplicates merge and preserve first/last seen provenance', () => {
  const { jobs, duplicates_merged } = mergeJobRecords([
    {
      source: 'fixture_a',
      source_job_id: 'a-42',
      title: 'Product Manager',
      url: 'https://example.com/jobs/42?utm_source=a',
      first_seen_at: '2026-01-01T00:00:00.000Z'
    }
  ], [
    {
      source: 'fixture_b',
      source_job_id: 'b-42',
      title: 'Product Manager, AI',
      url: 'https://www.example.com/jobs/42/#details'
    }
  ], { now: '2026-02-01T00:00:00.000Z' });
  assert.equal(jobs.length, 1);
  assert.equal(duplicates_merged, 1);
  assert.equal(jobs[0].first_seen_at, '2026-01-01T00:00:00.000Z');
  assert.equal(jobs[0].last_seen_at, '2026-02-01T00:00:00.000Z');
  assert.equal(jobs[0].times_seen, 2);
  assert.equal(jobs[0].discovery_status, 'previously_seen');
  assert.equal(jobs[0].sources.length, 2);
  assert.equal(jobs[0].dedupe.reason, 'canonical_url_match');
});

test('repeating the same batch does not create another job', () => {
  const fixture = [{ source: 'fixture', source_job_id: '7', title: 'Analyst', url: 'https://example.com/jobs/7' }];
  const first = mergeJobRecords([], fixture, { now: '2026-01-01T00:00:00.000Z' });
  const second = mergeJobRecords(first.jobs, fixture, { now: '2026-01-02T00:00:00.000Z' });
  assert.equal(second.jobs.length, 1);
  assert.equal(second.jobs[0].job_id, first.jobs[0].job_id);
  assert.equal(second.jobs[0].last_seen_at, '2026-01-02T00:00:00.000Z');
  assert.equal(second.jobs[0].times_seen, 2);
  assert.equal(second.jobs[0].discovery_memory.status, 'previously_seen');
});

test('freshness ranking puts unseen jobs first and uses posted date within each group', () => {
  const ranked = rankJobsByFreshness([
    { job_id: 'repeated', discovery_status: 'previously_seen', times_seen: 4, posted_date: '2026-08-10', last_seen: '2026-08-10' },
    { job_id: 'explicit-seen', discovery_status: 'previously_seen', times_seen: 1, posted_date: '2026-08-11', last_seen: '2026-08-11' },
    { job_id: 'new-older', discovery_status: 'new', times_seen: 1, posted_date: '2026-08-01', last_seen: '2026-08-10' },
    { job_id: 'new-recent', discovery_status: 'new', times_seen: 1, posted_date: '2026-08-09', last_seen: '2026-08-10' }
  ]);
  assert.deepEqual(ranked.map(job => job.job_id), ['new-recent', 'new-older', 'explicit-seen', 'repeated']);
});

test('fixture discovery runs offline without persistence', async () => {
  const result = await discoverJobs({ fixture: true, dryRun: true, maxQueries: 1, maxResultsPerQuery: 10 });
  assert.equal(result.status, 'ok');
  assert.equal(result.mode, 'fixture-offline');
  assert.equal(result.network_accessed, false);
  assert.equal(result.job_leads_modified, false);
  assert.equal(result.deduped_jobs_count, 2);
  assert.equal(result.current_result_count, 2);
  assert.equal(result.new_result_count, 2);
  assert.equal(result.deferred_count, 0);
  assert.equal(result.provider_health.searxng_search.status, 'not_run_fixture_mode');
  assert.equal(result.provider_health.fixture_provider.ok, true);
  assert.equal(result.query_results.length, 1);
  assert.equal(result.query_results[0].query, result.generated_queries[0]);
  assert.equal(result.query_results[0].result_count, 2);
});

test('a repeated controlled search defers already-seen jobs without deleting them', async () => {
  const firstSeen = '2026-08-11T00:00:00.000Z';
  const existingJobs = [
    normalizeJobRecord({ source: 'fixture_provider', title: 'Synthetic Product Manager', company: 'fixture', url: 'https://fixture.example/jobs/pm-001' }, { now: firstSeen }),
    normalizeJobRecord({ source: 'fixture_provider', title: 'Synthetic Product Analyst', company: 'fixture', url: 'https://fixture.example/jobs/pa-002' }, { now: firstSeen })
  ];
  const result = await discoverJobs({
    fixture: true,
    dryRun: true,
    existingJobs,
    now: '2026-08-12T00:00:00.000Z',
    maxQueries: 1,
    maxResultsPerQuery: 10,
    preferences: {
      target_roles: ['Product Manager'],
      preferred_locations: ['Remote'],
      search_query_templates: ['{role} {location} jobs'],
      repeat_after_days: 14,
      maximum_results_per_company: 3,
      minimum_source_diversity: 1
    }
  });
  assert.equal(result.deduped_jobs_count, 2);
  assert.equal(result.current_result_count, 0);
  assert.equal(result.previously_seen_result_count, 0);
  assert.equal(result.deferred_count, 2);
  assert.equal(result.discovery_quality.deferred_reasons.repeat_wait, 2);
});

test('live discovery is disabled unless explicitly enabled', async () => {
  const result = await discoverJobs({ allowLiveSearch: false });
  assert.equal(result.status, 'READY_BUT_NOT_RUN');
  assert.equal(result.network_accessed, false);
  assert.equal(result.job_leads_modified, false);
});

test('the existing Greenhouse provider accepts a controlled entry with fake transport', async () => {
  const jobs = await greenhouse.fetch({
    name: 'Synthetic Company',
    api: 'https://boards-api.greenhouse.io/v1/boards/synthetic/jobs'
  }, {
    fetchJson: async () => ({
      jobs: [{
        id: 42,
        title: 'Product Manager',
        absolute_url: 'https://job-boards.greenhouse.io/synthetic/jobs/42',
        location: { name: 'Remote' }
      }]
    })
  });
  assert.deepEqual(jobs, [{
    title: 'Product Manager',
    url: 'https://job-boards.greenhouse.io/synthetic/jobs/42',
    company: 'Synthetic Company',
    location: 'Remote'
  }]);
});
