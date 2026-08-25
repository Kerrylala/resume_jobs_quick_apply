import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.RESUME_JOBS_LIFECYCLE_TEST_PORT || 8767);
const base = `http://127.0.0.1:${port}`;
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-lifecycle-'));
const directories = Object.fromEntries(['data', 'reports', 'applications', 'archive', 'resumes', 'browser_profiles', 'browser_sessions']
  .map(name => [name, path.join(temporaryRoot, name)]));
Object.values(directories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function portIsAvailable() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}

async function waitForReady(child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Dashboard exited during startup (${child.exitCode}).`);
    try {
      const response = await fetch(`${base}/api/summary`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { await response.arrayBuffer(); return; }
    } catch {
      // Startup polling is bounded by the deadline.
    }
    await wait(100);
  }
  throw new Error('Dashboard did not become ready within 15 seconds.');
}

async function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard did not exit within 10 seconds.')), timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}

async function waitForPortRelease(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portIsAvailable())) return;
    await wait(100);
  }
  throw new Error(`Port ${port} remained in use after Dashboard exit.`);
}

function launchDashboard(cycle) {
  const token = `lifecycle-${cycle}-${Date.now()}`;
  const child = spawn(process.execPath, [path.join(root, 'dashboard', 'server.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RESUME_JOBS_SHUTDOWN_TOKEN: token,
      RESUME_JOBS_DATA_DIR: directories.data,
      RESUME_JOBS_REPORTS_DIR: directories.reports,
      RESUME_JOBS_APPLICATIONS_DIR: directories.applications,
      RESUME_JOBS_ARCHIVE_DIR: directories.archive,
      RESUME_JOBS_RESUME_LIBRARY_DIR: directories.resumes,
      RESUME_JOBS_BROWSER_PROFILES_DIR: directories.browser_profiles,
      RESUME_JOBS_BROWSER_SESSIONS_DIR: directories.browser_sessions
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  // Consume output to prevent pipe backpressure, but never copy runtime output
  // into the acceptance report.
  child.stdout.resume();
  child.stderr.resume();
  return { child, token };
}

async function consumeOneSseEvent() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const reader = response.body.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value || new Uint8Array());
    assert.match(text, /event:\s*dashboard-update/);
    await reader.cancel();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function readProductViews() {
  for (const endpoint of ['/api/summary', '/api/jobs', '/api/workflow-state', '/api/provider-health']) {
    const response = await fetch(`${base}${endpoint}`, { signal: AbortSignal.timeout(3000) });
    assert.equal(response.status, 200, endpoint);
    await response.json();
  }
}

async function stopGracefully(instance) {
  const response = await fetch(`${base}/api/runtime/shutdown`, {
    method: 'POST',
    headers: { 'X-Resume-Jobs-Shutdown-Token': instance.token },
    signal: AbortSignal.timeout(3000)
  });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  assert.equal(await waitForExit(instance.child), 0);
  await waitForPortRelease();
}

function validateTemporaryPersistence() {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else files.push(absolute);
    }
  };
  visit(temporaryRoot);
  const temporaryFiles = files.filter(file => /\.tmp$/i.test(file));
  const invalidJson = [];
  for (const file of files.filter(file => file.endsWith('.json'))) {
    try { JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { invalidJson.push(path.relative(temporaryRoot, file)); }
  }
  assert.deepEqual(temporaryFiles, []);
  assert.deepEqual(invalidJson, []);
  return files.length;
}

let coldStarts = 0;
let portChecks = 0;
let sseReconnects = 0;
let abruptTerminations = 0;
let recoveryStarts = 0;

try {
  assert.equal(await portIsAvailable(), false, `Port ${port} must be free before lifecycle testing.`);
  for (let cycle = 1; cycle <= 10; cycle += 1) {
    const instance = launchDashboard(`cold-${cycle}`);
    await waitForReady(instance.child);
    coldStarts += 1;
    assert.equal(await portIsAvailable(), true);
    portChecks += 1;
    await readProductViews();
    if (cycle <= 5) {
      await consumeOneSseEvent();
      sseReconnects += 1;
    }
    await stopGracefully(instance);
  }

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const interrupted = launchDashboard(`abrupt-${cycle}`);
    await waitForReady(interrupted.child);
    interrupted.child.kill('SIGKILL');
    await waitForExit(interrupted.child);
    abruptTerminations += 1;
    await waitForPortRelease();

    const recovered = launchDashboard(`recovery-${cycle}`);
    await waitForReady(recovered.child);
    await readProductViews();
    recoveryStarts += 1;
    await stopGracefully(recovered);
  }

  const persistedFileCount = validateTemporaryPersistence();
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    port,
    cold_starts: coldStarts,
    port_availability_checks: portChecks,
    sse_disconnect_reconnect_cycles: sseReconnects,
    abrupt_dashboard_terminations: abruptTerminations,
    successful_recovery_starts: recoveryStarts,
    invalid_json_files: 0,
    temporary_residue_files: 0,
    persisted_fixture_file_count: persistedFileCount
  }, null, 2)}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
