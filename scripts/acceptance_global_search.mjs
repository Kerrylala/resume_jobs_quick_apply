// Global Job Search Engine acceptance — real network, real SearXNG (local
// Docker), real ATS APIs, real filter/match pipeline, plus the browser-search
// machinery (site search box + pagination) proven on a localhost board.
//
//   1  a multi-criteria search plan saves and activates
//   2  the planner generates several query groups from profile + plan
//   3  3+ provider systems return REAL jobs (Lever/Greenhouse/Ashby/Workday…)
//   4  company ATS boards work (incl. the new Workday CXS provider)
//   5  SearXNG runs and reports READY — or degrades with an honest status
//   6  a browser-assisted board search fills the site's own search box,
//      paginates, and imports only real postings
//   7  cross-source dedup: a second run adds no duplicate cards
//   8  the Filter Engine rejects with recorded why_filtered on real data
//   9  invalid_non_job in the resulting inventory = 0
//   10 every result carries provenance; accepted ones carry match explanations
//
// Nothing applies, uploads or submits anywhere in this run.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');

async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function waitFor(read, predicate, { timeoutMs = 240_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read().catch(() => null);
    if (last != null && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)?.slice(0, 400)}`);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-global-search-'));
const dataDir = path.join(root, 'data');
for (const directory of ['data', 'archive', 'reports', 'applications', 'resumes', 'documents', 'browser_sessions', 'browser_profiles']) {
  await mkdir(path.join(root, directory), { recursive: true });
}
const writeJson = (name, value) => writeFile(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
await writeJson('job_leads.json', []);
await writeJson('career_profiles.local.json', {
  schema_version: '1.0',
  active_profile_id: 'career-gs',
  profiles: [{
    id: 'career-gs', family_id: 'career-gs', version: 1, name: 'GS Profile',
    state: 'approved', user_approved: true, approved_at: '2026-08-01T00:00:00.000Z',
    identity: { full_name: 'Acceptance Test Candidate', email: 'gs@example.invalid', city: 'Shanghai', country: 'China', links: {} },
    education: [{ institution: 'Synthetic University', degree: 'MSc', field_of_study: 'CS' }],
    experience: [{ company: 'Lab', role: 'Software Engineer', achievements: ['Built systems in Python'], technologies: ['Python', 'SQL'] }],
    projects: [], skills: { programming: ['Python', 'SQL', 'JavaScript'], data: ['Analytics'] }, certifications: [], languages: [],
    interview_stories: [], career_goals: ['Software Engineer'], job_preferences: {}, field_provenance: {}
  }]
});

// Localhost mock board proving the browser-search machinery: a site search
// box, then a paginated result list with a navigation anchor that must NEVER
// import.
const mockSite = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const query = url.searchParams.get('query') || '';
  if (!query) {
    return res.end(`<!doctype html><html><body>
      <form action="/board" method="get">
        <input type="search" name="query" placeholder="搜索职位">
        <button type="submit">搜索</button>
      </form></body></html>`);
  }
  const page = Number(url.searchParams.get('page') || 1);
  const jobs = page === 1
    ? ['<a href="https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555">Senior Engineer (page1)</a>',
       '<a href="https://jobs.lever.co/acme/66666666-7777-8888-9999-aaaaaaaaaaaa">Platform Engineer (page1)</a>',
       `<a rel="next" href="/board?query=${encodeURIComponent(query)}&page=2">下一页</a>`]
    : ['<a href="https://jobs.lever.co/acme/bbbbbbbb-cccc-dddd-eeee-ffffffffffff">Staff Engineer (page2)</a>',
       '<a href="/board">查看更多职位</a>'];
  res.end(`<!doctype html><html><body><ul>${jobs.map(item => `<li>${item}</li>`).join('')}</ul></body></html>`);
});
await new Promise(resolve => mockSite.listen(0, '127.0.0.1', resolve));
const mockBoardUrl = `http://127.0.0.1:${mockSite.address().port}/board`;

const port = await freePort();
const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(port),
    RESUME_JOBS_DATA_DIR: dataDir,
    RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'),
    RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
    RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'),
    RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
    RESUME_JOBS_DOCUMENTS_DIR: path.join(root, 'documents'),
    RESUME_JOBS_BROWSER_SESSIONS_DIR: path.join(root, 'browser_sessions'),
    RESUME_JOBS_BROWSER_PROFILES_DIR: path.join(root, 'browser_profiles'),
    RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json'),
    RESUME_JOBS_BROWSER_AGENT_TEST_MODE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
const base = `http://127.0.0.1:${port}`;
const api = async (url, options = {}) => {
  const response = await fetch(base + url, { headers: { 'content-type': 'application/json' }, ...options });
  return { status: response.status, value: await response.json().catch(() => ({})) };
};

const results = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 15000);
    dashboard.stdout.on('data', chunk => {
      if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
    });
    dashboard.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}.`)); });
  });

  // 1. Save a multi-criteria plan.
  const saved = await api('/api/search/plans', {
    method: 'POST',
    body: JSON.stringify({
      name: '全球工程岗', activate: true,
      criteria: {
        target_roles: ['Software Engineer'], keywords: ['engineer'],
        locations: ['Remote', 'United States', 'Shanghai'],
        remote: 'any', experience_max: 10, education: 'master',
        salary_currency: 'USD', salary_period: 'year',
        excluded_keywords: ['staffing agency'], blocked_companies: ['FakeCorp'],
        posted_within_days: 120, minimum_match_score: 10,
      },
    }),
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.value).slice(0, 300));
  results.push(`多条件搜索方案已保存并激活（${Object.keys(saved.value.plan.criteria).length} 个筛选维度）`);

  // 2–5. Run the global search and wait for completion.
  const started = await api('/api/search/run', { method: 'POST', body: '{}' });
  assert.equal(started.status, 200, JSON.stringify(started.value).slice(0, 300));
  results.push(`SearXNG 状态：${started.value.searxng}`);
  const run = await waitFor(
    async () => (await api('/api/search/run/status')).value?.run,
    value => ['completed', 'failed'].includes(value?.status),
    { label: 'the global search to finish', timeoutMs: 420_000 });
  assert.equal(run.status, 'completed', JSON.stringify(run).slice(0, 400));

  assert.ok(run.queries.roles.length >= 3, `planner must expand roles, got ${run.queries.roles.length}`);
  assert.ok(run.queries.text >= 3 && run.queries.site >= 3, 'planner must generate several query groups');
  results.push(`Planner：${run.queries.roles.length} 个角色（含相邻角色）→ ${run.queries.text} 组全网 query + ${run.queries.site} 组 site:ATS query`);

  const ats = run.providers.find(provider => provider.id === 'company_ats');
  assert.equal(ats.status, 'ok');
  const atsSystems = new Set((ats.notes || [])
    .filter(note => / ok \d+$/.test(note) && !/ ok 0$/.test(note))
    .map(note => note.split(':')[0]));
  assert.ok(atsSystems.size >= 3, `3+ ATS systems must return real jobs, got: ${[...atsSystems].join(', ')}`);
  assert.ok(atsSystems.has('workday'), 'the new Workday provider must return real jobs');
  results.push(`公司 ATS：${ats.found} 条真实岗位，来自 ${atsSystems.size} 个 provider 系统（${[...atsSystems].join(', ')}）`);

  const web = run.providers.find(provider => provider.id === 'searxng_web');
  assert.ok(['ok', 'unavailable', 'provider_unreachable'].includes(web.status));
  results.push(`SearXNG 全网：${web.status}${web.status === 'ok' ? `，看到 ${web.urls_seen} 个 URL，入库 ${web.found} 条` : '（诚实降级）'}`);
  assert.ok(run.providers.some(provider => provider.id === 'browser_boss' && provider.status === 'user_action_required'));

  // 8. Filter Engine on real data.
  assert.ok(run.summary.raw_found >= 20, `expect a real haul, got ${run.summary.raw_found}`);
  assert.ok(run.summary.unique_after_dedup <= run.summary.raw_found);
  assert.ok(run.summary.filtered_out >= 1, 'real data must trigger some filters');
  assert.ok((run.filtered || []).every(item => item.why_filtered?.length >= 1), 'every rejection records why_filtered');
  const filterRules = new Set(run.filtered.flatMap(item => item.why_filtered.map(why => why.rule)));
  results.push(`过滤前 ${run.summary.unique_after_dedup} → 过滤后 ${run.summary.accepted}（过滤掉 ${run.summary.filtered_out}，规则：${[...filterRules].slice(0, 5).join(', ')}）`);

  // 9–10. Inventory hygiene + provenance + match explanations.
  const inventory = (await api('/api/jobs')).value;
  const invalid = inventory.filter(job => job.invalid_non_job === true);
  assert.equal(invalid.length, 0, 'invalid_non_job must be 0');
  for (const job of inventory) {
    assert.ok(job.discovery?.discovered_by && job.discovery?.original_url, `${job.title} must carry provenance`);
  }
  const withMatch = inventory.filter(job => job.search_match?.match_score != null);
  assert.ok(withMatch.length >= 5, `accepted jobs carry match scores, got ${withMatch.length}`);
  assert.ok(withMatch.some(job => (job.search_match.why_fit || []).length >= 1), 'why-fit explanations exist');
  assert.ok((run.top_jobs || []).length >= 3, 'the run reports its best matches');
  results.push(`入库 ${inventory.length} 条：0 条 invalid_non_job，全员带溯源；${withMatch.length} 条带匹配分与解释；Top: ${run.top_jobs.slice(0, 3).map(job => `${job.title}(${job.match_score})`).join(' · ')}`);

  // 7. Dedup: run again — no duplicate cards.
  const beforeRerun = inventory.length;
  await api('/api/search/run', { method: 'POST', body: '{}' });
  const rerun = await waitFor(
    async () => (await api('/api/search/run/status')).value?.run,
    value => ['completed', 'failed'].includes(value?.status) && value?.run_id !== run.run_id,
    { label: 'the second run to finish', timeoutMs: 420_000 });
  assert.equal(rerun.status, 'completed');
  const afterRerun = (await api('/api/jobs')).value.length;
  assert.ok(afterRerun <= beforeRerun + 3,
    `a re-run must merge, not duplicate: ${beforeRerun} → ${afterRerun} (merged ${rerun.summary.inventory_duplicates_merged})`);
  assert.ok(rerun.summary.inventory_duplicates_merged >= 5,
    `the same jobs must merge into existing records; rerun summary: ${JSON.stringify(rerun.summary)}`);
  results.push(`重复运行：库存 ${beforeRerun} → ${afterRerun}（${rerun.summary.inventory_duplicates_merged} 条按 canonical URL 合并，无重复卡片）`);

  // 6. Browser-assisted search machinery: fill the site's search box, paginate,
  // import only real postings (direct script run, headless, localhost).
  const outFile = path.join(root, 'browser-search-result.json');
  // async spawn: spawnSync would block this process's event loop and starve
  // the localhost mock site the browser is reading from.
  const browserExit = await new Promise(resolve => {
    const child = spawn(process.execPath, [
      path.join(ROOT, 'browser_agent', 'discover_jobs.mjs'),
      '--url', mockBoardUrl, '--mode', 'search', '--board', 'generic',
      '--keyword', 'engineer', '--out', outFile,
      '--profile-dir', path.join(root, 'browser_profiles', 'search-probe'),
      '--max-wait-ms', '25000', '--max-jobs', '3', '--headless-test',
    ], { cwd: ROOT, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(-1); }, 180_000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
  assert.equal(browserExit, 0, `browser search script exited ${browserExit}`);
  const browserReport = JSON.parse(await readFile(outFile, 'utf8'));
  const browserTitles = browserReport.jobs.map(job => job.title);
  assert.ok(browserTitles.some(title => title.includes('page1')), 'page 1 postings read');
  assert.ok(browserTitles.some(title => title.includes('page2')), 'pagination reached page 2');
  assert.ok(!browserTitles.some(title => /查看更多/.test(title)), 'navigation anchors never import');
  assert.equal(browserReport.safety.login_attempted, false);
  results.push(`浏览器搜索机制：填入站内搜索框 → 翻页 → 读到 ${browserReport.jobs.length} 条真实职位（含第 2 页），导航锚点拒收`);

  process.stdout.write(`global search acceptance: PASS\n${results.map(line => `  - ${line}`).join('\n')}\n`);
} finally {
  dashboard.kill();
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 15_000);
    dashboard.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await new Promise(resolve => mockSite.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => { /* handles */ });
}
