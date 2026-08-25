import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const browserExecutable = [
  process.env.RESUME_JOBS_CHROME_EXECUTABLE,
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
].filter(Boolean).find(candidate => fs.existsSync(candidate));
if (!browserExecutable) throw new Error('Chrome or Edge is required for Browser Agent crash recovery testing.');

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body><form><label for="name">Full name</label><input id="name" name="name"><label for="email">Email</label><input id="email" name="email" type="email"><label for="resume">Resume</label><input id="resume" name="resume" type="file"><button type="submit">Submit</button></form></body></html>');
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}/apply`;

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function spawnAgent(paths, closeAfterFill) {
  const args = [
    path.join(root, 'browser_agent', 'run.mjs'),
    '--context', paths.context,
    '--report', paths.report,
    '--status', paths.status,
    '--screenshots', paths.screenshots,
    '--profile-dir', paths.profile,
    '--retry-command', paths.retry,
    '--headless-test'
  ];
  if (closeAfterFill) args.push('--close-after-fill');
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: { ...process.env, RESUME_JOBS_CHROME_EXECUTABLE: browserExecutable },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function waitForStatus(statusPath, expected, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = '';
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
      lastStatus = value.status || '';
      if (lastStatus === expected) return value;
      if (lastStatus === 'FAILED') throw new Error('Browser Agent reported a bounded failure.');
    } catch (error) {
      if (/bounded failure/.test(error.message)) throw error;
    }
    await wait(100);
  }
  throw new Error(`Browser Agent did not reach ${expected}; last status was ${lastStatus || 'unavailable'}.`);
}

async function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Browser Agent process did not exit.')), timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

function profileProcessCount(profilePath) {
  if (process.platform !== 'win32') return 0;
  const escaped = profilePath.replaceAll("'", "''");
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
    `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' -and $_.Name -match 'chrome|msedge' } | Measure-Object).Count`
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (result.status !== 0) throw new Error('Could not inspect controlled browser processes.');
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

async function waitForNoProfileProcesses(profilePath, timeoutMs = 20_000) {
  if (process.platform !== 'win32') return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (profileProcessCount(profilePath) === 0) return;
    await wait(250);
  }
  throw new Error('Controlled Chromium processes remained after the Browser Agent crash.');
}

let crashCycles = 0;
let recoveryCycles = 0;
let orphanProcesses = 0;

try {
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `resume-jobs-agent-crash-${cycle}-`));
    const paths = {
      context: path.join(temporaryRoot, 'context.json'),
      report: path.join(temporaryRoot, 'ApplicationExecution.json'),
      status: path.join(temporaryRoot, 'status.json'),
      screenshots: path.join(temporaryRoot, 'screenshots'),
      profile: path.join(temporaryRoot, 'profile'),
      retry: path.join(temporaryRoot, 'retry-command.json')
    };
    writeJson(paths.context, {
      authorized: true,
      profile_confirmed: true,
      final_submit: false,
      upload_resume: false,
      login: false,
      solve_challenge: false,
      schema: 'ApplicationExecutionSession',
      schema_version: '1.1',
      session_id: `crash-session-${cycle}`,
      application_id: `crash-application-${cycle}`,
      job_id: `crash-job-${cycle}`,
      package_id: `crash-package-${cycle}`,
      executor_type: 'local_browser_agent',
      target_url: baseUrl,
      execution_status: 'EXECUTOR_READY',
      active_attempt_id: `crash-attempt-${cycle}`,
      approved_profile_version: {
        profile_id: 'synthetic-profile', family_id: 'synthetic-profile', version: 1,
        approved_at: '2026-01-01T00:00:00.000Z', snapshot_digest: 'sha256:synthetic'
      },
      approved_field_mappings: [
        { canonical_key: 'full_name', value: 'Synthetic Test User', source: 'synthetic_package', confidence: 1, user_confirmed: true },
        { canonical_key: 'email', value: 'synthetic@example.test', source: 'synthetic_package', confidence: 1, user_confirmed: true }
      ],
      safety: {
        resume_upload_allowed: false,
        sensitive_answers_allowed: false,
        login_allowed: false,
        challenge_bypass_allowed: false,
        final_submit_allowed: false
      }
    });

    try {
      const interrupted = spawnAgent(paths, false);
      const firstStatus = await waitForStatus(paths.status, 'PAUSED_FOR_USER_REVIEW');
      assert.equal(firstStatus.safety.upload_attempted, false);
      assert.equal(firstStatus.safety.submit_attempted, false);
      interrupted.kill('SIGKILL');
      await waitForExit(interrupted);
      crashCycles += 1;
      await waitForNoProfileProcesses(paths.profile);

      const recovered = spawnAgent(paths, true);
      assert.equal(await waitForExit(recovered), 0);
      const recoveryStatus = await waitForStatus(paths.status, 'PAUSED_FOR_USER_REVIEW');
      assert.equal(recoveryStatus.safety.upload_attempted, false);
      assert.equal(recoveryStatus.safety.submit_attempted, false);
      await waitForNoProfileProcesses(paths.profile);
      recoveryCycles += 1;
      orphanProcesses += profileProcessCount(paths.profile);
    } finally {
      await fs.promises.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 60, retryDelay: 250 });
    }
  }

  assert.equal(orphanProcesses, 0);
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    simulated_browser_agent_crashes: crashCycles,
    successful_same_profile_recoveries: recoveryCycles,
    controlled_browser_orphans: orphanProcesses,
    resume_upload_attempts: 0,
    submit_attempts: 0
  }, null, 2)}\n`);
} finally {
  await new Promise(resolve => server.close(resolve));
}
