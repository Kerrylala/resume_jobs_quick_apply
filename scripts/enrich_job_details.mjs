import fs from 'fs';
import path from 'path';
import { extractPublicMetadata as extractScraplingPublicMetadata, scraplingEnvStatus } from '../providers/scrapling_generic_public_page/index.mjs';
import { createApprovalSafety, downgradeApprovalSafety } from './lib/approval_safety.mjs';
import { projectRootFromMetaUrl } from './lib/project_paths.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const dataDir = path.join(root, 'data');
const reportsDir = path.join(root, 'reports');
const leadsPath = path.join(dataDir, 'job_leads.json');
const providerHealthPath = path.join(dataDir, 'provider_health.json');
const reportJsonPath = path.join(reportsDir, 'job_detail_enrichment_001.json');
const reportMdPath = path.join(reportsDir, 'job_detail_enrichment_001.md');

const DEFAULTS = { maxJobs: 20, delayMs: 1500, timeoutMs: 12000, enableScrapling: false };
const SUPPORTED_PROVIDERS = new Set(['ashby', 'greenhouse', 'lever']);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function parseArgs(argv = process.argv.slice(2)) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--max-jobs') args.maxJobs = Number(argv[++i]);
    else if (arg.startsWith('--max-jobs=')) args.maxJobs = Number(arg.split('=')[1]);
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++i]);
    else if (arg.startsWith('--delay-ms=')) args.delayMs = Number(arg.split('=')[1]);
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg.startsWith('--timeout-ms=')) args.timeoutMs = Number(arg.split('=')[1]);
    else if (arg === '--enable-scrapling') args.enableScrapling = true;
  }
  args.maxJobs = Number.isFinite(args.maxJobs) && args.maxJobs > 0 ? Math.floor(args.maxJobs) : DEFAULTS.maxJobs;
  args.delayMs = Number.isFinite(args.delayMs) && args.delayMs >= 0 ? Math.floor(args.delayMs) : DEFAULTS.delayMs;
  args.timeoutMs = Number.isFinite(args.timeoutMs) && args.timeoutMs > 0 ? Math.floor(args.timeoutMs) : DEFAULTS.timeoutMs;
  return args;
}
function extractionFromScrapling(metadata, url) {
  const meta = metadata?.meta || {};
  const title = metadata?.title || meta['og:title'] || meta['twitter:title'] || '';
  const description = metadata?.text_snippet || meta.description || meta['og:description'] || meta['twitter:description'] || '';
  return {
    title: cleanText(title, 1000),
    company: companyFromUrl(url),
    location: '',
    description_text: cleanText(description, 12000),
    apply_url: normalizeUrl(url)
  };
}
function cleanText(value, max = 12000) {
  return decodeEntities(String(value || ''))
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim()
    .slice(0, max);
}
function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}
function stripTags(html) {
  return cleanText(String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/li>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}
function metaContent(html, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${escaped}["'][^>]+content=["']([^"']*)["'][^>]*>`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${escaped}["'][^>]*>`, 'i')
    ];
    for (const re of patterns) {
      const m = html.match(re);
      if (m?.[1]) return cleanText(m[1], 1000);
    }
  }
  return '';
}
function htmlTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cleanText(stripTags(m[1]), 1000) : '';
}
function normalizeUrl(value, base = '') {
  try {
    const u = new URL(String(value || '').trim(), base || undefined);
    if (!['http:', 'https:'].includes(u.protocol)) return '';
    u.hash = '';
    return u.href;
  } catch { return ''; }
}
function isUuidLike(value) {
  const t = String(value || '').trim();
  return /^[0-9a-f]{8}[ -][0-9a-f]{4}[ -][0-9a-f]{4}[ -][0-9a-f]{4}[ -][0-9a-f]{12}$/i.test(t)
    || /^[0-9a-f]{32}$/i.test(t)
    || /^\d{5,}$/.test(t);
}
function isBadTitle(value) {
  const t = cleanText(value, 300);
  return !t || t.length < 4 || isUuidLike(t) || /^(job|jobs|opening|careers?)$/i.test(t);
}
function fieldQuality(value, field) {
  const t = cleanText(value, field === 'description_text' ? 20000 : 1000);
  if (!t) return 0;
  if (field === 'title' && isBadTitle(t)) return 1;
  if (field === 'description_text') return Math.min(10, Math.floor(t.length / 250));
  return Math.min(10, Math.max(2, Math.floor(t.length / 8)));
}
function shouldReplace(existing, incoming, field) {
  const next = cleanText(incoming, field === 'description_text' ? 20000 : 1000);
  if (!next) return false;
  const current = cleanText(existing, field === 'description_text' ? 20000 : 1000);
  if (!current) return true;
  if (field === 'title' && isBadTitle(current) && !isBadTitle(next)) return true;
  if (field === 'description_text' && next.length > current.length + 200) return true;
  if (['company', 'location', 'apply_url'].includes(field) && fieldQuality(next, field) > fieldQuality(current, field) + 2) return true;
  return false;
}
function companyFromUrl(url) {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    if (/ashbyhq\.com$/i.test(u.hostname) && parts[0]) return parts[0];
    if (/greenhouse\.io$/i.test(u.hostname) && parts[0]) return parts[0];
    return u.hostname.replace(/^www\./, '').split('.')[0];
  } catch { return ''; }
}
function parseJsonObjects(html) {
  const out = [];
  const scripts = [...String(html || '').matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].trim()).filter(Boolean);
  for (const raw of scripts) {
    const text = decodeEntities(raw);
    if (/^\s*[{[]/.test(text)) {
      try { out.push(JSON.parse(text)); }
      catch {
        // Public pages often mix JavaScript and JSON in script tags; only valid
        // structured fragments are eligible for extraction.
      }
    }
    for (const key of ['__NEXT_DATA__', 'initialState', 'initialData']) {
      if (text.includes(key)) {
        const m = text.match(/\{[\s\S]{20,}\}/);
        if (m) {
          try { out.push(JSON.parse(m[0])); }
          catch {
            // Ignore a non-JSON state fragment and continue with other sources.
          }
        }
      }
    }
  }
  return out;
}
function walkJson(value, visit, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit, seen);
    return;
  }
  visit(value);
  for (const item of Object.values(value)) walkJson(item, visit, seen);
}
function extractFromJson(html, baseUrl) {
  const found = {};
  for (const obj of parseJsonObjects(html)) {
    walkJson(obj, (node) => {
      const pairs = [
        ['title', ['title', 'jobTitle', 'job_title', 'name']],
        ['company', ['company', 'companyName', 'organizationName']],
        ['location', ['location', 'jobLocation', 'locationName']],
        ['department', ['department', 'team']],
        ['description_text', ['description', 'descriptionHtml', 'content', 'jobDescription']],
        ['apply_url', ['applyUrl', 'apply_url', 'absolute_url', 'applicationUrl']]
      ];
      for (const [field, keys] of pairs) {
        if (found[field]) continue;
        for (const key of keys) {
          const v = node[key];
          if (typeof v === 'string' && v.trim()) {
            found[field] = field === 'apply_url' ? normalizeUrl(v, baseUrl) : (field === 'description_text' ? stripTags(v) : cleanText(v, 1000));
          } else if (field === 'location' && v && typeof v === 'object') {
            const text = [v.name, v.city, v.region, v.country].filter(Boolean).join(', ');
            if (text) found.location = cleanText(text, 500);
          } else if (field === 'company' && v && typeof v === 'object' && v.name) {
            found.company = cleanText(v.name, 500);
          }
        }
      }
    });
  }
  return found;
}
function titleCleanup(raw, provider) {
  let t = cleanText(raw, 500);
  t = t.replace(/\s*[-|•]\s*(Ashby|Greenhouse|Job Application|Careers|Jobs)\s*$/i, '');
  if (provider === 'greenhouse') t = t.replace(/\s+at\s+.+$/i, (m) => m.length > 60 ? '' : m);
  return cleanText(t, 300);
}
function locationFromBody(text) {
  const patterns = [
    /\b(?:Location|Office|Workplace|Job Location)\s*[:\-]\s*([^\n]{2,120})/i,
    /\b(Singapore|Hong Kong|Shanghai|Beijing|China|Remote|APAC|Asia)\b/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m?.[1]) return cleanText(m[1], 300);
  }
  return '';
}
function applyUrlFromHtml(html, baseUrl) {
  const hrefs = [...String(html || '').matchAll(/<a\b[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const [, href, labelHtml] of hrefs) {
    const label = stripTags(labelHtml);
    const url = normalizeUrl(href, baseUrl);
    if (!url) continue;
    if (/apply|application/i.test(label) || /\/apply|application/i.test(url)) return url;
  }
  return normalizeUrl(baseUrl);
}
function extractAshby(html, url) {
  const json = extractFromJson(html, url);
  const titleMeta = metaContent(html, ['og:title', 'twitter:title']);
  const descMeta = metaContent(html, ['description', 'og:description', 'twitter:description']);
  const body = stripTags(html);
  const title = titleCleanup(json.title || titleMeta || htmlTitle(html), 'ashby');
  return {
    title,
    company: cleanText(json.company || companyFromUrl(url), 500),
    location: cleanText(json.location || locationFromBody(body), 500),
    department: cleanText(json.department || '', 500),
    description_text: cleanText(json.description_text || descMeta || body, 12000),
    apply_url: json.apply_url || applyUrlFromHtml(html, url)
  };
}
function extractGreenhouse(html, url) {
  const json = extractFromJson(html, url);
  const titleMeta = metaContent(html, ['og:title', 'twitter:title']);
  const descMeta = metaContent(html, ['description', 'og:description', 'twitter:description']);
  const body = stripTags(html);
  let title = json.title || titleMeta || htmlTitle(html);
  if (!title) {
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1) title = stripTags(h1[1]);
  }
  return {
    title: titleCleanup(title, 'greenhouse'),
    company: cleanText(json.company || companyFromUrl(url), 500),
    location: cleanText(json.location || locationFromBody(body), 500),
    description_text: cleanText(json.description_text || descMeta || body, 12000),
    apply_url: json.apply_url || applyUrlFromHtml(html, url)
  };
}
function extractLever(html, url) {
  const json = extractFromJson(html, url);
  const body = stripTags(html);
  return {
    title: titleCleanup(json.title || metaContent(html, ['og:title', 'twitter:title']) || htmlTitle(html), 'lever'),
    company: cleanText(json.company || companyFromUrl(url), 500),
    location: cleanText(json.location || locationFromBody(body), 500),
    description_text: cleanText(json.description_text || metaContent(html, ['description', 'og:description']) || body, 12000),
    apply_url: json.apply_url || applyUrlFromHtml(html, url)
  };
}
function computeInfoQuality(job) {
  const hasTitle = Boolean(job.title && !isBadTitle(job.title));
  const hasCompany = Boolean(cleanText(job.company));
  const hasLocation = Boolean(cleanText(job.location || job.country_or_region));
  const hasDescription = cleanText(job.description_text).length >= 120;
  const hasApplyUrl = Boolean(normalizeUrl(job.apply_url || job.url));
  let score = 0;
  if (hasTitle) score += 25;
  else if (job.title && isUuidLike(job.title)) score -= 10;
  if (hasCompany) score += 15;
  if (hasLocation) score += 15;
  if (hasDescription) score += 30;
  if (hasApplyUrl) score += 15;
  score = Math.max(0, Math.min(100, score));
  return {
    has_title: hasTitle,
    has_company: hasCompany,
    has_location: hasLocation,
    has_description: hasDescription,
    has_apply_url: hasApplyUrl,
    is_job_detail: true,
    score
  };
}
function needsEnrichment(job) {
  if (job.page_type !== 'job_detail') return false;
  if (!SUPPORTED_PROVIDERS.has(String(job.provider || '').toLowerCase())) return false;
  const iq = computeInfoQuality(job);
  return isBadTitle(job.title) || !iq.has_company || !iq.has_location || !iq.has_description || !iq.has_apply_url;
}
function selectJobs(leads, maxJobs) {
  return leads
    .map((job, index) => ({ job, index }))
    .filter(({ job }) => needsEnrichment(job))
    .sort((a, b) => {
      const ap = a.job.source === 'detail_expansion' ? 0 : 1;
      const bp = b.job.source === 'detail_expansion' ? 0 : 1;
      return ap - bp;
    })
    .slice(0, maxJobs);
}
async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'user-agent': 'resume-jobs-public-fetch-enrichment/1.0 (+no-apply-no-login)'
      }
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`http_${res.status}`);
    if (!/html|text|json/i.test(res.headers.get('content-type') || '') && !/<html|<script|<title/i.test(text)) throw new Error('non_html_response');
    return { html: text, status: res.status, finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}
function applyExtraction(job, extraction) {
  const updated = { ...job };
  const changed = {};
  for (const field of ['title', 'company', 'location', 'description_text', 'apply_url', 'department']) {
    if (field === 'department' && !extraction[field]) continue;
    if (shouldReplace(updated[field], extraction[field], field)) {
      updated[field] = field === 'apply_url' ? normalizeUrl(extraction[field], job.url) : cleanText(extraction[field], field === 'description_text' ? 20000 : 1000);
      changed[field] = { before: job[field] ?? null, after: updated[field] };
    }
  }
  updated.enriched_at = new Date().toISOString();
  updated.enrichment_source = 'public_fetch';
  updated.info_quality = computeInfoQuality(updated);
  if (updated.info_quality.score >= 85) updated.enrichment_status = 'enriched';
  else if (Object.keys(changed).length > 0 || updated.info_quality.score >= 45) updated.enrichment_status = 'partial';
  else updated.enrichment_status = 'failed';
  updated.confidence = Math.max(Number(updated.confidence || 0), updated.info_quality.score >= 85 ? 0.86 : updated.info_quality.score >= 70 ? 0.78 : 0.62);
  if (updated.info_quality.score < 70 || !updated.info_quality.has_description || isBadTitle(updated.title)) {
    if (updated.recommended_decision === 'approve') updated.recommended_decision = 'manual_review';
    const downgradeReason = 'enrichment_quality_below_safety_threshold';
    updated.approval_safety = updated.approval_safety == null
      ? createApprovalSafety('needs_review', false, [downgradeReason])
      : downgradeApprovalSafety(updated.approval_safety, downgradeReason, { field: 'job.approval_safety' });
  }
  return { updated, changed };
}
function countBy(items, fn) {
  return items.reduce((acc, item) => {
    const key = typeof fn === 'function' ? fn(item) : item[fn];
    acc[key || 'unknown'] = (acc[key || 'unknown'] || 0) + 1;
    return acc;
  }, {});
}
function qualityBucket(score) {
  if (score >= 90) return '90-100';
  if (score >= 70) return '70-89';
  if (score >= 50) return '50-69';
  if (score >= 1) return '1-49';
  return '0';
}
function safeExample(job) {
  return {
    job_id: job.job_id,
    provider: job.provider,
    title: job.title || '',
    company: job.company || '',
    location: job.location || '',
    description_len: cleanText(job.description_text).length,
    apply_url: job.apply_url || '',
    info_quality_score: job.info_quality?.score ?? computeInfoQuality(job).score,
    url: job.url || ''
  };
}
function reportMarkdown(report) {
  const failed = report.failed_urls.length ? report.failed_urls.map((x) => `- ${x.provider}: ${x.url} — ${x.reason}`).join('\n') : '- none';
  const examples = report.examples_before_after.length ? report.examples_before_after.map((x, i) => [
    `### Example ${i + 1}`,
    `- Before: ${x.before.title || 'Untitled'} — ${x.before.company || 'Unknown'} — ${x.before.location || ''} — desc_len=${x.before.description_len}`,
    `- After: ${x.after.title || 'Untitled'} — ${x.after.company || 'Unknown'} — ${x.after.location || ''} — desc_len=${x.after.description_len}`,
    `- URL: ${x.after.url}`
  ].join('\n')).join('\n\n') : 'none';
  return `# Job Detail Enrichment 001\n\n- PWD used: ${report.pwd_used}\n- Selected jobs count: ${report.selected_jobs_count}\n- Enriched count: ${report.enriched_count}\n- Partial count: ${report.partial_count}\n- Failed count: ${report.failed_count}\n- Provider breakdown: ${JSON.stringify(report.provider_breakdown)}\n- UUID-like title count before/after: ${report.uuid_like_title_count_before} / ${report.uuid_like_title_count_after}\n- Info quality breakdown: ${JSON.stringify(report.info_quality_breakdown)}\n- Chrome/apply/submit/upload/login happened: No\n- Scrapling enabled by flag: ${report.scrapling_enabled ? 'Yes' : 'No'}\n- Scrapling was used: ${report.scrapling_used ? 'Yes' : 'No'}\n- Scrapling attempts: ${report.scrapling_attempts}\n- Next step: ${report.next_step}\n\n## Examples before/after\n\n${examples}\n\n## Failed URLs and reasons\n\n${failed}\n`;
}
async function main() {
  const args = parseArgs();
  const pwdUsed = process.cwd();
  const leads = readJson(leadsPath, []);
  if (!Array.isArray(leads)) throw new Error('data/job_leads.json must be an array');
  const selected = selectJobs(leads, args.maxJobs);
  const uuidBefore = leads.filter((j) => j.page_type === 'job_detail' && isUuidLike(j.title)).length;
  const examples = [];
  const failedUrls = [];
  const results = [];
  const fetched = new Set();
  const scraplingFallbacks = [];
  const scraplingEnv = args.enableScrapling ? scraplingEnvStatus() : { ok: false, status: 'disabled' };

  for (let i = 0; i < selected.length; i += 1) {
    const { job, index } = selected[i];
    const before = safeExample({ ...job, info_quality: computeInfoQuality(job) });
    try {
      const url = normalizeUrl(job.url || job.apply_url);
      if (!url) throw new Error('missing_valid_url');
      if (fetched.has(url)) throw new Error('duplicate_url_skipped');
      fetched.add(url);
      const { html } = await fetchHtml(url, args.timeoutMs);
      const provider = String(job.provider || '').toLowerCase();
      const extraction = provider === 'ashby' ? extractAshby(html, url) : provider === 'greenhouse' ? extractGreenhouse(html, url) : extractLever(html, url);
      const { updated, changed } = applyExtraction(job, extraction);
      leads[index] = updated;
      const after = safeExample(updated);
      if (examples.length < 8 && (Object.keys(changed).length || before.info_quality_score !== after.info_quality_score)) examples.push({ before, after, changed_fields: Object.keys(changed) });
      results.push({ status: updated.enrichment_status, provider, url, info_quality_score: updated.info_quality.score, changed_fields: Object.keys(changed) });
    } catch (e) {
      let fallbackApplied = false;
      let fallbackStatus = '';
      if (args.enableScrapling) {
        const fallback = await extractScraplingPublicMetadata(job.url || job.apply_url || '', { timeoutMs: args.timeoutMs + 8000 });
        fallbackStatus = fallback.status || 'unknown';
        scraplingFallbacks.push({ provider: job.provider || 'unknown', url: job.url || job.apply_url || '', status: fallbackStatus, ok: Boolean(fallback.ok) });
        if (fallback.ok) {
          const extraction = extractionFromScrapling(fallback, job.url || job.apply_url || '');
          const { updated, changed } = applyExtraction(job, extraction);
          updated.enrichment_source = 'scrapling_public_metadata_fallback';
          leads[index] = updated;
          const after = safeExample(updated);
          const changedFields = Object.keys(changed);
          fallbackApplied = true;
          if (examples.length < 8 && (changedFields.length || before.info_quality_score !== after.info_quality_score)) examples.push({ before, after, changed_fields: changedFields, fallback: 'scrapling_public_metadata' });
          results.push({ status: updated.enrichment_status, provider: job.provider || 'unknown', url: job.url || job.apply_url || '', info_quality_score: updated.info_quality.score, changed_fields: changedFields, fallback: 'scrapling_public_metadata' });
        }
      }
      if (!fallbackApplied) {
        const reason = args.enableScrapling && fallbackStatus ? `${String(e.message || e)}; scrapling_${fallbackStatus}` : String(e.message || e);
        const updated = { ...job, enriched_at: new Date().toISOString(), enrichment_status: 'failed', enrichment_source: 'public_fetch', enrichment_error: reason, info_quality: computeInfoQuality(job) };
        if (updated.recommended_decision === 'approve') updated.recommended_decision = 'manual_review';
        leads[index] = updated;
        failedUrls.push({ provider: job.provider || 'unknown', url: job.url || job.apply_url || '', reason });
        results.push({ status: 'failed', provider: job.provider || 'unknown', url: job.url || job.apply_url || '', reason, info_quality_score: updated.info_quality.score });
      }
    }
    if (i < selected.length - 1 && args.delayMs > 0) await sleep(args.delayMs);
  }

  for (const job of leads) {
    if (job.page_type === 'job_detail' && SUPPORTED_PROVIDERS.has(String(job.provider || '').toLowerCase())) {
      job.info_quality = computeInfoQuality(job);
      if (job.info_quality.score < 70 || !job.info_quality.has_description || isBadTitle(job.title)) {
        if (job.recommended_decision === 'approve') job.recommended_decision = 'manual_review';
      }
    }
  }
  writeJson(leadsPath, leads);

  const uuidAfter = leads.filter((j) => j.page_type === 'job_detail' && isUuidLike(j.title)).length;
  const touched = selected.map(({ index }) => leads[index]);
  const report = {
    generated_at: new Date().toISOString(),
    pwd_used: pwdUsed,
    max_jobs: args.maxJobs,
    delay_ms: args.delayMs,
    timeout_ms: args.timeoutMs,
    scrapling_enabled: args.enableScrapling,
    scrapling_env_status: scraplingEnv.status,
    scrapling_attempts: scraplingFallbacks.length,
    scrapling_fallbacks: scraplingFallbacks,
    selected_jobs_count: selected.length,
    enriched_count: touched.filter((j) => j.enrichment_status === 'enriched').length,
    partial_count: touched.filter((j) => j.enrichment_status === 'partial').length,
    failed_count: touched.filter((j) => j.enrichment_status === 'failed').length,
    provider_breakdown: countBy(touched, 'provider'),
    examples_before_after: examples,
    uuid_like_title_count_before: uuidBefore,
    uuid_like_title_count_after: uuidAfter,
    info_quality_breakdown: countBy(touched, (j) => qualityBucket(j.info_quality?.score || 0)),
    failed_urls: failedUrls,
    chrome_apply_submit_upload_login_happened: false,
    scrapling_used: scraplingFallbacks.length > 0,
    next_step: 'Run score_jobs and build_approval_queue; manually review partial/failed detail pages before any application prep.'
  };
  writeJson(reportJsonPath, report);
  writeText(reportMdPath, reportMarkdown(report));

  const health = readJson(providerHealthPath, {});
  health.generated_at = new Date().toISOString();
  health.job_detail_enrichment = {
    ok: true,
    last_run_at: report.generated_at,
    selected_jobs_count: report.selected_jobs_count,
    enriched_count: report.enriched_count,
    partial_count: report.partial_count,
    failed_count: report.failed_count,
    provider_breakdown: report.provider_breakdown,
    chrome_opened: false,
    apply_submit_upload_login_happened: false,
    scrapling_used: scraplingFallbacks.length > 0,
    scrapling_enabled: args.enableScrapling,
    scrapling_attempts: scraplingFallbacks.length,
    report_json: 'reports/job_detail_enrichment_001.json',
    report_md: 'reports/job_detail_enrichment_001.md'
  };
  writeJson(providerHealthPath, health);

  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
