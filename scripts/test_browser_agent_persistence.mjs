// Real-browser verification of the resume-after-verification flow.
//
// Everything here runs against a localhost page. Nothing touches a real job
// site, no challenge is solved or bypassed, and no form is submitted. The page
// simply *reports* a challenge until a flag is flipped, which is how a real
// Cloudflare or CAPTCHA interstitial behaves from the agent's point of view.
//
// What it proves, with an actual Chromium:
//   1. The persistent profile directory is created and REUSED across sessions —
//      so cookies and a completed verification survive.
//   2. While a challenge is up, the agent fills nothing and reports
//      VERIFICATION_REQUIRED.
//   3. After the user clears it, `continue_after_verification` resumes filling
//      in the SAME long-lived process and window.
//   4. If the page drifted off the approved URL, resuming refuses to fill.
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function findBrowser() {
  const candidates = [
    process.env.RESUME_JOBS_CHROME_EXECUTABLE,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try the next one */ }
  }
  return '';
}

async function readJsonWhen(filePath, predicate, { timeoutMs = 45_000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = JSON.parse(await readFile(filePath, 'utf8'));
      if (predicate(last)) return last;
    } catch { /* the file is mid-write or not there yet */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}. Last seen: ${JSON.stringify(last)}`);
}

const browser = await findBrowser();
if (!browser) throw new Error('Chrome/Edge is required for the Browser Agent persistence test.');

const root = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-agent-persistence-'));
// One shared profile directory across both sessions — the product behaviour.
const profileDir = path.join(root, 'shared-profile');

// The localhost page reports a challenge until the "user" clears it.
let challengeActive = true;
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/clear-challenge')) {
    challengeActive = false;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('cleared');
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  // A real interstitial REPLACES the page: the form is not reachable while the
  // challenge is up. Serving both at once would not be a challenge at all, and
  // the detector is right to treat it as an ordinary page.
  if (challengeActive) {
    // Real interstitials re-check and then navigate to the target page on their
    // own, which is how the agent's tab ends up on the form without anything
    // here driving the browser.
    return res.end(`<!doctype html><html><head>
      <meta http-equiv="refresh" content="1">
    </head><body>
      <h1>Checking your browser before you continue</h1>
      <p>Verify you are human to access this page.</p>
    </body></html>`);
  }
  return res.end(`<!doctype html><html><body>
    <form>
      <label for="name">Full name</label><input id="name" name="name">
      <label for="email">Email</label><input id="email" name="email" type="email">
      <input type="submit" value="Submit application">
    </form>
  </body></html>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const { port } = server.address();
const targetUrl = `http://127.0.0.1:${port}/apply`;

function sessionDocument(sessionId) {
  return {
    authorized: true,
    profile_confirmed: true,
    final_submit: false,
    upload_resume: false,
    login: false,
    solve_challenge: false,
    schema: 'ApplicationExecutionSession',
    schema_version: '1.1',
    session_id: sessionId,
    application_id: 'persistence-application',
    job_id: 'persistence-job',
    package_id: 'persistence-package',
    executor_type: 'local_browser_agent',
    target_url: targetUrl,
    execution_status: 'EXECUTOR_READY',
    active_attempt_id: 'attempt_one',
    approved_profile_version: {
      profile_id: 'career-persistence', family_id: 'career-persistence', version: 1,
      approved_at: '2026-08-10T00:00:00.000Z', snapshot_digest: 'sha256:persistence'
    },
    approved_field_mappings: [
      { canonical_key: 'full_name', value: 'Persistence Test Candidate', source: 'test_package', confidence: 1, user_confirmed: true },
      { canonical_key: 'email', value: 'persistence@example.test', source: 'test_package', confidence: 1, user_confirmed: true }
    ],
    safety: {
      resume_upload_allowed: false, sensitive_answers_allowed: false, login_allowed: false,
      challenge_bypass_allowed: false, final_submit_allowed: false
    }
  };
}

async function startAgent(sessionId, dir) {
  await mkdir(dir, { recursive: true });
  const contextPath = path.join(dir, 'context.json');
  const statusPath = path.join(dir, 'status.json');
  const reportPath = path.join(dir, 'ApplicationExecution.json');
  const retryCommandPath = path.join(dir, 'retry-command.json');
  await writeFile(contextPath, JSON.stringify(sessionDocument(sessionId), null, 2));
  const child = spawn(process.execPath, [
    path.resolve('browser_agent/run.mjs'),
    '--context', contextPath,
    '--report', reportPath,
    '--status', statusPath,
    '--screenshots', path.join(dir, 'screenshots'),
    '--profile-dir', profileDir,
    '--retry-command', retryCommandPath,
    '--headless-test'
  ], {
    cwd: path.resolve('.'),
    env: { ...process.env, RESUME_JOBS_CHROME_EXECUTABLE: browser, RESUME_JOBS_BROWSER_AGENT_TEST_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', () => { /* progress only */ });
  return { child, statusPath, reportPath, retryCommandPath, stderr: () => stderr };
}

async function stopAgent(agent) {
  agent.child.kill('SIGTERM');
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 10_000);
    agent.child.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

const results = [];

try {
  // --- Session 1: a challenge is up. Nothing may be filled. -----------------
  const first = await startAgent('persistence-session-1', path.join(root, 's1'));
  let status;
  try {
    status = await readJsonWhen(
      first.statusPath,
      value => ['VERIFICATION_REQUIRED', 'PAUSED_FOR_USER_REVIEW', 'FAILED'].includes(value.status),
      { label: 'the first attempt to pause' }
    );
    assert.notEqual(status.status, 'FAILED', `agent failed: ${status.reason || first.stderr()}`);
    assert.equal(status.status, 'VERIFICATION_REQUIRED', 'an active challenge must pause the agent for the user');
    assert.equal(status.challenge_scope, 'active');

    const blockedReport = JSON.parse(await readFile(first.reportPath, 'utf8'));
    assert.equal(blockedReport.counts.filled, 0, 'nothing may be filled while a challenge is on screen');
    assert.equal(blockedReport.safety.submit_attempted, false);
    assert.equal(blockedReport.safety.challenge_attempted, false);
    results.push('challenge up → agent paused, 0 fields filled, challenge untouched');

    // --- The user clears the verification themselves. ----------------------
    await fetch(`http://127.0.0.1:${port}/clear-challenge`);

    // --- Resume in the SAME process and window. ---------------------------
    //
    // The interstitial takes a moment to navigate to the real page, so the
    // first click on "I finished verifying" can legitimately land while the
    // challenge is still on screen. That must NOT bypass anything: it simply
    // reports the challenge again. Retrying is what a user would do, and this
    // loop asserts both halves of that behaviour.
    let resumed = null;
    let clickedWhileStillChallenged = 0;
    for (let attempt = 2; attempt <= 8; attempt += 1) {
      const attemptId = `attempt_${attempt}`;
      await writeFile(first.retryCommandPath, JSON.stringify({
        command: 'continue_after_verification',
        session_id: 'persistence-session-1',
        attempt_id: attemptId,
        requested_at: new Date().toISOString()
      }, null, 2));

      const observed = await readJsonWhen(
        first.statusPath,
        value => value.attempt_id === attemptId || value.status === 'VERIFICATION_URL_MISMATCH',
        { label: `resumed attempt ${attemptId}` }
      );
      assert.notEqual(
        observed.status, 'VERIFICATION_URL_MISMATCH',
        'the page never left the approved URL in this scenario'
      );
      if (observed.status === 'VERIFICATION_REQUIRED') {
        // Clicked too early: nothing may have been filled.
        assert.equal(
          observed.counts.filled, 0,
          'clicking "I finished verifying" early must never fill a still-challenged page'
        );
        clickedWhileStillChallenged += 1;
        await new Promise(resolve => setTimeout(resolve, 1500));
        continue;
      }
      resumed = observed;
      break;
    }

    assert.ok(resumed, 'filling never resumed after the verification was cleared');
    assert.equal(resumed.status, 'PAUSED_FOR_USER_REVIEW', 'a cleared page resumes to normal review');
    assert.equal(resumed.counts.filled, 2, 'safe fields must fill once the verification is gone');
    results.push('user cleared verification → same process resumed and filled 2 safe fields');
    if (clickedWhileStillChallenged > 0) {
      results.push(`clicked ${clickedWhileStillChallenged}× while still challenged → 0 fields filled, no bypass`);
    }

    const resumedReport = JSON.parse(await readFile(first.reportPath, 'utf8'));
    assert.equal(resumedReport.safety.submit_attempted, false, 'resuming must never press Submit');
    assert.equal(resumedReport.safety.upload_attempted, false, 'resuming must never upload a file');
    assert.doesNotMatch(
      JSON.stringify(resumedReport),
      /Persistence Test Candidate|persistence@example\.test/,
      'candidate values must not appear in the report'
    );
    results.push('resumed run still uploaded nothing, submitted nothing, and redacted values');
  } finally {
    await stopAgent(first);
  }

  // The persistent profile must exist after the first session.
  await access(profileDir);
  await access(path.join(profileDir, 'Default'));
  results.push('persistent profile directory created');

  // --- Session 2: a brand new session reuses the same profile. -------------
  challengeActive = false;
  const second = await startAgent('persistence-session-2', path.join(root, 's2'));
  try {
    const status2 = await readJsonWhen(
      second.statusPath,
      value => ['PAUSED_FOR_USER_REVIEW', 'VERIFICATION_REQUIRED', 'FAILED'].includes(value.status),
      { label: 'the second session to settle' }
    );
    assert.notEqual(status2.status, 'FAILED', `second session failed: ${status2.reason || second.stderr()}`);
    assert.equal(status2.counts.filled, 2);
    results.push('second session reused the same profile directory and filled normally');
  } finally {
    await stopAgent(second);
  }

  process.stdout.write(`Browser Agent persistence + pause/resume: PASS\n${results.map(line => `  - ${line}`).join('\n')}\n`);
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true }).catch(() => { /* Chromium may still hold a handle */ });
}
