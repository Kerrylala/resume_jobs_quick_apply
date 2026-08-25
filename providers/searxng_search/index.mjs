async function fetchSearxngPage(query, { searxngUrl, pageno, timeoutMs, engines }) {
  const url = new URL(searxngUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', 'all');
  // Pin engines when asked: several defaults (brave/ddg/startpage) suspend
  // themselves under automated query rates, silently emptying every result.
  if (engines) url.searchParams.set('engines', engines);
  if (pageno > 1) url.searchParams.set('pageno', String(pageno));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'career-discovery-public-metadata/1.0' }, signal: controller.signal });
    if (!res.ok) throw new Error(`searxng_http_${res.status}`);
    const json = await res.json();
    return (Array.isArray(json.results) ? json.results : []).map((item) => ({
      title: String(item.title || '').trim(),
      url: String(item.url || '').trim(),
      content: String(item.content || item.snippet || '').trim(),
      engine: item.engine || '',
      score: Number(item.score || 0)
    })).filter((item) => item.url);
  } finally {
    clearTimeout(timer);
  }
}

export async function searchSearxng(query, {
  searxngUrl = process.env.SEARXNG_URL || 'http://127.0.0.1:8888/search',
  maxResults = 5,
  maxPages = 3,
  timeoutMs = 12000,
  engines = ''
} = {}) {
  // Paginate with `pageno` until the result cap is met or a page comes back
  // empty; earlier versions fetched only page 1, so repeated runs could never
  // reach results beyond the first page.
  const cappedPages = Math.max(1, Math.min(10, Number(maxPages) || 1));
  const seen = new Set();
  const results = [];
  for (let pageno = 1; pageno <= cappedPages && results.length < maxResults; pageno += 1) {
    const page = await fetchSearxngPage(query, { searxngUrl, pageno, timeoutMs, engines });
    if (!page.length) break;
    for (const item of page) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      results.push(item);
      if (results.length >= maxResults) break;
    }
  }
  return results;
}
