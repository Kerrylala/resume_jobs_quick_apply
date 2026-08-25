import dns from 'node:dns/promises';
import net from 'node:net';
import { detectProvider } from '../../providers/provider_detector.mjs';
import { extractPublicCareerJobsFromHtml, extractPublicJobFromHtml } from '../../providers/generic_company_careers/index.mjs';
import { classifyJobInput, isNavigationTitle, jobQualityGate } from './job_input_classifier.mjs';
import { normalizeJobRecord } from './job_records.mjs';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
export const MAX_PUBLIC_JOB_PAGE_BYTES = 1024 * 1024;

const NON_PUBLIC_ADDRESS_BLOCKS = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) NON_PUBLIC_ADDRESS_BLOCKS.addSubnet(network, prefix, 'ipv4');

for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
]) NON_PUBLIC_ADDRESS_BLOCKS.addSubnet(network, prefix, 'ipv6');

export class JobUrlIngestionError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'JobUrlIngestionError';
    this.code = code;
    this.status = status;
  }
}

function isPrivateAddress(address) {
  const value = String(address || '').toLowerCase();
  const family = net.isIP(value);
  if (!family) return true;
  return NON_PUBLIC_ADDRESS_BLOCKS.check(value, family === 6 ? 'ipv6' : 'ipv4');
}

export async function validatePublicJobUrl(value, { lookup = dns.lookup } = {}) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 2048) throw new JobUrlIngestionError('INVALID_JOB_URL', 'Enter one valid public job URL.');
  let parsed;
  try { parsed = new URL(raw); } catch { throw new JobUrlIngestionError('INVALID_JOB_URL', 'The job URL is not valid.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new JobUrlIngestionError('INVALID_JOB_URL', 'Only HTTP or HTTPS job URLs are supported.');
  if (parsed.username || parsed.password) throw new JobUrlIngestionError('URL_CREDENTIALS_FORBIDDEN', 'Job URLs must not contain credentials.');
  const hostname = parsed.hostname.toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(hostname);
  if (!loopback && parsed.protocol !== 'https:') throw new JobUrlIngestionError('HTTPS_REQUIRED', 'Remote job URLs must use HTTPS. HTTP is allowed only for localhost demos.');
  if (!loopback && parsed.port && parsed.port !== '443') throw new JobUrlIngestionError('UNSAFE_REMOTE_PORT', 'Remote job URLs must use the standard HTTPS port.');
  if (!loopback) {
    let records;
    try { records = await lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new JobUrlIngestionError('JOB_HOST_UNREACHABLE', 'The job site hostname could not be resolved.', 422); }
    const addresses = (Array.isArray(records) ? records : [records]).map(item => item?.address || item).filter(Boolean);
    if (!addresses.length || addresses.some(isPrivateAddress)) {
      throw new JobUrlIngestionError('PRIVATE_NETWORK_FORBIDDEN', 'Private, link-local, and internal network addresses are not allowed.');
    }
  }
  parsed.hash = '';
  return { url: parsed.href, loopback };
}

async function readPublicHtml(url, { fetchImpl, timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'resume-jobs-public-metadata/1.0' }, redirect: 'error', signal: controller.signal
    });
    if (!response.ok) throw new JobUrlIngestionError('JOB_PAGE_HTTP_ERROR', `The public job page returned HTTP ${response.status}.`, 422);
    const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new JobUrlIngestionError('UNSUPPORTED_JOB_PAGE', 'The URL did not return an HTML job page.', 422);
    }
    if (Number(response.headers?.get?.('content-length') || 0) > maxBytes) throw new JobUrlIngestionError('JOB_PAGE_TOO_LARGE', 'The public job page is too large to import.', 422);
    const html = await response.text();
    if (Buffer.byteLength(html, 'utf8') > maxBytes) throw new JobUrlIngestionError('JOB_PAGE_TOO_LARGE', 'The public job page is too large to import.', 422);
    return html;
  } catch (error) {
    if (error instanceof JobUrlIngestionError) throw error;
    if (error?.name === 'AbortError') throw new JobUrlIngestionError('JOB_PAGE_TIMEOUT', 'The public job page did not respond in time.', 504);
    throw new JobUrlIngestionError('JOB_PAGE_FETCH_FAILED', `The public job page could not be read: ${error.message}`, 422);
  } finally { clearTimeout(timer); }
}

// Recover a Greenhouse-wrapped posting through the official boards API.
// Token comes from the wrapping site's second-level domain (jobs.dropbox.com →
// dropbox); the constructed record's apply URL is the Greenhouse-hosted page,
// which a real browser can open even when the wrapper blocks plain fetches.
async function greenhouseApiRecovery(rawUrl, { fetchImpl, timeoutMs, now, classification }) {
  try {
    const url = new URL(String(rawUrl || ''));
    const ghJid = url.searchParams.get('gh_jid') || '';
    if (!/^\d+$/.test(ghJid) || /greenhouse\.io$/i.test(url.hostname)) return null;
    const hostParts = url.hostname.split('.');
    const token = hostParts.length >= 2
      ? hostParts[hostParts.length - 2].toLocaleLowerCase('en-US').replace(/[^a-z0-9]/g, '')
      : '';
    if (!token) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let payload = null;
    try {
      const response = await fetchImpl(
        `https://boards-api.greenhouse.io/v1/boards/${token}/jobs/${ghJid}?content=true`,
        { signal: controller.signal }
      );
      if (!response.ok) return null;
      payload = await response.json();
    } finally {
      clearTimeout(timer);
    }
    if (!payload?.title) return null;
    const decoded = String(payload.content || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const description = decoded.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
    const applyUrl = `https://boards.greenhouse.io/${token}/jobs/${ghJid}`;
    const job = normalizeJobRecord({
      title: String(payload.title),
      company: token.charAt(0).toUpperCase() + token.slice(1),
      location: String(payload.location?.name || ''),
      url: applyUrl,
      canonical_url: applyUrl,
      apply_url: applyUrl,
      description_text: description,
      source: 'user_supplied_url', provider: 'greenhouse', ats: 'greenhouse',
      import_mode: 'greenhouse_official_api',
      imported_at: now,
      discovery: { discovered_by: 'greenhouse_api_recovery', query: '', discovered_at: now, original_url: String(rawUrl) }
    }, { now, defaultSource: 'user_supplied_url' });
    if (!job) return null;
    return {
      job, jobs: [job],
      provider: { provider: 'greenhouse', ats: 'greenhouse' },
      classification,
      loopback: false,
      safety: { public_metadata_read: true, application_page_opened_in_browser: false, login_attempted: false, resume_uploaded: false, application_submitted: false }
    };
  } catch {
    return null;
  }
}

export async function ingestPublicJobUrl(value, {
  confirmedPublicFetch = false, fetchImpl = globalThis.fetch, lookup = dns.lookup,
  timeoutMs = 12000, maxBytes = MAX_PUBLIC_JOB_PAGE_BYTES, now = new Date().toISOString()
} = {}) {
  if (confirmedPublicFetch !== true) throw new JobUrlIngestionError('PUBLIC_FETCH_CONFIRMATION_REQUIRED', 'Confirm that Resume Jobs may read public metadata from this URL.', 409);
  const classification = classifyJobInput(value);
  // A board list/search/home page is never a job. Refuse before fetching —
  // this is exactly the input that used to produce "查看更多职位" records.
  if (classification.kind === 'job_board_url') {
    const error = new JobUrlIngestionError(
      classification.browser_required ? 'BROWSER_REQUIRED' : 'JOB_BOARD_URL',
      'This is a job-board list page, not a single posting. Open it in the assisted browser to read jobs from it, or paste one posting URL.',
      422
    );
    error.classification = classification;
    throw error;
  }
  const safe = await validatePublicJobUrl(value, { lookup });
  let html;
  try {
    html = await readPublicHtml(safe.url, { fetchImpl, timeoutMs, maxBytes });
  } catch (error) {
    // JS-rendered / login-walled boards (LinkedIn, BOSS, …) refuse plain
    // fetches. Say what the user can actually do, not "fetch failed".
    if (classification.browser_required && error instanceof JobUrlIngestionError
      && ['JOB_PAGE_HTTP_ERROR', 'JOB_PAGE_FETCH_FAILED', 'JOB_PAGE_TIMEOUT', 'UNSUPPORTED_JOB_PAGE'].includes(error.code)) {
      const browserError = new JobUrlIngestionError('BROWSER_REQUIRED',
        'This site only shows jobs in a real browser session. Open it in the assisted browser and complete any sign-in yourself.', 422);
      browserError.classification = classification;
      throw browserError;
    }
    // A gh_jid parameter marks a Greenhouse-backed posting whose wrapping
    // company site (jobs.dropbox.com …) blocks plain fetches. The OFFICIAL
    // Greenhouse boards API for the same posting stays public — verify there
    // instead of dead-ending both the one-click verify and the paste box.
    const recovered = await greenhouseApiRecovery(safe.url, { fetchImpl, timeoutMs, now, classification });
    if (recovered) return recovered;
    throw error;
  }
  const provider = detectProvider(safe.url, html);
  const extracted = extractPublicJobFromHtml(safe.url, html, { providerDetection: provider });
  const isJobPosting = /["']@type["']\s*:\s*["']JobPosting["']/i.test(html)
    || /^apple_job_hydration_extract/.test(extracted.notes || '');

  // Multi-job link discovery only applies to a CAREERS page — never as a
  // fallback for a failed single-posting extraction, and every discovered link
  // passes the quality gate (navigation anchors are not jobs).
  if (!isJobPosting && classification.kind === 'company_careers_url') {
    const discovered = extractPublicCareerJobsFromHtml(safe.url, html)
      .filter(item => !isNavigationTitle(item.title))
      .filter(item => jobQualityGate({ ...item, company: item.company || 'pending' }).ok);
    const jobs = discovered.map(item => {
      const detected = detectProvider(item.apply_url);
      return normalizeJobRecord({
        ...item, source: 'user_supplied_career_url', provider: detected.provider, ats: detected.ats,
        provider_detection: detected, import_mode: 'public_career_links_only', imported_at: now,
        discovery: { discovered_by: 'company_careers_import', query: '', discovered_at: now, original_url: safe.url }
      }, { now, defaultSource: 'user_supplied_career_url' });
    }).filter(Boolean);
    if (jobs.length) {
      return {
        job: jobs[0], jobs, provider, classification, loopback: safe.loopback,
        safety: { public_metadata_read: true, application_page_opened_in_browser: false, login_attempted: false, resume_uploaded: false, application_submitted: false }
      };
    }
  }

  // Single posting: the quality gate decides — a page without a real title,
  // description or structure never becomes a job record. A recognized ATS
  // job-detail URL, structured JobPosting data, or the localhost demo counts
  // as structure; a generic page must carry a real description.
  const trustedSingle = String(classification.reason || '').startsWith('ats_single_job_url')
    || isJobPosting
    || safe.loopback === true;
  const gate = jobQualityGate(extracted, { requireDescription: !trustedSingle });
  if (!gate.ok) {
    const error = new JobUrlIngestionError('JOB_DETAILS_NOT_FOUND',
      'No real job posting was found on this page. Check that the link opens one specific job.', 422);
    error.quality_gate = gate;
    error.classification = classification;
    throw error;
  }
  const job = normalizeJobRecord({
    ...extracted, source: 'user_supplied_url', provider: provider.provider, ats: provider.ats,
    provider_detection: provider, import_mode: 'public_metadata_only', imported_at: now,
    discovery: { discovered_by: 'user_url_import', query: '', discovered_at: now, original_url: safe.url }
  }, { now, defaultSource: 'user_supplied_url' });
  if (!job) throw new JobUrlIngestionError('INVALID_JOB_URL', 'The job URL could not be normalized.');
  return {
    job, jobs: [job], provider, classification, loopback: safe.loopback,
    safety: { public_metadata_read: true, application_page_opened_in_browser: false, login_attempted: false, resume_uploaded: false, application_submitted: false }
  };
}
