// Acceptance criteria 7 and 12: after the user personally clears a Cloudflare
// interstitial, CAPTCHA, login or MFA prompt, filling continues in the SAME
// browser window, profile, page and application session — and the product never
// touches the challenge itself.
//
// The dangerous failure here is not "resume does not work"; it is "resume works
// when it should not": filling a page the user never approved, or filling while
// a challenge is still up because a click said it was done. Those are the cases
// asserted hardest below.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { classifyPageSafety, comparableExecutionUrl, withinApplicationScope } from '../application_executor/safety_policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPROVED_URL = 'https://jobs.example.test/synthetic/apply';

// ---------------------------------------------------------------------------
// Unit level: the decisions the agent makes before it fills anything.
// ---------------------------------------------------------------------------

test('a page outside the application scope is never filled', () => {
  const drifted = [
    // Another job's form on the same site: no identity token survives.
    'https://jobs.example.test/other/apply',
    // A different host, even on the same registrable domain.
    'https://login.example.test/sso?next=/synthetic/apply',
    // A foreign domain entirely.
    'https://evil.example.evil/synthetic/apply'
  ];
  for (const url of drifted) {
    assert.equal(withinApplicationScope(url, APPROVED_URL), false, `${url} must be out of scope`);
    const verdict = classifyPageSafety({ url }, APPROVED_URL);
    assert.equal(verdict.action, 'skip');
    assert.equal(verdict.reason, 'approved_url_redirected');
  }
});

test('a later wizard step of the SAME application stays in scope and fillable', () => {
  // The shipped defect: dropbox.jobs walks /en/jobs/<id>/<slug>/ over to
  // /en/jobs/apply/?id=<id> and then step pages — strict URL equality called
  // that "navigated away" and froze all assistance mid-wizard.
  const dropboxJob = 'https://dropbox.jobs/en/jobs/7958409/infrastructure-software-engineer-metadata-core/';
  const dropboxSteps = [
    'https://dropbox.jobs/en/jobs/apply/?id=7958409#cv-fields',
    'https://dropbox.jobs/en/jobs/apply/step-2?id=7958409'
  ];
  for (const step of dropboxSteps) {
    assert.equal(withinApplicationScope(step, dropboxJob), true, `${step} must stay in scope`);
    assert.equal(classifyPageSafety({ url: step }, dropboxJob).action, 'allow');
  }
  // A DIFFERENT job on the same site shares no identity token.
  assert.equal(
    withinApplicationScope('https://dropbox.jobs/en/jobs/1111222/other-role-name/', dropboxJob),
    false
  );

  // A step that keeps the approved URL's identity token stays in scope.
  assert.equal(withinApplicationScope(`${APPROVED_URL}/step-2`, APPROVED_URL), true);
  const verdict = classifyPageSafety({ url: `${APPROVED_URL}/step-2` }, APPROVED_URL);
  assert.equal(verdict.action, 'allow');

  // Token-less approved URLs (all-generic path words) fall back to
  // path-prefix: deeper steps qualify, sibling paths do not.
  const tokenless = 'https://jobs.example.test/careers/apply';
  assert.equal(withinApplicationScope(`${tokenless}/step2`, tokenless), true);
  assert.equal(withinApplicationScope('https://jobs.example.test/other', tokenless), false);
});

test('cosmetic URL differences still count as the approved page', () => {
  // Returning from a verification often re-adds a fragment or reorders params.
  for (const url of [
    `${APPROVED_URL}#form`,
    `${APPROVED_URL}/`
  ]) {
    assert.equal(
      comparableExecutionUrl(url), comparableExecutionUrl(APPROVED_URL),
      `${url} should be treated as the same page`
    );
  }
});

test('adversarial same-host pages stay OUT of application scope', () => {
  // Cases from the adversarial review of the scope rule: multi-tenant ATS
  // hosts, substring/superstring tokens, dictionary-word tokens, hash-router
  // identity, root approved URLs, prefix swallowing, year tokens.
  const outOfScope = [
    ['https://jobs.smartrecruiters.com/EvilCorp/senior-software-engineer-lead', 'https://jobs.smartrecruiters.com/RealCorp/software-engineer'],
    ['https://boards.greenhouse.io/attackerllc/jobs/7654321', 'https://boards.greenhouse.io/realco/jobs/7654321'],
    ['https://boards.greenhouse.io/acme/jobs/123456', 'https://boards.greenhouse.io/acme/jobs/12345'],
    ['https://jobs.acme.com/careers/other-role/apply?page=2412345', 'https://jobs.acme.com/careers/first-role/apply?jid=12345'],
    ['https://jobs.acme.com/jobs/marketing-intern-summer/apply', 'https://jobs.acme.com/jobs/marketing/apply'],
    ['https://jobs.lever.co/anthropic/bbbb1111-2222-3333-4444-555566667777/apply', 'https://jobs.lever.co/anthropic/aaaa1111-2222-3333-4444-555566667777'],
    ['https://jobs.acme.com/apply#/job/0000001-attacker', 'https://jobs.acme.com/apply#/job/7958409-real'],
    ['https://boards.greenhouse.io/attacker-co/jobs/999/apply', 'https://boards.greenhouse.io/'],
    ['https://jobs.acme.com/careers/apply-admin/reset', 'https://jobs.acme.com/careers/apply'],
    ['https://jobs.lever.co/evilco/data-harvest-2024/apply', 'https://jobs.lever.co/acme/summer-intern-2024-software/apply']
  ];
  for (const [current, approved] of outOfScope) {
    assert.equal(withinApplicationScope(current, approved), false, `${current} must be out of scope of ${approved}`);
  }
  // And the legitimate shapes stay IN scope.
  const inScope = [
    ['https://jobs.lever.co/anthropic/aaaa1111-2222-3333-4444-555566667777/apply', 'https://jobs.lever.co/anthropic/aaaa1111-2222-3333-4444-555566667777'],
    ['https://jobs.acme.com/apply#/job/7958409-real/step2', 'https://jobs.acme.com/apply#/job/7958409-real'],
    ['https://jobs.acme.com/x/apply#form', 'https://jobs.acme.com/x/apply']
  ];
  for (const [current, approved] of inScope) {
    assert.equal(withinApplicationScope(current, approved), true, `${current} must stay in scope of ${approved}`);
  }
});

test('every kind of human-only barrier keeps the page unfillable', () => {
  // Clicking "I finished verifying" too early must not unlock filling for any
  // of the barriers the product refuses to touch.
  const barriers = [
    ['an active challenge (Cloudflare / CAPTCHA)', { challenge_scope: 'active', has_challenge: true }, 'CAPTCHA_REQUIRES_USER'],
    ['an MFA / one-time-code prompt', { has_otp: true }, 'VERIFICATION_REQUIRES_USER'],
    ['a login wall', { has_password: true }, 'LOGIN_REQUIRES_USER']
  ];
  for (const [label, pageState, expectedBlocker] of barriers) {
    const verdict = classifyPageSafety({ url: APPROVED_URL, ...pageState }, APPROVED_URL);
    assert.equal(verdict.action, 'skip', `filling must stay blocked by ${label}`);
    assert.equal(verdict.challenge_scope, 'active');
    assert.equal(verdict.submission_blocker, expectedBlocker);
  }
});

test('a challenge that only blocks submission still allows safe fields', () => {
  // A passive banner (already solved, or only gating Submit) should not strand
  // the user: safe fields fill, and submission stays theirs.
  const verdict = classifyPageSafety({
    url: APPROVED_URL,
    has_challenge: true,
    challenge_scope: 'passive',
    application_form_accessible: true,
    accessible_application_control_count: 6
  }, APPROVED_URL);
  assert.equal(verdict.action, 'allow');
  assert.equal(verdict.submission_blocker, 'CAPTCHA_REQUIRES_USER');
});

test('a cleared page is fillable again', () => {
  const verdict = classifyPageSafety({ url: APPROVED_URL }, APPROVED_URL);
  assert.equal(verdict.action, 'allow');
  assert.equal(verdict.challenge_scope, 'none');
});

test('the agent resume path is wired to the same URL comparison as page safety', () => {
  // Both must be the one implementation; a second copy would drift.
  const agentSource = fs.readFileSync(path.join(ROOT, 'browser_agent', 'run.mjs'), 'utf8');
  assert.match(
    agentSource,
    /import \{[^}]*comparableExecutionUrl[^}]*\} from '\.\.\/application_executor\/safety_policy\.mjs'/,
    'the agent must reuse the shared URL comparison'
  );
  assert.match(agentSource, /command === 'continue_after_verification'/);
  assert.match(
    agentSource, /VERIFICATION_URL_MISMATCH/,
    'a drifted page must be reported honestly rather than silently skipped'
  );
});

test('resuming never enables the things the product must not do', () => {
  const serverSource = fs.readFileSync(path.join(ROOT, 'dashboard', 'server.mjs'), 'utf8');
  const handler = serverSource.slice(
    serverSource.indexOf('async function handleContinueAfterVerification'),
    serverSource.indexOf('async function handleRequestReviewRescan')
  );
  assert.ok(handler.length > 0, 'expected to find the continue handler');
  for (const forbidden of ['challenge_bypass_allowed: true', 'login_allowed: true', 'final_submit_allowed: true', 'solve_challenge']) {
    assert.equal(
      handler.includes(forbidden), false,
      `resuming must not set ${forbidden}`
    );
  }
  assert.match(handler, /challenge_bypassed: false/);
  assert.match(handler, /login_performed: false/);
});

// ---------------------------------------------------------------------------
// Contract level: the endpoint's gates, over real HTTP.
// ---------------------------------------------------------------------------

function seedWorkspace({ withSession = true, executor = 'local_browser_agent' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-continue-'));
  const dataDir = path.join(root, 'data');
  for (const directory of ['data', 'archive', 'reports', 'applications', 'resumes']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const write = (name, value) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);

  write('job_leads.json', [{
    job_id: 'job_synthetic',
    title: 'Synthetic Role',
    company: 'Synthetic Corp',
    canonical_url: 'https://jobs.example.test/synthetic',
    url: 'https://jobs.example.test/synthetic',
    apply_url: APPROVED_URL
  }]);
  write('jobs_shortlist.json', []);

  const session = {
    schema: 'ApplicationExecutionSession',
    schema_version: '1.1',
    session_id: 'session-synthetic',
    application_id: 'application_job_synthetic',
    job_id: 'job_synthetic',
    package_id: 'package-synthetic',
    executor_type: executor,
    execution_status: 'NEEDS_REVIEW',
    target_url: APPROVED_URL,
    active_attempt_id: 'execution_attempt_one',
    approved_profile_version: {
      profile_id: 'career_synthetic', family_id: 'career_synthetic', version: 1,
      approved_at: '2026-01-01T00:00:00.000Z', snapshot_digest: 'sha256:synthetic'
    },
    approved_field_mappings: [{
      canonical_key: 'email', value: 'candidate@example.test',
      source: 'application_package', confidence: 1, user_confirmed: true
    }],
    safety: {
      resume_upload_allowed: false, sensitive_answers_allowed: false,
      login_allowed: false, challenge_bypass_allowed: false, final_submit_allowed: false
    },
    // No browser_agent block: the window is not running in this test, which is
    // exactly the condition the endpoint must refuse.
    latest_review_rescan: {
      scan_id: 'scan-synthetic', challenge_scope: 'active',
      detected_count: 4, required_count: 3, required_filled_count: 2, required_empty_count: 1
    }
  };

  write('dashboard_state.json', {
    version: '1.1.0',
    created_at: '2026-01-01T00:00:00.000Z',
    application_status_overrides: withSession
      ? {
        job_synthetic: {
          job_id: 'job_synthetic',
          application_status: 'NEEDS_REVIEW',
          active_session_id: 'session-synthetic'
        }
      }
      : { job_synthetic: { job_id: 'job_synthetic', application_status: 'PACKAGE_READY' } },
    application_execution_sessions: withSession ? { 'session-synthetic': session } : {},
    audit_events: [],
    run_history: []
  });

  return { root, dataDir };
}

async function withDashboard(dirs, run) {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RESUME_JOBS_DATA_DIR: dirs.dataDir,
      RESUME_JOBS_REPORTS_DIR: path.join(dirs.root, 'reports'),
      RESUME_JOBS_APPLICATIONS_DIR: path.join(dirs.root, 'applications'),
      RESUME_JOBS_ARCHIVE_DIR: path.join(dirs.root, 'archive'),
      RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(dirs.root, 'resumes'),
      RESUME_JOBS_PROFILE_PATH: path.join(dirs.root, 'profile.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 10000);
      dashboard.stdout.on('data', chunk => {
        if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
      });
      dashboard.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}.`)); });
    });
    return await run(port);
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
}

function callApi(port, script) {
  const client = `
    const base = 'http://127.0.0.1:${port}';
    const request = async (url, options={}) => {
      const response = await fetch(base + url, {headers:{'content-type':'application/json'}, ...options});
      return {status: response.status, value: await response.json()};
    };
    ${script}
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
    encoding: 'utf8', timeout: 20000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('continuing requires an explicit confirmation and an open browser window', async () => {
  const dirs = seedWorkspace();
  const outcome = await withDashboard(dirs, port => callApi(port, `
    const unconfirmed = await request('/api/jobs/job_synthetic/continue-after-verification', {
      method:'POST', body: JSON.stringify({})
    });
    const closedWindow = await request('/api/jobs/job_synthetic/continue-after-verification', {
      method:'POST', body: JSON.stringify({ confirmed: true })
    });
    const applyState = await request('/api/jobs/job_synthetic/apply-state');
    process.stdout.write(JSON.stringify({ unconfirmed, closedWindow, applyState: applyState.value }));
  `));

  assert.equal(outcome.unconfirmed.status, 409);
  assert.equal(outcome.unconfirmed.value.code, 'VERIFICATION_CONFIRMATION_REQUIRED');

  // The window is not running in this fixture. Resuming must refuse rather than
  // relaunch, because a relaunch would discard the verification the user just
  // completed and land them back at the challenge.
  assert.equal(outcome.closedWindow.status, 409);
  assert.equal(outcome.closedWindow.value.code, 'BROWSER_WINDOW_CLOSED');
  assert.match(outcome.closedWindow.value.recommended_recovery_action, /start this application again/i);

  // And the job reports the waiting state so a UI can show the right prompt.
  assert.equal(outcome.applyState.state, 'awaiting_verification');
  assert.equal(outcome.applyState.can_continue_after_verification, false);
});

test('continuing is refused for a job with no open application at all', async () => {
  const dirs = seedWorkspace({ withSession: false });
  const outcome = await withDashboard(dirs, port => callApi(port, `
    const response = await request('/api/jobs/job_synthetic/continue-after-verification', {
      method:'POST', body: JSON.stringify({ confirmed: true })
    });
    process.stdout.write(JSON.stringify(response));
  `));
  assert.equal(outcome.status, 409);
  assert.equal(outcome.value.code, 'APPLICATION_EXECUTION_SESSION_NOT_FOUND');
});

test('continuing is refused when the page is not in the browser this product opened', async () => {
  const dirs = seedWorkspace({ executor: 'extension' });
  const outcome = await withDashboard(dirs, port => callApi(port, `
    const response = await request('/api/jobs/job_synthetic/continue-after-verification', {
      method:'POST', body: JSON.stringify({ confirmed: true })
    });
    process.stdout.write(JSON.stringify(response));
  `));
  assert.equal(outcome.status, 409);
  assert.equal(outcome.value.code, 'CONTINUE_REQUIRES_BROWSER_AGENT');
});
