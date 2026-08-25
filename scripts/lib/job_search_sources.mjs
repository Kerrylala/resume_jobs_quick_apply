import { publicAIProviderSettings } from './ai_provider.mjs';

export const SEARXNG_PROVIDER_ID = 'searxng_search';
export const SUGGESTED_SEARXNG_URL = 'http://127.0.0.1:8888/search';
export const PROVIDER_STATES = new Set([
  'READY',
  'DISABLED',
  'MISCONFIGURED',
  'UNREACHABLE',
  'ERROR'
]);

const DEFAULT_SEARXNG = Object.freeze({
  name: 'SearXNG',
  description: 'Privacy-respecting metasearch used to discover public job pages.',
  enabled: false,
  url: '',
  timeout_ms: 12000,
  max_results_per_query: 5,
  status: 'DISABLED',
  last_health_check: '',
  last_error: ''
});

export const JOB_SOURCE_CATALOG = Object.freeze({
  china: [
    { id: 'china_company_careers', name: 'Company careers', category: 'company_career', mode: 'public_page_and_user_url', public_only: true },
    { id: 'china_public_job_pages', name: 'Public job pages', category: 'public_job_pages', mode: 'user_url_or_assisted_browsing', public_only: true, examples: ['BOSS直聘', '拉勾', '猎聘', '智联招聘', '前程无忧'] },
    { id: 'china_user_imported_urls', name: 'User-imported links', category: 'user_imported_urls', mode: 'user_url', public_only: true },
    { id: 'china_assisted_browsing', name: 'Assisted browsing', category: 'assisted_browsing', mode: 'user_started_public_browsing', public_only: true }
  ],
  global: [
    { id: 'global_company_careers', name: 'Company careers', category: 'career_pages', mode: 'public_page_and_user_url', public_only: true },
    { id: 'global_public_application_forms', name: 'Public application forms', category: 'ats', mode: 'public_application_adapter', public_only: true, examples: ['Greenhouse', 'Lever', 'Workday', 'Ashby'] },
    { id: 'global_user_imported_urls', name: 'User-imported links', category: 'user_imported_urls', mode: 'user_url', public_only: true },
    { id: 'global_assisted_browsing', name: 'Assisted browsing', category: 'assisted_browsing', mode: 'user_started_public_browsing', public_only: true }
  ]
});

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

export function validateSearchProviderUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    const error = new Error('Enter a SearXNG endpoint before enabling Live Search.');
    error.code = 'SEARCH_PROVIDER_URL_REQUIRED';
    throw error;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    const error = new Error('The SearXNG endpoint must be a valid URL.');
    error.code = 'SEARCH_PROVIDER_URL_INVALID';
    throw error;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    const error = new Error('The SearXNG endpoint must use HTTP or HTTPS.');
    error.code = 'SEARCH_PROVIDER_URL_INVALID';
    throw error;
  }
  if (url.username || url.password) {
    const error = new Error('Do not include credentials in the SearXNG endpoint URL.');
    error.code = 'SEARCH_PROVIDER_CREDENTIALS_FORBIDDEN';
    throw error;
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && !loopback) {
    const error = new Error('Remote SearXNG endpoints must use HTTPS. HTTP is allowed only for localhost.');
    error.code = 'SEARCH_PROVIDER_HTTPS_REQUIRED';
    throw error;
  }
  return url.toString();
}

export function normalizeJobSearchSources(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const backends = source.search_backends && typeof source.search_backends === 'object'
    ? source.search_backends
    : {};
  const current = backends[SEARXNG_PROVIDER_ID] && typeof backends[SEARXNG_PROVIDER_ID] === 'object'
    ? backends[SEARXNG_PROVIDER_ID]
    : {};
  const enabled = current.enabled === true;
  const url = String(current.url || '').trim();
  let status = String(current.status || '').toUpperCase();
  if (!enabled) status = 'DISABLED';
  else if (!url) status = 'MISCONFIGURED';
  else if (!PROVIDER_STATES.has(status) || status === 'DISABLED') status = 'ERROR';

  return {
    ...source,
    schema_version: '1.0',
    search_backends: {
      ...backends,
      [SEARXNG_PROVIDER_ID]: {
        ...DEFAULT_SEARXNG,
        ...current,
        name: DEFAULT_SEARXNG.name,
        description: DEFAULT_SEARXNG.description,
        enabled,
        url,
        timeout_ms: clampInteger(current.timeout_ms, DEFAULT_SEARXNG.timeout_ms, 500, 120000),
        max_results_per_query: clampInteger(
          current.max_results_per_query,
          DEFAULT_SEARXNG.max_results_per_query,
          1,
          50
        ),
        status,
        last_health_check: String(current.last_health_check || ''),
        last_error: String(current.last_error || '')
      }
    }
  };
}

export function effectiveJobSearchProvider(input = {}, env = process.env) {
  const normalized = normalizeJobSearchSources(input);
  const saved = normalized.search_backends[SEARXNG_PROVIDER_ID];
  const envFlag = String(env.LIVE_JOB_SEARCH || '').trim();
  const enabled = envFlag === '1' ? true : envFlag === '0' ? false : saved.enabled;
  const url = String(env.SEARXNG_URL || saved.url || '').trim();
  return {
    ...saved,
    enabled,
    url,
    enabled_source: envFlag === '1' || envFlag === '0' ? 'LIVE_JOB_SEARCH' : 'job_sources.json',
    url_source: env.SEARXNG_URL ? 'SEARXNG_URL' : 'job_sources.json'
  };
}

export function publicJobSearchSources(input = {}, env = process.env) {
  const normalized = normalizeJobSearchSources(input);
  const effective = effectiveJobSearchProvider(normalized, env);
  const saved = normalized.search_backends[SEARXNG_PROVIDER_ID];
  return {
    schema_version: normalized.schema_version,
    suggested_searxng_url: SUGGESTED_SEARXNG_URL,
    providers: [{
      id: SEARXNG_PROVIDER_ID,
      name: saved.name,
      description: saved.description,
      enabled: effective.enabled,
      saved_enabled: saved.enabled,
      endpoint: effective.url,
      saved_endpoint: saved.url,
      endpoint_source: effective.url_source,
      enabled_source: effective.enabled_source,
      timeout_ms: saved.timeout_ms,
      max_results_per_query: saved.max_results_per_query,
      status: effective.enabled ? saved.status : 'DISABLED',
      last_health_check: saved.last_health_check,
      last_error: saved.last_error
    }],
    downstream_adapters: [
      'Greenhouse',
      'Lever',
      'Ashby',
      'SmartRecruiters',
      'Workable',
      'Generic public career pages'
    ],
    source_catalog: JOB_SOURCE_CATALOG,
    source_safety: {
      login_automation: false,
      captcha_or_mfa_bypass: false,
      access_control_bypass: false,
      user_provided_urls_supported: true,
      search_failure_blocks_workflow: false
    },
    offline_demo: {
      enabled: true,
      status: 'READY',
      synthetic: true,
      network_accessed: false
    },
    ai_enrichment: publicAIProviderSettings(null, { env })
  };
}

export async function testSearxngConnection(provider, {
  fetchImpl = globalThis.fetch,
  now = () => new Date().toISOString()
} = {}) {
  const checkedAt = now();
  if (provider?.enabled === false) {
    return {
      status: 'DISABLED',
      ok: false,
      last_health_check: checkedAt,
      last_error: 'Provider is disabled.',
      result_count: 0
    };
  }

  let endpoint;
  try {
    endpoint = validateSearchProviderUrl(provider?.url || provider?.endpoint || '');
  } catch (error) {
    return {
      status: 'MISCONFIGURED',
      ok: false,
      last_health_check: checkedAt,
      last_error: error.message,
      result_count: 0
    };
  }

  const timeoutMs = clampInteger(provider?.timeout_ms, DEFAULT_SEARXNG.timeout_ms, 500, 120000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL(endpoint);
    url.searchParams.set('q', 'resume jobs provider health check');
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', 'all');
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) {
      return {
        status: response.status >= 500 ? 'UNREACHABLE' : 'ERROR',
        ok: false,
        last_health_check: checkedAt,
        last_error: `Provider returned HTTP ${response.status}.`,
        result_count: 0
      };
    }
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.results)) {
      return {
        status: 'ERROR',
        ok: false,
        last_health_check: checkedAt,
        last_error: 'Provider response is not valid SearXNG JSON.',
        result_count: 0
      };
    }
    return {
      status: 'READY',
      ok: true,
      last_health_check: checkedAt,
      last_error: '',
      result_count: payload.results.length
    };
  } catch (error) {
    let isLoopback = false;
    try {
      isLoopback = ['127.0.0.1', 'localhost', '::1'].includes(new URL(endpoint).hostname.toLowerCase());
    } catch {
      // Validation below already classifies an invalid endpoint as unreachable.
      isLoopback = false;
    }
    return {
      status: 'UNREACHABLE',
      ok: false,
      last_health_check: checkedAt,
      last_error: error?.name === 'AbortError'
        ? `Connection timed out after ${timeoutMs} ms.`
        : isLoopback
          ? 'SearXNG is not running at the configured localhost endpoint.'
          : 'Could not reach the configured SearXNG endpoint.',
      result_count: 0
    };
  } finally {
    clearTimeout(timer);
  }
}
