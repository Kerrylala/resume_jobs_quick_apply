// Discovery Provider Adapter Registry — the extensible architecture behind
// the Global Job Discovery Engine. Adding a site = adding ONE adapter object.
//
// Adapter contract:
//   {
//     id, label, region: 'china' | 'global',
//     kind: 'api' | 'html' | 'meta' | 'browser',
//     capability: 'REAL_WORKING' | 'BROWSER_LOGIN_REQUIRED' | 'PARTIAL'
//               | 'BLOCKED_EXTERNAL' | 'NOT_IMPLEMENTED',
//     capability_notes: honest one-liner,
//     search({ keyword, criteria, fetchImpl, limit }) → { status, jobs, notes? }
//       jobs: [{ title, company, location, salary, description_text,
//                apply_url, posted_date }]   (candidate shape; the orchestrator
//                adds provenance and runs the quality gate)
//     browser (kind 'browser' only): { search_url(keyword, city) } — runs in
//       the persistent browser the USER signs into; never headless-scraped.
//   }
//
// Honesty rules: an adapter never fabricates fields, never bypasses a wall,
// and reports empty/blocked outcomes as exactly that.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0 Safari/537.36';
// 实习僧 obfuscates some glyphs through a custom font — those arrive as
// private-use-area entities and must be stripped, never guessed.
const text = value => String(value ?? '')
  .replace(/&#x[ef][0-9a-f]{3};/gi, '')
  .replace(/[-]/g, '')
  .replace(/\s+/g, ' ').trim();
const stripHtml = value => text(String(value ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&'));

async function getJson(fetchImpl, url, { timeoutMs = 12_000, headers = {} } = {}) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': UA, accept: 'application/json', ...headers },
    signal: AbortSignal.timeout(timeoutMs), redirect: 'follow',
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}
async function getHtml(fetchImpl, url, { timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(timeoutMs), redirect: 'follow',
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.text();
}

// --- Global: Amazon.jobs (public JSON) --------------------------------------
const amazonJobs = {
  id: 'amazon_jobs', label: 'Amazon Jobs', region: 'global', kind: 'api',
  capability: 'REAL_WORKING', capability_notes: 'Public search.json API.',
  async search({ keyword, fetchImpl, limit = 20 }) {
    const data = await getJson(fetchImpl,
      `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(keyword)}&result_limit=${Math.min(limit, 50)}&offset=0`);
    const jobs = (data.jobs || []).map(job => ({
      title: text(job.title),
      company: 'Amazon',
      location: text(job.normalized_location || job.location),
      salary: '',
      description_text: stripHtml(job.description_short || job.description || '').slice(0, 1500),
      apply_url: job.job_path ? `https://www.amazon.jobs${job.job_path}` : text(job.url_next_step),
      posted_date: text(job.posted_date),
    }));
    return { status: jobs.length ? 'ok' : 'no_results', jobs };
  },
};

// --- Global: Wellfound (server-rendered role pages) --------------------------
const wellfound = {
  id: 'wellfound', label: 'Wellfound', region: 'global', kind: 'html',
  capability: 'REAL_WORKING', capability_notes: 'Server-rendered role pages; job links parsed with nearby company names.',
  async search({ keyword, fetchImpl, limit = 20 }) {
    const slug = text(keyword).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!slug) return { status: 'no_results', jobs: [] };
    const html = await getHtml(fetchImpl, `https://wellfound.com/role/r/${slug}`);
    const jobs = [];
    // Job anchors carry the posting; the nearest preceding company anchor
    // names the startup. Titles come from the visible anchor text.
    const pattern = /<a[^>]*href="(\/jobs\/(\d+)-[^"]*)"[^>]*>([\s\S]{0,300}?)<\/a>/g;
    const companyPattern = /<a[^>]*href="\/company\/([^"/]+)"[^>]*>([\s\S]{0,120}?)<\/a>/g;
    const companies = [...html.matchAll(companyPattern)].map(match => ({ index: match.index, name: stripHtml(match[2]) }));
    const seen = new Set();
    for (const match of html.matchAll(pattern)) {
      const id = match[2];
      if (seen.has(id)) continue;
      seen.add(id);
      const title = stripHtml(match[3]) || text(match[1].split('-').slice(1).join(' '));
      const nearestCompany = companies.filter(company => company.index < match.index).at(-1);
      jobs.push({
        title,
        company: nearestCompany?.name || '',
        location: '', salary: '', description_text: '',
        apply_url: `https://wellfound.com${match[1]}`,
        posted_date: '',
      });
      if (jobs.length >= limit) break;
    }
    return { status: jobs.length ? 'ok' : 'no_results', jobs };
  },
};

// --- Global: Remotive (public API, remote jobs) ------------------------------
const remotive = {
  id: 'remotive', label: 'Remotive (remote)', region: 'global', kind: 'api',
  capability: 'REAL_WORKING', capability_notes: 'Public remote-jobs API.',
  async search({ keyword, fetchImpl, limit = 20 }) {
    const data = await getJson(fetchImpl,
      `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(keyword)}&limit=${Math.min(limit, 50)}`);
    const jobs = (data.jobs || []).slice(0, limit).map(job => ({
      title: text(job.title),
      company: text(job.company_name),
      location: text(job.candidate_required_location) || 'Remote',
      salary: text(job.salary),
      description_text: stripHtml(job.description).slice(0, 1500),
      apply_url: text(job.url),
      posted_date: text(job.publication_date),
    }));
    return { status: jobs.length ? 'ok' : 'no_results', jobs };
  },
};

// --- China: 腾讯招聘 (public JSON) ------------------------------------------
const tencentCareers = {
  id: 'tencent_careers', label: '腾讯招聘', region: 'china', kind: 'api',
  capability: 'REAL_WORKING', capability_notes: 'Official public post/Query API.',
  async search({ keyword, fetchImpl, limit = 20 }) {
    const data = await getJson(fetchImpl,
      `https://careers.tencent.com/tencentcareer/api/post/Query?keyword=${encodeURIComponent(keyword)}&pageIndex=1&pageSize=${Math.min(limit, 50)}&language=zh-cn`);
    const jobs = (data?.Data?.Posts || []).map(post => ({
      title: text(post.RecruitPostName),
      company: '腾讯',
      location: text(post.LocationName),
      salary: '',
      description_text: text(post.Responsibility).slice(0, 1500),
      apply_url: text(post.PostURL),
      posted_date: text(post.LastUpdateTime),
    }));
    return { status: jobs.length ? 'ok' : 'no_results', jobs };
  },
};

// --- China: 牛客招聘 (public JSON, campus + experienced) ---------------------
const nowcoder = {
  id: 'nowcoder', label: '牛客招聘', region: 'china', kind: 'api',
  capability: 'REAL_WORKING', capability_notes: 'Public np-api job search; strong for 校招/应届.',
  async search({ keyword, fetchImpl, limit = 20 }) {
    const response = await fetchImpl('https://www.nowcoder.com/np-api/u/job/search', {
      method: 'POST',
      headers: { 'user-agent': UA, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ query: keyword, page: 1, pageSize: Math.min(limit, 30) }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const data = await response.json();
    const jobs = (data?.data?.datas || []).map(item => {
      let description = '';
      try {
        const ext = JSON.parse(item.ext || '{}');
        description = text([ext.infos, ext.requirements].filter(Boolean).join('\n')).slice(0, 1500);
      } catch { /* ext is optional */ }
      const salary = item.salaryMin && item.salaryMax
        ? `${item.salaryMin}-${item.salaryMax}K${item.salaryMonth ? `·${item.salaryMonth}薪` : ''}`
        : '';
      return {
        title: text(item.jobName),
        company: text(item.recommendInternCompany?.companyName || item.dockSourceProjectName || ''),
        location: text(item.jobCity),
        salary,
        description_text: description,
        apply_url: `https://www.nowcoder.com/jobs/detail/${item.id}`,
        posted_date: item.refreshTime ? new Date(item.refreshTime).toISOString() : '',
      };
    });
    return { status: jobs.length ? 'ok' : 'no_results', jobs };
  },
};

// --- China: 实习僧 (server-rendered internship search) -----------------------
const shixiseng = {
  id: 'shixiseng', label: '实习僧', region: 'china', kind: 'html',
  capability: 'REAL_WORKING', capability_notes: 'Server-rendered intern search; links + titles parsed.',
  async search({ keyword, fetchImpl, limit = 20 }) {
    const html = await getHtml(fetchImpl,
      `https://www.shixiseng.com/interns?page=1&type=intern&keyword=${encodeURIComponent(keyword)}&city=%E5%85%A8%E5%9B%BD`);
    const jobs = [];
    const seen = new Set();
    const pattern = /<a[^>]*href="(https:\/\/www\.shixiseng\.com\/intern\/(inn_[a-z0-9]+)[^"]*)"[^>]*(?:title="([^"]*)")?[^>]*>([\s\S]{0,200}?)<\/a>/g;
    for (const match of html.matchAll(pattern)) {
      if (seen.has(match[2])) continue;
      seen.add(match[2]);
      const title = text(match[3]) || stripHtml(match[4]);
      if (!title || title.length < 2) continue;
      jobs.push({
        title, company: '', location: '', salary: '',
        description_text: '',
        apply_url: `https://www.shixiseng.com/intern/${match[2]}`,
        posted_date: '',
      });
      if (jobs.length >= limit) break;
    }
    return { status: jobs.length ? 'ok' : 'no_results', jobs };
  },
};

// --- Global: Apple Jobs (server-rendered search with embedded JSON) ----------
const appleJobs = {
  id: 'apple_jobs', label: 'Apple Jobs', region: 'global', kind: 'html',
  capability: 'REAL_WORKING',
  capability_notes: 'SSR search page embeds the results JSON; parsed without any token (probed 2026-08-23).',
  async search({ keyword, fetchImpl, limit = 20 }) {
    const html = await getHtml(fetchImpl,
      `https://jobs.apple.com/en-us/search?search=${encodeURIComponent(keyword)}`);
    const unescaped = html.replace(/\\"/g, '"').replace(/\\u0026/g, '&');
    const jobs = [];
    const seen = new Set();
    const pattern = /"jobSummary":"([\s\S]*?)","locations":\[([\s\S]*?)\],"positionId":"(\d+)","postingDate":"([^"]*)","postingTitle":"([^"]*)"[\s\S]{0,400}?"transformedPostingTitle":"([^"]*)"/g;
    for (const match of unescaped.matchAll(pattern)) {
      const [, summary, locationsBlob, positionId, postingDate, title, slug] = match;
      if (seen.has(positionId)) continue;
      seen.add(positionId);
      const locationName = locationsBlob.match(/"name":"([^"]+)"/)?.[1] || '';
      const country = locationsBlob.match(/"countryName":"([^"]+)"/)?.[1] || '';
      jobs.push({
        title: text(title),
        company: 'Apple',
        location: text([locationName, country].filter(Boolean).join(', ')),
        salary: '',
        description_text: text(summary.replace(/\\n/g, '\n')).slice(0, 1500),
        apply_url: `https://jobs.apple.com/en-us/details/${positionId}/${slug}`,
        posted_date: Number.isFinite(Date.parse(postingDate)) ? new Date(Date.parse(postingDate)).toISOString().slice(0, 10) : '',
      });
      if (jobs.length >= limit) break;
    }
    return { status: jobs.length ? 'ok' : 'no_results', jobs };
  },
};

// --- Global: Oracle Careers (Oracle Cloud Recruiting public REST) ------------
const oracleCareers = {
  id: 'oracle_careers', label: 'Oracle Careers', region: 'global', kind: 'api',
  capability: 'REAL_WORKING',
  capability_notes: 'Public ORC recruitingCEJobRequisitions REST with expand=requisitionList (probed 2026-08-23); the same shape works for other ORC tenants.',
  async search({ keyword, fetchImpl, limit = 20 }) {
    const data = await getJson(fetchImpl,
      'https://eeho.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions'
      + `?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_45001,limit=${Math.min(limit, 30)},keyword=${encodeURIComponent(keyword)}`);
    const jobs = (data?.items?.[0]?.requisitionList || []).map(req => ({
      title: text(req.Title),
      company: 'Oracle',
      location: text(req.PrimaryLocation),
      salary: '',
      description_text: text([req.ShortDescriptionStr, stripHtml(req.ExternalQualificationsStr || '')]
        .filter(Boolean).join('\n')).slice(0, 1500),
      apply_url: `https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_45001/job/${req.Id}`,
      posted_date: text(req.PostedDate),
    }));
    return { status: jobs.length ? 'ok' : 'no_results', jobs };
  },
};

// --- Browser-required boards (the USER signs in; the watcher only reads) -----
const browserBoard = (id, label, region, searchUrl, notes) => ({
  id, label, region, kind: 'browser',
  capability: 'BROWSER_LOGIN_REQUIRED', capability_notes: notes,
  browser: { search_url: searchUrl },
});
// City codes for boards whose search URL takes a coded city parameter.
const BOSS_CITY_CODES = {
  '北京': '101010100', '上海': '101020100', '广州': '101280100', '深圳': '101280600',
  '杭州': '101210100', '苏州': '101190400', '成都': '101270100', '南京': '101190100',
  '武汉': '101200100', '西安': '101110100',
};
const CITY_SUBDOMAINS_58 = {
  '北京': 'bj', '上海': 'sh', '广州': 'gz', '深圳': 'sz', '杭州': 'hz',
  '苏州': 'su', '成都': 'cd', '南京': 'nj', '武汉': 'wh', '西安': 'xa',
};
const browserBoards = [
  browserBoard('browser_boss', 'BOSS直聘', 'china',
    (keyword, city) => `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}`
      + (BOSS_CITY_CODES[String(city || '').trim()] ? `&city=${BOSS_CITY_CODES[String(city).trim()]}` : ''),
    'JS + login wall; search/scroll/paginate runs in the signed-in browser.'),
  browserBoard('browser_liepin', '猎聘', 'china',
    keyword => `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}`,
    'JS-rendered list; works in the signed-in browser.'),
  browserBoard('browser_51job', '前程无忧 51job', 'china',
    keyword => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(keyword)}`,
    'WAF-guarded; works in the signed-in browser.'),
  browserBoard('browser_zhaopin', '智联招聘', 'china',
    keyword => `https://sou.zhaopin.com/?kw=${encodeURIComponent(keyword)}`,
    'Login-walled search; works in the signed-in browser.'),
  browserBoard('browser_lagou', '拉勾', 'china',
    keyword => `https://www.lagou.com/wn/jobs?kd=${encodeURIComponent(keyword)}`,
    'JS + login wall; works in the signed-in browser.'),
  browserBoard('browser_linkedin', 'LinkedIn Jobs', 'global',
    (keyword, city) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}${city ? `&location=${encodeURIComponent(city)}` : ''}`,
    'Authwall for guests; search runs in the signed-in browser. Automated guest scraping is against their terms and is not done.'),
  browserBoard('browser_58', '58同城招聘', 'china',
    (keyword, city) => `https://${CITY_SUBDOMAINS_58[String(city || '').trim()] || 'sh'}.58.com/job/?key=${encodeURIComponent(keyword)}`,
    'Security-verification wall on direct fetch; the user passes any check once in the real browser.'),
  browserBoard('browser_maimai', '脉脉招聘', 'china',
    keyword => `https://maimai.cn/web/search_center?type=job&query=${encodeURIComponent(keyword)}`,
    'Sign-in required; search runs in the signed-in browser.'),
  browserBoard('browser_yingjiesheng', '应届生求职网', 'china',
    keyword => `https://q.yingjiesheng.com/pc/search?keyword=${encodeURIComponent(keyword)}`,
    'Aliyun WAF JS page: loads normally in the real browser, usually without sign-in.'),
  browserBoard('browser_microsoft', 'Microsoft Careers', 'global',
    keyword => `https://apply.careers.microsoft.com/careers?query=${encodeURIComponent(keyword)}`,
    'Eightfold portal; jobs API rejects non-browser calls (403), the portal itself browses without sign-in.'),
];

// --- Honest placeholders: probed, currently not automatable ------------------
const blocked = (id, label, region, notes) => ({
  id, label, region, kind: 'html', capability: 'BLOCKED_EXTERNAL', capability_notes: notes,
});
const blockedProviders = [
  blocked('indeed', 'Indeed', 'global', 'HTTP 403 anti-bot wall on search (probed 2026-08-22); no public API without a partner key.'),
  blocked('glassdoor', 'Glassdoor', 'global', 'HTTP 403 anti-bot wall on search (probed 2026-08-22).'),
  blocked('ziprecruiter', 'ZipRecruiter', 'global', 'HTTP 403 anti-bot wall (probed 2026-08-22); partner API needs a key.'),
  blocked('builtin', 'Built In', 'global', 'Cloudflare challenge on search (re-probed 2026-08-23: HTTP 403).'),
  blocked('google_careers', 'Google Careers', 'global', 'Unreachable from this network (re-probed 2026-08-23: connection failed).'),
  blocked('icims', 'iCIMS (per-company)', 'global', 'Tenant portals answer bot traffic with a challenge (probed 2026-08-23: HTTP 405 interstitial).'),
];
const notImplemented = (id, label, region, notes) => ({
  id, label, region, kind: 'api', capability: 'NOT_IMPLEMENTED', capability_notes: notes,
});
const notImplementedProviders = [
  notImplemented('successfactors', 'SAP SuccessFactors', 'global', 'Sample tenant portal renders (probed 2026-08-23) but markup varies per tenant; no stable public search shape yet.'),
  notImplemented('handshake', 'Handshake', 'global', 'Campus login required.'),
  notImplemented('dice', 'Dice', 'global', 'Search API answers 403 without the site frontend key (probed 2026-08-23); lifting that key would be credential misuse, so it is not done.'),
  notImplemented('bytedance_careers', '字节跳动招聘', 'china', 'API needs per-page CSRF token; postings still arrive via 牛客/browser.'),
];

export const DISCOVERY_ADAPTERS = Object.freeze([
  amazonJobs, wellfound, remotive, appleJobs, oracleCareers,
  tencentCareers, nowcoder, shixiseng,
  ...browserBoards,
  ...blockedProviders,
  ...notImplementedProviders,
]);

export function fetchableAdapters() {
  return DISCOVERY_ADAPTERS.filter(adapter => typeof adapter.search === 'function'
    && ['REAL_WORKING', 'PARTIAL'].includes(adapter.capability));
}
export function browserAdapters() {
  return DISCOVERY_ADAPTERS.filter(adapter => adapter.kind === 'browser');
}
export function capabilityReport() {
  return DISCOVERY_ADAPTERS.map(adapter => ({
    id: adapter.id, label: adapter.label, region: adapter.region,
    kind: adapter.kind, capability: adapter.capability, notes: adapter.capability_notes,
  }));
}
