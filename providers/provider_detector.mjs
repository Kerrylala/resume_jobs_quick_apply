const CHINA_JOB_BOARD_HOSTS = [
  'jobs.bytedance.com', 'careers.tencent.com', 'talent.alibaba.com', 'jobs.alibaba.com',
  'zhaopin.com', '51job.com', 'liepin.com', 'zhipin.com', 'kanzhun.com', 'lagou.com',
  'moka.hr', 'hotjob.cn', 'italent.cn', 'xiaohongshu.com'
];

function safeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url;
  } catch {
    return null;
  }
}

function hostMatches(hostname, needle) {
  return hostname === needle || hostname.endsWith(`.${needle}`);
}

export const SUPPORTED_PROVIDER_TYPES = [
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'smartrecruiters',
  'bamboohr',
  'teamtailor',
  'generic_company_careers',
  'china_job_board',
  'unknown'
];

export function detectProvider(inputUrl, html = '') {
  const url = safeUrl(inputUrl);
  if (!url) return { provider: 'unknown', ats: '', confidence: 0, reason: 'invalid_or_non_http_url' };

  const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
  const href = url.href.toLowerCase();
  const path = url.pathname.toLowerCase();
  const text = String(html || '').toLowerCase().slice(0, 200000);

  if (hostMatches(hostname, 'greenhouse.io') || href.includes('gh_jid=') || text.includes('greenhouse job board')) {
    return { provider: 'greenhouse', ats: 'greenhouse', confidence: hostMatches(hostname, 'greenhouse.io') ? 0.98 : 0.82, reason: 'greenhouse_domain_or_gh_jid_marker' };
  }
  if (hostname === 'jobs.lever.co' || text.includes('lever.co') || text.includes('lever job')) {
    return { provider: 'lever', ats: 'lever', confidence: hostname === 'jobs.lever.co' ? 0.98 : 0.78, reason: 'lever_domain_or_page_marker' };
  }
  if (hostMatches(hostname, 'ashbyhq.com') || text.includes('ashby') && text.includes('job board')) {
    return { provider: 'ashby', ats: 'ashby', confidence: hostMatches(hostname, 'ashbyhq.com') ? 0.98 : 0.76, reason: 'ashby_domain_or_page_marker' };
  }
  if (hostMatches(hostname, 'myworkdayjobs.com') || hostMatches(hostname, 'workdayjobs.com') || text.includes('myworkdayjobs')) {
    return { provider: 'workday', ats: 'workday', confidence: hostMatches(hostname, 'myworkdayjobs.com') || hostMatches(hostname, 'workdayjobs.com') ? 0.97 : 0.75, reason: 'workday_domain_or_page_marker' };
  }
  if (hostname === 'jobs.smartrecruiters.com' || text.includes('smartrecruiters')) {
    return { provider: 'smartrecruiters', ats: 'smartrecruiters', confidence: hostname === 'jobs.smartrecruiters.com' ? 0.97 : 0.75, reason: 'smartrecruiters_domain_or_page_marker' };
  }
  if (hostMatches(hostname, 'bamboohr.com') || path.includes('/careers/') && text.includes('bamboohr')) {
    return { provider: 'bamboohr', ats: 'bamboohr', confidence: hostMatches(hostname, 'bamboohr.com') ? 0.94 : 0.72, reason: 'bamboohr_domain_or_page_marker' };
  }
  if (hostMatches(hostname, 'teamtailor.com') || text.includes('teamtailor')) {
    return { provider: 'teamtailor', ats: 'teamtailor', confidence: hostMatches(hostname, 'teamtailor.com') ? 0.94 : 0.72, reason: 'teamtailor_domain_or_page_marker' };
  }
  if (CHINA_JOB_BOARD_HOSTS.some((needle) => hostMatches(hostname, needle)) || /招聘|校招|社招|职位详情|投递/.test(text)) {
    return { provider: 'china_job_board', ats: '', confidence: CHINA_JOB_BOARD_HOSTS.some((needle) => hostMatches(hostname, needle)) ? 0.88 : 0.62, reason: 'known_china_jobs_domain_or_chinese_job_markers' };
  }
  if (/career|careers|jobs|job|positions|join-us|joinus|招聘|职位|校招|社招/.test(`${hostname} ${path}`)) {
    return { provider: 'generic_company_careers', ats: '', confidence: 0.62, reason: 'career_or_job_terms_in_company_url' };
  }
  return { provider: 'unknown', ats: '', confidence: 0.2, reason: 'no_supported_provider_marker_detected' };
}

export default detectProvider;

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = detectProvider(process.argv[2] || '');
  console.log(JSON.stringify(result, null, 2));
}
