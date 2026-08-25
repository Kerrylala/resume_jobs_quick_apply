import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApprovalSafety } from './lib/approval_safety.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserExecutable = [
  process.env.RESUME_JOBS_CHROME_EXECUTABLE,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean).find(candidate => fs.existsSync(candidate));
if (!browserExecutable) throw new Error('Chrome or Edge is required for the Dashboard Browser Agent integration test.');

function freePort() {
  const probe = spawnSync(process.execPath, ['-e', `
    const net = require('node:net');
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  return Number(probe.stdout.trim());
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function waitForServer(child) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 10_000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('Dashboard server running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Dashboard exited before startup (${code}).`));
    });
  });
}

async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${pathname}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}

async function waitForExecution(base, jobId) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    last = await request(base, `/api/executor/status?job_id=${encodeURIComponent(jobId)}`);
    if (['PAUSED_FOR_USER_REVIEW', 'NEEDS_REVIEW', 'NEEDS_USER_INPUT', 'READY_FOR_MANUAL_SUBMIT', 'FAILED'].includes(last.status)) return last;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Browser Agent did not finish the localhost handoff: ${JSON.stringify(last)}`);
}

async function waitForStatusFile(filePath, predicate, label) {
  const deadline = Date.now() + 30_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (predicate(last)) return last;
    } catch {
      // The Browser Agent writes this file atomically; absence during startup
      // is expected and bounded by the deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not complete: ${JSON.stringify({
    status: last?.status || '',
    attempt_id: last?.attempt_id || '',
    scan_id: last?.review_rescan?.scan_id || ''
  })}`);
}

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-dashboard-agent-'));
const dataDir = path.join(temporaryRoot, 'data');
const applicationsDir = path.join(temporaryRoot, 'applications');
const reportsDir = path.join(temporaryRoot, 'reports');
const browserProfilesDir = path.join(temporaryRoot, 'browser_profiles');
const browserSessionsDir = path.join(temporaryRoot, 'browser_sessions');
const port = freePort();
const base = `http://127.0.0.1:${port}`;
const jobId = 'dashboard-browser-agent-local';
const applicationId = 'application-dashboard-browser-agent-local';
const packageDir = path.join(applicationsDir, jobId);
const now = new Date().toISOString();
const shutdownToken = `dashboard-agent-test-${process.pid}`;

const job = {
  job_id: jobId,
  source: 'localhost_fixture',
  source_job_id: jobId,
  title: 'Product Manager',
  company: 'Local Fixture Company',
  location: 'Remote',
  provider: 'greenhouse',
  ats: 'greenhouse',
  url: `${base}/mock-ats/jobs/123456`,
  page_type: 'job_detail',
  match_score: 95,
  recommended_decision: 'approve',
  approval_safety: createApprovalSafety('safe_to_approve', true, []),
  application_mode: 'REVIEW_ONLY',
  submit_allowed: false,
  upload_resume_allowed: false,
  final_submit_allowed: false,
};

writeJson(path.join(dataDir, 'jobs_shortlist.json'), [job]);
writeJson(path.join(dataDir, 'job_leads.json'), [job]);
writeJson(path.join(dataDir, 'job_reviews.json'), [{ job_id: jobId, decision: 'approved', decided_at: now }]);
writeJson(path.join(dataDir, 'search_preferences.json'), {
  active_search_profile_id: 'local-agent-test',
  search_profiles: [{
    id: 'local-agent-test', name: 'Local Agent Test', enabled: true,
    target_roles: [{ keyword: 'Product Manager', weight: 100, enabled: true, aliases: [] }],
    preferred_locations: [{ keyword: 'Remote', weight: 100, enabled: true, aliases: [] }],
    maximum_jobs_to_open: 1,
  }],
});
writeJson(path.join(dataDir, 'dashboard_state.json'), {
  selected_job_ids: [jobId],
  application_status_overrides: {
    [jobId]: {
      job_id: jobId,
      application_id: applicationId,
      status: 'FILL_APPROVED',
      application_status: 'FILL_APPROVED',
      fill_approved_at: now,
      package_path: path.relative(root, packageDir),
      updated_at: now,
    },
  },
  application_execution_sessions: {},
  audit_events: [],
});
writeJson(path.join(dataDir, 'career_profiles.local.json'), {
  schema_version: '1.0',
  active_profile_id: 'career-local-agent',
  profiles: [{
    id: 'career-local-agent', family_id: 'career-local-agent', name: 'Local Agent Profile', version: 1,
    state: 'approved', user_approved: true, approved_at: now, created_at: now, updated_at: now,
    source_resume_ids: [],
    identity: {
      full_name: 'Synthetic Browser Agent', first_name: 'Synthetic', last_name: 'Agent',
      email: 'agent@local.invalid', phone: '000-000-0000', current_location: 'Fixture City',
      links: {
        linkedin: 'https://linkedin.invalid/in/synthetic-agent',
        github: 'https://github.invalid/synthetic-agent',
        portfolio: 'https://portfolio.invalid/synthetic-agent', other: []
      }
    },
    education: [], experience: [], projects: [],
    skills: { programming: [], ai_tools: [], frameworks: [], cloud: [], data: [], business: [] },
    certifications: [], languages: [], interview_stories: [], job_preferences: {}, career_goals: []
  }]
});
writeJson(path.join(packageDir, 'application_package.json'), {
  application_id: applicationId,
  package_id: `${applicationId}-package`,
  job_id: jobId,
  status: 'PACKAGE_READY',
  career_profile_reference: {
    profile_id: 'career-local-agent', family_id: 'career-local-agent', version: 1,
    user_approved: true, approved_at: now
  },
  application_profile: {
    full_name: 'Synthetic Browser Agent',
    first_name: 'Synthetic',
    last_name: 'Agent',
    email: 'agent@local.invalid',
    phone: '000-000-0000',
    city: 'Fixture City',
    linkedin: 'https://linkedin.invalid/in/synthetic-agent',
    github: 'https://github.invalid/synthetic-agent',
    portfolio: 'https://portfolio.invalid/synthetic-agent',
    approved_for_real_applications: true,
    profile_meta: {
      career_profile_reference: {
        profile_id: 'career-local-agent', family_id: 'career-local-agent', version: 1, approved_at: now
      },
      candidate_fact_review: { snapshot_digest: 'sha256:local-agent-test', confirmed_at: now }
    },
  },
  form_answers: { answers: [], requires_review: [] },
});
writeJson(path.join(packageDir, 'package_manifest.json'), {
  application_id: applicationId,
  job_id: jobId,
  package_id: `${applicationId}-package`,
  package_status: 'PACKAGE_READY'
});

const dashboard = spawn(process.execPath, [path.join(root, 'dashboard', 'server.mjs')], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    RESUME_JOBS_DATA_DIR: dataDir,
    RESUME_JOBS_REPORTS_DIR: reportsDir,
    RESUME_JOBS_APPLICATIONS_DIR: applicationsDir,
    RESUME_JOBS_BROWSER_PROFILES_DIR: browserProfilesDir,
    RESUME_JOBS_BROWSER_SESSIONS_DIR: browserSessionsDir,
    RESUME_JOBS_CHROME_EXECUTABLE: browserExecutable,
    RESUME_JOBS_BROWSER_AGENT_TEST_MODE: '1',
    RESUME_JOBS_BROWSER_AGENT_KEEP_OPEN_TEST: '1',
    RESUME_JOBS_SHUTDOWN_TOKEN: shutdownToken,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

try {
  await waitForServer(dashboard);
  const started = await request(base, `/api/jobs/${encodeURIComponent(jobId)}/start-fill`, {
    method: 'POST',
    body: JSON.stringify({
      confirmed: true,
      idempotency_key: 'dashboard-browser-agent-local-start',
      executor_mode: 'local_browser_agent',
    }),
  });
  assert.equal(started.application_execution_session.executor_type, 'local_browser_agent');
  assert.equal(started.safety.browser_opened_by_server, true);
  assert.equal(started.safety.resume_uploaded, false);
  const status = await waitForExecution(base, jobId);
  assert.notEqual(status.status, 'FAILED', JSON.stringify(status));
  assert.equal(status.executor, 'local_browser_agent');
  assert.equal(status.connected, true);
  assert.equal(status.application_id, applicationId);
  assert.equal(status.package_id, `${applicationId}-package`);
  assert.ok(status.fields.detected > 0);
  assert.ok(status.fields.filled > 0);
  assert.equal(status.safety.resume_uploaded, false);
  assert.equal(status.safety.submitted, false);
  assert.equal(status.safety.final_submit, false);

  const sessionDir = path.join(browserSessionsDir, started.application_execution_session.session_id);
  const execution = JSON.parse(fs.readFileSync(path.join(sessionDir, 'ApplicationExecution.json'), 'utf8'));
  assert.equal(execution.executor, 'local_browser_agent');
  assert.equal(execution.application_id, applicationId);
  assert.equal(execution.package_id, `${applicationId}-package`);
  assert.ok(execution.fields.detected.length > 0);
  assert.ok(execution.fields.filled.length > 0);
  assert.equal(execution.fields.detected.length, execution.field_results.length);
  assert.doesNotMatch(JSON.stringify(execution), /Synthetic Browser Agent|agent@local\.invalid|000-000-0000/);
  assert.ok(fs.existsSync(path.join(sessionDir, 'screenshots', 'before-fill.png')));
  assert.ok(fs.existsSync(path.join(sessionDir, 'screenshots', 'after-fill.png')));

  const statusFile = path.join(sessionDir, 'status.json');
  const retried = await request(base, `/api/jobs/${encodeURIComponent(jobId)}/start-fill`, {
    method: 'POST',
    body: JSON.stringify({
      confirmed: true,
      idempotency_key: 'dashboard-browser-agent-local-retry',
      executor_mode: 'local_browser_agent',
      retry_safe_fill: true,
    }),
  });
  const retryAttemptId = retried.application_execution_session.active_attempt_id;
  assert.ok(retryAttemptId);
  const retryStatus = await waitForStatusFile(
    statusFile,
    value => value.attempt_id === retryAttemptId && value.status === 'PAUSED_FOR_USER_REVIEW',
    'Safe-fill retry'
  );
  assert.equal(retryStatus.safety.resume_uploaded, false);
  assert.equal(retryStatus.safety.submitted, false);

  const scanId = 'dashboard-browser-agent-local-rescan';
  await request(base, `/api/jobs/${encodeURIComponent(jobId)}/review-rescan`, {
    method: 'POST',
    body: JSON.stringify({ scan_id: scanId }),
  });
  const rescanStatus = await waitForStatusFile(
    statusFile,
    value => value.review_rescan?.scan_id === scanId && value.status === 'REVIEW_RESCANNED',
    'Review re-scan'
  );
  assert.equal(rescanStatus.review_rescan.scan_id, scanId);
  assert.equal(rescanStatus.review_rescan.submit_control_detected, true);
  assert.equal(rescanStatus.review_rescan.final_submit_clicked, false);
  assert.equal(rescanStatus.safety.upload_attempted, false);
  assert.equal(rescanStatus.safety.submit_attempted, false);
  assert.equal(rescanStatus.safety.final_submit, false);

  process.stdout.write(JSON.stringify({
    success: true,
    flow: ['Dashboard', 'Application Package', 'Browser Agent', 'Mock ATS', 'Safe fill', 'Retry', 'Re-scan', 'ApplicationExecution'],
    status: status.status,
    fields: status.fields,
    retry_cycles: 1,
    review_rescan_cycles: 1,
    safety: status.safety,
  }, null, 2));
} finally {
  try {
    await fetch(`${base}/api/runtime/shutdown`, {
      method: 'POST',
      headers: { 'X-Resume-Jobs-Shutdown-Token': shutdownToken },
      signal: AbortSignal.timeout(3000)
    });
  } catch {
    dashboard.kill();
  }
  await new Promise(resolve => {
    const timer = setTimeout(() => { dashboard.kill(); resolve(); }, 10_000);
    dashboard.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  await fs.promises.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
}
