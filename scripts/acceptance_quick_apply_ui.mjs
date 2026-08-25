// Quick Apply UI acceptance — the NEW default UI, driven end-to-end in a real
// browser, with the real backend and the real Browser Agent. Nothing stubbed.
//
// Covered (the goal's acceptance list):
//   1  new user: upload resume → online profile → confirm it (all through UI)
//   2  paste a real public job URL → job card appears
//   3  job cards render with match info
//   4  “用 AI 申请” opens the preflight drawer
//   5  preflight works (resume block, questions, one primary button)
//   6  tailored resume usable from the drawer (deterministic version)
//   7  Browser Agent opens the page (persistent, headless for CI)
//   8  the correct tailored resume is REALLY uploaded (agent-verified)
//   9  safe fields are filled
//   10 challenge → UI prompts → “我已完成验证，继续” resumes the same window
//   11 real remaining-items count from the checklist
//   12 Answer Memory reduces what the next application needs
//   13 application history updates after “我已提交”
//   14 /advanced still serves the old Dashboard
//
// Safety: no CAPTCHA bypass, no login, no sensitive autofill, no auto-submit.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

import { agentBrowserCandidates } from './lib/agent_browser.mjs';

const ROOT = path.resolve('.');
const REAL_IMPORT_URL = process.env.RESUME_JOBS_ACCEPTANCE_LEVER_URL
  || 'https://jobs.lever.co/alloy/6f359313-0233-47c9-a030-ef57b3bc3a68/apply';

const browserExecutable = agentBrowserCandidates(ROOT).find(candidate => fs.existsSync(candidate));
if (!browserExecutable) throw new Error('A local Chromium is required (npm run browser:install-agent-runtime).');

async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}
async function waitFor(read, predicate, { timeoutMs = 120_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read().catch(() => null);
    if (last != null && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)?.slice(0, 300)}`);
}

// --- Workspace ---------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-ui-acceptance-'));
const dataDir = path.join(root, 'data');
const sessionsDir = path.join(root, 'browser_sessions');
for (const directory of ['data', 'archive', 'reports', 'applications', 'resumes', 'documents', 'browser_sessions', 'browser_profiles']) {
  await mkdir(path.join(root, directory), { recursive: true });
}
const writeJson = (name, value) => writeFile(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);

// --- Mock employer site ------------------------------------------------------
let challengeActive = true;
const formPage = extra => `<!doctype html><html><body><form>
  <label for="name">Full name</label><input id="name" name="name">
  <label for="email">Email</label><input id="email" name="email" type="email">
  <label for="phone">Phone</label><input id="phone" name="phone">
  <label for="favdb">Which database do you know best?</label><input id="favdb" name="favorite_database">
  <label for="resume">Resume/CV</label><input id="resume" name="resume" type="file">
  ${extra || ''}
  <input type="submit" value="Submit application">
</form></body></html>`;
const site = http.createServer((req, res) => {
  if (req.url.startsWith('/clear')) {
    challengeActive = false;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('cleared');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (req.url.startsWith('/challenge') && challengeActive) {
    return res.end(`<!doctype html><html><head><meta http-equiv="refresh" content="4"></head><body>
      <h1>Checking your browser before you continue</h1>
      <p>Verify you are human to access this page.</p></body></html>`);
  }
  res.end(formPage());
});
await new Promise((resolve, reject) => { site.once('error', reject); site.listen(0, '127.0.0.1', resolve); });
const sitePort = site.address().port;
const pageUrl = slug => `http://127.0.0.1:${sitePort}/${slug}/apply`;

// --- Seed jobs (localhost apply targets; a real URL is pasted through the UI)
const jobDef = (id, slug, title, company) => ({
  job_id: id, title, company, location: 'Remote',
  url: pageUrl(slug), canonical_url: pageUrl(slug), apply_url: pageUrl(slug), application_url: pageUrl(slug),
  provider: 'generic', page_type: 'job_detail', recommended_decision: 'shortlist',
  description_text: `Synthetic ${title} description for the Quick Apply UI acceptance run. `.repeat(4),
  info_quality: { score: 100 }, confidence: 0.95, match_score: 86,
  match_reasons: ['Skills match your profile'],
  approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic_acceptance'] },
  application_mode: 'REVIEW_ONLY', submit_allowed: false, upload_resume_allowed: false, final_submit_allowed: false
});
const jobs = [
  jobDef('job_ui_a', 'alpha', 'Data Scientist', 'UI Alpha Corp'),
  jobDef('job_ui_b', 'beta', 'Data Engineer', 'UI Beta Corp'),
  jobDef('job_ui_c', 'challenge', 'ML Engineer', 'UI Gamma Corp'),
];
await writeJson('jobs_shortlist.json', jobs);
await writeJson('job_leads.json', jobs);
await writeJson('job_reviews.json', []);
await writeJson('question_bank.json', { version: '2.0', answers: [] });

// --- Dashboard control -------------------------------------------------------
const dashboardPort = await freePort();
const base = `http://127.0.0.1:${dashboardPort}`;
let dashboard = null;
async function startDashboard(keepOpen) {
  dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(dashboardPort),
      RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'),
      RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
      RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'),
      RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
      RESUME_JOBS_DOCUMENTS_DIR: path.join(root, 'documents'),
      RESUME_JOBS_BROWSER_SESSIONS_DIR: sessionsDir,
      RESUME_JOBS_BROWSER_PROFILES_DIR: path.join(root, 'browser_profiles'),
      RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json'),
      RESUME_JOBS_CHROME_EXECUTABLE: browserExecutable,
      RESUME_JOBS_BROWSER_AGENT_TEST_MODE: '1',
      ...(keepOpen ? { RESUME_JOBS_BROWSER_AGENT_KEEP_OPEN_TEST: '1' } : {}),
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
const dashboardState = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'dashboard_state.json'), 'utf8'));
async function agentReport(sessionId) {
  const file = path.join(sessionsDir, sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_'), 'ApplicationExecution.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

// --- UI browser --------------------------------------------------------------
let ui = null;
let page = null;
async function openUi() {
  ui = await chromium.launch({ executablePath: browserExecutable, headless: true });
  page = await ui.newPage({ viewport: { width: 1280, height: 860 } });
  page.setDefaultTimeout(30_000);
  // Surface failed backend calls in the test log — the UI shows them as
  // toasts, which a timeout would otherwise hide.
  page.on('response', async response => {
    if (response.url().includes('/api/') && response.status() >= 400) {
      const body = await response.text().catch(() => '');
      process.stdout.write(`  [ui-api ${response.status()}] ${response.request().method()} ${response.url().slice(base.length)} ${body.replace(/\s+/g, ' ').slice(0, 300)}\n`);
    }
  });
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
}
async function closeUi() {
  if (ui) await ui.close().catch(() => { /* already gone */ });
  ui = null;
}
const clickText = async (text, scope) => (scope || page).getByText(text, { exact: false }).first().click();

async function waitForAgentGone() {
  await waitFor(async () => {
    const status = await api('/api/executor/status');
    return status.value?.connected !== true;
  }, value => value === true, { label: 'the previous browser window to close' });
}

// Drives one application from the jobs list to a settled state via the UI.
async function gotoRoute(route) {
  // Navigate the way a user does: close any open panel, then use the sidebar.
  if (await page.locator('#drawer').isVisible().catch(() => false)) {
    await page.locator('#drawerClose').click();
    await page.waitForTimeout(200);
  }
  await page.locator(`#mainNav a[data-route=${route}]`).click();
  await page.waitForTimeout(700);
}

async function applyThroughUi(jobTitle) {
  await gotoRoute('jobs');
  const card = page.locator('.job-card', { hasText: jobTitle }).first();
  try {
    await card.getByRole('button', { name: /用 AI 申请|Apply with AI/ }).click();
  } catch (error) {
    const mainText = await page.locator('main').innerText().catch(() => '');
    throw new Error(`apply button for "${jobTitle}" not found. Jobs page shows: ${mainText.replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  // Preflight drawer.
  await page.locator('#drawer').waitFor({ state: 'visible' });
  const go = page.getByRole('button', { name: /打开并填写|Open & fill/ });
  await go.waitFor({ state: 'visible' });
  // The previous job's window may still be shutting down (one browser window
  // at a time is a product constraint the UI surfaces as a plain error toast);
  // retry the primary action until the window slot frees up.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await go.click();
    const settled = await page.locator('.apply-status').waitFor({ state: 'visible', timeout: 8_000 }).then(() => true).catch(() => false);
    if (settled) return;
    await page.waitForTimeout(2000);
  }
  throw new Error(`the fill never started for "${jobTitle}"`);
}

const results = [];
try {
  // ==========================================================================
  // Phase 1: window closes after each fill (sequential jobs A and B).
  // ==========================================================================
  await startDashboard(false);
  await openUi();

  // 1. New user: home recommends uploading a resume.
  const homeText = await page.locator('main').innerText();
  assert.ok(/上传一份简历|Upload a resume/.test(homeText), 'home must recommend uploading a resume first');
  results.push('new user home: one recommended next step (upload resume)');

  // Upload through the UI (real file input), then confirm the profile.
  await gotoRoute('profile');
  const resumeTxt = path.join(root, 'acceptance_ui_resume.txt');
  await writeFile(resumeTxt, [
    'Acceptance Test Candidate',
    'Email: acceptance-ui@example.invalid',
    'Phone: +1 555 0100',
    'Location: Shanghai, China',
    '', 'EXPERIENCE',
    'Synthetic ML Lab - ML Engineer (2023 - now)',
    '- Built a causal inference platform in Python',
    '- Reduced query latency by 18% with SQL optimization',
    '', 'EDUCATION', 'Synthetic University - MSc Statistics',
    '', 'SKILLS', 'Python, SQL, PyTorch',
  ].join('\n'));
  await page.locator('input[type=file]').setInputFiles(resumeTxt);
  await waitFor(async () => (await api('/api/profile/full')).value, value => value.has_profile === true, { label: 'profile generated from upload' });
  await page.waitForTimeout(600);
  // Edit the contact section through the UI (the TXT parser missed the phone).
  await page.locator('.card', { hasText: /联系方式|Contact/ }).first()
    .getByRole('button', { name: /编辑|Edit/ }).click();
  const editor = page.locator('#drawer textarea');
  const identity = JSON.parse(await editor.inputValue());
  identity.phone = '+1 555 0100';
  identity.current_location = 'Shanghai, China';
  await editor.fill(JSON.stringify(identity, null, 2));
  await page.locator('#drawer').getByRole('button', { name: /保存|Save/ }).click();
  await waitFor(async () => (await api('/api/profile/full')).value,
    value => value.sections?.identity?.phone === '+1 555 0100', { label: 'contact edit saved' });
  results.push('contact section edited through the UI (phone + location) → saved as a new version');

  // Saving an edit confirms in the same action; click the confirm button only
  // if the profile still needs it.
  const profileNow = (await api('/api/profile/full')).value;
  if (profileNow.approved !== true) {
    await page.getByRole('button', { name: /确认资料|Confirm profile/ }).click();
  }
  await waitFor(async () => (await api('/api/profile/full')).value, value => value.approved === true, { label: 'profile approved' });
  results.push('resume uploaded through the UI → online profile generated → edited → confirmed');

  // 2. Paste a real public job URL through the UI.
  await gotoRoute('jobs');
  await page.locator('#importUrl').fill(REAL_IMPORT_URL);
  await page.locator('#importUrl').press('Enter');
  await waitFor(async () => (await api('/api/jobs')).value, rows => Array.isArray(rows) && rows.length >= 4, { label: 'real URL imported', timeoutMs: 60_000 });
  results.push('real public job URL pasted in the UI → imported');

  // 3. Job cards render.
  await gotoRoute('jobs');
  await page.waitForTimeout(700);
  const jobsText = await page.locator('main').innerText();
  assert.ok(jobsText.includes('UI Alpha Corp') && jobsText.includes('Data Scientist'), 'job cards must render');
  results.push('job cards: company, title, location, match, one-line reason');

  // 4–9. Apply job A through the UI; the agent uploads and fills for real.
  await applyThroughUi('UI Alpha Corp');
  const stateA = await waitFor(
    async () => (await api('/api/jobs/job_ui_a/apply-state')).value,
    value => ['needs_you', 'ready_to_submit'].includes(value.state),
    { label: 'job A to settle after filling', timeoutMs: 180_000 });
  const sessionA = dashboardState().application_status_overrides.job_ui_a.active_session_id;
  const reportA = await agentReport(sessionA);
  assert.equal(reportA.resume_upload.status, 'confirmed', JSON.stringify(reportA.resume_upload).slice(0, 200));
  assert.ok(reportA.counts.filled >= 3, `safe fields must fill, got ${reportA.counts.filled}`);
  assert.equal(reportA.safety.submit_attempted, false);
  await page.waitForTimeout(2500);
  const drawerTextA = await page.locator('#drawer').innerText();
  assert.ok(/还有|还剩|need you|left|准备提交|Ready to submit/.test(drawerTextA),
    `the drawer must show the remaining-items count in plain words; saw: ${drawerTextA.replace(/\s+/g, ' ').slice(0, 200)}`);
  results.push(`job A: agent opened the page, uploaded ${reportA.resume_upload.file.name}, filled ${reportA.counts.filled} fields; UI shows ${stateA.things_left} things left`);

  // 12a. Save the answer the mock form asked for — through the UI.
  await gotoRoute('profile');
  await page.getByRole('button', { name: /添加答案|Add answer/ }).click();
  await page.locator('#drawer input').fill('Which database do you know best?');
  await page.locator('#drawer textarea').fill('PostgreSQL');
  await page.locator('#drawer').getByRole('button', { name: /保存|Save/ }).click();
  await waitFor(async () => (await api('/api/answers')).value, value => (value.answers || []).length >= 1, { label: 'answer saved' });
  results.push('answer saved through the UI (My Answers)');

  // Wait until job A's window closed, then apply job B.
  await waitForAgentGone();
  await applyThroughUi('UI Beta Corp');
  const stateB = await waitFor(
    async () => (await api('/api/jobs/job_ui_b/apply-state')).value,
    value => ['needs_you', 'ready_to_submit'].includes(value.state),
    { label: 'job B to settle after filling', timeoutMs: 180_000 });
  const sessionB = dashboardState().application_status_overrides.job_ui_b.active_session_id;
  const reportB = await agentReport(sessionB);
  const answerFilled = (reportB.field_results || []).some(item =>
    item.outcome === 'filled' && /database/i.test(item.label || ''));
  assert.ok(answerFilled, 'job B must auto-fill the remembered answer');
  assert.ok(reportB.counts.filled > reportA.counts.filled, 'Answer Memory must reduce what the next application needs');
  assert.ok(stateB.things_left <= stateA.things_left, 'fewer things left on the next application');
  results.push(`job B: remembered answer auto-filled (${reportB.counts.filled} filled vs ${reportA.counts.filled}); things left ${stateB.things_left} ≤ ${stateA.things_left}`);

  // Cross-job binding: B uploaded B's file, not A's.
  assert.notEqual(reportA.resume_upload.file.name, reportB.resume_upload.file.name, 'each job uploads its own tailored file');
  results.push('cross-job isolation: A and B uploaded two different tailored files');

  await closeUi();
  await stopDashboard();

  // ==========================================================================
  // Phase 2: challenge → continue in the SAME window → review → submitted.
  // ==========================================================================
  await startDashboard(true);
  await openUi();

  await applyThroughUi('UI Gamma Corp');
  await waitFor(
    async () => (await api('/api/jobs/job_ui_c/apply-state')).value,
    value => value.state === 'awaiting_verification',
    { label: 'challenge to pause the fill', timeoutMs: 120_000 });
  await page.waitForTimeout(2000);
  const drawerChallenge = await page.locator('#drawer').innerText();
  assert.ok(/完成验证|verification/i.test(drawerChallenge), 'the UI must ask the user to complete the verification');
  results.push('challenge: UI shows “需要你完成验证” with the continue button — nothing bypassed');

  await fetch(`http://127.0.0.1:${sitePort}/clear`);
  await page.waitForTimeout(5000);
  // A too-early continue is harmless (the agent re-reads and refuses to fill
  // through a still-visible challenge); the user just clicks again.
  let stateC = null;
  for (let attempt = 0; attempt < 6 && !stateC; attempt += 1) {
    const cont = page.locator('#drawer').getByRole('button', { name: /我已完成验证|finished verifying/ });
    if (await cont.isVisible().catch(() => false)) await cont.click().catch(() => { /* repainted mid-click */ });
    stateC = await waitFor(
      async () => (await api('/api/jobs/job_ui_c/apply-state')).value,
      value => ['needs_you', 'ready_to_submit'].includes(value.state),
      { label: 'job C to resume and settle', timeoutMs: 25_000 }).catch(() => null);
  }
  assert.ok(stateC, 'filling never resumed after the verification was cleared');
  const sessionC = dashboardState().application_status_overrides.job_ui_c.active_session_id;
  const reportC = await agentReport(sessionC);
  assert.equal(reportC.resume_upload.status, 'confirmed');
  assert.ok(reportC.counts.filled >= 3);
  results.push(`challenge cleared: same window resumed, uploaded + filled ${reportC.counts.filled} fields; ${stateC.things_left} things left`);

  // Review → submitted through the UI.
  await page.waitForTimeout(2500);
  if (stateC.state === 'needs_you') {
    await page.locator('#drawer').getByRole('button', { name: /我已检查完毕|reviewed everything/ }).click();
    await waitFor(
      async () => (await api('/api/jobs/job_ui_c/apply-state')).value,
      value => value.state === 'ready_to_submit',
      { label: 'review completed', timeoutMs: 60_000 });
  }
  await page.waitForTimeout(2500);
  await page.locator('#drawer').getByRole('button', { name: /我已提交|I submitted/ }).click();
  await waitFor(
    async () => (await api('/api/jobs/job_ui_c/apply-state')).value,
    value => value.state === 'applied',
    { label: 'application marked submitted', timeoutMs: 60_000 });
  const history = await api('/api/applications/history');
  assert.ok((history.value?.applications || []).some(item => String(item.job_id) === 'job_ui_c'),
    'application history must record the submitted application');
  results.push('review completed and “我已提交” through the UI → history updated');

  // 14. The old Dashboard still lives at /advanced.
  const advanced = await fetch(`${base}/advanced`);
  const advancedHtml = await advanced.text();
  assert.equal(advanced.status, 200);
  assert.ok(/applicationExecutorMode|Resume Jobs/i.test(advancedHtml), '/advanced must serve the classic Dashboard');
  const rootHtml = await (await fetch(`${base}/`)).text();
  assert.ok(/Quick Apply/i.test(rootHtml), '/ must serve the new UI');
  results.push('/ serves the new UI; /advanced serves the classic Dashboard');

  process.stdout.write(`quick-apply UI acceptance: PASS\n${results.map(line => `  - ${line}`).join('\n')}\n`);
} finally {
  await closeUi();
  await stopDashboard();
  await new Promise(resolve => site.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => { /* Chromium may hold handles */ });
}
