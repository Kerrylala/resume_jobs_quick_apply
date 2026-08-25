import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dashboardUrl = String(argument('dashboard-url', process.env.RESUME_JOBS_DASHBOARD_URL || 'http://127.0.0.1:8767')).replace(/\/$/, '');
const durationMs = Math.max(30_000, Number(argument('duration-ms', process.env.RESUME_JOBS_SOAK_DURATION_MS || 7_200_000)) || 7_200_000);
const intervalMs = Math.max(5_000, Number(argument('interval-ms', process.env.RESUME_JOBS_SOAK_INTERVAL_MS || 30_000)) || 30_000);
const dashboardPid = Number(argument('dashboard-pid', process.env.RESUME_JOBS_DASHBOARD_PID || 0)) || 0;
const statePath = path.join(root, 'reports', 'soak_runtime_state.json');
const stdoutLogPath = argument('stdout-log', process.env.RESUME_JOBS_SOAK_STDOUT_LOG || path.join(root, 'logs', 'soak-dashboard.stdout.log'));
const stderrLogPath = argument('stderr-log', process.env.RESUME_JOBS_SOAK_STDERR_LOG || path.join(root, 'logs', 'soak-dashboard.stderr.log'));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function browserExecutable() {
  const candidates = [
    process.env.RESUME_JOBS_BROWSER_EXECUTABLE,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(candidate)) || '';
}

function writeState(value) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, statePath);
}

function dashboardMetrics() {
  if (!dashboardPid || process.platform !== 'win32') return null;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
    `$p=Get-Process -Id ${dashboardPid} -ErrorAction Stop; [pscustomobject]@{working_set=$p.WorkingSet64;private_memory=$p.PrivateMemorySize64;handles=$p.HandleCount;threads=$p.Threads.Count;cpu=$p.CPU}|ConvertTo-Json -Compress`
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout.trim()); }
  catch { return null; }
}

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; }
  catch { return 0; }
}

function collectPrivateNeedles() {
  const needles = new Set();
  const sensitiveKey = /(?:full_?name|first_?name|last_?name|email|phone|linkedin|github|portfolio)/i;
  const visit = (value, key = '') => {
    if (Array.isArray(value)) return value.forEach(item => visit(item, key));
    if (value && typeof value === 'object') return Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
    if (sensitiveKey.test(key) && typeof value === 'string' && value.trim().length >= 4) needles.add(value.trim());
  };
  for (const relative of ['data/resume_profiles.json', 'data/career_profiles.local.json']) {
    try { visit(JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'))); }
    catch {
      // A missing optional store contributes no private comparison value.
    }
  }
  return [...needles];
}

function privateLogMatchCount(needles) {
  let matches = 0;
  for (const logPath of [stdoutLogPath, stderrLogPath]) {
    let content = '';
    try { content = fs.readFileSync(logPath, 'utf8'); }
    catch { continue; }
    for (const needle of needles) if (content.includes(needle)) matches += 1;
  }
  return matches;
}

async function requestJson(endpoint) {
  const response = await fetch(`${dashboardUrl}${endpoint}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}.`);
  return response.json();
}

async function consumeSseConnection() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${dashboardUrl}/api/events`, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
    const reader = response.body.getReader();
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value || new Uint8Array()), /event:\s*dashboard-update/);
    await reader.cancel();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const startedAt = new Date();
const deadline = startedAt.getTime() + durationMs;
const initialMetrics = dashboardMetrics();
if (dashboardPid) assert.ok(initialMetrics, 'The configured Dashboard process is not running.');
await requestJson('/api/summary');

const executablePath = browserExecutable();
if (!executablePath) throw new Error('Chrome or Edge is required for continuous Dashboard UI rotation.');
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let consoleErrors = 0;
let pageErrors = 0;
page.on('console', message => { if (message.type() === 'error') consoleErrors += 1; });
page.on('pageerror', () => { pageErrors += 1; });
await page.goto(`${dashboardUrl}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
await page.waitForSelector('.container', { state: 'visible', timeout: 20_000 });

const navigation = ['#homeTabBtn', '#jobSearchTabBtn', '#jobMatchesTabBtn', '#applicationsTabBtn', '#interviewPrepTabBtn', '#settingsTabBtn'];
const apiViews = ['/api/summary', '/api/jobs', '/api/workflow-state', '/api/settings', '/api/provider-health', '/api/audit'];
const privateNeedles = collectPrivateNeedles();
let samples = 0;
let apiReads = 0;
let apiFailures = 0;
let uiRotations = 0;
let uiFailures = 0;
let sseReconnects = 0;
let sseFailures = 0;
let memoryMin = initialMetrics?.working_set ?? null;
let memoryMax = initialMetrics?.working_set ?? null;
let handleMin = initialMetrics?.handles ?? null;
let handleMax = initialMetrics?.handles ?? null;
let threadMin = initialMetrics?.threads ?? null;
let threadMax = initialMetrics?.threads ?? null;
const stdoutStartBytes = fileSize(stdoutLogPath);
const stderrStartBytes = fileSize(stderrLogPath);

try {
  while (Date.now() < deadline) {
    const iterationStarted = Date.now();
    const endpoint = apiViews[samples % apiViews.length];
    try { await requestJson(endpoint); apiReads += 1; }
    catch { apiFailures += 1; }

    if (samples % 10 === 0) {
      try { await consumeSseConnection(); sseReconnects += 1; }
      catch { sseFailures += 1; }
    }

    try {
      const selector = navigation[samples % navigation.length];
      await page.locator(selector).click({ timeout: 10_000 });
      await page.waitForTimeout(100);
      uiRotations += 1;
    } catch {
      uiFailures += 1;
    }

    const metrics = dashboardMetrics();
    if (dashboardPid && !metrics) throw new Error('Dashboard process disappeared during soak.');
    if (metrics) {
      memoryMin = Math.min(memoryMin ?? metrics.working_set, metrics.working_set);
      memoryMax = Math.max(memoryMax ?? metrics.working_set, metrics.working_set);
      handleMin = Math.min(handleMin ?? metrics.handles, metrics.handles);
      handleMax = Math.max(handleMax ?? metrics.handles, metrics.handles);
      threadMin = Math.min(threadMin ?? metrics.threads, metrics.threads);
      threadMax = Math.max(threadMax ?? metrics.threads, metrics.threads);
    }
    samples += 1;
    writeState({
      schema_version: '1.0',
      status: 'running',
      started_at: startedAt.toISOString(),
      updated_at: new Date().toISOString(),
      target_duration_ms: durationMs,
      elapsed_ms: Date.now() - startedAt.getTime(),
      samples,
      api_reads: apiReads,
      api_failures: apiFailures,
      ui_rotations: uiRotations,
      ui_failures: uiFailures,
      sse_reconnects: sseReconnects,
      sse_failures: sseFailures,
      dashboard_alive: Boolean(metrics || !dashboardPid)
    });
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(remaining, Math.max(0, intervalMs - (Date.now() - iterationStarted))));
  }
} finally {
  await browser.close();
}

const finishedAt = new Date();
const stdoutGrowthBytes = Math.max(0, fileSize(stdoutLogPath) - stdoutStartBytes);
const stderrGrowthBytes = Math.max(0, fileSize(stderrLogPath) - stderrStartBytes);
const privateMatches = privateLogMatchCount(privateNeedles);
const memoryGrowth = memoryMax === null || initialMetrics === null ? null : memoryMax - initialMetrics.working_set;
const failures = [
  apiFailures ? `${apiFailures} API read failure(s)` : '',
  uiFailures ? `${uiFailures} UI rotation failure(s)` : '',
  sseFailures ? `${sseFailures} SSE failure(s)` : '',
  consoleErrors ? `${consoleErrors} browser console error(s)` : '',
  pageErrors ? `${pageErrors} browser page error(s)` : '',
  privateMatches ? `${privateMatches} private-value log match(es)` : '',
  stderrGrowthBytes ? `${stderrGrowthBytes} new Dashboard stderr byte(s)` : '',
  memoryGrowth !== null && memoryGrowth > 256 * 1024 * 1024 ? 'Dashboard working set grew beyond the 256 MiB soak bound' : '',
  handleMax !== null && handleMin !== null && handleMax - handleMin > 256 ? 'Dashboard handle count grew beyond the soak bound' : '',
  threadMax !== null && threadMin !== null && threadMax - threadMin > 64 ? 'Dashboard thread count grew beyond the soak bound' : ''
].filter(Boolean);

const result = {
  status: failures.length ? 'failed' : 'passed',
  started_at: startedAt.toISOString(),
  finished_at: finishedAt.toISOString(),
  duration_ms: finishedAt.getTime() - startedAt.getTime(),
  target_duration_ms: durationMs,
  samples,
  api_reads: apiReads,
  api_failures: apiFailures,
  ui_rotations: uiRotations,
  ui_failures: uiFailures,
  sse_disconnect_reconnect_cycles: sseReconnects,
  sse_failures: sseFailures,
  browser_console_errors: consoleErrors,
  browser_page_errors: pageErrors,
  dashboard_working_set_min_bytes: memoryMin,
  dashboard_working_set_max_bytes: memoryMax,
  dashboard_working_set_growth_bound_bytes: memoryGrowth,
  dashboard_handle_min: handleMin,
  dashboard_handle_max: handleMax,
  dashboard_thread_min: threadMin,
  dashboard_thread_max: threadMax,
  stdout_growth_bytes: stdoutGrowthBytes,
  stderr_growth_bytes: stderrGrowthBytes,
  private_value_log_matches: privateMatches,
  failures
};
writeState({ schema_version: '1.0', ...result });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
