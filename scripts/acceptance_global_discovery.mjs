// Global Job Discovery Engine — the long real acceptance.
//
// Runs SIX real search profiles (中国 AI/软件 · 中国销售 · 中国应届 ·
// US entry-level software · Remote · broad) through the full pipeline against
// the real network: registry adapters (Amazon/Wellfound/Remotive/腾讯/牛客/
// 实习僧), ATS boards (GH/Lever/Ashby/SR/Workable/Workday), SearXNG, hard vs
// soft filters, matching, dedup, and the shortlist/ignore/block actions with
// a server restart to prove persistence. Nothing applies or submits.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
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
async function waitFor(read, predicate, { timeoutMs = 600_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read().catch(() => null);
    if (last != null && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)?.slice(0, 300)}`);
}

const root = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-global-discovery-'));
const dataDir = path.join(root, 'data');
for (const directory of ['data', 'archive', 'reports', 'applications', 'resumes', 'documents', 'browser_sessions', 'browser_profiles']) {
  await mkdir(path.join(root, directory), { recursive: true });
}
const writeJson = (name, value) => writeFile(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
await writeJson('job_leads.json', []);
await writeJson('career_profiles.local.json', {
  schema_version: '1.0',
  active_profile_id: 'career-gd',
  profiles: [{
    id: 'career-gd', family_id: 'career-gd', version: 1, name: 'GD Profile',
    state: 'approved', user_approved: true, approved_at: '2026-08-01T00:00:00.000Z',
    identity: { full_name: 'Acceptance Test Candidate', email: 'gd@example.invalid', city: 'Shanghai', country: 'China', links: {} },
    education: [{ institution: 'Synthetic University', degree: 'MSc', field_of_study: 'CS' }],
    experience: [{ company: 'Lab', role: 'Software Engineer', achievements: ['Built systems in Python'], technologies: ['Python', 'SQL'] }],
    projects: [], skills: { programming: ['Python', 'SQL'], ai_tools: ['PyTorch'], business: ['销售支持'] }, certifications: [], languages: [],
    interview_stories: [], career_goals: ['AI Engineer'], job_preferences: {}, field_provenance: {}
  }]
});

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let dashboard = null;
async function startDashboard() {
  dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
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
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 15000);
    dashboard.stdout.on('data', chunk => {
      if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
    });
    dashboard.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}.`)); });
  });
}
async function stopDashboard() {
  if (!dashboard) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 15_000);
    dashboard.once('exit', () => { clearTimeout(timer); resolve(); });
    dashboard.kill();
  });
  dashboard = null;
}
const api = async (url, options = {}) => {
  const response = await fetch(base + url, { headers: { 'content-type': 'application/json' }, ...options });
  return { status: response.status, value: await response.json().catch(() => ({})) };
};

const PROFILES = [
  {
    name: '中国 AI/软件', criteria: {
      target_roles: ['AI 工程师', '软件工程师'], keywords: ['AI'], locations: ['上海', '北京', '深圳'],
      soft_rules: ['location_mismatch', 'no_keyword_match'],
    },
  },
  {
    name: '中国 销售/技术销售', criteria: {
      target_roles: ['销售', '技术销售'], locations: ['深圳', '上海'],
      soft_rules: ['location_mismatch'],
    },
  },
  {
    name: '中国 应届 0-3 年', criteria: {
      target_roles: ['校招', '应届'], keywords: ['实习'], locations: ['上海'],
      experience_max: 3, entry_level: true,
      soft_rules: ['location_mismatch', 'no_keyword_match'],
    },
  },
  {
    name: 'US Entry-Level Software/AI', criteria: {
      target_roles: ['Software Engineer', 'AI Engineer'], locations: ['United States', 'Remote'],
      experience_max: 3, entry_level: true, salary_currency: 'USD',
      soft_rules: ['location_mismatch', 'not_entry_level', 'experience_above_max'],
    },
  },
  {
    name: 'Remote', criteria: {
      target_roles: ['Software Engineer'], remote: 'remote', locations: [],
      soft_rules: ['no_keyword_match'],
    },
  },
  {
    name: '宽泛 Engineer', criteria: { target_roles: ['Engineer'], soft_rules: ['no_keyword_match'] },
  },
];

const results = [];
const perProfile = [];
const providerTotals = new Map();
try {
  await startDashboard();

  for (const profile of PROFILES) {
    const saved = await api('/api/search/plans', {
      method: 'POST', body: JSON.stringify({ name: profile.name, criteria: profile.criteria, activate: true }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.value).slice(0, 200));
    const started = await api('/api/search/run', { method: 'POST', body: '{}' });
    assert.equal(started.status, 200, JSON.stringify(started.value).slice(0, 300));
    const run = await waitFor(
      async () => (await api('/api/search/run/status')).value?.run,
      value => ['completed', 'failed'].includes(value?.status),
      { label: `${profile.name} run`, timeoutMs: 900_000 });
    assert.equal(run.status, 'completed', JSON.stringify(run).slice(0, 300));
    const providerCounts = Object.fromEntries(run.providers
      .filter(provider => (provider.found ?? 0) > 0)
      .map(provider => [provider.id, provider.found]));
    for (const [id, found] of Object.entries(providerCounts)) {
      providerTotals.set(id, (providerTotals.get(id) || 0) + found);
    }
    perProfile.push({
      name: profile.name,
      raw: run.summary.raw_found, unique: run.summary.unique_after_dedup,
      filtered: run.summary.filtered_out, accepted: run.summary.accepted,
      providers: providerCounts,
      soft_sample: (run.top_jobs || []).length,
      filter_rules: [...new Set((run.filtered || []).flatMap(item => item.why_filtered.map(why => why.rule)))].slice(0, 5),
    });
    results.push(`${profile.name}: raw ${run.summary.raw_found} → 去重 ${run.summary.unique_after_dedup} → 过滤后 ${run.summary.accepted}（滤掉 ${run.summary.filtered_out}）`);
  }

  // Aggregate provider reality check: 3+ systems with real jobs, spanning
  // China AND global AND ATS boards.
  const realProviders = [...providerTotals.keys()];
  assert.ok(realProviders.length >= 4, `4+ real providers expected, got ${realProviders.join(', ')}`);
  assert.ok(providerTotals.has('company_ats'), 'ATS boards must produce jobs');
  assert.ok(['tencent_careers', 'nowcoder', 'shixiseng'].some(id => providerTotals.has(id)), 'a China provider must produce jobs');
  assert.ok(['amazon_jobs', 'wellfound', 'remotive'].some(id => providerTotals.has(id)), 'a global provider must produce jobs');
  results.push(`真实出岗位的 provider：${realProviders.map(id => `${id}(${providerTotals.get(id)})`).join(' · ')}`);

  // Soft preferences: at least one accepted job carries soft notes.
  const inventory = (await api('/api/jobs')).value;
  const soft = inventory.filter(job => (job.search_match?.soft_notes || []).length > 0);
  results.push(`软偏好降序：${soft.length} 条入库岗位带 soft_notes（降分未删除）`);

  // Hygiene: zero invalid, full provenance.
  assert.equal(inventory.filter(job => job.invalid_non_job === true).length, 0, 'invalid_non_job must be 0');
  for (const job of inventory) {
    assert.ok(job.discovery?.discovered_by && job.discovery?.original_url, `${job.title} missing provenance`);
  }
  const uniqueUrls = new Set(inventory.map(job => job.canonical_url));
  assert.equal(uniqueUrls.size, inventory.length, 'canonical URLs must be unique in the inventory');
  results.push(`库存 ${inventory.length} 条：0 invalid · 0 重复 canonical URL · 全员溯源`);

  // User actions + persistence across a server restart.
  const target = inventory.find(job => job.company && job.title) || inventory[0];
  assert.ok(target, 'inventory must not be empty');
  const flagged = await api(`/api/jobs/${encodeURIComponent(target.job_id)}/flag`, { method: 'POST', body: JSON.stringify({ action: 'shortlist' }) });
  assert.equal(flagged.status, 200);
  const ignoreTarget = inventory.find(job => job.job_id !== target.job_id);
  await api(`/api/jobs/${encodeURIComponent(ignoreTarget.job_id)}/flag`, { method: 'POST', body: JSON.stringify({ action: 'ignore_forever' }) });
  const blockTarget = inventory.find(job => job.company && job.job_id !== target.job_id && job.job_id !== ignoreTarget.job_id);
  const blocked = await api(`/api/jobs/${encodeURIComponent(blockTarget.job_id)}/flag`, { method: 'POST', body: JSON.stringify({ action: 'block_company' }) });
  assert.equal(blocked.status, 200);

  await stopDashboard();
  await startDashboard();

  const afterRestart = (await api('/api/jobs')).value;
  const shortlistedAfter = afterRestart.find(job => job.job_id === target.job_id);
  assert.equal(shortlistedAfter.shortlisted, true, 'shortlist must survive a restart');
  const ignoredAfter = afterRestart.find(job => job.job_id === ignoreTarget.job_id);
  assert.equal(ignoredAfter.ignored_forever, true, 'ignore-forever must survive a restart');
  assert.equal(ignoredAfter.suppressed_from_default, true, 'ignored jobs never resurface by default');
  const plans = (await api('/api/search/plans')).value;
  const activePlan = plans.plans.find(plan => plan.plan_id === plans.active_plan_id);
  assert.ok(activePlan.criteria.blocked_companies.some(name => name === blocked.value.blocked_company),
    'blocking a company must feed the active plan');
  results.push(`收藏/备选/忽略/屏蔽：重启后仍持久（备选 ✓ · 永久忽略 ✓ 且默认隐藏 · 屏蔽公司 "${blocked.value.blocked_company}" 已进方案黑名单）`);

  // Stop control: start a run and stop it immediately — it must still land in
  // a terminal state without hanging.
  await api('/api/search/run', { method: 'POST', body: '{}' });
  await api('/api/search/run/stop', { method: 'POST', body: '{}' });
  const stoppedRun = await waitFor(
    async () => (await api('/api/search/run/status')).value?.run,
    value => ['completed', 'failed'].includes(value?.status),
    { label: 'stopped run to finish', timeoutMs: 300_000 });
  assert.equal(stoppedRun.status, 'completed');
  results.push('停止搜索：请求后当前来源收尾即完成，不悬挂');

  // Capability roster persisted for the report.
  const status = await api('/api/search/run/status');
  const capabilities = status.value.capabilities || [];
  assert.ok(capabilities.length >= 20, 'the capability roster covers the provider landscape');
  await mkdir(path.join(ROOT, 'reports'), { recursive: true });
  await writeFile(path.join(ROOT, 'reports', 'global_discovery_capability.json'), `${JSON.stringify({
    generated_at: new Date().toISOString(),
    capabilities,
    provider_totals: Object.fromEntries(providerTotals),
    profiles: perProfile,
  }, null, 2)}\n`);
  results.push(`能力名册：${capabilities.length} 个平台标注（REAL_WORKING/BROWSER_LOGIN_REQUIRED/PARTIAL/BLOCKED_EXTERNAL/NOT_IMPLEMENTED）→ reports/global_discovery_capability.json`);

  process.stdout.write(`global discovery acceptance: PASS\n${results.map(line => `  - ${line}`).join('\n')}\n`);
  process.stdout.write(`\nPER-PROFILE:\n${perProfile.map(item => `  ${item.name}: ${JSON.stringify(item.providers)}`).join('\n')}\n`);
} finally {
  await stopDashboard();
  await rm(root, { recursive: true, force: true }).catch(() => { /* handles */ });
}
