// Company careers page discovery.
//
// The user pastes a company's careers/jobs URL; this finds the open postings
// behind it. Provider order is reliability order:
//
//   1. Greenhouse / Lever public JSON APIs — official, stable, no scraping.
//   2. A conservative HTML pass over generic listing pages, reusing the same
//      SSRF-guarded fetch and link extractor the single-URL import uses.
//
// Honesty rule: when nothing can be discovered, the result says exactly why
// (`js_rendered_page`, `board_not_found`, `provider_unreachable`,
// `no_postings_found`) and carries zero jobs. Nothing is ever fabricated —
// an empty board and an unparseable board are different answers, and the UI
// needs to know which one it got.

import { validatePublicJobUrl } from './job_url_ingestion.mjs';
import { extractPublicCareerJobsFromHtml } from '../../providers/generic_company_careers/index.mjs';

const MAX_JOBS = 100;
const MAX_HTML_BYTES = 1024 * 1024;

// Heuristics for "this page builds its job list in JavaScript": a large
// document with framework mount points and no job links. Observed for real on
// jobs.lever.co boards (~700 KB of HTML, zero links without JS).
const SPA_MARKERS = /(?:<div[^>]+id="(?:root|app|__next)"|window\.__INITIAL_STATE__|data-reactroot|ng-version=)/i;

function text(value, limit = 500) {
  return String(value ?? '').trim().slice(0, limit);
}

export function detectCareersSource(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return { provider: 'generic', token: '' }; }
  const host = parsed.hostname.toLowerCase();
  const firstSegment = parsed.pathname.split('/').filter(Boolean)[0] || '';

  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    // boards.greenhouse.io/{token}[/...]; embeds carry ?for={token}.
    const token = text(parsed.searchParams.get('for') || firstSegment, 100)
      .replace(/[^a-z0-9_-]/gi, '');
    return { provider: 'greenhouse', token };
  }
  if (host.endsWith('.greenhouse.io') && parsed.searchParams.get('for')) {
    return { provider: 'greenhouse', token: text(parsed.searchParams.get('for'), 100).replace(/[^a-z0-9_-]/gi, '') };
  }
  if (host === 'jobs.lever.co') {
    return { provider: 'lever', token: text(firstSegment, 100).replace(/[^a-z0-9_-]/gi, '') };
  }
  if (host === 'jobs.ashbyhq.com') {
    return { provider: 'ashby', token: text(decodeURIComponent(firstSegment), 100).replace(/[^a-z0-9 ._-]/gi, '') };
  }
  if (host === 'careers.smartrecruiters.com' || host === 'jobs.smartrecruiters.com') {
    return { provider: 'smartrecruiters', token: text(firstSegment, 100).replace(/[^a-z0-9_-]/gi, '') };
  }
  if (host === 'apply.workable.com') {
    return { provider: 'workable', token: text(firstSegment, 100).replace(/[^a-z0-9_-]/gi, '') };
  }
  // {tenant}.wd{N}.myworkdayjobs.com/{lang?}/{site} — the public CXS jobs API.
  const workday = host.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (workday) {
    const segments = parsed.pathname.split('/').filter(Boolean);
    const site = segments.find(segment => !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(segment)) || segments.at(-1) || '';
    if (site) {
      return { provider: 'workday', token: `${workday[1]}|${workday[2]}|${text(site, 100).replace(/[^a-zA-Z0-9_-]/g, '')}` };
    }
  }
  return { provider: 'generic', token: '' };
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, code) => { try { return String.fromCharCode(Number(code)); } catch { return ' '; } })
    .replace(/\s+/g, ' ').trim();
}

function normalizedJob({ title, url, location, company, source, description_text = '', posted_date = '' }) {
  return {
    title: text(title, 300),
    url: text(url, 1000),
    apply_url: text(url, 1000),
    location: text(location, 300),
    company: text(company, 300),
    description_text: text(description_text, 1500),
    posted_date: text(posted_date, 40),
    source,
    source_type: 'company_careers_page'
  };
}

async function fetchJson(url, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (response.status === 404) return { notFound: true };
  if (!response.ok) return { error: `http_${response.status}` };
  return { value: await response.json() };
}

async function discoverGreenhouse(token, { fetchImpl, timeoutMs, limit }) {
  // Public board API — an official fixed-host HTTPS endpoint, so the SSRF
  // guard for arbitrary URLs does not apply here.
  // content=true returns full descriptions, posted dates and education in the
  // SAME single call — a big field-completeness win at no extra request cost.
  const result = await fetchJson(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs?content=true`,
    fetchImpl, timeoutMs
  );
  if (result.notFound) return { status: 'board_not_found', jobs: [] };
  if (result.error) return { status: 'provider_unreachable', jobs: [], diagnostics: result.error };
  const jobs = (Array.isArray(result.value?.jobs) ? result.value.jobs : [])
    .filter(job => job?.absolute_url && job?.title)
    .slice(0, limit)
    .map(job => normalizedJob({
      title: job.title,
      url: job.absolute_url,
      location: job.location?.name || '',
      company: job.company_name || result.value?.name || token,
      description_text: stripHtml(job.content),
      posted_date: job.updated_at || job.first_published || '',
      source: 'company_careers_greenhouse'
    }));
  return { status: jobs.length ? 'ok' : 'no_postings_found', jobs };
}

async function discoverLever(token, { fetchImpl, timeoutMs, limit }) {
  const result = await fetchJson(
    `https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`,
    fetchImpl, timeoutMs
  );
  if (result.notFound) return { status: 'board_not_found', jobs: [] };
  if (result.error) return { status: 'provider_unreachable', jobs: [], diagnostics: result.error };
  const jobs = (Array.isArray(result.value) ? result.value : [])
    .filter(job => job?.hostedUrl && job?.text)
    .slice(0, limit)
    .map(job => normalizedJob({
      title: job.text,
      url: job.hostedUrl,
      location: job.categories?.location || '',
      company: token,
      description_text: job.descriptionPlain || stripHtml(job.description || ''),
      posted_date: job.createdAt ? new Date(job.createdAt).toISOString() : '',
      source: 'company_careers_lever'
    }));
  return { status: jobs.length ? 'ok' : 'no_postings_found', jobs };
}

async function discoverAshby(token, { fetchImpl, timeoutMs, limit }) {
  // Official public posting API for hosted Ashby boards.
  const result = await fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`,
    fetchImpl, timeoutMs
  );
  if (result.notFound) return { status: 'board_not_found', jobs: [] };
  if (result.error) return { status: 'provider_unreachable', jobs: [], diagnostics: result.error };
  const jobs = (Array.isArray(result.value?.jobs) ? result.value.jobs : [])
    .filter(job => job?.jobUrl && job?.title)
    .slice(0, limit)
    .map(job => normalizedJob({
      title: job.title,
      url: job.jobUrl,
      location: job.location || job.address?.postalAddress?.addressLocality || '',
      company: token,
      description_text: job.descriptionPlain || stripHtml(job.descriptionHtml || ''),
      posted_date: job.publishedAt || job.updatedAt || '',
      source: 'company_careers_ashby'
    }));
  return { status: jobs.length ? 'ok' : 'no_postings_found', jobs };
}

async function discoverSmartRecruiters(token, { fetchImpl, timeoutMs, limit }) {
  // Official public postings API.
  const result = await fetchJson(
    `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=${Math.min(limit, 100)}`,
    fetchImpl, timeoutMs
  );
  if (result.notFound) return { status: 'board_not_found', jobs: [] };
  if (result.error) return { status: 'provider_unreachable', jobs: [], diagnostics: result.error };
  const jobs = (Array.isArray(result.value?.content) ? result.value.content : [])
    .filter(job => job?.name && (job?.id || job?.ref))
    .slice(0, limit)
    .map(job => normalizedJob({
      title: job.name,
      url: `https://jobs.smartrecruiters.com/${encodeURIComponent(token)}/${encodeURIComponent(job.id)}`,
      location: [job.location?.city, job.location?.country].filter(Boolean).join(', '),
      company: job.company?.name || token,
      source: 'company_careers_smartrecruiters'
    }));
  return { status: jobs.length ? 'ok' : 'no_postings_found', jobs };
}

async function discoverWorkday(token, { fetchImpl, timeoutMs, limit, searchText = '' }) {
  // Workday's public CXS jobs endpoint — the same JSON the hosted board reads.
  const [tenant, instance, site] = String(token).split('|');
  if (!tenant || !instance || !site) return { status: 'board_not_found', jobs: [] };
  const base = `https://${tenant}.${instance}.myworkdayjobs.com`;
  const response = await fetchImpl(`${base}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: Math.min(limit, 20), offset: 0, searchText: text(searchText, 100) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (response.status === 404) return { status: 'board_not_found', jobs: [] };
  if (!response.ok) return { status: 'provider_unreachable', jobs: [], diagnostics: `http_${response.status}` };
  const value = await response.json().catch(() => null);
  const postings = Array.isArray(value?.jobPostings) ? value.jobPostings : [];
  const jobs = postings
    .filter(posting => posting?.title && posting?.externalPath)
    .slice(0, limit)
    .map(posting => normalizedJob({
      title: posting.title,
      url: `${base}/${site}${posting.externalPath.startsWith('/') ? '' : '/'}${posting.externalPath}`,
      location: text(posting.locationsText, 300),
      company: tenant,
      source: 'company_careers_workday'
    }));
  return { status: jobs.length ? 'ok' : 'no_postings_found', jobs };
}

async function discoverWorkable(token, { fetchImpl, timeoutMs, limit }) {
  // Official public widget API for hosted Workable boards.
  const result = await fetchJson(
    `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}`,
    fetchImpl, timeoutMs
  );
  if (result.notFound) return { status: 'board_not_found', jobs: [] };
  if (result.error) return { status: 'provider_unreachable', jobs: [], diagnostics: result.error };
  const jobs = (Array.isArray(result.value?.jobs) ? result.value.jobs : [])
    .filter(job => job?.title && (job?.url || job?.application_url || job?.shortcode))
    .slice(0, limit)
    .map(job => normalizedJob({
      title: job.title,
      url: job.url || job.application_url || `https://apply.workable.com/${encodeURIComponent(token)}/j/${encodeURIComponent(job.shortcode)}/`,
      location: [job.city, job.country].filter(Boolean).join(', '),
      company: result.value?.name || token,
      source: 'company_careers_workable'
    }));
  return { status: jobs.length ? 'ok' : 'no_postings_found', jobs };
}

async function discoverGeneric(url, { fetchImpl, timeoutMs, limit, lookup }) {
  // Arbitrary host: the same SSRF validation the single-URL import enforces.
  await validatePublicJobUrl(url, lookup ? { lookup } : undefined);
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  } catch (error) {
    return { status: 'provider_unreachable', jobs: [], diagnostics: text(error?.message, 120) };
  }
  if (!response.ok) return { status: 'provider_unreachable', jobs: [], diagnostics: `http_${response.status}` };
  const html = (await response.text()).slice(0, MAX_HTML_BYTES);

  const extracted = extractPublicCareerJobsFromHtml(url, html);
  const jobs = (Array.isArray(extracted) ? extracted : [])
    .slice(0, limit)
    .map(job => normalizedJob({
      title: job.title,
      url: job.apply_url,
      location: job.location || '',
      company: job.company || '',
      source: 'company_careers_generic'
    }))
    .filter(job => job.title && job.url);
  if (jobs.length) return { status: 'ok', jobs };

  // Nothing found — say why, so the user is not told "no jobs" when the truth
  // is "this page needs JavaScript we deliberately do not execute here".
  if (html.length > 200_000 || SPA_MARKERS.test(html)) {
    return { status: 'js_rendered_page', jobs: [] };
  }
  return { status: 'no_postings_found', jobs: [] };
}

export async function discoverCompanyJobs(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
  limit = 50,
  lookup
} = {}) {
  const bounded = Math.max(1, Math.min(Number(limit) || 50, MAX_JOBS));
  const source = detectCareersSource(url);

  if (source.provider !== 'generic' && !source.token) {
    return { status: 'board_not_found', provider: source.provider, jobs: [] };
  }

  let outcome;
  try {
    if (source.provider === 'greenhouse') {
      outcome = await discoverGreenhouse(source.token, { fetchImpl, timeoutMs, limit: bounded });
    } else if (source.provider === 'lever') {
      outcome = await discoverLever(source.token, { fetchImpl, timeoutMs, limit: bounded });
    } else if (source.provider === 'ashby') {
      outcome = await discoverAshby(source.token, { fetchImpl, timeoutMs, limit: bounded });
    } else if (source.provider === 'smartrecruiters') {
      outcome = await discoverSmartRecruiters(source.token, { fetchImpl, timeoutMs, limit: bounded });
    } else if (source.provider === 'workable') {
      outcome = await discoverWorkable(source.token, { fetchImpl, timeoutMs, limit: bounded });
    } else if (source.provider === 'workday') {
      outcome = await discoverWorkday(source.token, { fetchImpl, timeoutMs, limit: bounded });
    } else {
      outcome = await discoverGeneric(url, { fetchImpl, timeoutMs, limit: bounded, lookup });
    }
  } catch (error) {
    // validatePublicJobUrl throws typed errors (SSRF, scheme, size); surface
    // the code rather than swallowing it into a generic failure.
    if (error?.code) throw error;
    outcome = { status: 'provider_unreachable', jobs: [], diagnostics: text(error?.message, 120) };
  }

  return {
    status: outcome.status,
    provider: source.provider,
    board: source.token || undefined,
    jobs: outcome.jobs,
    diagnostics: outcome.diagnostics,
    safety: { pages_fetched: 1, login_attempted: false, jobs_fabricated: false }
  };
}
