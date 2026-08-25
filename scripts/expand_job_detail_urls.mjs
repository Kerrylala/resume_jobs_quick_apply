import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { detectProvider } from '../providers/provider_detector.mjs';
import { projectRootFromMetaUrl } from './lib/project_paths.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const dataDir = path.join(root, 'data');
const reportsDir = path.join(root, 'reports');

const TARGET_RE = /(AI Product Manager|Associate Product Manager|Product Manager|Data Product Manager|Product Analyst|数据产品经理|AI\s*产品经理|产品实习生)/i;
const LINK_RE = /\b(job|jobs|careers|career|position|positions|role|roles|opening|openings|lever|greenhouse|ashby|workday|myworkdayjobs)\b/i;
const APPLY_FLOW_RE = /\b(apply|application|submit|signin|login|register|captcha|otp)\b/i;
const PARENT_TYPES = new Set(['ats_company_board', 'company_careers_home', 'aggregator_search']);
const HIGH_VALUE_PROVIDERS = new Set(['lever', 'ashby', 'greenhouse', 'workday', 'generic_company_careers', 'unknown']);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }
function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}
function resolveUrl(href, base) {
  try {
    if (!href || /^(mailto:|tel:|javascript:|data:)/i.test(href)) return '';
    const url = new URL(href.replace(/&amp;/g, '&'), base);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.href;
  } catch { return ''; }
}
function idFor(url) { return `job_${crypto.createHash('sha256').update(url).digest('hex').slice(0, 16)}`; }
function companyFromUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (/greenhouse|lever|ashby|smartrecruiters/.test(host) && parts[0]) return parts[0];
    return host.split('.')[0];
  } catch { return ''; }
}
function locationFromText(text) {
  const value = String(text || '');
  const match = value.match(/Singapore|Hong Kong|Shanghai|Beijing|Shenzhen|Hangzhou|Tokyo|APAC|Remote|China|新加坡|香港|上海|北京|深圳|杭州/i);
  return match ? match[0] : '';
}
function titleFromUrlOrText(url, text) {
  const cleanText = String(text || '').replace(/\s+/g, ' ').trim();
  const target = cleanText.match(TARGET_RE)?.[0];
  if (target) return cleanText.slice(0, 180);
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part).replace(/[-_]+/g, ' '));
    const candidate = parts.reverse().find((part) => TARGET_RE.test(part)) || parts.find((part) => part.length > 6) || cleanText;
    return String(candidate || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  } catch { return cleanText.slice(0, 180); }
}
function parseArgs(argv = process.argv.slice(2)) {
  const args = { maxParents: 10, maxLinksPerParent: 20, timeoutMs: 12000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-parents') args.maxParents = Number(argv[++i]);
    else if (arg.startsWith('--max-parents=')) args.maxParents = Number(arg.split('=')[1]);
    else if (arg === '--max-links-per-parent') args.maxLinksPerParent = Number(argv[++i]);
    else if (arg.startsWith('--max-links-per-parent=')) args.maxLinksPerParent = Number(arg.split('=')[1]);
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg.startsWith('--timeout-ms=')) args.timeoutMs = Number(arg.split('=')[1]);
  }
  return args;
}
function extractLinks(html, baseUrl) {
  const links = [];
  const anchorRe = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorRe.exec(html))) {
    const url = resolveUrl(match[1] || match[2] || match[3], baseUrl);
    if (!url) continue;
    const text = String(match[4] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    links.push({ url, text });
  }
  const urlRe = /https?:\/\/[^\s"'<>]+/gi;
  while ((match = urlRe.exec(html))) {
    const url = normalizeUrl(match[0].replace(/[),.;]+$/, ''));
    if (url) links.push({ url, text: '' });
  }
  const seen = new Set();
  return links.filter((link) => {
    const key = normalizeUrl(link.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': 'resume-jobs-detail-expansion/1.0 public-metadata-only',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`http_${response.status}`);
    return { html: text, status: response.status };
  } finally {
    clearTimeout(timeout);
  }
}
function chooseParents(jobLeads, shortlist, maxParents) {
  const byUrl = new Map();
  for (const job of [...shortlist, ...jobLeads]) {
    const url = normalizeUrl(job.url || job.apply_url || '');
    if (!url || byUrl.has(url)) continue;
    const pageType = job.page_type || 'unknown';
    const provider = job.provider || job.provider_guess || 'unknown';
    if (!PARENT_TYPES.has(pageType)) continue;
    if (pageType === 'aggregator_search' && Number(job.match_score || 0) < 65) continue;
    if (pageType === 'aggregator_search' && !HIGH_VALUE_PROVIDERS.has(provider)) continue;
    byUrl.set(url, { ...job, url, page_type: pageType, provider });
  }
  return [...byUrl.values()]
    .sort((a, b) => Number(b.match_score || 0) - Number(a.match_score || 0))
    .slice(0, maxParents);
}
function isLikelyJobDetail(url, text) {
  const haystack = `${url} ${text}`;
  if (!LINK_RE.test(haystack)) return false;
  if (APPLY_FLOW_RE.test(new URL(url).pathname.toLowerCase()) && !TARGET_RE.test(haystack)) return false;
  if (/greenhouse\.io\/[^/]+\/jobs\/\d+/i.test(url)) return true;
  if (/jobs\.lever\.co\/[^/]+\/[a-f0-9-]{12,}/i.test(url)) return true;
  if (/jobs\.ashbyhq\.com\/[^/]+\/[a-f0-9-]{12,}/i.test(url)) return true;
  if (/myworkdayjobs\.com\/[^/]+\/job\//i.test(url)) return true;
  return TARGET_RE.test(haystack) && LINK_RE.test(url);
}
function makeLead({ link, parent, detection }) {
  const url = normalizeUrl(link.url);
  const text = `${link.text || ''} ${decodeURIComponent(url)}`;
  return {
    job_id: idFor(url),
    source: 'detail_expansion',
    parent_url: parent.url,
    provider: detection.provider || 'unknown',
    ats: detection.ats || '',
    title: titleFromUrlOrText(url, link.text) || parent.title || '',
    company: companyFromUrl(url) || parent.company || '',
    location: locationFromText(text) || parent.location || '',
    url,
    apply_url: url,
    page_type: isLikelyJobDetail(url, link.text) ? 'job_detail' : 'unknown',
    status: 'discovered',
    risk_level: 'public_metadata_only',
    confidence: Number(Math.max(detection.confidence || 0, TARGET_RE.test(text) ? 0.72 : 0.45).toFixed(2)),
    discovered_at: new Date().toISOString(),
    notes: `expanded_from=${parent.page_type}; detector=${detection.reason || ''}; no_apply_opened; no_chrome; public_fetch_only`
  };
}
function updateProviderHealth(report) {
  const file = path.join(dataDir, 'provider_health.json');
  const current = readJson(file, {});
  current.generated_at = new Date().toISOString();
  current.detail_expansion = {
    ok: true,
    last_run_at: report.generated_at,
    entries_inspected_count: report.entries_inspected_count,
    new_job_detail_urls_found: report.new_job_detail_urls_found,
    new_leads_added: report.new_leads_added,
    provider_breakdown: report.provider_breakdown,
    chrome_opened: false,
    scrapling_enabled: false
  };
  writeJson(file, current);
}

async function main() {
  const args = parseArgs();
  const jobLeads = readJson(path.join(dataDir, 'job_leads.json'), []);
  const shortlist = readJson(path.join(dataDir, 'jobs_shortlist.json'), []);
  const existingUrls = new Set([...jobLeads, ...shortlist].map((job) => normalizeUrl(job.url || job.apply_url || '')).filter(Boolean));
  const parents = chooseParents(jobLeads, shortlist, args.maxParents);
  const failures = [];
  const newLeads = [];
  const parentReports = [];

  for (const parent of parents) {
    const parentReport = { url: parent.url, page_type: parent.page_type, provider: parent.provider || 'unknown', links_considered: 0, candidates_found: 0 };
    try {
      const { html, status } = await fetchText(parent.url, args.timeoutMs);
      parentReport.http_status = status;
      const links = extractLinks(html, parent.url)
        .filter((link) => LINK_RE.test(`${link.url} ${link.text}`))
        .slice(0, args.maxLinksPerParent);
      parentReport.links_considered = links.length;
      for (const link of links) {
        if (!isLikelyJobDetail(link.url, link.text)) continue;
        const url = normalizeUrl(link.url);
        if (!url || existingUrls.has(url)) continue;
        const detection = detectProvider(url);
        const lead = makeLead({ link: { ...link, url }, parent, detection });
        existingUrls.add(url);
        newLeads.push(lead);
        parentReport.candidates_found += 1;
      }
    } catch (error) {
      failures.push({ url: parent.url, reason: error.name === 'AbortError' ? 'timeout' : error.message });
      parentReport.error = error.name === 'AbortError' ? 'timeout' : error.message;
    }
    parentReports.push(parentReport);
  }

  const updatedLeads = [...jobLeads, ...newLeads];
  if (newLeads.length) writeJson(path.join(dataDir, 'job_leads.json'), updatedLeads);

  const providerBreakdown = newLeads.reduce((acc, lead) => {
    acc[lead.provider] = (acc[lead.provider] || 0) + 1;
    return acc;
  }, {});
  const report = {
    report_id: 'job_detail_expansion_001',
    generated_at: new Date().toISOString(),
    pwd_used: root,
    entries_inspected_count: parents.length,
    parent_urls_inspected: parents.map((parent) => parent.url),
    parent_reports: parentReports,
    new_job_detail_urls_found: newLeads.filter((lead) => lead.page_type === 'job_detail').length,
    new_leads_added: newLeads.length,
    provider_breakdown: providerBreakdown,
    failed_parent_urls_and_reasons: failures,
    safety: {
      login_apply_submit_upload_happened: false,
      chrome_opened: false,
      scrapling_enabled: false,
      application_forms_opened: false,
      public_fetch_only: true
    },
    examples_of_new_job_detail_leads: newLeads.slice(0, 10),
    next_step: 'rerun score_jobs and build_approval_queue'
  };
  updateProviderHealth(report);
  writeJson(path.join(reportsDir, 'job_detail_expansion_001.json'), report);

  const md = [
    '# Job Detail Expansion 001', '',
    `- pwd used: \`${report.pwd_used}\``,
    `- entries inspected count: ${report.entries_inspected_count}`,
    `- new job_detail URLs found: ${report.new_job_detail_urls_found}`,
    `- new leads added: ${report.new_leads_added}`,
    `- Chrome opened: No`,
    `- login/apply/submit/upload happened: No`,
    `- Scrapling enabled: No`,
    '', '## Parent URLs Inspected', '',
    ...(report.parent_urls_inspected.length ? report.parent_urls_inspected.map((url) => `- ${url}`) : ['- None']),
    '', '## Provider Breakdown', '',
    '```json', JSON.stringify(report.provider_breakdown, null, 2), '```',
    '', '## Failed Parent URLs', '',
    ...(failures.length ? failures.map((item) => `- ${item.url}: ${item.reason}`) : ['- None']),
    '', '## Examples of New Job Detail Leads', '',
    ...(newLeads.slice(0, 10).map((lead) => `- ${lead.title || '(untitled)'} — ${lead.company || '(unknown)'} — ${lead.url}`) || ['- None']),
    '', '## Next Step', '',
    'Rerun `node scripts/score_jobs.mjs` and `node scripts/build_approval_queue.mjs`.'
  ].join('\n');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(reportsDir, 'job_detail_expansion_001.md'), md + '\n', 'utf8');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: 'error', message: error.message, stack: error.stack }, null, 2));
  process.exitCode = 1;
});
