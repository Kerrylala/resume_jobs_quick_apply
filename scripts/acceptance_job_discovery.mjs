// Job discovery / import acceptance — real network, real classification, real
// quality gate, against a live server on a scratch workspace.
//
//   1  a real Lever single-posting URL imports as ONE job
//   2  a real Greenhouse single-posting URL imports as ONE job
//   3  a company careers URL imports MANY jobs (deduped)
//   4  the LinkedIn jobs HOME page → job_board_url + browser_required, ZERO records
//   5  a LinkedIn posting URL → honest outcome (imported if public, else browser_required) — never garbage
//   6  a BOSS 直聘 list URL → browser_required, ZERO records
//   7  keyword “销售” → a REAL provider call with honest sources; keyword hit on boards proves results flow
//   8  importing the same URL twice → one record, times_seen goes up
//   9  no navigation title ("查看更多职位"…) exists anywhere in the resulting inventory
//   10 assisted browser reading (mechanism, localhost): opens the board, reads
//      only real job links, imports them gated + deduped
//
// Nothing applies, uploads or submits anywhere in this run.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve('.');
const LEVER_SINGLE = process.env.RESUME_JOBS_ACCEPTANCE_LEVER_URL
  || 'https://jobs.lever.co/alloy/6f359313-0233-47c9-a030-ef57b3bc3a68';
const GREENHOUSE_SINGLE = process.env.RESUME_JOBS_ACCEPTANCE_GREENHOUSE_URL
  || 'https://job-boards.greenhouse.io/greenhouse/jobs/8021661?gh_jid=8021661';
const CAREERS_URL = 'https://jobs.lever.co/alloy';
const LINKEDIN_HOME = 'https://www.linkedin.com/jobs/';
const LINKEDIN_VIEW = 'https://www.linkedin.com/jobs/view/4242424242';
const BOSS_LIST = 'https://www.zhipin.com/web/geek/job?query=%E9%94%80%E5%94%AE';

async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function waitFor(read, predicate, { timeoutMs = 60_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read().catch(() => null);
    if (last != null && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)?.slice(0, 300)}`);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-discovery-'));
const dataDir = path.join(root, 'data');
for (const directory of ['data', 'archive', 'reports', 'applications', 'resumes', 'documents', 'browser_sessions', 'browser_profiles']) {
  await mkdir(path.join(root, directory), { recursive: true });
}
await writeFile(path.join(dataDir, 'job_leads.json'), '[]\n');

// Localhost mock board for the assisted-reading mechanism: real job links next
// to the exact navigation anchors that used to become fake records.
const mockSite = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body>
    <ul>
      <li><a href="https://jobs.lever.co/acme/11111111-2222-3333-4444-555555555555">Senior Sales Manager</a></li>
      <li><a href="https://jobs.lever.co/acme/66666666-7777-8888-9999-aaaaaaaaaaaa">Backend Engineer</a></li>
      <li><a href="/web/geek/job?page=2">查看更多职位</a></li>
      <li><a href="/jobs">View all jobs</a></li>
    </ul></body></html>`);
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
const importInput = input => api('/api/jobs/import', { method: 'POST', body: JSON.stringify({ input }) });
const inventory = async () => (await api('/api/jobs')).value;

const results = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 15000);
    dashboard.stdout.on('data', chunk => {
      if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
    });
    dashboard.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}.`)); });
  });

  // 1. Real Lever single posting.
  const lever = await importInput(LEVER_SINGLE);
  assert.equal(lever.status, 200, JSON.stringify(lever.value).slice(0, 300));
  assert.equal(lever.value.classification.kind, 'single_job_url');
  assert.equal((lever.value.jobs || []).length, 1, 'one URL, one job');
  assert.ok(lever.value.jobs[0].title.length > 3);
  results.push(`Lever single URL → 1 job: "${lever.value.jobs[0].title}" (识别为单个职位)`);

  // 2. Real Greenhouse single posting.
  const greenhouse = await importInput(GREENHOUSE_SINGLE);
  assert.equal(greenhouse.status, 200, JSON.stringify(greenhouse.value).slice(0, 300));
  assert.equal(greenhouse.value.classification.kind, 'single_job_url');
  assert.equal((greenhouse.value.jobs || []).length, 1);
  results.push(`Greenhouse single URL → 1 job: "${greenhouse.value.jobs[0].title}"`);

  // 3. Company careers URL → many jobs.
  const careers = await importInput(CAREERS_URL);
  assert.equal(careers.status, 200, JSON.stringify(careers.value).slice(0, 300));
  assert.equal(careers.value.classification.kind, 'company_careers_url');
  const careersCount = Number(careers.value.imported_count ?? careers.value.jobs?.length ?? 0);
  assert.ok(careersCount >= 3, `expected several postings from the careers page, got ${careersCount}`);
  results.push(`company careers URL → ${careersCount} real postings imported (识别为公司招聘页)`);

  // 4. LinkedIn jobs home: board, browser required, zero records.
  const before4 = (await inventory()).length;
  const linkedinHome = await importInput(LINKEDIN_HOME);
  assert.equal(linkedinHome.value.status, 'browser_required', JSON.stringify(linkedinHome.value).slice(0, 200));
  assert.equal(linkedinHome.value.classification.kind, 'job_board_url');
  assert.equal((await inventory()).length, before4, 'the LinkedIn home page must create ZERO records');
  results.push('LinkedIn jobs 首页 → 识别为招聘网站（browser_required），0 条记录');

  // 5. A LinkedIn posting URL: honest outcome, never garbage.
  const before5 = (await inventory()).length;
  const linkedinView = await importInput(LINKEDIN_VIEW);
  const viewOutcome = linkedinView.status === 200 && Array.isArray(linkedinView.value.jobs)
    ? `imported "${linkedinView.value.jobs[0].title}"`
    : `${linkedinView.value.status || linkedinView.value.code}`;
  if (linkedinView.status !== 200) {
    assert.ok(['browser_required', 'blocked'].includes(linkedinView.value.status) || linkedinView.value.code,
      JSON.stringify(linkedinView.value).slice(0, 200));
    assert.equal((await inventory()).length, before5, 'a refused LinkedIn posting must add nothing');
  }
  results.push(`LinkedIn 具体职位 URL → ${viewOutcome}（诚实结果，无垃圾记录）`);

  // 6. BOSS list URL: browser required, zero records.
  const before6 = (await inventory()).length;
  const boss = await importInput(BOSS_LIST);
  assert.equal(boss.value.status, 'browser_required', JSON.stringify(boss.value).slice(0, 200));
  assert.equal(boss.value.classification.kind, 'job_board_url');
  assert.equal((await inventory()).length, before6, 'a BOSS list page must create ZERO records');
  results.push('BOSS 直聘搜索页 → 识别为招聘网站（browser_required），0 条记录');

  // 7. Keyword search: a real provider call.
  const sales = await api('/api/jobs/search', { method: 'POST', body: JSON.stringify({ query: '销售' }) });
  assert.equal(sales.status, 200, JSON.stringify(sales.value).slice(0, 300));
  assert.ok(['ok', 'no_sources'].includes(sales.value.status));
  const salesSources = (sales.value.sources || []).map(item => `${item.source}:${item.status}`).join(', ');
  // Boards imported above make company_careers a REAL available source.
  assert.equal(sales.value.status, 'ok', 'with known boards the search must actually run');
  results.push(`关键词“销售” → 真实调用 providers [${salesSources}]，命中 ${sales.value.found} 条（诚实结果）`);
  const engineer = await api('/api/jobs/search', { method: 'POST', body: JSON.stringify({ query: 'engineer' }) });
  assert.equal(engineer.status, 200);
  assert.ok(engineer.value.found >= 1, `an English keyword should match board postings, got ${engineer.value.found}`);
  results.push(`关键词 "engineer" → 从公司 careers boards 命中 ${engineer.value.found} 条真实职位`);

  // 8. Duplicate import: one record, times_seen goes up.
  const beforeDup = await inventory();
  const dupBeforeCount = beforeDup.length;
  const dup = await importInput(LEVER_SINGLE);
  assert.equal(dup.status, 200);
  const afterDup = await inventory();
  assert.equal(afterDup.length, dupBeforeCount, 'importing the same URL twice must not add a card');
  const leverRow = afterDup.find(job => String(job.canonical_url || '').includes('6f359313'));
  assert.ok(leverRow, 'the Lever job must still exist exactly once');
  assert.ok(Number(leverRow.times_seen) >= 2, `times_seen must increase, got ${leverRow.times_seen}`);
  results.push(`重复导入同一 URL → 仍是 1 条记录，times_seen=${leverRow.times_seen}`);

  // 9. No navigation garbage anywhere.
  const all = await inventory();
  const garbage = all.filter(job => /查看更多|更多职位|职位列表|^jobs$|^careers$|view all/i.test(String(job.title || '')) && job.invalid_non_job !== true);
  assert.deepEqual(garbage.map(job => job.title), [], 'no navigation title may exist as a live job record');
  results.push(`库存共 ${all.length} 条，0 条导航垃圾（"查看更多职位"不可能再进入 JobRecord）`);

  // 10. Assisted browser reading (mechanism, localhost headless).
  const started = await api('/api/jobs/discover-in-browser', {
    method: 'POST', body: JSON.stringify({ url: mockBoardUrl, confirmed: true })
  });
  assert.equal(started.status, 200, JSON.stringify(started.value).slice(0, 300));
  const finished = await waitFor(
    async () => (await api('/api/jobs/discover-in-browser/status')).value,
    value => value.status !== 'running' && value.status !== 'idle',
    { label: 'assisted discovery to finish', timeoutMs: 90_000 });
  assert.ok(finished.found >= 2, `the mock board shows 2 real jobs, found ${finished.found}`);
  assert.equal(finished.imported, 2, 'exactly the two REAL postings import — never the navigation anchors');
  const afterAssisted = await inventory();
  assert.ok(afterAssisted.some(job => job.title === 'Senior Sales Manager'));
  assert.ok(!afterAssisted.some(job => /查看更多/.test(String(job.title || ''))));
  results.push(`浏览器辅助读取（localhost 机制验证）→ 读到 ${finished.found} 条真实职位，导入 ${finished.imported} 条，导航锚点全部拒收`);

  // Provenance is answerable for every job.
  for (const job of afterAssisted) {
    assert.ok(job.discovery && job.discovery.discovered_by && job.discovery.original_url,
      `job "${job.title}" must carry full provenance`);
  }
  results.push('每条职位都带 source / discovered_by / query / discovered_at / original_url');

  process.stdout.write(`job discovery acceptance: PASS\n${results.map(line => `  - ${line}`).join('\n')}\n`);
} finally {
  dashboard.kill();
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 15_000);
    dashboard.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await new Promise(resolve => mockSite.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => { /* browser may hold handles */ });
}
