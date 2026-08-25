import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
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
    '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  return '';
}

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${stderr || stdout}\nExit ${code}`)));
  });
}

const browser = await findBrowser();
if (!browser) throw new Error('Chrome/Edge is required for the Browser Agent local integration test.');
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-browser-agent-'));
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><body>
    <form>
      <label for="name">Full name</label><input id="name" name="name">
      <label for="email">Email</label><input id="email" name="email" type="email">
      <label for="resume">Resume</label><input id="resume" name="resume" type="file">
      <label for="gender">Gender</label><input id="gender" name="gender">
      <input type="submit" value="Submit application">
    </form>
  </body></html>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
const contextPath = path.join(temporaryRoot, 'context.json');
const reportPath = path.join(temporaryRoot, 'ApplicationExecution.json');
const statusPath = path.join(temporaryRoot, 'status.json');
await import('node:fs/promises').then(({ writeFile }) => writeFile(contextPath, JSON.stringify({
  authorized: true,
  profile_confirmed: true,
  final_submit: false,
  upload_resume: false,
  login: false,
  solve_challenge: false,
  schema: 'ApplicationExecutionSession',
  schema_version: '1.1',
  session_id: 'local-browser-agent-run',
  application_id: 'local-browser-agent-application',
  job_id: 'local-browser-agent-job',
  package_id: 'local-browser-agent-package',
  executor_type: 'local_browser_agent',
  target_url: `http://127.0.0.1:${address.port}/apply`,
  execution_status: 'EXECUTOR_READY',
  approved_profile_version: {
    profile_id: 'career-local-test', family_id: 'career-local-test', version: 1,
    approved_at: '2026-08-10T00:00:00.000Z', snapshot_digest: 'sha256:local-test'
  },
  approved_field_mappings: [
    { canonical_key: 'full_name', value: 'Reviewed Test Candidate', source: 'test_package', confidence: 1, user_confirmed: true },
    { canonical_key: 'email', value: 'reviewed@example.test', source: 'test_package', confidence: 1, user_confirmed: true }
  ],
  safety: {
    resume_upload_allowed: false, sensitive_answers_allowed: false, login_allowed: false,
    challenge_bypass_allowed: false, final_submit_allowed: false
  }
}, null, 2)));

try {
  await run(process.execPath, [
    path.resolve('browser_agent/run.mjs'),
    '--context', contextPath,
    '--report', reportPath,
    '--status', statusPath,
    '--screenshots', path.join(temporaryRoot, 'screenshots'),
    '--profile-dir', path.join(temporaryRoot, 'profile'),
    '--headless-test',
    '--close-after-fill',
  ], {
    cwd: path.resolve('.'),
    env: { ...process.env, RESUME_JOBS_CHROME_EXECUTABLE: browser },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  assert.equal(report.executor, 'local_browser_agent');
  assert.equal(report.counts.detected, 5);
  assert.equal(report.counts.filled, 2);
  assert.equal(report.counts.skipped, 3);
  assert.equal(report.safety.upload_attempted, false);
  assert.equal(report.safety.submit_attempted, false);
  assert.equal(report.safety.final_submit, false);
  assert.doesNotMatch(JSON.stringify(report), /Reviewed Test Candidate|reviewed@example\.test/);
  assert.equal(status.status, 'PAUSED_FOR_USER_REVIEW');
  await Promise.all(status.screenshots.map(file => access(file)));
  process.stdout.write('Browser Agent local integration: PASS (2 safe fields filled; upload, sensitive, and submit controls skipped).\n');
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(temporaryRoot, { recursive: true, force: true });
}
