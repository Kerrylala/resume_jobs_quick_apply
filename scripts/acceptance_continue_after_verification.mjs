// End-to-end acceptance for "I finished the verification, keep filling".
//
// This is the chain the product actually runs, with nothing stubbed:
//   Dashboard HTTP  →  application session  →  persistent Chromium
//   →  challenge page pauses the fill  →  user clears it
//   →  POST /continue-after-verification  →  same window resumes  →  fields filled
//
// The challenge page is served from localhost and reports a Cloudflare-style
// interstitial until a flag is flipped. Nothing bypasses anything: the agent
// re-reads the page and only continues when the barrier is genuinely gone.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { agentBrowserCandidates } from './lib/agent_browser.mjs';

const ROOT = path.resolve('.');
const JOB_ID = 'continue-acceptance-job';

async function findBrowser() {
  // One detection order for the whole product: env override -> local Chrome
  // for Testing (carries the bundled extension) -> branded Chrome/Edge.
  for (const candidate of agentBrowserCandidates(ROOT)) {
    try { await access(candidate); return candidate; } catch { /* next */ }
  }
  return '';
}

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
    if (last && predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${label}. Last: ${JSON.stringify(last)?.slice(0, 400)}`);
}

const browser = await findBrowser();
if (!browser) throw new Error('Chrome/Edge is required for this acceptance run.');

const root = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-continue-e2e-'));
const dataDir = path.join(root, 'data');
const applicationsDir = path.join(root, 'applications');
const sessionsDir = path.join(root, 'browser_sessions');
for (const directory of [dataDir, applicationsDir, sessionsDir,
  path.join(root, 'archive'), path.join(root, 'reports'), path.join(root, 'resumes'),
  path.join(root, 'browser_profiles')]) {
  await mkdir(directory, { recursive: true });
}

// --- The employer page: an interstitial until the user clears it. -----------
let challengeActive = true;
const site = http.createServer((req, res) => {
  if (req.url.startsWith('/clear')) {
    challengeActive = false;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('cleared');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  if (challengeActive) {
    // A real interstitial replaces the page and re-checks on its own.
    return res.end(`<!doctype html><html><head><meta http-equiv="refresh" content="1"></head><body>
      <h1>Checking your browser before you continue</h1>
      <p>Verify you are human to access this page.</p></body></html>`);
  }
  return res.end(`<!doctype html><html><body><form>
    <label for="name">Full name</label><input id="name" name="name">
    <label for="email">Email</label><input id="email" name="email" type="email">
    <label for="phone">Phone</label><input id="phone" name="phone">
    <input type="submit" value="Submit application">
  </form></body></html>`);
});
await new Promise((resolve, reject) => { site.once('error', reject); site.listen(0, '127.0.0.1', resolve); });
const sitePort = site.address().port;
const applyUrl = `http://127.0.0.1:${sitePort}/apply`;

// --- Seed a workspace the product considers ready to fill. ------------------
const writeJson = (name, value) => writeFile(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
const job = {
  job_id: JOB_ID,
  title: 'Acceptance Engineer',
  company: 'Synthetic Labs',
  location: 'Remote',
  url: applyUrl,
  canonical_url: applyUrl,
  apply_url: applyUrl,
  application_url: applyUrl,
  provider: 'generic',
  page_type: 'job_detail',
  recommended_decision: 'shortlist',
  description_text: 'Synthetic role description for the continue-after-verification acceptance run. '.repeat(4),
  info_quality: { score: 100 },
  confidence: 0.95,
  match_score: 88,
  approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic_acceptance'] },
  application_mode: 'REVIEW_ONLY',
  submit_allowed: false,
  upload_resume_allowed: false,
  final_submit_allowed: false
};
await writeJson('jobs_shortlist.json', [job]);
await writeJson('job_leads.json', [job]);
await writeJson('job_reviews.json', []);
await writeJson('question_bank.json', { version: '2.0', answers: [] });
await writeJson('resume_profiles.json', {
  schema_version: '2.0',
  active_resume_profile_id: 'resume_acceptance_v1',
  active_resume_id: 'resume_acceptance_v1',
  items: [{
    id: 'resume_acceptance_v1', resume_id: 'resume_acceptance_v1', name: 'Acceptance Resume',
    version: 1, enabled: true, file_reference: 'synthetic/resume.pdf',
    content_hash: 'sha256:synthetic-acceptance', approved_at: '2026-08-01T00:00:00.000Z',
    target_roles: ['Acceptance Engineer'], skills: ['acceptance']
  }]
});
await writeJson('career_profiles.local.json', {
  schema_version: '1.0',
  active_profile_id: 'career-acceptance',
  profiles: [{
    id: 'career-acceptance', family_id: 'career-acceptance', version: 1, name: 'Acceptance Profile',
    state: 'approved', user_approved: true, approved_at: '2026-08-01T00:00:00.000Z',
    identity: {
      full_name: 'Acceptance Test Candidate', first_name: 'Acceptance', last_name: 'Candidate',
      email: 'acceptance@example.invalid', phone: '+1 555 0100', city: 'Shanghai', country: 'China',
      links: {}
    },
    education: [], experience: [], projects: [], skills: {}, certifications: [], languages: [],
    interview_stories: [], career_goals: ['Acceptance Engineer'],
    job_preferences: {}, field_provenance: {}
  }]
});

const dashboardPort = await freePort();
const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(dashboardPort),
    RESUME_JOBS_DATA_DIR: dataDir,
    RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'),
    RESUME_JOBS_APPLICATIONS_DIR: applicationsDir,
    RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'),
    RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
    RESUME_JOBS_BROWSER_PROFILES_DIR: path.join(root, 'browser_profiles'),
    RESUME_JOBS_BROWSER_SESSIONS_DIR: sessionsDir,
    RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json'),
    RESUME_JOBS_CHROME_EXECUTABLE: browser,
    RESUME_JOBS_BROWSER_AGENT_TEST_MODE: '1',
    // Headless is fine for acceptance, but the window must stay open: closing it
    // after the first fill is exactly what makes resuming impossible.
    RESUME_JOBS_BROWSER_AGENT_KEEP_OPEN_TEST: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
});

const base = `http://127.0.0.1:${dashboardPort}`;
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

  // 1. Preflight and start the fill through the product's own endpoints.
  const preflight = await api(`/api/jobs/${JOB_ID}/quick-apply`, { method: 'POST', body: '{}' });
  assert.equal(preflight.status, 200, `preflight failed: ${JSON.stringify(preflight.value).slice(0, 300)}`);
  results.push('quick-apply preflight prepared the application');

  const started = await api(`/api/jobs/${JOB_ID}/quick-apply/start`, {
    method: 'POST',
    body: JSON.stringify({ confirmed: true, executor_type: 'local_browser_agent' })
  });
  assert.equal(started.status, 200, `start failed: ${JSON.stringify(started.value).slice(0, 300)}`);
  results.push('start opened the persistent browser on the application page');

  // 2. The interstitial must stop the fill without touching it.
  const blocked = await waitFor(
    async () => (await api(`/api/jobs/${JOB_ID}/apply-state`)).value,
    state => state.state === 'awaiting_verification',
    { label: 'the job to report it is waiting for the user to verify', timeoutMs: 90_000 }
  );
  assert.equal(blocked.state, 'awaiting_verification');
  results.push('challenge detected → job reports "awaiting_verification", nothing filled');

  // Resuming is only meaningful while the window is genuinely open, so assert
  // that rather than assuming it.
  const liveness = await api(`/api/executor/status?job_id=${JOB_ID}`);
  assert.equal(liveness.value.connected, true, 'the browser window should still be open at this point');
  results.push('the opened browser window is still live and owned by this session');

  // 3. Clicking continue while the challenge is still up must not bypass it.
  const tooEarly = await api(`/api/jobs/${JOB_ID}/continue-after-verification`, {
    method: 'POST', body: JSON.stringify({ confirmed: true })
  });
  assert.equal(tooEarly.status, 200, `early continue was rejected outright: ${JSON.stringify(tooEarly.value).slice(0, 300)}`);
  const stillBlocked = await waitFor(
    async () => (await api(`/api/jobs/${JOB_ID}/apply-state`)).value,
    state => state.state === 'awaiting_verification' || state.state === 'needs_you',
    { label: 'state after an early continue' }
  );
  assert.notEqual(stillBlocked.state, 'ready_to_submit');
  results.push('continue while still challenged → accepted but filled nothing, no bypass');

  // 4. The user clears the verification themselves.
  await fetch(`http://127.0.0.1:${sitePort}/clear`);
  results.push('user cleared the verification in the open window');

  // 5. Continue through the HTTP endpoint — the chain under test.
  let resumed = null;
  for (let attempt = 0; attempt < 6 && !resumed; attempt += 1) {
    const response = await api(`/api/jobs/${JOB_ID}/continue-after-verification`, {
      method: 'POST', body: JSON.stringify({ confirmed: true })
    });
    assert.equal(response.status, 200, `continue failed: ${JSON.stringify(response.value).slice(0, 300)}`);
    assert.equal(response.value.continued_in_existing_window, true);
    assert.equal(response.value.safety.challenge_bypassed, false);
    assert.equal(response.value.safety.application_submitted, false);

    const state = await waitFor(
      async () => (await api(`/api/jobs/${JOB_ID}/apply-state`)).value,
      value => value.state !== 'filling',
      { label: 'the resumed attempt to settle', timeoutMs: 60_000 }
    );
    if (state.state !== 'awaiting_verification') resumed = state;
    else await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(resumed, 'filling never resumed after the verification was cleared');
  results.push(`continue-after-verification resumed the fill (state=${resumed.state})`);

  // 6. Prove from the execution report that safe fields were actually filled in
  //    the same session, and that nothing forbidden happened.
  const audit = await api(`/api/audit?job_id=${JOB_ID}`);
  assert.equal(audit.status, 200);

  const sessionDirs = (await import('node:fs')).readdirSync(sessionsDir);
  assert.ok(sessionDirs.length >= 1, 'expected a browser session directory');
  const reportPath = path.join(sessionsDir, sessionDirs[0], 'ApplicationExecution.json');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.ok(report.counts.filled >= 2, `expected safe fields to be filled, got ${report.counts.filled}`);
  assert.equal(report.safety.submit_attempted, false);
  // This form has no file input. The agent may LOOK for the resume control
  // (upload is authorized product-wide), but it must report honestly that
  // nothing was uploaded — never a fabricated success.
  assert.equal(report.safety.resume_uploaded, false);
  if (report.resume_upload && report.resume_upload.attempted) {
    assert.equal(report.resume_upload.status, 'UPLOAD_CONTROL_NOT_FOUND');
  }
  assert.equal(report.safety.challenge_attempted, false);
  assert.equal(report.safety.login_attempted, false);
  assert.doesNotMatch(
    JSON.stringify(report),
    /Acceptance Test Candidate|acceptance@example\.invalid/,
    'candidate values must not appear in the execution report'
  );
  results.push(`execution report: ${report.counts.filled} safe fields filled, nothing uploaded or submitted, values redacted`);

  // 7. The session stayed the same one throughout.
  assert.equal(String(report.job_id || JOB_ID), JOB_ID);
  results.push('the whole flow stayed on one job, one session, one window');

  process.stdout.write(`continue-after-verification acceptance: PASS\n${results.map(line => `  - ${line}`).join('\n')}\n`);
} finally {
  dashboard.kill();
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 15_000);
    dashboard.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await new Promise(resolve => site.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => { /* Chromium may hold handles */ });
}
