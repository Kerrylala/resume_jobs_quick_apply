// Installed-mode extension acceptance.
//
// The extension is REALLY installed (--load-extension into a Chrome for
// Testing persistent profile — branded Chrome 137+ ignores the flag) and
// everything runs through its own machinery: the MV3 service worker, the
// auto-injected content script, the loopback handoff, the shared executor
// core, and the fill report POSTed back by the extension itself. Nothing is
// evaluated into the page by the test except assertions.
//
// Phase A (localhost): full product chain on a mock application page with
//   text/select/radio/checkbox/file/sensitive/unknown fields, a challenge
//   variant, and continue-after-verification driven through real
//   chrome.tabs messaging from the service worker.
// Phase B (real sites, fill-only): public Lever + Greenhouse pages. Safe
//   fields are filled by the installed extension; nothing is uploaded by it,
//   nothing is submitted, no challenge is touched.
//
// Requires the local agent browser runtime: npm run browser:install-agent-runtime
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

import { detectChromeForTesting } from './lib/agent_browser.mjs';

const ROOT = path.resolve('.');
// The extension's service worker talks to the fixed loopback origin, so this
// acceptance runs the dashboard on the product port.
const PORT = 8767;
// --local-only skips the real Lever/Greenhouse phase (used by the browser E2E
// suite, which must not open real websites). --result-json <path> writes a
// machine-readable outcome for that suite.
const LOCAL_ONLY = process.argv.includes('--local-only');
const resultJsonIndex = process.argv.indexOf('--result-json');
const RESULT_JSON_PATH = resultJsonIndex >= 0 && process.argv[resultJsonIndex + 1]
  ? path.resolve(process.argv[resultJsonIndex + 1])
  : '';

const runtimeChrome = detectChromeForTesting(ROOT);
if (!runtimeChrome) {
  throw new Error('Chrome for Testing is required (branded Chrome cannot load unpacked extensions). Run: npm run browser:install-agent-runtime');
}

async function waitFor(read, predicate, { timeoutMs = 90_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read().catch(() => null);
    if (last && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)?.slice(0, 400)}`);
}

// --- Workspace --------------------------------------------------------------

const root = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-ext-installed-'));
const dataDir = path.join(root, 'data');
for (const directory of ['data', 'archive', 'reports', 'applications', 'resumes', 'documents', 'browser_sessions', 'browser_profiles']) {
  await mkdir(path.join(root, directory), { recursive: true });
}
const writeJson = (name, value) => writeFile(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);

// --- Local mock application pages ------------------------------------------

let challengeActive = true;
const mockPage = () => `<!doctype html><html><body><form>
  <label for="name">Full name</label><input id="name" name="name">
  <label for="email">Email</label><input id="email" name="email" type="email">
  <label for="phone">Phone</label><input id="phone" name="phone">
  <label for="workmode">Preferred work arrangement</label>
  <select id="workmode" name="preferred_work_arrangement">
    <option value="">Choose…</option>
    <option value="remote">Remote</option>
    <option value="onsite">Onsite</option>
  </select>
  <fieldset><legend>How did you initially hear about this job?</legend>
    <label><input type="radio" name="hear_about" value="job_board">Job board</label>
    <label><input type="radio" name="hear_about" value="company_website">Company website</label>
  </fieldset>
  <label><input type="checkbox" id="updates" name="updates_opt_in">Send me updates about this application</label>
  <label for="essay">Why do you want this specific role at our company?</label>
  <textarea id="essay" name="essay"></textarea>
  <label for="gender">Gender</label><input id="gender" name="gender">
  <label for="resume">Resume/CV</label><input id="resume" name="resume" type="file">
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
  return res.end(mockPage());
});
await new Promise((resolve, reject) => { site.once('error', reject); site.listen(0, '127.0.0.1', resolve); });
const sitePort = site.address().port;
const plainUrl = `http://127.0.0.1:${sitePort}/apply`;
const challengeUrl = `http://127.0.0.1:${sitePort}/challenge/apply`;

// --- Jobs (localhost + real public pages) -----------------------------------

const REAL_LEVER_URL = process.env.RESUME_JOBS_ACCEPTANCE_LEVER_URL
  || 'https://jobs.lever.co/alloy/6f359313-0233-47c9-a030-ef57b3bc3a68/apply';
const REAL_GREENHOUSE_URL = process.env.RESUME_JOBS_ACCEPTANCE_GREENHOUSE_URL
  || 'https://job-boards.greenhouse.io/greenhouse/jobs/8021661?gh_jid=8021661';

const jobDef = (id, url, title, company) => ({
  job_id: id, title, company, location: 'Remote',
  url, canonical_url: url, apply_url: url, application_url: url,
  provider: 'generic', page_type: 'job_detail', recommended_decision: 'shortlist',
  description_text: `Synthetic ${title} description for the installed-extension acceptance run. `.repeat(4),
  info_quality: { score: 100 }, confidence: 0.95, match_score: 88,
  approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic_acceptance'] },
  application_mode: 'REVIEW_ONLY',
  submit_allowed: false, upload_resume_allowed: false, final_submit_allowed: false
});
const jobs = [
  jobDef('job_ext_local', plainUrl, 'Bridge Engineer', 'Local Mock Corp'),
  jobDef('job_ext_challenge', challengeUrl, 'Challenge Engineer', 'Challenge Mock Corp'),
  jobDef('job_ext_lever', REAL_LEVER_URL, 'Lever Role', 'Lever Live'),
  jobDef('job_ext_greenhouse', REAL_GREENHOUSE_URL, 'Greenhouse Role', 'Greenhouse Live'),
];
await writeJson('jobs_shortlist.json', jobs);
await writeJson('job_leads.json', jobs);
await writeJson('job_reviews.json', []);
await writeJson('question_bank.json', { version: '2.0', answers: [] });
await writeJson('resume_profiles.json', {
  schema_version: '2.0',
  active_resume_profile_id: 'resume_ext_v1', active_resume_id: 'resume_ext_v1',
  items: [{
    id: 'resume_ext_v1', resume_id: 'resume_ext_v1', name: 'Extension Resume', version: 1,
    enabled: true, file_reference: 'synthetic/resume.pdf', content_hash: 'sha256:synthetic-ext',
    approved_at: '2026-08-01T00:00:00.000Z', target_roles: ['Bridge Engineer'], skills: ['bridges']
  }]
});
await writeJson('career_profiles.local.json', {
  schema_version: '1.0',
  active_profile_id: 'career-ext',
  profiles: [{
    id: 'career-ext', family_id: 'career-ext', version: 1, name: 'Extension Profile',
    state: 'approved', user_approved: true, approved_at: '2026-08-01T00:00:00.000Z',
    identity: {
      full_name: 'Acceptance Test Candidate', first_name: 'Acceptance', last_name: 'Candidate',
      email: 'acceptance-test@example.invalid', phone: '+1 555 0100', city: 'Shanghai', country: 'China',
      links: { linkedin: 'https://www.linkedin.com/in/example-invalid' }
    },
    education: [], experience: [{
      company: 'Acceptance Test Company', role: 'Acceptance Test Engineer',
      achievements: ['Synthetic acceptance bullet'], technologies: []
    }],
    projects: [], skills: {}, certifications: [], languages: [],
    interview_stories: [], career_goals: ['Bridge Engineer'],
    job_preferences: {}, field_provenance: {}
  }]
});

// --- Dashboard on the product port ------------------------------------------

const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
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
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});
const base = `http://127.0.0.1:${PORT}`;
const api = async (url, options = {}) => {
  const response = await fetch(base + url, { headers: { 'content-type': 'application/json' }, ...options });
  return { status: response.status, value: await response.json().catch(() => ({})) };
};
const dashboardState = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'dashboard_state.json'), 'utf8'));

// --- Installed-extension browser --------------------------------------------

const extensionDir = path.resolve(ROOT, 'extensions', 'application_assistant');
const profileDir = path.join(root, 'browser_profiles', 'ext-installed');
let browserContext = null;
let serviceWorker = null;

// Real user actions arrive through the extension's own machinery: the service
// worker sends chrome.tabs messages, exactly like the popup does.
async function sendToActiveTab(message) {
  return serviceWorker.evaluate(async payload => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return { status: 'error', message: 'no active tab' };
    return new Promise(resolve => {
      chrome.tabs.sendMessage(tabs[0].id, payload, response => {
        if (chrome.runtime.lastError) resolve({ status: 'error', message: chrome.runtime.lastError.message });
        else resolve(response || null);
      });
    });
  }, message);
}

async function startFill(jobId, { idempotencyKey = '', confirmedAnswers = null } = {}) {
  const preflight = await api(`/api/jobs/${jobId}/quick-apply`, { method: 'POST', body: '{}' });
  assert.equal(preflight.status, 200, `${jobId} preflight: ${JSON.stringify(preflight.value).slice(0, 300)}`);
  const selection = await api('/api/workflow/selection', { method: 'POST', body: JSON.stringify({ job_ids: [jobId] }) });
  assert.equal(selection.status, 200, JSON.stringify(selection.value).slice(0, 200));
  const started = await api(`/api/jobs/${jobId}/quick-apply/start`, {
    method: 'POST',
    body: JSON.stringify({
      confirmed: true, executor_type: 'extension',
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      ...(confirmedAnswers ? { confirmed_answers: confirmedAnswers } : {})
    })
  });
  assert.equal(started.status, 200, `${jobId} start: ${JSON.stringify(started.value).slice(0, 300)}`);
  // Extension sessions never gain upload permission.
  assert.equal(started.value.application_execution_session.safety.resume_upload_allowed, false);
  return started.value.application_execution_session;
}

async function latestReportFor(jobId, predicate = () => true, label = 'fill report') {
  return waitFor(
    () => Promise.resolve(dashboardState().application_status_overrides[jobId]?.latest_fill_report || null),
    report => Boolean(report) && predicate(report),
    { label: `${jobId} ${label}` }
  );
}

const results = [];
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard did not start (is port 8767 free?).')), 15000);
    dashboard.stdout.on('data', chunk => {
      if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
    });
    dashboard.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}.`)); });
  });

  browserContext = await chromium.launchPersistentContext(profileDir, {
    executablePath: runtimeChrome,
    headless: true,
    acceptDownloads: false,
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--no-default-browser-check', '--noerrdialogs'
    ],
  });
  serviceWorker = browserContext.serviceWorkers().find(worker => worker.url().startsWith('chrome-extension://'))
    || await browserContext.waitForEvent('serviceworker', { timeout: 15_000 });
  assert.ok(serviceWorker.url().startsWith('chrome-extension://'), 'the extension service worker must be running');
  results.push(`extension REALLY installed: service worker ${serviceWorker.url().split('/')[2]}`);

  const page = browserContext.pages()[0] || await browserContext.newPage();

  // ---- Phase A1: localhost page, full field-type coverage -------------------
  // The confirmed answers that power the choice controls ride along with the
  // one and only start call, the product way.
  await startFill('job_ext_local', {
    confirmedAnswers: [
      {
        question_id: 'q_work_arrangement', canonical_key: 'answer_preferred_work_arrangement',
        original_question: 'Preferred work arrangement', answer: 'Remote',
        question_patterns: ['preferred work arrangement'],
        source: 'user_confirmed', user_confirmed: true, sensitive_category: 'none', risk_level: 'normal'
      },
      {
        question_id: 'q_hear_about', canonical_key: 'answer_how_did_you_hear',
        original_question: 'How did you initially hear about this job?', answer: 'Company website',
        question_patterns: ['how did you initially hear', 'how did you hear about'],
        source: 'user_confirmed', user_confirmed: true, sensitive_category: 'none', risk_level: 'normal'
      },
      {
        question_id: 'q_updates', canonical_key: 'answer_updates_opt_in',
        original_question: 'Send me updates about this application', answer: 'Yes',
        question_patterns: ['send me updates about this application', 'updates opt in'],
        source: 'user_confirmed', user_confirmed: true, sensitive_category: 'none', risk_level: 'normal'
      }
    ]
  });

  await page.goto(plainUrl, { waitUntil: 'domcontentloaded' });
  // The installed extension connects and fills on its own (page_load run).
  const localReport = await latestReportFor('job_ext_local', report => report.filled_fields_count > 0);
  assert.equal(localReport.application_submitted, false);
  assert.equal(localReport.final_submit_clicked, false);
  assert.equal(localReport.resume_upload_attempted, false, 'the extension must never claim an upload');

  // Verify against the actual DOM, not the report.
  const domState = await page.evaluate(() => ({
    name: document.getElementById('name').value,
    email: document.getElementById('email').value,
    phone: document.getElementById('phone').value,
    workmode: document.getElementById('workmode').value,
    hear_about: document.querySelector('input[name="hear_about"]:checked')?.value || '',
    updates: document.getElementById('updates').checked,
    essay: document.getElementById('essay').value,
    gender: document.getElementById('gender').value,
    resume_files: document.getElementById('resume').files.length,
  }));
  assert.equal(domState.name, 'Acceptance Test Candidate');
  assert.equal(domState.email, 'acceptance-test@example.invalid');
  assert.equal(domState.workmode, 'remote', 'the select must hold the confirmed option');
  assert.equal(domState.hear_about, 'company_website', 'the radio must hold the confirmed option');
  assert.equal(domState.updates, true, 'the checkbox must be ticked from the affirmative confirmed answer');
  assert.equal(domState.essay, '', 'the subjective unknown question must stay untouched');
  assert.equal(domState.gender, '', 'the sensitive field must stay untouched');
  assert.equal(domState.resume_files, 0, 'the extension must never touch a file input');
  results.push(`localhost: installed extension filled text+select+radio+checkbox (verified in DOM), skipped sensitive/unknown/file, ${localReport.filled_fields_count} filled`);

  // ---- Phase A2: challenge pause → user verifies → Continue -----------------
  const challengeSession = await startFill('job_ext_challenge');
  await page.goto(challengeUrl, { waitUntil: 'domcontentloaded' });
  const blockedReport = await latestReportFor('job_ext_challenge', report => true, 'blocked report');
  assert.equal(blockedReport.blocked_page_state, true, JSON.stringify(blockedReport).slice(0, 200));
  assert.equal(blockedReport.filled_fields_count, 0, 'nothing may fill while the challenge is up');
  const awaiting = await api('/api/jobs/job_ext_challenge/apply-state');
  assert.equal(awaiting.value.state, 'awaiting_verification');
  results.push('challenge page: installed extension filled nothing, product reports awaiting_verification');

  await fetch(`http://127.0.0.1:${sitePort}/clear`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  // The user finishes verification and chooses Continue — the popup's message,
  // sent through the extension's own service worker to the same tab.
  const continued = await sendToActiveTab({ type: 'CONTINUE_AFTER_VERIFICATION' });
  assert.equal(continued?.status, 'filled', JSON.stringify(continued).slice(0, 300));
  const resumedReport = await latestReportFor('job_ext_challenge', report => report.filled_fields_count > 0, 'resumed report');
  assert.equal(resumedReport.application_submitted, false);
  results.push(`challenge cleared: Continue filled ${resumedReport.filled_fields_count} fields in the same tab, same browser, same profile`);

  // ---- Phase A3: popup renders the minimal vocabulary -----------------------
  const popupPage = await browserContext.newPage();
  await popupPage.goto(`${serviceWorker.url().split('/').slice(0, 3).join('/')}/popup.html`);
  const popupText = await popupPage.evaluate(() => document.body.innerText);
  // The Assistant popup speaks the minimal 8-word vocabulary (正在连接 /
  // 正在扫描 / 正在填写 / 发现新问题 / 需要你处理 N 项 / 等待登录、验证码 /
  // 准备提交 / 已完成); statically it must at least announce itself and its
  // connecting word — and never leak internal vocabulary.
  for (const expected of ['申请助手', '正在连接']) {
    assert.ok(popupText.includes(expected), `popup must show "${expected}"`);
  }
  for (const forbidden of ['Package', 'Session', 'Executor', 'handoff', 'EXECUTOR', 'NEEDS_REVIEW']) {
    assert.ok(!popupText.includes(forbidden), `popup must not show "${forbidden}"`);
  }
  await popupPage.close();
  results.push('popup: 申请助手 minimal vocabulary — no internal vocabulary');

  // ---- Phase B: real public pages, fill-only --------------------------------
  for (const [jobId, label] of LOCAL_ONLY ? [] : [['job_ext_lever', 'Lever'], ['job_ext_greenhouse', 'Greenhouse']]) {
    await startFill(jobId);
    await page.goto(jobs.find(job => job.job_id === jobId).apply_url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const report = await latestReportFor(jobId, item => item.total_fields_seen > 0, `${label} report`);
    assert.ok(report.filled_fields_count >= 3, `${label}: expected real fields filled, got ${report.filled_fields_count}`);
    assert.equal(report.application_submitted, false);
    assert.equal(report.final_submit_clicked, false);
    assert.equal(report.resume_upload_attempted, false);
    results.push(`${label} (real page): installed extension filled ${report.filled_fields_count}/${report.total_fields_seen} fields, nothing submitted, nothing uploaded`);
  }

  // ---- Cross-job isolation: each report is bound to its own session ---------
  const coveredJobs = LOCAL_ONLY
    ? ['job_ext_local', 'job_ext_challenge']
    : ['job_ext_local', 'job_ext_challenge', 'job_ext_lever', 'job_ext_greenhouse'];
  const state = dashboardState();
  const boundSessions = coveredJobs
    .map(jobId => state.application_status_overrides[jobId]?.active_session_id).filter(Boolean);
  assert.equal(new Set(boundSessions).size, coveredJobs.length, 'every job must have its own distinct fill attempt');
  for (const jobId of coveredJobs) {
    const sessionId = state.application_status_overrides[jobId].active_session_id;
    const session = state.application_execution_sessions[sessionId];
    assert.equal(String(session.job_id), jobId, 'a fill attempt must belong to its own job');
  }
  results.push(`cross-job isolation: ${coveredJobs.length} jobs → ${coveredJobs.length} distinct attempts, each bound to its own job`);

  if (RESULT_JSON_PATH) {
    await mkdir(path.dirname(RESULT_JSON_PATH), { recursive: true });
    await writeFile(RESULT_JSON_PATH, `${JSON.stringify({
      success: true,
      environment: { temporary_chrome_profile: true, extension_really_installed: true, runtime: 'chrome_for_testing' },
      safety: {
        only_localhost_urls_used: LOCAL_ONLY,
        real_websites_opened: !LOCAL_ONLY,
        submit_clicked: false,
        file_uploaded_by_extension: false,
        challenge_bypassed: false
      },
      workflow: {
        unknown_question_paused: true,
        sensitive_question_paused: true,
        challenge_paused: true,
        continue_after_verification_filled: true
      },
      local_form: {
        filled_fields_count: Number(localReport.filled_fields_count || 0),
        total_fields_seen: Number(localReport.total_fields_seen || 0)
      },
      results
    }, null, 2)}\n`);
  }

  process.stdout.write(`installed-extension acceptance: PASS\n${results.map(line => `  - ${line}`).join('\n')}\n`);
} finally {
  if (browserContext) await browserContext.close().catch(() => { /* window already gone */ });
  dashboard.kill();
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 15_000);
    dashboard.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await new Promise(resolve => site.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => { /* Chromium may hold handles */ });
}
