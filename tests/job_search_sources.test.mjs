import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  effectiveJobSearchProvider,
  normalizeJobSearchSources,
  publicJobSearchSources,
  SUGGESTED_SEARXNG_URL,
  testSearxngConnection,
  validateSearchProviderUrl
} from '../scripts/lib/job_search_sources.mjs';
import { createMockAIProvider } from '../scripts/lib/ai_provider.mjs';
import { enrichJobsWithLocalModel } from '../scripts/enrich_jobs_with_local_model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function configuredSources(overrides = {}) {
  return normalizeJobSearchSources({
    search_backends: {
      searxng_search: {
        enabled: true,
        url: 'http://127.0.0.1:8888/search',
        timeout_ms: 2500,
        max_results_per_query: 7,
        ...overrides
      }
    }
  });
}

test('first run keeps SearXNG disabled and suggests localhost without saving it', () => {
  const sources = publicJobSearchSources({}, {});
  assert.equal(sources.providers[0].status, 'DISABLED');
  assert.equal(sources.providers[0].saved_endpoint, '');
  assert.equal(sources.suggested_searxng_url, SUGGESTED_SEARXNG_URL);
  assert.equal(sources.offline_demo.synthetic, true);
  assert.equal(sources.offline_demo.network_accessed, false);
  assert.deepEqual(sources.source_catalog.china.map(source => source.name), [
    'Company careers', 'Public job pages', 'User-imported links', 'Assisted browsing'
  ]);
  assert.deepEqual(sources.source_catalog.global.map(source => source.name), [
    'Company careers', 'Public application forms', 'User-imported links', 'Assisted browsing'
  ]);
  assert.equal(sources.source_safety.captcha_or_mfa_bypass, false);
  assert.equal(sources.source_safety.search_failure_blocks_workflow, false);
});

test('saved provider configuration round-trips through the single job_sources contract', (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-provider-config-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const file = path.join(temp, 'job_sources.json');
  const saved = configuredSources();
  fs.writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
  const effective = effectiveJobSearchProvider(JSON.parse(fs.readFileSync(file, 'utf8')), {});
  assert.equal(effective.enabled, true);
  assert.equal(effective.url, 'http://127.0.0.1:8888/search');
  assert.equal(effective.timeout_ms, 2500);
  assert.equal(effective.max_results_per_query, 7);
  assert.equal(effective.enabled_source, 'job_sources.json');
});

test('explicit environment values remain compatible overrides', () => {
  const saved = configuredSources();
  assert.equal(effectiveJobSearchProvider(saved, { LIVE_JOB_SEARCH: '0' }).enabled, false);
  const overridden = effectiveJobSearchProvider(saved, {
    LIVE_JOB_SEARCH: '1',
    SEARXNG_URL: 'http://localhost:9999/search'
  });
  assert.equal(overridden.enabled, true);
  assert.equal(overridden.url, 'http://localhost:9999/search');
  assert.equal(overridden.url_source, 'SEARXNG_URL');
});

test('provider Test Connection reports READY for valid SearXNG JSON', async () => {
  const result = await testSearxngConnection(configuredSources().search_backends.searxng_search, {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() { return { results: [{ url: 'https://example.invalid/job' }] }; }
    }),
    now: () => '2026-07-25T00:00:00.000Z'
  });
  assert.equal(result.status, 'READY');
  assert.equal(result.ok, true);
  assert.equal(result.result_count, 1);
  assert.equal(result.last_error, '');
});

test('provider Test Connection distinguishes disabled, misconfigured, unreachable, and error', async () => {
  assert.equal((await testSearxngConnection({ enabled: false })).status, 'DISABLED');
  assert.equal((await testSearxngConnection({ enabled: true, url: '' })).status, 'MISCONFIGURED');
  assert.equal((await testSearxngConnection(configuredSources().search_backends.searxng_search, {
    fetchImpl: async () => { throw new Error('synthetic connection refusal'); }
  })).status, 'UNREACHABLE');
  assert.equal((await testSearxngConnection(configuredSources().search_backends.searxng_search, {
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { unexpected: true }; } })
  })).status, 'ERROR');
});

test('AI configuration is enrichment-only and never changes Live Search readiness', () => {
  const sources = configuredSources({ status: 'READY' });
  const withoutAi = publicJobSearchSources(sources, {});
  const withAi = publicJobSearchSources(sources, {
    LOCAL_LLM_ENABLED: '1',
    LOCAL_LLM_MODEL: 'synthetic-local-model'
  });
  assert.equal(withoutAi.providers[0].status, 'READY');
  assert.equal(withAi.providers[0].status, 'READY');
  assert.equal(withoutAi.ai_enrichment.status, 'DISABLED');
  assert.equal(withAi.ai_enrichment.status, 'READY');
});

test('AI enrichment adds explanations without changing provider, score, or approval state', async () => {
  const original = {
    job_id: 'synthetic-job',
    title: 'Product Manager',
    company: 'Synthetic Company',
    provider: 'greenhouse',
    match_score: 82,
    approval_status: 'pending',
    strengths: ['Product strategy'],
    gaps: ['Domain depth']
  };
  const provider = createMockAIProvider({
    semantic_job_match: {
      score: 88,
      recommendation: 'Apply',
      strengths: ['Product strategy'],
      weaknesses: ['Domain depth'],
      missing: [],
      career_reason: 'Strong product strategy alignment.',
      confidence: 0.88
    }
  });
  const enriched = await enrichJobsWithLocalModel({
    jobs: [original],
    provider,
    now: () => '2026-07-25T00:00:00.000Z'
  });
  assert.equal(enriched.jobs[0].provider, original.provider);
  assert.equal(enriched.jobs[0].match_score, original.match_score);
  assert.equal(enriched.jobs[0].approval_status, original.approval_status);
  assert.equal(enriched.jobs[0].ai_enrichment.model_used, true);
  assert.equal(enriched.jobs[0].hybrid_match.recommendation, 'Apply');
  assert.equal(enriched.jobs[0].hybrid_match.deterministic.score, original.match_score);
  assert.equal(enriched.result.deterministic_scores_changed, false);
  assert.equal(enriched.result.provider_availability_changed, false);
});

test('provider endpoint validation rejects credentials and insecure remote HTTP', () => {
  assert.throws(() => validateSearchProviderUrl('http://user:secret@localhost:8888/search'), /credentials/i);
  assert.throws(() => validateSearchProviderUrl('http://search.example.com/search'), /HTTPS/i);
  assert.equal(validateSearchProviderUrl('https://search.example.com/search'), 'https://search.example.com/search');
});

test('Dashboard includes provider guide, explicit modes, structured results, and no stdout rendering', () => {
  const html = fs.readFileSync(path.join(root, 'dashboard', 'public', 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'dashboard', 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'dashboard', 'server.mjs'), 'utf8');
  assert.match(html, /id="providerSetupGuide"/);
  assert.match(html, /Offline Demo \(synthetic, no network\)/);
  assert.match(html, /Live Search \+ AI Enrichment/);
  assert.match(html, /id="jobSearchSourcesSection"/);
  assert.match(html, /id="sourceCatalogContainer"/);
  assert.match(html, /id="homeRecommendedJobs"/);
  assert.match(html, /id="homeApplicationsSummary"/);
  assert.match(html, /What should I do today\?/);
  assert.match(html, /id="homeInterviewSummary"/);
  assert.match(html, /id="homeProfileImprovements"/);
  assert.match(html, /id="jobListSummary"/);
  assert.match(html, /id="loadMoreJobsBtn"/);
  assert.match(html, /Rejected history/);
  assert.match(html, /data-job-inventory="new"/);
  assert.match(html, /data-job-inventory="seen"/);
  assert.match(html, /id="inventoryAppliedCount"/);
  assert.match(html, /New and recent first/);
  assert.match(html, /id="searchPlanSummary"/);
  assert.match(html, /Review the target roles, adjacent paths, locations, keywords, and public sources before searching/);
  assert.match(html, /AI Fill Assistant/);
  assert.match(html, /id="packageCoverLetterPreview"/);
  assert.match(html, /id="packageInterviewQuestions"/);
  assert.match(html, /id="packageStarStories"/);
  assert.match(html, /id="packageMissingSkills"/);
  assert.match(html, /id="packageRiskLevel"/);
  assert.match(app, /renderSearchResultSummary/);
  assert.match(app, /Why fit/);
  assert.match(app, /Why not/);
  assert.match(app, /Why discovered/);
  assert.match(app, /Recommended action/);
  assert.match(app, /Immediate fit/);
  assert.match(app, /Career growth value/);
  assert.match(app, /const JOB_PAGE_SIZE = 5/);
  assert.match(app, /function jobLifecycleStatus/);
  assert.match(app, /function jobDiscoveryStatus/);
  assert.match(app, /function renderJobInventory/);
  assert.match(app, /function renderJobSearchPlan/);
  assert.match(app, /Continue & Approve/);
  assert.match(app, /Role title differs from your target\. Continue anyway/);
  assert.match(app, /View details/);
  assert.match(app, /data-career-item/);
  assert.match(app, /Advanced · JSON editor/);
  assert.match(app, /Use JSON values when saving/);
  assert.match(app, /function factValueHtml/);
  assert.match(app, /Advanced · structured fact JSON/);
  assert.match(app, /stickySaveCareerProfileBtn/);
  assert.match(app, /Edit \/ Save New Draft/);
  assert.doesNotMatch(app, /Record \$\{index \+ 1\}/);
  assert.match(server, /hybrid_match: job\.hybrid_match \|\| null/);
  assert.match(server, /lifecycle_status: lifecycleStatus/);
  assert.doesNotMatch(app, /stdout_tail/);
  assert.doesNotMatch(app, /stderr_tail/);
});
