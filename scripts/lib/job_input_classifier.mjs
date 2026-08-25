// Job-discovery input classification and the job quality gate.
//
// One import box used to force every input through the same single-URL fetch,
// which is exactly how a BOSS 直聘 list page became dozens of fake
// "查看更多职位" job records and the LinkedIn jobs HOME page became one failed
// fetch. Inputs are now classified FIRST, and each kind has its own path:
//
//   search_query        – not a URL: goes to the discovery providers
//   single_job_url      – one posting: fetch + extract + quality gate
//   company_careers_url – a company board: the careers providers, many jobs
//   job_board_url       – an aggregator list/search/home page (LinkedIn jobs,
//                         BOSS, 拉勾, 猎聘…): NEVER a job record; usually needs
//                         a real browser session the user drives
export const INPUT_KINDS = Object.freeze(['single_job_url', 'company_careers_url', 'job_board_url', 'search_query']);

const text = value => String(value ?? '').trim();

// Aggregator boards. These sites are list/search products, not single
// companies; their list pages must never be scraped into job records, and most
// of them render with JavaScript behind a login wall — a plain fetch cannot
// read them honestly.
const BOARD_HOSTS = [
  { host: 'linkedin.com', detail: /^\/jobs\/view\/\d+/i, browserRequired: true },
  { host: 'zhipin.com', detail: /^\/job_detail\/[^/]+\.html/i, browserRequired: true },
  { host: 'lagou.com', detail: /^\/(?:wn\/)?jobs\/\d+/i, browserRequired: true },
  { host: 'liepin.com', detail: /^\/(?:job|a)\/\d+/i, browserRequired: true },
  { host: 'zhaopin.com', detail: /^\/job_detail\//i, browserRequired: true },
  { host: '51job.com', detail: /\/job\/|\/\d+\.html/i, browserRequired: true },
  { host: 'kanzhun.com', detail: /^$/, browserRequired: true },
  { host: 'indeed.com', detail: /viewjob/i, browserRequired: true },
  { host: 'glassdoor.com', detail: /\/job-listing\//i, browserRequired: true },
  { host: 'xiaohongshu.com', detail: /^$/, browserRequired: true },
];

// ATS hosts where a SPECIFIC posting is recognizable from the URL shape alone.
const ATS_SINGLE_JOB = [
  { host: 'jobs.lever.co', pattern: /^\/[^/]+\/[0-9a-f]{8}-[0-9a-f-]{27,}(?:\/apply)?\/?$/i },
  { host: 'greenhouse.io', pattern: /\/jobs\/\d+/i, query: 'gh_jid' },
  { host: 'jobs.ashbyhq.com', pattern: /^\/[^/]+\/[0-9a-f]{8}-[0-9a-f-]{27,}/i },
  { host: 'jobs.smartrecruiters.com', pattern: /^\/[^/]+\/\d{9,}/i },
  { host: 'apply.workable.com', pattern: /^\/[^/]+\/j\/[0-9A-F]{8,}/i },
  { host: 'myworkdayjobs.com', pattern: /\/job\/[^/]+\/[^/]+/i },
  { host: 'workdayjobs.com', pattern: /\/job\/[^/]+\/[^/]+/i },
  { host: 'jobs.apple.com', pattern: /\/details\/\d+/i },
];

// ATS hosts where the ORG ROOT is a company board the careers providers read.
const ATS_BOARD_ROOT = [
  { host: 'jobs.lever.co', pattern: /^\/[^/]+\/?$/ },
  { host: 'greenhouse.io', pattern: /^\/[^/]+\/?$/ },
  { host: 'jobs.ashbyhq.com', pattern: /^\/[^/]+\/?$/ },
  { host: 'jobs.smartrecruiters.com', pattern: /^\/[^/]+\/?$/ },
  { host: 'careers.smartrecruiters.com', pattern: /^\/[^/]+\/?$/ },
  { host: 'apply.workable.com', pattern: /^\/[^/]+\/?$/ },
];

function hostMatches(hostname, needle) {
  return hostname === needle || hostname.endsWith(`.${needle}`);
}

export function classifyJobInput(raw) {
  const value = text(raw);
  if (!value) return { kind: 'search_query', query: '', reason: 'empty_input' };

  let url = null;
  try { url = new URL(value); } catch { /* not a URL */ }
  if (!url && /^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(value) && !/\s/.test(value)) {
    try { url = new URL(`https://${value}`); } catch { /* keep as query */ }
  }
  if (!url || !['http:', 'https:'].includes(url.protocol)) {
    return { kind: 'search_query', query: value, reason: 'not_a_url' };
  }

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  const pathname = url.pathname.replace(/\/{2,}/g, '/');

  // Aggregator boards first: a specific posting URL is a single job; anything
  // else on the board (home, search, list, company page) is the board itself.
  for (const board of BOARD_HOSTS) {
    if (!hostMatches(hostname, board.host)) continue;
    if (board.detail.source !== '^$' && board.detail.test(pathname)) {
      return {
        kind: 'single_job_url', url: url.href, provider_hint: board.host,
        browser_required: board.browserRequired === true,
        reason: `known_job_board_detail_url:${board.host}`
      };
    }
    return {
      kind: 'job_board_url', url: url.href, provider_hint: board.host,
      browser_required: board.browserRequired === true,
      reason: `job_board_page:${board.host}`
    };
  }

  for (const ats of ATS_SINGLE_JOB) {
    if (!hostMatches(hostname, ats.host)) continue;
    if (ats.pattern.test(pathname) || (ats.query && url.searchParams.has(ats.query))) {
      return { kind: 'single_job_url', url: url.href, provider_hint: ats.host, browser_required: false, reason: `ats_single_job_url:${ats.host}` };
    }
  }
  for (const ats of ATS_BOARD_ROOT) {
    if (!hostMatches(hostname, ats.host)) continue;
    if (ats.pattern.test(pathname)) {
      return { kind: 'company_careers_url', url: url.href, provider_hint: ats.host, browser_required: false, reason: `ats_board_root:${ats.host}` };
    }
  }

  // Generic company sites: a careers/jobs LISTING path is a careers page; a
  // deeper path under it that ends in an identifier-ish segment is a posting.
  const segments = pathname.split('/').filter(Boolean);
  const careerish = /(careers?|jobs?|positions?|join-?us|vacanc|招聘|职位|校招|社招)/i;
  if (careerish.test(pathname) || careerish.test(hostname)) {
    const last = segments.at(-1) || '';
    const looksLikePosting = segments.length >= 2
      && !careerish.test(last)
      && (/^\d+$/.test(last) || /\d{3,}/.test(last) || /^[0-9a-f-]{8,}$/i.test(last) || /[a-z0-9]+(?:-[a-z0-9]+){2,}/i.test(last));
    return looksLikePosting
      ? { kind: 'single_job_url', url: url.href, provider_hint: 'generic', browser_required: false, reason: 'careerish_path_with_posting_segment' }
      : { kind: 'company_careers_url', url: url.href, provider_hint: 'generic', browser_required: false, reason: 'careerish_listing_path' };
  }

  // Any other URL: try it as a single posting; the quality gate decides.
  return { kind: 'single_job_url', url: url.href, provider_hint: 'generic', browser_required: false, reason: 'unrecognized_url_defaults_to_single_job' };
}

// --- Job quality gate --------------------------------------------------------
//
// Titles that are navigation, not jobs. "查看更多职位" reaching the inventory
// as a job record is the defect this gate exists to stop.
const NAV_TITLE_PATTERN = new RegExp([
  '^查看更多.*$', '^更多(?:工作|职位|岗位).*$', '^全部(?:职位|岗位|工作)$', '^职位列表$', '^热招职位$',
  '^(?:立即)?(?:投递|申请|沟通)$', '^登录|注册$', '^搜索.*$', '^首页$', '^下一页$', '^上一页$',
  '^jobs?$', '^careers?$', '^all\\s+(?:jobs|positions|openings)$', '^open\\s+positions?$',
  '^view\\s+(?:all|more).*$', '^see\\s+(?:all|more).*$', '^more\\s+jobs$', '^load\\s+more.*$',
  '^apply(?:\\s+now)?$', '^view$', '^details?$', '^learn\\s+more$', '^join\\s+us$', '^home$',
  '^next$', '^previous$', '^back$', '^sign\\s+(?:in|up)$', '^log\\s?in$',
].join('|'), 'i');

export function isNavigationTitle(title) {
  const value = text(title);
  if (!value) return true;
  return NAV_TITLE_PATTERN.test(value);
}

// Decides whether an extracted record is a real job. Used on import (fail
// closed: no record) and by the inventory repair pass (mark, don't delete).
export function jobQualityGate(record = {}, { requireDescription = false } = {}) {
  const reasons = [];
  const title = text(record.title);
  if (title.length < 2) reasons.push('missing_title');
  else if (isNavigationTitle(title)) reasons.push('navigation_title');
  const company = text(record.company);
  const description = text(record.description_text || record.description);
  if (!company && !description) reasons.push('no_company_and_no_description');
  if (requireDescription && description.length < 40 && record.page_type !== 'job_detail') {
    reasons.push('no_real_description');
  }
  const applyUrl = text(record.apply_url || record.canonical_url || record.url);
  if (!applyUrl) reasons.push('missing_url');
  else {
    const boardPage = classifyJobInput(applyUrl);
    if (boardPage.kind === 'job_board_url') reasons.push('url_is_board_list_page');
  }
  return { ok: reasons.length === 0, reasons };
}
