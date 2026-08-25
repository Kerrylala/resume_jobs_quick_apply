import crypto from 'node:crypto';

const TRACKING_PARAMETERS = new Set([
  'fbclid', 'gclid', 'igshid', 'msclkid', 'ref', 'ref_src', 'referrer',
  'source', 'spm',
  'utm_campaign', 'utm_content', 'utm_medium', 'utm_source', 'utm_term'
]);

function cleanText(value, max = 5000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(value, maxItems = 200) {
  const source = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(source.map(item => cleanText(typeof item === 'object' ? item?.name || item?.text : item, 1000)).filter(Boolean))].slice(0, maxItems);
}

function inferCountry(job, location) {
  const explicit = cleanText(job?.country || job?.country_or_region, 200);
  if (explicit) return explicit;
  const value = location.toLowerCase();
  if (/\b(?:china|beijing|shanghai|shenzhen|guangzhou|hangzhou|nanjing|chengdu|wuhan|suzhou)\b|中国|上海|北京|深圳|广州|杭州|南京|成都|武汉|苏州/.test(value)) return 'China';
  if (/\bsingapore\b|新加坡/.test(value)) return 'Singapore';
  if (/\bhong kong\b|香港/.test(value)) return 'Hong Kong';
  if (/\bunited states\b|\busa\b|\bu\.s\./.test(value)) return 'United States';
  if (/\bunited kingdom\b|\buk\b/.test(value)) return 'United Kingdom';
  return '';
}

function normalizeRemote(job, location) {
  const source = cleanText(job?.remote ?? job?.remote_policy ?? job?.workplace_mode, 100).toLowerCase();
  if (job?.remote === true || source === 'true' || /\bremote\b|远程/.test(location.toLowerCase())) return 'remote';
  if (/hybrid|混合/.test(source)) return 'hybrid';
  if (/onsite|on-site|office|现场|线下/.test(source)) return 'onsite';
  return source === 'false' ? 'onsite' : '';
}

function normalizeSalary(job) {
  const source = job?.salary && typeof job.salary === 'object' && !Array.isArray(job.salary) ? job.salary : {};
  const salaryText = cleanText(typeof job?.salary === 'string' ? job.salary : job?.salary_text || job?.compensation || source.text, 500);
  const number = value => Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    text: salaryText,
    minimum: number(source.minimum ?? source.min ?? job?.salary_min),
    maximum: number(source.maximum ?? source.max ?? job?.salary_max),
    currency: cleanText(source.currency || job?.salary_currency, 20),
    period: cleanText(source.period || job?.salary_period, 50)
  };
}

function inferSourceType(job, source) {
  const explicit = cleanText(job?.source_type, 100);
  if (explicit) return explicit;
  const value = `${source} ${job?.provider || ''}`.toLowerCase();
  if (/user.*url|manual.*url/.test(value)) return 'user_provided_url';
  if (/greenhouse|lever|workday|ashby|smartrecruiters|workable/.test(value)) return 'ats';
  if (/searx|search/.test(value)) return 'search_backend';
  if (/china_job_board|zhipin|lagou|liepin|zhaopin|51job/.test(value)) return 'job_board';
  if (/career/.test(value)) return 'company_career_page';
  return 'public_page';
}

const ATS_PROVIDERS = new Set(['greenhouse', 'lever', 'workday', 'ashby', 'smartrecruiters', 'workable']);

export function categorizeJobSource(job = {}) {
  const country = cleanText(job.country || job.country_or_region, 200);
  const location = cleanText(job.location, 500);
  const provider = cleanText(job.provider || job.ats, 100).toLowerCase();
  const sourceType = cleanText(job.source_type, 100).toLowerCase();
  const isChina = /\bchina\b|中国|上海|北京|深圳|广州|杭州|南京|成都|武汉|苏州/i.test(`${country} ${location}`);
  if (isChina) {
    if (sourceType === 'user_provided_url') {
      return { market: 'china', category: 'user_imported_urls', label: 'User imported URLs' };
    }
    if (sourceType === 'company_career_page') {
      return { market: 'china', category: 'company_career', label: 'Company careers' };
    }
    if (sourceType === 'assisted_browsing') {
      return { market: 'china', category: 'assisted_browsing', label: 'Assisted browsing' };
    }
    return { market: 'china', category: 'public_job_pages', label: 'Public job pages' };
  }
  if (sourceType === 'user_provided_url') {
    return { market: 'global', category: 'user_imported_urls', label: 'User imported URLs' };
  }
  if (sourceType === 'assisted_browsing') {
    return { market: 'global', category: 'assisted_browsing', label: 'Assisted browsing' };
  }
  if (sourceType === 'ats' || ATS_PROVIDERS.has(provider)) {
    return { market: 'global', category: 'ats', label: 'Public application forms' };
  }
  return { market: 'global', category: 'career_pages', label: 'Company careers' };
}

function discoveryMetadata(job, { source, sourceType, provider, firstSeen }) {
  const existing = job?.discovery && typeof job.discovery === 'object' && !Array.isArray(job.discovery)
    ? job.discovery
    : {};
  const query = cleanText(existing.query || job?.search_query || job?.query, 1000);
  const searchedAt = cleanText(existing.searched_at || job?.search_time || job?.imported_at || firstSeen, 100);
  let whyDiscovered = cleanText(existing.why_discovered || job?.why_discovered || job?.role_reason, 2000);
  if (!whyDiscovered) {
    if (sourceType === 'user_provided_url') whyDiscovered = 'You imported this public job URL.';
    else if (query) whyDiscovered = `Matched the saved search query: ${query}`;
    else if (sourceType === 'ats') whyDiscovered = 'Discovered on a supported public application page.';
    else if (sourceType === 'company_career_page') whyDiscovered = 'Discovered on a public company career page.';
    else whyDiscovered = 'Discovered from a public job source.';
  }
  return {
    source: cleanText(existing.source || source, 200),
    query: query || (sourceType === 'user_provided_url' ? 'Direct URL import' : 'Not recorded'),
    searched_at: searchedAt,
    why_discovered: whyDiscovered,
    provider: cleanText(existing.provider || provider || 'unknown', 100),
    // Full provenance: which mechanism found this job and the exact page it
    // came from, so the UI can always answer "这个岗位从哪里来的？".
    discovered_by: cleanText(existing.discovered_by || job?.discovered_by || sourceType || source, 100),
    discovered_at: cleanText(existing.discovered_at || job?.imported_at || firstSeen, 100),
    original_url: cleanText(existing.original_url || job?.original_url || job?.apply_url || job?.url, 2048)
  };
}

export function canonicalizeJobUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMETERS.has(key.toLowerCase()) || key.toLowerCase().startsWith('utm_')) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/';
    return url.href;
  } catch {
    return '';
  }
}

function stableJobId(canonicalUrl) {
  return `job_${crypto.createHash('sha256').update(canonicalUrl).digest('hex').slice(0, 16)}`;
}

function inferSourceJobId(job, canonicalUrl) {
  const explicit = cleanText(job.source_job_id || job.external_id || job.requisition_id, 200);
  if (explicit) return explicit;
  try {
    const url = new URL(canonicalUrl);
    for (const key of ['gh_jid', 'job_id', 'jobId', 'lever-source']) {
      const value = cleanText(url.searchParams.get(key), 200);
      if (value) return value;
    }
    const parts = url.pathname.split('/').filter(Boolean);
    if (/greenhouse|lever|ashby|smartrecruiters/.test(url.hostname) && parts.length) {
      return cleanText(parts.at(-1), 200);
    }
  } catch {
    // A malformed optional source URL has no trustworthy provider identifier.
  }
  return '';
}

function provenance(job, source, sourceJobId, canonicalUrl, seenAt) {
  const existing = Array.isArray(job.sources) ? job.sources : [];
  const current = {
    source,
    source_job_id: sourceJobId,
    url: canonicalUrl,
    seen_at: seenAt
  };
  const byKey = new Map();
  for (const item of [...existing, current]) {
    const key = `${cleanText(item?.source)}\u0000${cleanText(item?.source_job_id)}\u0000${canonicalizeJobUrl(item?.url)}`;
    byKey.set(key, {
      source: cleanText(item?.source),
      source_job_id: cleanText(item?.source_job_id),
      url: canonicalizeJobUrl(item?.url),
      seen_at: cleanText(item?.seen_at) || seenAt
    });
  }
  return [...byKey.values()];
}

export function normalizeJobRecord(job, { now = new Date().toISOString(), defaultSource = 'unknown' } = {}) {
  const canonicalUrl = canonicalizeJobUrl(job?.canonical_url || job?.url || job?.job_url || job?.apply_url);
  if (!canonicalUrl) return null;
  const source = cleanText(job?.source) || defaultSource;
  const sourceJobId = inferSourceJobId(job || {}, canonicalUrl);
  const firstSeen = cleanText(job?.first_seen || job?.first_seen_at || job?.discovered_at || job?.date_found) || now;
  const lastSeen = cleanText(job?.last_seen || job?.last_seen_at) || firstSeen;
  const timesSeen = Math.max(1, Number(job?.times_seen) || 1);
  const discoveryStatus = cleanText(job?.discovery_status, 50) || (timesSeen > 1 ? 'previously_seen' : 'new');
  const location = cleanText(job?.location || job?.city, 500);
  const salary = normalizeSalary(job || {});
  const country = inferCountry(job || {}, location);
  const sourceType = inferSourceType(job || {}, source);
  const provider = cleanText(job?.provider || job?.ats, 100) || 'unknown';
  const sourceCategory = categorizeJobSource({ ...job, country, location, provider, source_type: sourceType });
  const discovery = discoveryMetadata(job || {}, { source, sourceType, provider, firstSeen });
  return {
    ...(job || {}),
    job_id: cleanText(job?.job_id || job?.lead_id, 200) || stableJobId(canonicalUrl),
    status: cleanText(job?.status || job?.lifecycle_status || job?.approval_status, 100) || 'discovered',
    source,
    source_type: sourceType,
    source_market: sourceCategory.market,
    source_category: sourceCategory.category,
    source_category_label: sourceCategory.label,
    source_job_id: sourceJobId,
    company: cleanText(job?.company),
    title: cleanText(job?.title || job?.search_title, 220),
    location,
    country,
    remote: normalizeRemote(job || {}, location),
    salary,
    canonical_url: canonicalUrl,
    url: canonicalUrl,
    apply_url: canonicalizeJobUrl(job?.apply_url || canonicalUrl) || canonicalUrl,
    // notes carry internal provenance/status markers and must never become the
    // job description; a job with no real content reports description_available=false.
    description_text: cleanText(job?.description_text || job?.description || job?.search_snippet),
    description_available: Boolean(cleanText(job?.description_text || job?.description || job?.search_snippet)),
    requirements: cleanList(job?.requirements || job?.required_skills || job?.qualifications),
    posted_date: cleanText(job?.posted_date || job?.posted_at || job?.published_at, 100),
    seniority: cleanText(job?.seniority || job?.likely_seniority, 100),
    first_seen_at: firstSeen,
    last_seen_at: lastSeen,
    first_seen: firstSeen,
    last_seen: lastSeen,
    times_seen: timesSeen,
    discovery_status: discoveryStatus,
    discovery_memory: {
      first_seen: firstSeen,
      last_seen: lastSeen,
      times_seen: timesSeen,
      status: discoveryStatus,
      source
    },
    discovered_at: firstSeen,
    search_query: discovery.query,
    search_time: discovery.searched_at,
    why_discovered: discovery.why_discovered,
    discovery,
    // Set by the inventory repair pass on records that were never jobs
    // (navigation/list-page anchors). Kept through every re-normalization so a
    // marked record can never silently resurface.
    ...(job?.invalid_non_job === true ? {
      invalid_non_job: true,
      invalid_reasons: Array.isArray(job?.invalid_reasons) ? job.invalid_reasons.map(item => cleanText(item, 60)).filter(Boolean) : []
    } : {}),
    // User flags: shortlist membership and the permanent ignore. Both survive
    // every re-normalization and merge — a job ignored forever can be
    // rediscovered by any provider and still never resurface.
    ...(job?.shortlisted === true ? { shortlisted: true } : {}),
    ...(job?.ignored_forever === true ? { ignored_forever: true } : {}),
    // Match explanation attached by the Global Job Search run (score + why fit
    // + main gaps); preserved so the UI can show it after re-normalization.
    ...(job?.search_match && typeof job.search_match === 'object' ? {
      search_match: {
        match_score: Number.isFinite(Number(job.search_match.match_score)) ? Number(job.search_match.match_score) : null,
        why_fit: (Array.isArray(job.search_match.why_fit) ? job.search_match.why_fit : []).map(item => cleanText(item, 200)).filter(Boolean).slice(0, 6),
        main_gaps: (Array.isArray(job.search_match.main_gaps) ? job.search_match.main_gaps : []).map(item => cleanText(item, 200)).filter(Boolean).slice(0, 6),
        soft_notes: (Array.isArray(job.search_match.soft_notes) ? job.search_match.soft_notes : []).map(item => cleanText(item, 200)).filter(Boolean).slice(0, 6),
        plan_id: cleanText(job.search_match.plan_id, 60),
        scored_at: cleanText(job.search_match.scored_at, 100),
      }
    } : {}),
    sources: provenance(job || {}, source, sourceJobId, canonicalUrl, lastSeen),
    dedupe: {
      key: canonicalUrl,
      reason: cleanText(job?.dedupe?.reason) || 'canonical_url',
      merged_source_count: Array.isArray(job?.sources) ? job.sources.length : 1
    }
  };
}

function postedTimestamp(job) {
  const value = Date.parse(job?.posted_date || job?.posted_at || job?.published_at || '');
  return Number.isFinite(value) ? value : 0;
}

function seenTimestamp(job) {
  const value = Date.parse(job?.last_seen || job?.last_seen_at || job?.first_seen || job?.first_seen_at || '');
  return Number.isFinite(value) ? value : 0;
}

function isNewDiscovery(job) {
  if (job?.discovery_status === 'previously_seen') return false;
  if (job?.discovery_status === 'new') return true;
  return Number(job?.times_seen || 1) <= 1;
}

export function rankJobsByFreshness(jobs = []) {
  return [...jobs].sort((left, right) => {
    const leftNew = isNewDiscovery(left);
    const rightNew = isNewDiscovery(right);
    if (leftNew !== rightNew) return leftNew ? -1 : 1;
    const postedDelta = postedTimestamp(right) - postedTimestamp(left);
    if (postedDelta) return postedDelta;
    // New records in the same discovery batch may be normalized milliseconds
    // apart. That implementation timestamp is not job freshness and must not
    // reverse the provider's stable result order.
    if (!leftNew && !rightNew) {
      const seenDelta = seenTimestamp(right) - seenTimestamp(left);
      if (seenDelta) return seenDelta;
    }
    return Number(left?.times_seen || 1) - Number(right?.times_seen || 1);
  });
}

function normalizedLifecycleStatus(job, statusByJob) {
  const jobId = cleanText(job?.job_id, 200);
  const mapped = statusByJob instanceof Map
    ? statusByJob.get(jobId)
    : statusByJob && typeof statusByJob === 'object'
      ? statusByJob[jobId]
      : '';
  return cleanText(mapped || job?.lifecycle_status || job?.approval_status || job?.status, 100).toLowerCase();
}

function ageInDays(value, nowTimestamp) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (nowTimestamp - timestamp) / 86_400_000);
}

function sourceDiversityKey(job) {
  return cleanText(job?.source_category || job?.provider || job?.source_type || job?.source, 100).toLowerCase() || 'unknown';
}

function jobDiversityKey(job, field) {
  return cleanText(job?.[field], 500).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim() || `unknown:${field}`;
}

function diversityOrder(items, policy, state) {
  const remaining = [...items];
  const ordered = [];
  while (remaining.length) {
    let bestIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    remaining.forEach((job, index) => {
      const source = sourceDiversityKey(job);
      const company = jobDiversityKey(job, 'company');
      const role = jobDiversityKey(job, 'title');
      const location = jobDiversityKey(job, 'location');
      const score = (state.sources.size < policy.minimum_source_diversity && !state.sources.has(source) ? 100 : 0)
        + (!state.companies.has(company) ? 20 : 0)
        + (!state.roles.has(role) ? 5 : 0)
        + (!state.locations.has(location) ? 2 : 0)
        + ((remaining.length - index) / Math.max(1, remaining.length));
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    const [job] = remaining.splice(bestIndex, 1);
    ordered.push(job);
    state.sources.add(sourceDiversityKey(job));
    state.companies.add(jobDiversityKey(job, 'company'));
    state.roles.add(jobDiversityKey(job, 'title'));
    state.locations.add(jobDiversityKey(job, 'location'));
  }
  return ordered;
}

// Read-time suppression policy: one definition of which jobs stay out of the
// default New/Good Matches views while remaining stored, visible under their
// own lifecycle tab, and explicitly restorable.
const DEFAULT_SUPPRESSED_LIFECYCLES = new Set(['rejected', 'applied']);
const IN_PROGRESS_APPLICATION_STATUSES = new Set([
  'APPROVED_FOR_PACKAGE', 'PACKAGE_READY', 'FILL_APPROVED', 'EXECUTOR_READY',
  'EXECUTING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT', 'MANUALLY_SUBMITTED'
]);

export function isSuppressedFromDefaultResults({ lifecycleStatus = '', applicationStatus = '' } = {}) {
  if (DEFAULT_SUPPRESSED_LIFECYCLES.has(String(lifecycleStatus || '').toLowerCase())) return true;
  return IN_PROGRESS_APPLICATION_STATUSES.has(String(applicationStatus || ''));
}

export function filterRejectedJobs(jobs, { includeRejected = false } = {}) {
  const records = Array.isArray(jobs) ? jobs : [];
  if (includeRejected) return [...records];
  return records.filter(job => String(job?.lifecycle_status || '').toLowerCase() !== 'rejected');
}

export function applyDiscoveryPolicy(jobs = [], {
  preferences = {},
  statusByJob = {},
  now = new Date().toISOString()
} = {}) {
  const policy = {
    show_unseen_only: preferences.show_unseen_only === true,
    include_previously_seen: preferences.show_unseen_only === true
      ? false
      : preferences.include_previously_seen !== false,
    do_not_repeat_rejected: preferences.do_not_repeat_rejected !== false,
    do_not_repeat_approved: preferences.do_not_repeat_approved !== false,
    do_not_repeat_applied: preferences.do_not_repeat_applied !== false,
    repeat_after_days: Math.max(0, Math.min(365, Number(preferences.repeat_after_days ?? 14) || 0)),
    maximum_results_per_company: Math.max(1, Math.min(50, Number(preferences.maximum_results_per_company ?? 3) || 3)),
    minimum_source_diversity: Math.max(1, Math.min(10, Number(preferences.minimum_source_diversity ?? 2) || 2)),
    maximum_search_results: Math.max(1, Math.min(500, Number(preferences.maximum_search_results ?? 50) || 50))
  };
  const nowTimestamp = Number.isFinite(Date.parse(now)) ? Date.parse(now) : Date.now();
  const ranked = rankJobsByFreshness(jobs);
  const eligible = [];
  const deferred = [];

  for (const job of ranked) {
    const lifecycle = normalizedLifecycleStatus(job, statusByJob);
    const isNew = isNewDiscovery(job);
    const seenAgeDays = ageInDays(job?.last_seen || job?.last_seen_at, nowTimestamp);
    let reason = '';
    if (policy.do_not_repeat_rejected && lifecycle === 'rejected') reason = 'rejected_history';
    else if (policy.do_not_repeat_approved && lifecycle === 'approved') reason = 'approved_history';
    else if (policy.do_not_repeat_applied && lifecycle === 'applied') reason = 'applied_history';
    else if (!isNew && policy.show_unseen_only) reason = 'unseen_only';
    else if (!isNew && !policy.include_previously_seen) reason = 'previously_seen_disabled';
    else if (!isNew && seenAgeDays < policy.repeat_after_days) reason = 'repeat_wait';

    const annotated = {
      ...job,
      discovery_rank: {
        eligible: !reason,
        cohort: isNew ? 'new' : 'previously_seen',
        lifecycle_status: lifecycle || 'discovered',
        deferred_reason: reason,
        seen_age_days: Number.isFinite(seenAgeDays) ? Number(seenAgeDays.toFixed(2)) : null
      }
    };
    (reason ? deferred : eligible).push(annotated);
  }

  const companyCounts = new Map();
  const companyLimited = [];
  const withinCompanyLimit = [];
  for (const job of eligible) {
    const companyKey = cleanText(job.company, 500).toLowerCase() || `unknown:${job.job_id}`;
    const count = companyCounts.get(companyKey) || 0;
    if (count >= policy.maximum_results_per_company) {
      companyLimited.push({
        ...job,
        discovery_rank: { ...job.discovery_rank, eligible: false, deferred_reason: 'company_limit' }
      });
      continue;
    }
    companyCounts.set(companyKey, count + 1);
    withinCompanyLimit.push(job);
  }

  const diversityState = { sources: new Set(), companies: new Set(), roles: new Set(), locations: new Set() };
  const diversified = [
    ...diversityOrder(withinCompanyLimit.filter(job => job.discovery_rank.cohort === 'new'), policy, diversityState),
    ...diversityOrder(withinCompanyLimit.filter(job => job.discovery_rank.cohort !== 'new'), policy, diversityState)
  ];
  const selected = diversified.slice(0, policy.maximum_search_results);
  const resultLimited = diversified.slice(policy.maximum_search_results).map(job => ({
    ...job,
    discovery_rank: { ...job.discovery_rank, eligible: false, deferred_reason: 'result_limit' }
  }));

  const ordered = [...selected, ...deferred, ...companyLimited, ...resultLimited].map((job, index) => ({
    ...job,
    discovery_rank: { ...job.discovery_rank, position: index + 1 }
  }));
  const availableSources = new Set(withinCompanyLimit.map(sourceDiversityKey));
  const selectedSources = new Set(selected.map(sourceDiversityKey));
  const deferredReasons = {};
  for (const job of [...deferred, ...companyLimited, ...resultLimited]) {
    const reason = job.discovery_rank.deferred_reason || 'other';
    deferredReasons[reason] = (deferredReasons[reason] || 0) + 1;
  }
  return {
    jobs: ordered,
    current_jobs: selected,
    deferred_jobs: [...deferred, ...companyLimited, ...resultLimited],
    policy,
    quality: {
      total_inventory_count: ordered.length,
      current_result_count: selected.length,
      new_result_count: selected.filter(job => job.discovery_rank.cohort === 'new').length,
      previously_seen_result_count: selected.filter(job => job.discovery_rank.cohort === 'previously_seen').length,
      deferred_count: deferred.length + companyLimited.length + resultLimited.length,
      deferred_reasons: deferredReasons,
      source_diversity_count: selectedSources.size,
      available_source_diversity_count: availableSources.size,
      minimum_source_diversity: policy.minimum_source_diversity,
      source_diversity_met: selectedSources.size >= Math.min(policy.minimum_source_diversity, availableSources.size),
      company_diversity_count: new Set(selected.map(job => jobDiversityKey(job, 'company'))).size,
      role_diversity_count: new Set(selected.map(job => jobDiversityKey(job, 'title'))).size,
      location_diversity_count: new Set(selected.map(job => jobDiversityKey(job, 'location'))).size,
      company_limit_deferred_count: companyLimited.length,
      result_limit_deferred_count: resultLimited.length
    }
  };
}

export function mergeJobRecords(existingJobs = [], incomingJobs = [], { now = new Date().toISOString() } = {}) {
  const byCanonicalUrl = new Map();
  let duplicatesMerged = 0;
  const records = [
    ...existingJobs.map(raw => ({ raw, incoming: false })),
    ...incomingJobs.map(raw => ({ raw, incoming: true }))
  ];
  for (const { raw, incoming } of records) {
    const normalized = normalizeJobRecord(raw, { now });
    if (!normalized) continue;
    const previous = byCanonicalUrl.get(normalized.canonical_url);
    if (!previous) {
      byCanonicalUrl.set(normalized.canonical_url, normalized);
      continue;
    }
    duplicatesMerged += 1;
    const timesSeen = incoming
      ? Math.max(1, Number(previous.times_seen) || 1) + 1
      : Math.max(Number(previous.times_seen) || 1, Number(normalized.times_seen) || 1);
    const lastSeen = incoming
      ? now
      : [previous.last_seen_at, normalized.last_seen_at].filter(Boolean).sort().at(-1) || now;
    const sources = provenance(
      { sources: [...previous.sources, ...normalized.sources] },
      normalized.source,
      normalized.source_job_id,
      normalized.canonical_url,
      now
    );
    byCanonicalUrl.set(normalized.canonical_url, {
      ...previous,
      ...normalized,
      job_id: previous.job_id,
      first_seen_at: [previous.first_seen_at, normalized.first_seen_at].filter(Boolean).sort()[0],
      last_seen_at: lastSeen,
      first_seen: [previous.first_seen_at, normalized.first_seen_at].filter(Boolean).sort()[0],
      last_seen: lastSeen,
      times_seen: timesSeen,
      discovery_status: timesSeen > 1 ? 'previously_seen' : 'new',
      discovery_memory: {
        first_seen: [previous.first_seen_at, normalized.first_seen_at].filter(Boolean).sort()[0],
        last_seen: lastSeen,
        times_seen: timesSeen,
        status: timesSeen > 1 ? 'previously_seen' : 'new',
        source: normalized.source || previous.source || 'unknown'
      },
      discovered_at: [previous.first_seen_at, normalized.first_seen_at].filter(Boolean).sort()[0],
      search_query: normalized.search_query !== 'Not recorded'
        ? normalized.search_query
        : previous.search_query || 'Not recorded',
      search_time: normalized.search_time || previous.search_time || now,
      why_discovered: normalized.why_discovered || previous.why_discovered || 'Discovered from a public job source.',
      discovery: {
        ...(previous.discovery || {}),
        ...(normalized.discovery || {}),
        query: normalized.discovery?.query !== 'Not recorded'
          ? normalized.discovery?.query
          : previous.discovery?.query || 'Not recorded',
        searched_at: normalized.discovery?.searched_at || previous.discovery?.searched_at || now,
        why_discovered: normalized.discovery?.why_discovered
          || previous.discovery?.why_discovered
          || 'Discovered from a public job source.'
      },
      sources,
      dedupe: {
        key: normalized.canonical_url,
        reason: 'canonical_url_match',
        merged_source_count: sources.length
      }
    });
  }
  return { jobs: rankJobsByFreshness([...byCanonicalUrl.values()]), duplicates_merged: duplicatesMerged };
}
