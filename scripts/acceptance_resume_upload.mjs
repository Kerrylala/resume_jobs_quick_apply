// Real-browser acceptance for automatic tailored-resume upload.
//
// The whole product chain runs with nothing stubbed: Dashboard HTTP →
// execution session with a per-job upload authorization → persistent Chromium
// → the agent locates the resume control, attaches the exported file, and
// verifies the input actually holds it. Local pages model the upload shapes
// found on real ATS forms:
//
//   job_visible   – plain visible <input type=file> labeled Resume/CV
//   job_hidden    – hidden input behind an "Attach resume" button (Lever-style)
//   job_dropzone  – drag-and-drop zone wrapping a hidden input, accept=.pdf
//   job_coverless – only a Cover Letter file input → must refuse, not misfile
//   job_both      – resume AND cover letter inputs → only resume receives a file
//   job_challenge – interstitial first; upload happens after the user verifies
//
// Cross-job isolation: every uploaded file must be the target job's own draft.
// Final Submit is never touched anywhere in this run.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { agentBrowserCandidates } from './lib/agent_browser.mjs';

const ROOT = path.resolve('.');

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

const browser = await findBrowser();
if (!browser) throw new Error('Chrome/Edge is required for this acceptance run.');

const root = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-upload-e2e-'));
const dataDir = path.join(root, 'data');
const sessionsDir = path.join(root, 'browser_sessions');
for (const directory of [dataDir, sessionsDir,
  path.join(root, 'archive'), path.join(root, 'reports'), path.join(root, 'resumes'),
  path.join(root, 'applications'), path.join(root, 'documents'), path.join(root, 'browser_profiles')]) {
  await mkdir(directory, { recursive: true });
}

// --- The employer pages ------------------------------------------------------
const baseFields = `
  <label for="name">Full name</label><input id="name" name="name">
  <label for="email">Email</label><input id="email" name="email" type="email">`;
const showName = `<script>
  document.addEventListener('change', event => {
    if (event.target.type === 'file' && event.target.files.length) {
      document.getElementById('picked').textContent = event.target.files[0].name;
    }
  });
</script><div id="picked"></div>`;
let challengeActive = true;
const pages = {
  '/visible/apply': () => `<!doctype html><html><body><form>${baseFields}
    <label for="resume">Resume/CV</label>
    <input id="resume" name="resume" type="file" accept=".pdf,.doc,.docx,.txt,.rtf">
    <input type="submit" value="Submit application"></form>${showName}</body></html>`,
  '/hidden/apply': () => `<!doctype html><html><body><form>${baseFields}
    <div class="upload-widget">
      <button type="button" onclick="document.getElementById('resume-upload-input').click()">ATTACH RESUME/CV</button>
      <input id="resume-upload-input" name="resume" type="file" style="display:none" accept=".pdf,.docx">
    </div>
    <input type="submit" value="Submit application"></form>${showName}</body></html>`,
  '/dropzone/apply': () => `<!doctype html><html><body><form>${baseFields}
    <div class="dropzone" style="border:2px dashed #888;padding:24px">
      <p>Drag and drop your resume here, or click to browse</p>
      <input type="file" accept=".pdf" style="opacity:0;position:absolute;width:1px;height:1px">
    </div>
    <input type="submit" value="Submit application"></form>${showName}</body></html>`,
  '/coverless/apply': () => `<!doctype html><html><body><form>${baseFields}
    <label for="cover">Cover letter</label>
    <input id="cover" name="cover_letter" type="file" accept=".pdf,.docx">
    <input type="submit" value="Submit application"></form>${showName}</body></html>`,
  '/both/apply': () => `<!doctype html><html><body><form>${baseFields}
    <label for="resume">Resume/CV</label>
    <input id="resume" name="resume" type="file" accept=".pdf,.docx">
    <label for="cover">Cover letter</label>
    <input id="cover" name="cover_letter" type="file" accept=".pdf,.docx">
    <input type="submit" value="Submit application"></form>${showName}</body></html>`,
  '/challenge/apply': () => challengeActive
    ? `<!doctype html><html><head><meta http-equiv="refresh" content="1"></head><body>
        <h1>Checking your browser before you continue</h1>
        <p>Verify you are human to access this page.</p></body></html>`
    : `<!doctype html><html><body><form>${baseFields}
        <label for="resume">Resume/CV</label>
        <input id="resume" name="resume" type="file" accept=".pdf,.docx">
        <input type="submit" value="Submit application"></form>${showName}</body></html>`,
};
const site = http.createServer((req, res) => {
  if (req.url.startsWith('/clear')) {
    challengeActive = false;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('cleared');
  }
  const page = pages[req.url.split('?')[0]];
  if (!page) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page());
});
await new Promise((resolve, reject) => { site.once('error', reject); site.listen(0, '127.0.0.1', resolve); });
const sitePort = site.address().port;
const pageUrl = slug => `http://127.0.0.1:${sitePort}/${slug}/apply`;

// --- Seed the workspace ------------------------------------------------------
const jobDef = (id, slug, title) => ({
  job_id: id, title, company: `${title} Corp`, location: 'Remote',
  url: pageUrl(slug), canonical_url: pageUrl(slug), apply_url: pageUrl(slug), application_url: pageUrl(slug),
  provider: 'generic', page_type: 'job_detail', recommended_decision: 'shortlist',
  description_text: `Synthetic ${title} role description for the upload acceptance run. `.repeat(4),
  info_quality: { score: 100 }, confidence: 0.95, match_score: 88,
  approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic_acceptance'] },
  application_mode: 'REVIEW_ONLY',
  submit_allowed: false, upload_resume_allowed: false, final_submit_allowed: false
});
const jobs = [
  jobDef('job_visible', 'visible', 'Data Scientist'),
  jobDef('job_hidden', 'hidden', 'Data Engineer'),
  jobDef('job_dropzone', 'dropzone', 'ML Engineer'),
  jobDef('job_coverless', 'coverless', 'Analytics Engineer'),
  jobDef('job_both', 'both', 'Research Engineer'),
  jobDef('job_challenge', 'challenge', 'Platform Engineer'),
];
const writeJson = (name, value) => writeFile(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
await writeJson('jobs_shortlist.json', jobs);
await writeJson('job_leads.json', jobs);
await writeJson('job_reviews.json', []);
await writeJson('question_bank.json', { version: '2.0', answers: [] });
await writeJson('resume_profiles.json', {
  schema_version: '2.0',
  active_resume_profile_id: 'resume_upload_v1',
  active_resume_id: 'resume_upload_v1',
  items: [{
    id: 'resume_upload_v1', resume_id: 'resume_upload_v1', name: 'Upload Resume',
    version: 1, enabled: true, file_reference: 'synthetic/resume.pdf',
    content_hash: 'sha256:synthetic-upload', approved_at: '2026-08-01T00:00:00.000Z',
    target_roles: ['Data Scientist'], skills: ['python']
  }]
});
await writeJson('career_profiles.local.json', {
  schema_version: '1.0',
  active_profile_id: 'career-upload',
  profiles: [{
    id: 'career-upload', family_id: 'career-upload', version: 1, name: 'Upload Profile',
    state: 'approved', user_approved: true, approved_at: '2026-08-01T00:00:00.000Z',
    identity: {
      full_name: 'Acceptance Test Candidate', first_name: 'Acceptance', last_name: 'Candidate',
      email: 'acceptance@example.invalid', phone: '+1 555 0100', city: 'Shanghai', country: 'China',
      links: {}
    },
    education: [{ institution: 'Synthetic University', degree: 'MSc', field_of_study: 'Statistics' }],
    experience: [{
      company: 'Synthetic ML Lab', role: 'ML Engineer', dates: '2023 – now',
      achievements: [
        'Built a causal inference platform in Python serving 40 experiments per quarter',
        'Reduced query latency by 18% with SQL optimization'
      ],
      technologies: ['Python', 'SQL']
    }],
    projects: [], skills: { programming: ['Python', 'SQL'] }, certifications: [], languages: [],
    interview_stories: [], career_goals: ['Data Scientist'],
    job_preferences: {}, field_provenance: {}
  }]
});

function dashboardEnv(port, keepOpen) {
  return {
    ...process.env,
    PORT: String(port),
    RESUME_JOBS_DATA_DIR: dataDir,
    RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'),
    RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
    RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'),
    RESUME_JOBS_DOCUMENTS_DIR: path.join(root, 'documents'),
    RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
    RESUME_JOBS_BROWSER_PROFILES_DIR: path.join(root, 'browser_profiles'),
    RESUME_JOBS_BROWSER_SESSIONS_DIR: sessionsDir,
    RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json'),
    RESUME_JOBS_CHROME_EXECUTABLE: browser,
    RESUME_JOBS_BROWSER_AGENT_TEST_MODE: '1',
    ...(keepOpen ? { RESUME_JOBS_BROWSER_AGENT_KEEP_OPEN_TEST: '1' } : {})
  };
}

async function startDashboard(keepOpen) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT, env: dashboardEnv(port, keepOpen),
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 15000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}.`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const api = async (url, options = {}) => {
    const response = await fetch(base + url, { headers: { 'content-type': 'application/json' }, ...options });
    return { status: response.status, value: await response.json().catch(() => ({})) };
  };
  const stop = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 15_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
  return { api, stop };
}

async function readSessionReport(sessionId) {
  const reportPath = path.join(sessionsDir, sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_'), 'ApplicationExecution.json');
  return JSON.parse(await readFile(reportPath, 'utf8'));
}

// Starts a fill for one job, waits for the attempt to settle, returns
// { started, report } — the report read back from the agent's own output file.
async function runJob(api, jobId, { expectAuthorized = true, preflight = true, idempotencyKey = '' } = {}) {
  if (preflight) {
    const preflightResult = await api(`/api/jobs/${jobId}/quick-apply`, { method: 'POST', body: '{}' });
    assert.equal(preflightResult.status, 200, `${jobId} preflight: ${JSON.stringify(preflightResult.value).slice(0, 300)}`);
  }
  // The previous job's window closes after its fill; wait for that process to
  // actually exit rather than failing on "another agent is active".
  let started = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    started = await api(`/api/jobs/${jobId}/quick-apply/start`, {
      method: 'POST',
      body: JSON.stringify({
        confirmed: true, executor_type: 'local_browser_agent',
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {})
      })
    });
    if (!(started.status === 409 && String(started.value?.message || '').includes('Another Local Browser Agent is active'))) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(started.status, 200, `${jobId} start: ${JSON.stringify(started.value).slice(0, 300)}`);
  assert.equal(started.value.safety.resume_upload_authorized, expectAuthorized,
    `${jobId}: upload authorization expectation`);
  const sessionId = started.value.application_execution_session.session_id;
  await waitFor(
    async () => (await api(`/api/jobs/${jobId}/apply-state`)).value,
    state => !['preparing', 'filling'].includes(state.state),
    { label: `${jobId} attempt to settle` }
  );
  // The report file is written by the agent before the status flips; give the
  // file system a moment on slow machines.
  const report = await waitFor(
    () => readSessionReport(sessionId),
    value => Boolean(value && value.counts),
    { label: `${jobId} execution report`, timeoutMs: 30_000 }
  );
  return { started, sessionId, report };
}

const results = [];
const site2 = null;
let dashboard = null;
try {
  // ---------------------------------------------------------------------------
  // Phase 1 (window closes after each fill): upload shapes, format policy,
  // wrong-control refusal, stale regeneration, cross-job isolation.
  // ---------------------------------------------------------------------------
  dashboard = await startDashboard(false);
  const { api } = dashboard;

  // 1. Visible input.
  const visible = await runJob(api, 'job_visible');
  // When the agent runs on a build that can carry the bundled extension
  // (Chrome for Testing), the status must prove the extension really loaded.
  const visibleStatus = JSON.parse(await readFile(
    path.join(sessionsDir, visible.sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_'), 'status.json'), 'utf8'
  ));
  if (browser.toLowerCase().includes('browser_runtime')) {
    assert.equal(visibleStatus.extension_loaded, true, 'the agent browser must really carry the extension');
    results.push('agent browser (Chrome for Testing): bundled extension REALLY loaded (service worker verified)');
  } else {
    results.push(`agent browser: branded build, extension not loadable (extension_loaded=${visibleStatus.extension_loaded === true})`);
  }
  assert.equal(visible.report.resume_upload.status, 'confirmed', JSON.stringify(visible.report.resume_upload).slice(0, 300));
  assert.equal(visible.report.resume_upload.evidence.input_holds_file, true, 'the input must really hold the file');
  assert.equal(visible.report.safety.resume_uploaded, true);
  assert.equal(visible.report.safety.submit_attempted, false);
  results.push(`visible file input: uploaded ${visible.report.resume_upload.file.name} (${visible.report.resume_upload.file.format}), input verified`);

  // 2. Hidden input behind a button (Lever-style). Also proves format
  //    preference is honoured: switch the policy to DOCX first.
  const prefs = await api('/api/settings');
  const currentPrefs = prefs.value.search_preferences;
  const savePrefs = async safetyPatch => {
    const saved = await api('/api/settings/search-preferences', {
      method: 'POST',
      body: JSON.stringify({ ...currentPrefs, safety: { ...currentPrefs.safety, ...safetyPatch } })
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.value).slice(0, 300));
  };
  await savePrefs({ resume_format_preference: 'docx' });
  const hidden = await runJob(api, 'job_hidden');
  assert.equal(hidden.report.resume_upload.status, 'confirmed', JSON.stringify(hidden.report.resume_upload).slice(0, 300));
  assert.equal(hidden.report.resume_upload.file.format, 'docx', 'DOCX preference must be honoured');
  assert.equal(hidden.report.resume_upload.evidence.input_holds_file, true);
  results.push(`hidden input + attach button: uploaded as DOCX per configured preference, input verified`);
  await savePrefs({ resume_format_preference: 'auto' });

  // 3. Drop zone with accept=.pdf → auto policy picks the PDF.
  const dropzone = await runJob(api, 'job_dropzone');
  assert.equal(dropzone.report.resume_upload.status, 'confirmed', JSON.stringify(dropzone.report.resume_upload).slice(0, 300));
  assert.equal(dropzone.report.resume_upload.file.format, 'pdf', 'accept=.pdf must force the PDF');
  results.push('drag-and-drop zone (hidden input, accept=.pdf): PDF chosen by accept list, upload verified');

  // 4. A page with ONLY a cover-letter input must refuse — never misfile.
  const coverless = await runJob(api, 'job_coverless');
  assert.equal(coverless.report.resume_upload.status, 'UPLOAD_CONTROL_NOT_FOUND',
    JSON.stringify(coverless.report.resume_upload).slice(0, 300));
  assert.equal(coverless.report.safety.resume_uploaded, false);
  results.push('cover-letter-only page: refused with UPLOAD_CONTROL_NOT_FOUND, nothing misfiled');

  // 5. Resume + cover-letter inputs side by side → the resume control wins.
  const both = await runJob(api, 'job_both');
  assert.equal(both.report.resume_upload.status, 'confirmed', JSON.stringify(both.report.resume_upload).slice(0, 300));
  assert.equal(both.report.resume_upload.control.name, 'resume', 'the resume input must be the one chosen');
  results.push('resume + cover-letter inputs: only the resume control received the file');

  // 6. Cross-job isolation: every uploaded file is the job's own draft.
  const uploadedNames = new Map([
    ['job_visible', visible.report.resume_upload.file.name],
    ['job_hidden', hidden.report.resume_upload.file.name],
    ['job_dropzone', dropzone.report.resume_upload.file.name],
    ['job_both', both.report.resume_upload.file.name],
  ]);
  for (const [jobId, fileName] of uploadedNames) {
    const state = await api(`/api/jobs/${jobId}/apply-state`);
    const expected = state.value.tailored_resume.file_name.replace(/\.docx$/, '');
    assert.ok(fileName.startsWith(expected),
      `${jobId} uploaded "${fileName}" but its own tailored file is "${state.value.tailored_resume.file_name}"`);
  }
  assert.equal(new Set(uploadedNames.values()).size, uploadedNames.size, 'four jobs must upload four distinct files');
  results.push('cross-job isolation: 4 jobs uploaded 4 distinct files, each bound to its own job');

  // 7. Staleness: edit + re-approve the profile, then re-run a job. The server
  //    must regenerate and upload the NEW draft, never the stale file.
  const beforeStale = (await api('/api/jobs/job_visible/apply-state')).value.tailored_resume.file_name;
  const edited = await api('/api/application-profile', {
    method: 'PUT',
    body: JSON.stringify({
      patch: { skills: { ai_tools: ['PyTorch'] } },
      approve: true, confirmed: true
    })
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.value).slice(0, 300));
  const staleState = (await api('/api/jobs/job_visible/apply-state')).value;
  assert.equal(staleState.tailored_resume.stale_profile, true, 'the old export must be marked stale');
  // The retry of an already-filled job: no preflight rebuild, a fresh
  // idempotency key, the same product start endpoint.
  const refreshed = await runJob(api, 'job_visible', { preflight: false, idempotencyKey: 'stale-rerun-1' });
  assert.equal(refreshed.report.resume_upload.status, 'confirmed', JSON.stringify(refreshed.report.resume_upload).slice(0, 300));
  assert.notEqual(refreshed.report.resume_upload.file.name, beforeStale,
    'after a profile edit the agent must upload the regenerated draft, not the stale file');
  const freshState = (await api('/api/jobs/job_visible/apply-state')).value;
  assert.equal(freshState.tailored_resume.stale_profile, false, 'the regenerated export must be fresh');
  results.push('stale profile: start auto-regenerated the draft and uploaded the NEW file; stale flag cleared');

  await dashboard.stop();
  dashboard = null;

  // ---------------------------------------------------------------------------
  // Phase 2 (window stays open): challenge → user verifies → continue uploads
  // the not-yet-uploaded resume in the SAME window.
  // ---------------------------------------------------------------------------
  dashboard = await startDashboard(true);
  const api2 = dashboard.api;

  const preflight = await api2('/api/jobs/job_challenge/quick-apply', { method: 'POST', body: '{}' });
  assert.equal(preflight.status, 200, JSON.stringify(preflight.value).slice(0, 300));
  // Phase 1 filled the batch selection to its maximum; make this job the
  // selected one the way the product does.
  const selection = await api2('/api/workflow/selection', {
    method: 'POST', body: JSON.stringify({ job_ids: ['job_challenge'] })
  });
  assert.equal(selection.status, 200, JSON.stringify(selection.value).slice(0, 300));
  const started = await api2('/api/jobs/job_challenge/quick-apply/start', {
    method: 'POST',
    body: JSON.stringify({ confirmed: true, executor_type: 'local_browser_agent' })
  });
  assert.equal(started.status, 200, JSON.stringify(started.value).slice(0, 300));
  assert.equal(started.value.safety.resume_upload_authorized, true);
  const challengeSessionId = started.value.application_execution_session.session_id;

  const blocked = await waitFor(
    async () => (await api2('/api/jobs/job_challenge/apply-state')).value,
    state => state.state === 'awaiting_verification',
    { label: 'the challenge to pause the fill' }
  );
  assert.equal(blocked.state, 'awaiting_verification');
  const pausedReport = await readSessionReport(challengeSessionId);
  assert.equal(pausedReport.safety.resume_uploaded, false, 'nothing may upload while the challenge is up');
  assert.equal(pausedReport.resume_upload.status, 'deferred_challenge', JSON.stringify(pausedReport.resume_upload).slice(0, 200));
  results.push('challenge active: fill paused, upload deferred (not attempted), window kept open');

  await fetch(`http://127.0.0.1:${sitePort}/clear`);
  let resumedReport = null;
  for (let attempt = 0; attempt < 6 && !resumedReport; attempt += 1) {
    const continued = await api2('/api/jobs/job_challenge/continue-after-verification', {
      method: 'POST', body: JSON.stringify({ confirmed: true })
    });
    assert.equal(continued.status, 200, JSON.stringify(continued.value).slice(0, 300));
    assert.equal(continued.value.safety.challenge_bypassed, false);
    await waitFor(
      async () => (await api2('/api/jobs/job_challenge/apply-state')).value,
      state => state.state !== 'filling',
      { label: 'the resumed attempt to settle' }
    );
    const report = await readSessionReport(challengeSessionId);
    if (report.resume_upload && report.resume_upload.status !== 'deferred_challenge') resumedReport = report;
    else await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(resumedReport, 'the upload never ran after the verification was cleared');
  assert.equal(resumedReport.resume_upload.status, 'confirmed', JSON.stringify(resumedReport.resume_upload).slice(0, 300));
  assert.equal(resumedReport.resume_upload.evidence.input_holds_file, true);
  assert.equal(resumedReport.safety.resume_uploaded, true);
  assert.ok(resumedReport.counts.filled >= 2, `safe fields must fill after continue, got ${resumedReport.counts.filled}`);
  assert.equal(resumedReport.safety.submit_attempted, false);
  results.push('after user verification: SAME window continued, resume uploaded and verified, fields filled, no submit');

  process.stdout.write(`resume upload acceptance: PASS\n${results.map(line => `  - ${line}`).join('\n')}\n`);
} finally {
  if (dashboard) await dashboard.stop();
  await new Promise(resolve => site.close(resolve));
  if (site2) await new Promise(resolve => site2.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => { /* Chromium may hold handles */ });
}
