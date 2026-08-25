import fs from 'fs';
import path from 'path';
import { detectProvider } from '../providers/provider_detector.mjs';
import { searchSearxng } from '../providers/searxng_search/index.mjs';
import { extractPublicJob as extractGeneric } from '../providers/generic_company_careers/index.mjs';
import { applyDiscoveryPolicy, canonicalizeJobUrl, mergeJobRecords, normalizeJobRecord } from './lib/job_records.mjs';
import { writeJsonAtomic } from './lib/json_repository.mjs';
import { isMainModule, projectRootFromMetaUrl } from './lib/project_paths.mjs';
import { normalizeSearchPreferences } from './lib/search_preferences.mjs';
import { searchConfigurationFingerprint } from './lib/workflow_state.mjs';
import { normalizeCareerBrainStore } from './lib/career_brain.mjs';
import { buildJobSearchPlan } from './lib/job_search_agent.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const dataDir = path.resolve(process.env.RESUME_JOBS_DATA_DIR || path.join(root, 'data'));
const reportsDir = path.resolve(process.env.RESUME_JOBS_REPORTS_DIR || path.join(root, 'reports'));
const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888/search';
const DEFAULT_LIMITS = { max_queries: 10, max_results_per_query: 5, max_pages_per_provider: 1, delay_ms: 2000, timeout_ms: 12000 };
const TEST_QUERIES = [
  'AI Product Manager Shanghai careers',
  'Associate Product Manager Singapore jobs',
  'Product Analyst Hong Kong careers',
  '数据产品经理 AI 官网招聘 上海',
  'AI 产品经理 校招 官网招聘 北京',
  'site:myworkdayjobs.com Product Manager China',
  'site:careers.* AI Product Manager Shanghai',
  'site:jobs.lever.co Product Analyst Singapore',
  'site:greenhouse.io Associate Product Manager Hong Kong',
  'site:ashbyhq.com Product Manager APAC'
];
const FIXTURE_RESULTS = [
  { title: 'Synthetic Product Manager', url: 'https://fixture.example/jobs/pm-001?utm_source=test', content: 'Synthetic product role' },
  { title: 'Synthetic Product Analyst', url: 'https://fixture.example/jobs/pa-002', content: 'Synthetic analyst role' }
];

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function writeJson(file, value) { writeJsonAtomic(file, value); }
function recordSearchRun(run, preferences) {
  const normalized = normalizeSearchPreferences(preferences).value;
  const fingerprint = searchConfigurationFingerprint(normalized);
  const filePath = path.join(dataDir, 'search_runs.json');
  const source = readJson(filePath, []);
  const runs = Array.isArray(source) ? source : (Array.isArray(source?.runs) ? source.runs : []);
  const completed = run.status === 'ok' && run.searxng_reachable === true;
  const record = {
    run_id: `search_${Date.now()}`,
    search_configuration_fingerprint: fingerprint,
    search_profile_id: normalized.active_search_profile_id || '',
    status: completed ? 'completed' : 'failed',
    started_at: run.started_at || null,
    completed_at: new Date().toISOString(),
    provider: 'searxng_search',
    source: 'searxng_search',
    queries: Array.isArray(run.generated_queries) ? run.generated_queries : [],
    filters: {
      search_profile_id: normalized.active_search_profile_id || '',
      target_roles: normalized.target_roles || [],
      preferred_locations: normalized.preferred_locations || [],
      workplace_modes: normalized.workplace_modes || [],
      seniority_allowed: normalized.seniority_allowed || []
    },
    query_results: Array.isArray(run.query_results) ? run.query_results : [],
    provider_reachable: run.searxng_reachable === true,
    discovered_urls_count: Number(run.discovered_urls_count || 0),
    deduped_jobs_count: Number(run.deduped_jobs_count || 0),
    current_result_count: Number(run.current_result_count || 0),
    new_result_count: Number(run.new_result_count || 0),
    previously_seen_result_count: Number(run.previously_seen_result_count || 0),
    deferred_count: Number(run.deferred_count || 0),
    discovery_policy: run.discovery_policy || {},
    discovery_quality: run.discovery_quality || {},
    error: run.exact_error || run.reason || ''
  };
  writeJson(filePath, [...runs, record].slice(-100));
  return {
    ...run,
    search_configuration_fingerprint: fingerprint,
    search_run: record,
    search_completed: completed
  };
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function normalizeUrl(value) { return canonicalizeJobUrl(value); }
function regionFromLocation(text) { const t = String(text || '').toLowerCase(); if (/singapore|新加坡/.test(t)) return 'Singapore'; if (/hong kong|香港/.test(t)) return 'Hong Kong'; if (/shanghai|上海|beijing|北京|china|中国|深圳|杭州/.test(t)) return 'China'; if (/apac/.test(t)) return 'APAC'; return ''; }
function companyFromUrl(url) { try { const h = new URL(url).hostname.replace(/^www\./, ''); const parts = new URL(url).pathname.split('/').filter(Boolean); if (/greenhouse|lever|ashby|smartrecruiters/.test(h) && parts[0]) return parts[0]; return h.split('.')[0]; } catch { return ''; } }
function titleFromSearch(result) { return String(result?.title || '').replace(/\s+/g, ' ').trim().slice(0, 220); }

function parseArgs(argv = process.argv.slice(2)) {
  const args = { dryRun: false, fixture: false, allowLiveSearch: false, maxQueries: null, maxResultsPerQuery: null, searxngUrl: '', timeoutMs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--fixture') args.fixture = true;
    else if (arg === '--allow-live-search') args.allowLiveSearch = true;
    else if (arg === '--max-queries') args.maxQueries = Number(argv[++i]);
    else if (arg.startsWith('--max-queries=')) args.maxQueries = Number(arg.split('=')[1]);
    else if (arg === '--max-results-per-query') args.maxResultsPerQuery = Number(argv[++i]);
    else if (arg.startsWith('--max-results-per-query=')) args.maxResultsPerQuery = Number(arg.split('=')[1]);
    else if (arg === '--searxng-url') args.searxngUrl = argv[++i] || '';
    else if (arg.startsWith('--searxng-url=')) args.searxngUrl = arg.slice('--searxng-url='.length);
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg.startsWith('--timeout-ms=')) args.timeoutMs = Number(arg.split('=')[1]);
  }
  return args;
}

function resolveSearxngUrl({ cliUrl = '', env = process.env } = {}) {
  const jobSources = readJson(path.join(dataDir, 'job_sources.json'), {});
  const configUrl = jobSources?.search_backends?.searxng_search?.url || '';
  const url = cliUrl || env.SEARXNG_URL || configUrl || DEFAULT_SEARXNG_URL;
  return {
    url,
    source: cliUrl ? 'cli --searxng-url' : env.SEARXNG_URL ? 'env SEARXNG_URL' : configUrl ? 'data/job_sources.json' : 'default',
    default_url: DEFAULT_SEARXNG_URL
  };
}

function standardizeExistingLead(job) {
  const rawUrl = normalizeUrl(job.url || job.job_url || job.apply_url || '');
  if (!rawUrl) return null;
  const detection = detectProvider(rawUrl);
  const title = String(job.title || job.search_title || '').replace(/\s+/g, ' ').trim();
  const location = String(job.location || job.city || '').trim();
  const company = String(job.company || '').trim() || companyFromUrl(rawUrl);
  const confidenceText = String(job.discovery_confidence || '').toLowerCase();
  const confidence = Number(job.confidence || 0) || (confidenceText === 'high' ? 0.8 : confidenceText === 'medium' ? 0.6 : Math.max(detection.confidence || 0, 0.35));
  return normalizeJobRecord({
    ...job,
    job_id: String(job.job_id || job.lead_id || ''),
    source: String(job.source || 'legacy_job_leads'),
    provider: detection.provider || job.provider || job.provider_guess || 'unknown',
    ats: detection.ats || job.ats || '',
    company,
    title,
    location,
    country_or_region: String(job.country_or_region || job.country || regionFromLocation(`${location} ${job.query || ''}`) || ''),
    url: rawUrl,
    apply_url: normalizeUrl(job.apply_url || rawUrl) || rawUrl,
    description_text: String(job.description_text || job.search_snippet || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
    discovered_at: String(job.discovered_at || job.date_found || new Date().toISOString()),
    status: 'discovered',
    risk_level: 'public_metadata_only',
    confidence: Number(confidence.toFixed ? confidence.toFixed(2) : Number(confidence).toFixed(2)),
    tags: Array.from(new Set([...(Array.isArray(job.tags) ? job.tags : []), 'legacy_standardized', detection.provider || 'unknown'])),
    notes: String(job.notes || `standardized_from_legacy; detector=${detection.reason || ''}`).slice(0, 1000)
  });
}

function standardJob({ url, query, result, detection, extract }) {
  const discoveredAt = new Date().toISOString();
  const title = extract?.title || titleFromSearch(result);
  const location = extract?.location || (query.match(/Shanghai|Singapore|Hong Kong|Beijing|上海|北京|APAC|China/i)?.[0] || '');
  const company = extract?.company || companyFromUrl(url);
  const confidence = Math.max(Number(detection.confidence || 0), Number(extract?.confidence || 0), result?.score ? 0.45 : 0.35);
  return normalizeJobRecord({
    source: 'searxng_public_search',
    provider: detection.provider || 'unknown',
    ats: detection.ats || '',
    company,
    title,
    location,
    country_or_region: regionFromLocation(`${location} ${query}`),
    url,
    apply_url: extract?.apply_url || url,
    description_text: String(extract?.description_text || result?.content || '').replace(/\s+/g, ' ').trim().slice(0, 5000),
    discovered_at: discoveredAt,
    search_query: query,
    search_time: discoveredAt,
    why_discovered: `Matched the public search query: ${query}`,
    discovery: {
      source: 'searxng_public_search',
      query,
      searched_at: discoveredAt,
      why_discovered: `Matched the public search query: ${query}`,
      provider: detection.provider || 'unknown'
    },
    status: 'discovered',
    risk_level: 'public_metadata_only',
    confidence: Number(confidence.toFixed(2)),
    tags: ['public_search', detection.provider || 'unknown'].filter(Boolean),
    notes: `query=${query}; detector=${detection.reason || ''}; no_apply_opened`
  }, { now: discoveredAt, defaultSource: 'searxng_public_search' });
}

function enabledKeywords(items, fallback = []) {
  if (!Array.isArray(items)) return fallback;
  const enabled = items
    .filter((item) => item && (typeof item === 'string' || item.enabled === true))
    .map((item) => String(typeof item === 'string' ? item : item.keyword || '').trim())
    .filter(Boolean);
  return enabled.length ? enabled : fallback;
}

export function generateQueries(preferences = {}, limits = DEFAULT_LIMITS) {
  const roles = enabledKeywords(preferences.target_roles, ['AI Product Manager', 'Associate Product Manager', 'Product Analyst']);
  const locations = enabledKeywords(preferences.preferred_locations || preferences.locations || preferences.target_cities, ['Shanghai', 'Singapore', 'Hong Kong']);
  const templates = Array.isArray(preferences.search_query_templates) && preferences.search_query_templates.length
    ? preferences.search_query_templates.map((template) => String(template || '').trim()).filter(Boolean)
    : ['{role} {location} careers', '{role} {location} jobs'];
  const generated = [];
  for (const role of roles) {
    for (const location of locations) {
      for (const template of templates) {
        generated.push(template.replaceAll('{role}', role).replaceAll('{location}', location).replaceAll('{company}', '').replace(/\s+/g, ' ').trim());
      }
    }
  }
  return Array.from(new Set(generated.map((q) => q.trim()).filter(Boolean))).slice(0, limits.max_queries);
}

function fallbackFromExistingSources(limit = 20) {
  const jobSources = readJson(path.join(dataDir, 'job_sources.json'), {});
  const backends = jobSources?.search_backends || {};
  const fallbackSources = [];
  for (const [backendName, backend] of Object.entries(backends)) {
    for (const source of Array.isArray(backend?.sources) ? backend.sources : []) {
      if (source?.enabled === false || source?.requires_login === true) continue;
      const url = normalizeUrl(source.url);
      if (!url) continue;
      const detection = detectProvider(url);
      fallbackSources.push({
        source_id: source.source_id || '',
        backend: backendName,
        title: source.title || '',
        url,
        provider_hint: source.provider || '',
        detected_provider: detection.provider,
        detector_confidence: detection.confidence,
        action: 'available_as_existing_source_fallback_only_not_written_to_job_leads'
      });
    }
  }
  return fallbackSources.slice(0, limit);
}

function buildScraplingPlan() {
  return {
    status: 'planned_not_enabled',
    should_only_run_when: [
      'URL has already been discovered by search or an approved existing public source',
      'normal fetch/extractor failed with a recoverable public-page parsing issue',
      'page is a public job detail page, not an application form',
      'page does not require login, CAPTCHA, OTP, or access-control bypass',
      'provider_detector confidence is low or provider is generic_company_careers'
    ],
    should_not_run_when: [
      'URL is an Apply/Submit/Continue/Next application flow',
      'page asks for login, CAPTCHA, OTP, file upload, or personal data submission',
      'site blocks access or requires bypassing controls',
      'crawl rate would exceed small-test limits'
    ],
    intended_location_later: 'providers/scrapling_generic_public_page/index.mjs as a fallback after generic_company_careers extractor failure',
    current_task_action: 'do_not_install_or_enable_scrapling_yet'
  };
}

function providerBreakdown(jobs) {
  const breakdown = {};
  for (const job of jobs) breakdown[job.provider || 'unknown'] = (breakdown[job.provider || 'unknown'] || 0) + 1;
  return breakdown;
}

function lifecycleStatusMap(reviews = []) {
  const items = Array.isArray(reviews) ? reviews : (Array.isArray(reviews?.reviews) ? reviews.reviews : []);
  const statuses = {};
  for (const review of items) {
    const jobId = String(review?.job_id || '').trim();
    const decision = String(review?.decision || review?.status || '').trim().toLowerCase();
    if (jobId && decision) statuses[jobId] = decision;
  }
  return statuses;
}

async function runSearchUnavailableFallback({ limits, generatedQueries, searxng, errorMessage, dryRun }) {
  const existing = readJson(path.join(dataDir, 'job_leads.json'), []);
  const existingJobs = Array.isArray(existing) ? existing : [];
  const standardizedExisting = existingJobs.map(standardizeExistingLead).filter(Boolean);
  const fallbackSources = fallbackFromExistingSources();
  const providerHealth = {
    generated_at: new Date().toISOString(),
    searxng_search: {
      ok: false,
      reachable: false,
      url: searxng.url,
      url_source: searxng.source,
      error: errorMessage,
      status: 'search_failed_warn_and_continue',
      next_manual_step: 'cd /path/to/searxng && docker compose up -d && curl "http://127.0.0.1:8888/search?q=test&format=json"'
    },
    fallback: {
      mode: dryRun ? 'dry_run_existing_job_sources_only' : 'existing_job_sources_only',
      job_leads_modified: false,
      fallback_sources_count: fallbackSources.length,
      fallback_sources_sample: fallbackSources.slice(0, 10),
      note: 'SearXNG unavailable; did not write fake jobs and did not modify job_leads.'
    },
    extractor_fallback_plan: buildScraplingPlan()
  };
  const run = {
    status: 'provider_unavailable',
    mode: dryRun ? 'dry-run' : 'normal',
    limits,
    searxng_url_used: searxng.url,
    searxng_url_source: searxng.source,
    searxng_reachable: false,
    exact_error: errorMessage,
    generated_queries: generatedQueries,
    discovered_urls_count: 0,
    detected_provider_breakdown: providerBreakdown(standardizedExisting),
    extracted_jobs_count: 0,
    deduped_jobs_count: standardizedExisting.length,
    fallback_sources_count: fallbackSources.length,
    failed_urls: generatedQueries.map((query) => ({ url: '', query, reason: `search_failed:${errorMessage}` })),
    provider_health: providerHealth,
    job_leads_modified: false,
    safety_confirmation: {
      no_login: true,
      no_captcha_otp_handling: true,
      no_apply_click: true,
      no_submit_upload: true,
      no_chrome_opened: true,
      no_application_forms_opened: true,
      no_extension_modified: true,
      no_scrapling_install_or_enable: true,
      public_metadata_only: true
    }
  };
  writeJson(path.join(dataDir, 'provider_health.json'), providerHealth);
  return run;
}

export async function discoverJobs(options = {}) {
  const args = { ...parseArgs([]), ...options };
  const fixtureMode = args.fixture === true;
  const liveEnabled = args.allowLiveSearch === true || process.env.LIVE_JOB_SEARCH === '1';
  if (!fixtureMode && typeof args.searchProvider !== 'function' && !liveEnabled) {
    return {
      status: 'READY_BUT_NOT_RUN',
      mode: 'live-search-disabled',
      reason: 'Set LIVE_JOB_SEARCH=1 to enable controlled public job search.',
      job_leads_modified: false,
      network_accessed: false,
      generated_queries: [],
      failed_urls: [],
      safety_confirmation: {
        no_real_application_opened: true,
        no_login: true,
        no_resume_upload: true,
        no_submit: true,
        no_personal_data_sent: true
      }
    };
  }
  const limits = {
    ...DEFAULT_LIMITS,
    max_queries: Number.isFinite(args.maxQueries) && args.maxQueries > 0 ? args.maxQueries : DEFAULT_LIMITS.max_queries,
    max_results_per_query: Number.isFinite(args.maxResultsPerQuery) && args.maxResultsPerQuery > 0 ? args.maxResultsPerQuery : DEFAULT_LIMITS.max_results_per_query,
    timeout_ms: Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : DEFAULT_LIMITS.timeout_ms
  };
  const prefs = args.preferences || (fixtureMode ? {
    target_roles: ['Product Manager'],
    preferred_locations: ['Remote'],
    search_query_templates: ['{role} {location} jobs']
  } : readJson(path.join(dataDir, 'search_preferences.json'), {}));
  const normalizedPreferences = normalizeSearchPreferences(prefs).value;
  const activeProfile = normalizedPreferences.search_profiles.find(
    profile => profile.id === normalizedPreferences.active_search_profile_id
  ) || normalizedPreferences.search_profiles[0] || {};
  const persistOutputs = args.persist !== false && !fixtureMode;
  const existing = args.existingJobs || (fixtureMode ? [] : readJson(path.join(dataDir, 'job_leads.json'), []));
  const existingJobs = Array.isArray(existing) ? existing : [];
  const standardizedExisting = existingJobs.map(standardizeExistingLead).filter(Boolean);
  const initialCanonicalUrls = new Set(standardizedExisting.map(job => job.canonical_url).filter(Boolean));
  const incomingByUrl = new Map();
  const providerPages = new Map();
  const careerBrain = fixtureMode
    ? normalizeCareerBrainStore({})
    : normalizeCareerBrainStore(readJson(path.join(dataDir, 'career_profiles.local.json'), {}));
  const activeCareerProfile = careerBrain.profiles.find(profile => profile.id === careerBrain.active_profile_id) || null;
  const searchPlan = activeCareerProfile
    ? buildJobSearchPlan({ careerProfile: activeCareerProfile, searchPreferences: prefs, maxQueries: limits.max_queries })
    : null;
  const generatedQueries = Array.from(new Set([
    ...(searchPlan?.queries || []).map(item => item.query),
    ...generateQueries(prefs, limits)
  ])).slice(0, limits.max_queries);
  const plannedQueries = new Map((searchPlan?.queries || []).map(item => [item.query, item]));
  const failedUrls = [];
  const searxng = fixtureMode
    ? { url: '', source: 'fixture provider', default_url: DEFAULT_SEARXNG_URL }
    : resolveSearxngUrl({ cliUrl: args.searxngUrl || '' });
  let providerHealth = {
    generated_at: new Date().toISOString(),
    searxng_search: {
      ok: null,
      reachable: null,
      url: searxng.url,
      url_source: searxng.source,
      timeout_ms: limits.timeout_ms
    },
    extractor_fallback_plan: buildScraplingPlan()
  };
  let discoveredUrlsCount = 0;
  let extractedJobsCount = 0;
  const queryResults = [];
  const searchProvider = fixtureMode ? async () => FIXTURE_RESULTS : (args.searchProvider || searchSearxng);

  for (const [queryIndex, query] of generatedQueries.entries()) {
    let results = [];
    try {
      results = await searchProvider(query, { searxngUrl: searxng.url, maxResults: limits.max_results_per_query, timeoutMs: limits.timeout_ms });
      queryResults.push({
        query,
        source: fixtureMode ? 'fixture_provider' : 'searxng_search',
        provider: fixtureMode ? 'fixture_provider' : 'searxng_search',
        searched_at: new Date().toISOString(),
        reason: plannedQueries.get(query)?.reason || 'Generated from the active search configuration.',
        status: 'completed',
        result_count: results.length
      });
      if (fixtureMode) {
        providerHealth.searxng_search = {
          ...providerHealth.searxng_search,
          ok: null,
          reachable: null,
          status: 'not_run_fixture_mode'
        };
        providerHealth.fixture_provider = {
          ok: true,
          network_accessed: false,
          last_query: query,
          last_result_count: results.length
        };
      } else {
        providerHealth.searxng_search = {
          ...providerHealth.searxng_search,
          ok: true,
          reachable: true,
          status: 'ok',
          last_query: query,
          last_result_count: results.length
        };
      }
    } catch (error) {
      const errorMessage = error?.message || String(error);
      if (queryIndex === 0) {
        const failedRun = await runSearchUnavailableFallback({
          limits,
          generatedQueries,
          searxng,
          errorMessage,
          dryRun: args.dryRun === true
        });
        failedRun.query_results = [{
          query,
          source: 'searxng_search',
          provider: 'searxng_search',
          searched_at: new Date().toISOString(),
          reason: plannedQueries.get(query)?.reason || 'Generated from the active search configuration.',
          status: 'failed',
          result_count: 0,
          error: errorMessage
        }];
        return persistOutputs ? recordSearchRun(failedRun, prefs) : failedRun;
      }
      providerHealth.searxng_search = {
        ...providerHealth.searxng_search,
        ok: false,
        reachable: false,
        error: errorMessage,
        status: 'search_failed_after_partial_results'
      };
      failedUrls.push({ url: '', query, reason: `search_failed:${errorMessage}` });
      queryResults.push({
        query,
        source: 'searxng_search',
        provider: 'searxng_search',
        searched_at: new Date().toISOString(),
        reason: plannedQueries.get(query)?.reason || 'Generated from the active search configuration.',
        status: 'failed',
        result_count: 0,
        error: errorMessage
      });
      continue;
    }
    for (const result of results.slice(0, limits.max_results_per_query)) {
      const url = normalizeUrl(result.url);
      if (!url) continue;
      discoveredUrlsCount += 1;
      const detection = detectProvider(url);
      const count = providerPages.get(detection.provider) || 0;
      let extract = null;
      if (!args.dryRun && !fixtureMode && count < limits.max_pages_per_provider) {
        try {
          extract = await extractGeneric(url, { providerDetection: detection, searchResult: result, timeoutMs: limits.timeout_ms });
          extractedJobsCount += 1;
          providerPages.set(detection.provider, count + 1);
          providerHealth[detection.provider] = { ok: true, pages_extracted: (providerHealth[detection.provider]?.pages_extracted || 0) + 1 };
          await sleep(limits.delay_ms);
        } catch (error) {
          providerHealth[detection.provider] = {
            ok: false,
            reason: error?.message || String(error),
            pages_extracted: providerHealth[detection.provider]?.pages_extracted || 0,
            fallback_considered: 'scrapling_generic_public_page planned but not enabled in this task'
          };
          failedUrls.push({ url, query, provider: detection.provider, reason: `extract_failed:${error?.message || String(error)}` });
        }
      }
      const job = standardJob({ url, query, result, detection, extract });
      if (job?.canonical_url && !incomingByUrl.has(job.canonical_url)) incomingByUrl.set(job.canonical_url, job);
    }
  }

  const discoveryNow = args.now || new Date().toISOString();
  const mergedBatch = mergeJobRecords(standardizedExisting, [...incomingByUrl.values()], { now: discoveryNow });
  const statuses = args.statusByJob || (fixtureMode
    ? {}
    : lifecycleStatusMap(readJson(path.join(dataDir, 'job_reviews.json'), [])));
  // Only genuinely undecided newcomers may be stamped 'new': a rediscovered
  // job that already carries a lifecycle decision keeps its merge-derived
  // discovery status so rejected jobs cannot resurface as fresh results.
  const mergedInventory = mergedBatch.jobs.map(job => {
    if (initialCanonicalUrls.has(job.canonical_url)) return job;
    const decided = String(statuses[String(job.job_id)] || '');
    if (decided && decided !== 'pending') return job;
    return {
      ...job,
      discovery_status: 'new',
      discovery_memory: { ...(job.discovery_memory || {}), status: 'new' }
    };
  });
  const discoveryPolicyResult = applyDiscoveryPolicy(mergedInventory, {
    preferences: activeProfile,
    statusByJob: statuses,
    now: discoveryNow
  });
  const deduped = discoveryPolicyResult.jobs;
  const jobLeadsModified = persistOutputs && args.dryRun !== true && discoveredUrlsCount > 0;
  if (jobLeadsModified) writeJson(path.join(dataDir, 'job_leads.json'), deduped);
  providerHealth.fallback = {
    mode: args.dryRun ? 'dry_run_no_job_leads_write' : 'not_needed_when_search_reachable',
    job_leads_modified: jobLeadsModified,
    fallback_sources_count: fixtureMode ? 0 : fallbackFromExistingSources().length
  };
  if (persistOutputs) writeJson(path.join(dataDir, 'provider_health.json'), providerHealth);
  const run = {
    status: 'ok',
    mode: fixtureMode ? 'fixture-offline' : args.dryRun ? 'dry-run' : 'normal',
    persist_outputs: persistOutputs,
    network_accessed: !fixtureMode,
    limits,
    searxng_url_used: searxng.url,
    searxng_url_source: searxng.source,
    searxng_reachable: providerHealth.searxng_search.reachable === true,
    exact_error: providerHealth.searxng_search.error || '',
    generated_queries: generatedQueries,
    search_plan: searchPlan,
    query_results: queryResults,
    discovered_urls_count: discoveredUrlsCount,
    detected_provider_breakdown: providerBreakdown(deduped),
    extracted_jobs_count: extractedJobsCount,
    deduped_jobs_count: deduped.length,
    current_result_count: discoveryPolicyResult.quality.current_result_count,
    new_result_count: discoveryPolicyResult.quality.new_result_count,
    previously_seen_result_count: discoveryPolicyResult.quality.previously_seen_result_count,
    deferred_count: discoveryPolicyResult.quality.deferred_count,
    discovery_policy: discoveryPolicyResult.policy,
    discovery_quality: discoveryPolicyResult.quality,
    failed_urls: failedUrls,
    provider_health: providerHealth,
    job_leads_modified: jobLeadsModified,
    safety_confirmation: {
      no_login: true,
      no_captcha_otp_handling: true,
      no_apply_click: true,
      no_submit_upload: true,
      no_chrome_opened: true,
      no_application_forms_opened: true,
      no_extension_modified: true,
      no_scrapling_install_or_enable: true,
      public_metadata_only: true
    }
  };
  return persistOutputs ? recordSearchRun(run, prefs) : run;
}

function writeSearchEntryFixReports(run) {
  const report = {
    report_id: 'job_discovery_search_entry_fix_001',
    created_at: new Date().toISOString(),
    pwd_used: root,
    ...run,
    scrapling_should_be_added_when_where: buildScraplingPlan(),
    files_modified: [
      'scripts/discover_jobs.mjs',
      'data/provider_health.json',
      'reports/job_discovery_search_entry_fix_001.json',
      'reports/job_discovery_search_entry_fix_001.md'
    ],
    next_manual_step: 'cd /path/to/searxng && docker compose up -d && curl "http://127.0.0.1:8888/search?q=test&format=json"'
  };
  writeJson(path.join(reportsDir, 'job_discovery_search_entry_fix_001.json'), report);
  const md = `# Job Discovery Search Entry Fix 001\n\n- Created at: ${report.created_at}\n- pwd used: ${report.pwd_used}\n- mode: ${report.mode}\n\n## SearXNG\n\n- URL used: ${report.searxng_url_used}\n- URL source: ${report.searxng_url_source}\n- reachable: ${report.searxng_reachable ? 'yes' : 'no'}\n- exact error: ${report.exact_error || 'none'}\n\n## Dry-run result\n\n- generated queries: ${report.generated_queries.length}\n- discovered URLs count: ${report.discovered_urls_count}\n- extracted jobs count: ${report.extracted_jobs_count}\n- deduped jobs count: ${report.deduped_jobs_count}\n- job_leads modified: ${report.job_leads_modified ? 'yes' : 'no'}\n- fallback sources count: ${report.fallback_sources_count || report.provider_health?.fallback?.fallback_sources_count || 0}\n\n## Provider health result\n\n\`\`\`json\n${JSON.stringify(report.provider_health, null, 2)}\n\`\`\`\n\n## Failed searches\n\n${(report.failed_urls || []).map((f) => `- query: ${f.query || ''}; reason: ${f.reason}`).join('\n') || '- none'}\n\n## Scrapling fallback plan, not enabled\n\nScrapling should be added later at \`${report.scrapling_should_be_added_when_where.intended_location_later}\` only when:\n\n${report.scrapling_should_be_added_when_where.should_only_run_when.map((x) => `- ${x}`).join('\n')}\n\nDo not run Scrapling when:\n\n${report.scrapling_should_be_added_when_where.should_not_run_when.map((x) => `- ${x}`).join('\n')}\n\nCurrent task action: ${report.scrapling_should_be_added_when_where.current_task_action}\n\n## Files modified\n\n${report.files_modified.map((x) => `- ${x}`).join('\n')}\n\n## Safety confirmation\n\n${Object.entries(report.safety_confirmation).map(([k, v]) => `- ${k}: ${v ? 'yes' : 'no'}`).join('\n')}\n\n## Next manual step\n\n\`\`\`bash\ncd /path/to/searxng\ndocker compose up -d\ncurl "http://127.0.0.1:8888/search?q=test&format=json"\n\`\`\`\n`;
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'job_discovery_search_entry_fix_001.md'), md);
  return report;
}

if (isMainModule(import.meta.url)) {
  const cliArgs = parseArgs();
  discoverJobs(cliArgs)
    .then((run) => {
      const report = run.persist_outputs ? writeSearchEntryFixReports(run) : run;
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error) => { console.error(error); process.exit(1); });
}
