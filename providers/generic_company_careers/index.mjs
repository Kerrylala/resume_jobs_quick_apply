function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function clean(value) {
  return decodeHtml(String(value || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`, 'i')
  ];
  return patterns.map(pattern => html.match(pattern)?.[1]).find(Boolean) || '';
}

function titleFromHtml(html) {
  return clean(meta(html, 'og:title') || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
}

function descriptionFromHtml(html) {
  return clean(meta(html, 'description') || meta(html, 'og:description') || clean(html).slice(0, 2500));
}

function humanizeSlug(value) {
  return decodeURIComponent(String(value || ''))
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .trim();
}

function jsonLdValues(html) {
  const values = [];
  const pattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(decodeHtml(match[1]).trim());
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== 'object') continue;
        values.push(item);
        if (Array.isArray(item['@graph'])) queue.push(...item['@graph']);
      }
    } catch { /* malformed public metadata is ignored */ }
  }
  return values;
}

function applePostingFromHtml(url, html) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  if (host !== 'jobs.apple.com') return null;
  const match = html.match(/window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("((?:\\.|[^"\\])*)"\)/);
  if (!match) return null;
  try {
    const hydration = JSON.parse(JSON.parse(`"${match[1]}"`));
    const job = hydration?.loaderData?.jobDetails?.jobsData;
    if (!job?.postingTitle || !job?.jobNumber) return null;
    const locations = Array.isArray(job.locations) ? job.locations : [];
    return {
      '@type': 'JobPosting',
      title: job.postingTitle,
      description: [job.jobSummary, job.description, job.responsibilities, job.minimumQualifications, job.preferredQualifications]
        .map(clean).filter(Boolean).join(' '),
      hiringOrganization: { name: 'Apple' },
      jobLocation: locations.map(location => ({
        address: {
          addressLocality: location.city || location.name,
          addressRegion: location.stateProvince,
          addressCountry: location.countryName
        }
      })),
      datePosted: job.postingDate || '',
      employmentType: job.employmentType || '',
      identifier: { name: 'Apple', value: job.jobNumber },
      _resume_jobs_source: 'apple_static_router_hydration'
    };
  } catch { return null; }
}

function jobPostingFromHtml(url, html) {
  return jsonLdValues(html).find(item => {
    const type = item?.['@type'];
    return type === 'JobPosting' || Array.isArray(type) && type.includes('JobPosting');
  }) || applePostingFromHtml(url, html);
}

function companyFromUrl(inputUrl) {
  try {
    const url = new URL(inputUrl);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    if (host === 'jobs.lever.co' && parts[0]) return humanizeSlug(parts[0]);
    if ((host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') && parts[0]) return humanizeSlug(parts[0]);
    return humanizeSlug(host.split('.')[0]);
  } catch { return ''; }
}

function companyFromPosting(posting) {
  const organization = posting?.hiringOrganization;
  return clean(typeof organization === 'string' ? organization : organization?.name || '');
}

function addressText(value) {
  if (!value) return '';
  if (typeof value === 'string') return clean(value);
  const address = value.address || value;
  return [address.addressLocality, address.addressRegion, address.addressCountry?.name || address.addressCountry]
    .map(clean).filter(Boolean).join(', ');
}

function locationFromPosting(posting) {
  if (!posting) return '';
  if (String(posting.jobLocationType || '').toUpperCase() === 'TELECOMMUTE') {
    const remoteRegion = addressText(posting.applicantLocationRequirements);
    return remoteRegion ? `Remote — ${remoteRegion}` : 'Remote';
  }
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
  return locations.map(addressText).filter(Boolean).join(' / ');
}

function greenhouseLocationFromHtml(html, providerDetection = {}) {
  if (String(providerDetection?.provider || '').toLowerCase() !== 'greenhouse') return '';
  const encoded = html.match(/\\["']job_post_location\\["']\s*:\s*\\["']([^"']+)\\["']/i)?.[1];
  const plain = html.match(/["']job_post_location["']\s*:\s*["']([^"']+)["']/i)?.[1];
  const value = clean(encoded || plain || '');
  if (value) return value;
  const description = clean(meta(html, 'og:description'));
  return description.length <= 200 ? description : '';
}

function isLikelyJobLink(baseUrl, candidate) {
  const base = new URL(baseUrl);
  const url = new URL(candidate, base);
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);
  if (host === 'jobs.apple.com') return /\/details\/\d+(?:-\d+)*\/[^/?#]+/i.test(url.pathname) && !/\/locationpicker\/?$/i.test(url.pathname);
  if (host === 'jobs.lever.co') return segments.length >= 2;
  if (host.endsWith('greenhouse.io')) return /\/jobs\/\d+/i.test(url.pathname) || url.searchParams.has('gh_jid');
  if (host === 'jobs.ashbyhq.com') return segments.length >= 2 && /^[0-9a-f-]{16,}$/i.test(segments.at(-1));
  if (host.endsWith('ashbyhq.com')) return segments.includes('job') && segments.length >= 3;
  if (host !== base.hostname.toLowerCase()) return false;
  return /\/(jobs?|careers?|positions?)\//i.test(url.pathname) && url.pathname !== base.pathname;
}

export function extractPublicCareerJobsFromHtml(url, html) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { /* validated by caller */ }
  const pageTitle = titleFromHtml(html).replace(/^jobs?\s+(?:at|with)\s+/i, '').replace(/\s+(?:jobs?|careers?)$/i, '').trim();
  const company = clean(meta(html, 'og:site_name'))
    || (host === 'jobs.apple.com' ? 'Apple' : '')
    || (host === 'jobs.lever.co' && pageTitle ? pageTitle : '')
    || companyFromUrl(url);
  const jobs = [];
  const jobByUrl = new Map();
  const anchorPattern = /<a\b([^>]*?)href=["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    let applyUrl;
    try { applyUrl = new URL(decodeHtml(match[2]), url); } catch { continue; }
    applyUrl.hash = '';
    if (!isLikelyJobLink(url, applyUrl.href)) continue;
    const innerHtml = match[4];
    const postingName = innerHtml.match(/<h[1-6][^>]+(?:data-qa=["']posting-name["']|class=["'][^"']*posting-name)[^>]*>([\s\S]*?)<\/h[1-6]>/i)?.[1] || '';
    const title = clean(postingName || innerHtml) || humanizeSlug(applyUrl.pathname.split('/').filter(Boolean).at(-1));
    if (title.length < 2) continue;
    const location = clean(innerHtml.match(/<[^>]+class=["'][^"']*sort-by-location[^"']*["'][^>]*>([\s\S]*?)<\//i)?.[1] || '');
    const next = { company, title, location, description_text: '', apply_url: applyUrl.href, confidence: 0.72, notes: 'public_career_page_link_discovery' };
    const previousIndex = jobByUrl.get(applyUrl.href);
    if (previousIndex == null) {
      jobByUrl.set(applyUrl.href, jobs.length);
      jobs.push(next);
    } else if (/^(?:apply|view|details?)$/i.test(jobs[previousIndex].title) && !/^(?:apply|view|details?)$/i.test(title)) {
      jobs[previousIndex] = next;
    }
  }
  return jobs.slice(0, 100);
}

export function extractPublicJobFromHtml(url, html, { providerDetection = {}, searchResult = {} } = {}) {
  const posting = jobPostingFromHtml(url, html);
  const title = clean(posting?.title) || titleFromHtml(html) || searchResult.title || '';
  const description = clean(posting?.description) || descriptionFromHtml(html) || searchResult.content || '';
  const company = companyFromPosting(posting) || clean(meta(html, 'og:site_name')) || companyFromUrl(url);
  const location = locationFromPosting(posting) || greenhouseLocationFromHtml(html, providerDetection);
  return {
    company,
    title,
    location,
    description_text: description,
    apply_url: url,
    ...(posting ? { page_type: 'job_detail' } : {}),
    confidence: Math.max(Number(providerDetection.confidence || 0), posting ? 0.9 : (title ? 0.55 : 0.35)),
    notes: `${posting?._resume_jobs_source === 'apple_static_router_hydration' ? 'apple_job_hydration_extract' : posting ? 'jobposting_json_ld_extract' : 'generic_public_page_extract'}; ${providerDetection.reason || ''}`
  };
}

export async function extractPublicJob(url, {
  providerDetection = {}, searchResult = {}, timeoutMs = 12000,
  fetchImpl = globalThis.fetch, maxBytes = 1024 * 1024
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      headers: { 'user-agent': 'resume-jobs-public-metadata/1.0' },
      redirect: 'error', signal: controller.signal
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const contentType = String(res.headers?.get?.('content-type') || '').toLowerCase();
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) throw new Error('unsupported_content_type');
    if (Number(res.headers?.get?.('content-length') || 0) > maxBytes) throw new Error('response_too_large');
    const html = await res.text();
    if (Buffer.byteLength(html, 'utf8') > maxBytes) throw new Error('response_too_large');
    return extractPublicJobFromHtml(url, html, { providerDetection, searchResult });
  } finally { clearTimeout(timer); }
}
