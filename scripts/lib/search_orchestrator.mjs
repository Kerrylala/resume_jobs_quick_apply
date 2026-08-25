// Provider Orchestrator — one global search run.
//
// Providers FIND candidate jobs; they never decide what survives. Each
// provider runs independently: one failing (network, 404, JS wall) records an
// honest status and the run continues. The pipeline afterwards is always
// quality gate → cross-provider dedup → Filter Engine → matching.
//
// Providers here:
//   company_ats   – Greenhouse / Lever / Ashby / SmartRecruiters / Workable /
//                   Workday boards (official public APIs) from: the plan's
//                   pinned boards, the workspace inventory, and a seed catalog
//   searxng_web   – full-web metasearch (local SearXNG), planner text queries
//   searxng_ats   – site:ATS queries that EXPAND the board pool
//   browser_boss / browser_linkedin – reported as user-driven providers; they
//                   run through the assisted-browser endpoint, never headlessly
import { buildSearchQueries } from './search_planner.mjs';
import { discoverCompanyJobs, detectCareersSource } from './company_careers.mjs';
import { searchSearxng } from '../../providers/searxng_search/index.mjs';
import { classifyJobInput, jobQualityGate } from './job_input_classifier.mjs';
import { ingestPublicJobUrl } from './job_url_ingestion.mjs';
import { fetchableAdapters, browserAdapters } from '../../providers/discovery/registry.mjs';

const text = value => String(value ?? '').trim();

// A small catalog of real, usually-active public boards so a brand-new
// workspace is not empty-handed. Every entry is an official hosted board; a
// dead one simply reports board_not_found and costs nothing.
// Curated catalog of real, currently-active public boards so a brand-new
// workspace is not empty-handed. Every entry was live-probed 2026-08-23 and
// returned real postings; a dead one simply reports board_not_found and costs
// nothing. This is the reliable no-login recall backbone — each board yields
// up to `max_board_jobs` real jobs with full fields, no CAPTCHA, no sign-in.
export const SEED_BOARDS = Object.freeze([
  // Greenhouse
  'https://boards.greenhouse.io/stripe',
  'https://boards.greenhouse.io/airbnb',
  'https://boards.greenhouse.io/databricks',
  'https://boards.greenhouse.io/robinhood',
  'https://boards.greenhouse.io/coinbase',
  'https://boards.greenhouse.io/dropbox',
  'https://boards.greenhouse.io/gitlab',
  'https://boards.greenhouse.io/instacart',
  'https://boards.greenhouse.io/figma',
  'https://boards.greenhouse.io/anthropic',
  'https://boards.greenhouse.io/discord',
  'https://boards.greenhouse.io/reddit',
  'https://boards.greenhouse.io/twitch',
  'https://boards.greenhouse.io/cloudflare',
  'https://boards.greenhouse.io/pinterest',
  'https://boards.greenhouse.io/samsungresearchamerica',
  // Lever
  'https://jobs.lever.co/alloy',
  // Ashby
  'https://jobs.ashbyhq.com/linear',
  'https://jobs.ashbyhq.com/notion',
  'https://jobs.ashbyhq.com/openai',
  'https://jobs.ashbyhq.com/ramp',
  'https://jobs.ashbyhq.com/vanta',
  'https://jobs.ashbyhq.com/cursor',
  'https://jobs.ashbyhq.com/perplexity',
  'https://jobs.ashbyhq.com/runway',
  // Workable
  'https://apply.workable.com/netguru',
  // Workday
  'https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite',
  'https://adobe.wd5.myworkdayjobs.com/external_experienced',
  'https://salesforce.wd12.myworkdayjobs.com/External_Career_Site',
]);

function dedupeBoards(urls, limit = 40) {
  const seen = new Set();
  const result = [];
  for (const raw of urls) {
    const value = text(raw);
    if (!value) continue;
    const source = detectCareersSource(value);
    const key = source.provider === 'generic' ? value.toLowerCase() : `${source.provider}|${source.token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

export async function runGlobalSearch({
  criteria = {},
  careerProfile = {},
  inventoryBoards = [],
  searxng = { enabled: false, url: '', timeout_ms: 8000 },
  includeSeedBoards = true,
  fetchImpl = globalThis.fetch,
  onProgress = () => {},
  shouldStop = () => false,
  now = new Date().toISOString(),
  limits = {},
} = {}) {
  const maxBoardJobs = Math.max(5, Math.min(60, Number(limits.max_board_jobs) || 30));
  const maxWebQueries = Math.max(1, Math.min(10, Number(limits.max_web_queries) || 4));
  const maxSiteQueries = Math.max(1, Math.min(12, Number(limits.max_site_queries) || 6));
  const maxIngest = Math.max(3, Math.min(30, Number(limits.max_ingest) || 14));

  const queries = buildSearchQueries({ careerProfile, criteria });
  const providers = [];
  const jobs = [];
  // Login-wall job pages surfaced by web search: kept as leads (never dropped
  // just because we can't sign in), marked limited_access with their source.
  const limitedAccess = new Map();
  const report = (entry) => { providers.push(entry); onProgress({ providers: [...providers], queries }); };

  // --- Provider 1: company ATS boards ---------------------------------------
  const boardPool = dedupeBoards([
    ...(criteria.company_boards || []),
    ...inventoryBoards,
    ...(includeSeedBoards ? SEED_BOARDS : []),
  ]);
  const startedBoards = Date.now();
  let boardJobs = 0;
  const boardNotes = [];
  for (const board of boardPool) {
    if (shouldStop()) { boardNotes.push('stopped_by_user'); break; }
    try {
      const discovered = await discoverCompanyJobs(board, { fetchImpl, timeoutMs: 10_000, limit: maxBoardJobs });
      const kept = (discovered.jobs || []).slice(0, maxBoardJobs);
      for (const job of kept) {
        jobs.push({
          ...job,
          discovery: { discovered_by: 'global_search:company_ats', query: '', discovered_at: now, original_url: job.apply_url || board },
          imported_at: now,
          source: job.source || 'user_supplied_career_url',
        });
      }
      boardJobs += kept.length;
      boardNotes.push(`${discovered.provider}:${discovered.board || board} ${discovered.status} ${kept.length}`);
    } catch (error) {
      boardNotes.push(`${board} failed ${text(error?.code || error?.message).slice(0, 40)}`);
    }
  }
  report({
    id: 'company_ats', label: 'Company boards (GH/Lever/Ashby/SR/Workable/Workday)',
    status: boardJobs > 0 ? 'ok' : (boardPool.length ? 'no_results' : 'no_boards'),
    boards: boardPool.length, found: boardJobs, notes: boardNotes.slice(0, 20), duration_ms: Date.now() - startedBoards,
  });

  // --- Registry adapters: every fetchable site provider ----------------------
  // Adding a website = adding one adapter in providers/discovery/registry.mjs.
  const regionKeywords = region => {
    const pool = queries.board_queries.map(item => item.keyword);
    if (region === 'china') {
      const chinese = pool.filter(keyword => /[一-鿿]/.test(keyword));
      return (chinese.length ? chinese : pool).slice(0, 2);
    }
    const latin = pool.filter(keyword => !/[一-鿿]/.test(keyword));
    return (latin.length ? latin : pool).slice(0, 2);
  };
  for (const adapter of fetchableAdapters()) {
    if (shouldStop()) break;
    const started = Date.now();
    const keywords = regionKeywords(adapter.region);
    let found = 0;
    const notes = [];
    try {
      for (const keyword of keywords) {
        if (shouldStop()) break;
        try {
          const outcome = await adapter.search({ keyword, criteria, fetchImpl, limit: 15 });
          for (const job of outcome.jobs || []) {
            jobs.push({
              ...job,
              source: 'public_job_board',
              discovery: { discovered_by: `global_search:${adapter.id}`, query: keyword, discovered_at: now, original_url: job.apply_url },
              imported_at: now,
            });
            found += 1;
          }
          if (outcome.status !== 'ok') notes.push(`${keyword}: ${outcome.status}`);
        } catch (error) {
          notes.push(`${keyword}: ${String(error?.message).slice(0, 40)}`);
        }
      }
      report({
        id: adapter.id, label: adapter.label, region: adapter.region,
        status: found > 0 ? 'ok' : (notes.length ? 'provider_unreachable' : 'no_results'),
        found, notes: notes.slice(0, 4), duration_ms: Date.now() - started,
      });
    } catch (error) {
      report({ id: adapter.id, label: adapter.label, region: adapter.region, status: 'provider_unreachable', found, reason: String(error?.message).slice(0, 60), duration_ms: Date.now() - started });
    }
  }

  // --- Providers 2+3: SearXNG (web + site:ATS expansion) --------------------
  async function searxngPass(id, label, queryList, queryOf) {
    const started = Date.now();
    if (!(searxng.enabled === true && searxng.url)) {
      report({ id, label, status: 'unavailable', reason: 'searxng_not_configured', found: 0, duration_ms: 0 });
      return;
    }
    let urlsSeen = 0;
    let ingested = 0;
    const notes = [];
    // Web search must never dominate wall-clock: ATS/company providers already
    // ran, so cap this pass and bail out early rather than let a slow/weak
    // metasearch stretch the run.
    const passDeadline = Date.now() + Math.max(15_000, Number(limits.max_searxng_pass_ms) || 40_000);
    try {
      const candidateUrls = new Map();
      for (const item of queryList) {
        if (shouldStop() || Date.now() > passDeadline) { notes.push('time_budget_reached'); break; }
        const query = queryOf(item);
        try {
          const results = await searchSearxng(query, {
            searxngUrl: searxng.url, maxResults: 6, maxPages: 1,
            timeoutMs: Math.min(10_000, Number(searxng.timeout_ms) || 8000),
            engines: searxng.engines || 'bing',
          });
          urlsSeen += results.length;
          for (const result of results) {
            const kind = classifyJobInput(result.url);
            if (kind.kind === 'single_job_url' && !kind.browser_required && !candidateUrls.has(kind.url)) {
              candidateUrls.set(kind.url, { query, title: result.title });
            } else if (kind.browser_required && result.title && !limitedAccess.has(kind.url || result.url)) {
              // A real job page behind a login wall — keep the lead, don't drop.
              limitedAccess.set(kind.url || result.url, {
                title: result.title, url: kind.url || result.url,
                provider_hint: kind.provider_hint || '', query, discovered_by: `global_search:${id}`,
              });
            }
          }
        } catch (error) {
          notes.push(`query failed: ${text(error?.message).slice(0, 40)}`);
        }
      }
      for (const [url, meta] of candidateUrls) {
        if (ingested >= maxIngest || shouldStop() || Date.now() > passDeadline) break;
        try {
          const result = await ingestPublicJobUrl(url, { confirmedPublicFetch: true, timeoutMs: 8000, now });
          for (const job of result.jobs) {
            jobs.push({
              ...job,
              discovery: { discovered_by: `global_search:${id}`, query: meta.query, discovered_at: now, original_url: url },
            });
            ingested += 1;
          }
        } catch { /* one dead result never sinks the pass */ }
      }
      report({
        id, label, status: 'ok', queries: queryList.length, urls_seen: urlsSeen,
        found: ingested, notes: notes.slice(0, 5), duration_ms: Date.now() - started,
      });
    } catch (error) {
      report({ id, label, status: 'provider_unreachable', reason: text(error?.message).slice(0, 80), found: 0, duration_ms: Date.now() - started });
    }
  }

  await searxngPass('searxng_web', 'Web search (SearXNG)',
    queries.text_queries.slice(0, maxWebQueries), item => item.query);
  await searxngPass('searxng_ats', 'ATS site search (SearXNG)',
    queries.site_queries.slice(0, maxSiteQueries), item => item.query);

  // --- Browser-assisted boards: reported, launched separately by the user ---
  for (const adapter of browserAdapters()) {
    report({
      id: adapter.id, label: `${adapter.label} (browser you drive)`, region: adapter.region,
      status: 'user_action_required', found: 0,
      reason: adapter.capability_notes,
      queries: queries.browser_queries,
    });
  }

  // Quality gate before anything else sees the results.
  const gated = jobs.filter(job => jobQualityGate({ ...job, company: job.company || 'pending' }).ok);
  const limited_access = [...limitedAccess.values()].map(lead => ({
    ...lead, limited_access: true, discovered_at: now,
  }));
  if (limited_access.length) {
    report({ id: 'limited_access', label: 'Login-wall leads (kept, not opened)', status: 'ok', found: limited_access.length });
  }
  return {
    queries, providers, jobs: gated,
    limited_access,
    raw_found: jobs.length, gated_out: jobs.length - gated.length,
  };
}
