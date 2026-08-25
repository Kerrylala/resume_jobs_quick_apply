import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set([
  '.git',
  '.venv',
  '.venv_scrapling',
  'node_modules',
  'tests',
  'developer',
  'internal',
  'archive',
  'reports',
  'browser_profiles',
  'browser_sessions'
]);
const releaseSourceExtensions = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.html', '.htm']);
const nativeDialogCall = /(?:window\s*\.\s*|globalThis\s*\.\s*)?(alert|confirm|prompt)\s*\(/g;

function releaseSourceFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...releaseSourceFiles(absolute));
    else if (releaseSourceExtensions.has(path.extname(entry.name).toLowerCase())) files.push(absolute);
  }
  return files;
}

test('Release product source contains no browser-native alert, confirm, or prompt calls', () => {
  const violations = [];
  for (const file of releaseSourceFiles(root)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(nativeDialogCall)) {
      const line = source.slice(0, match.index).split(/\r?\n/).length;
      violations.push(`${path.relative(root, file).replaceAll(path.sep, '/')}:${line}:${match[1]}`);
    }
  }
  assert.deepEqual(violations, []);
});

test('Dashboard and extension expose product-owned confirmation and notification UI', () => {
  const dashboardHtml = fs.readFileSync(path.join(root, 'dashboard', 'public', 'index.html'), 'utf8');
  const dashboardJs = fs.readFileSync(path.join(root, 'dashboard', 'public', 'app.js'), 'utf8');
  const extensionHtml = fs.readFileSync(path.join(root, 'extensions', 'application_assistant', 'popup.html'), 'utf8');
  const extensionJs = fs.readFileSync(path.join(root, 'extensions', 'application_assistant', 'popup.js'), 'utf8');

  assert.match(dashboardHtml, /id="productConfirmationModal"/);
  assert.match(dashboardHtml, /id="productToastRegion"/);
  assert.match(dashboardJs, /function confirmProductAction/);
  assert.match(dashboardJs, /function showProductToast/);
  assert.match(extensionHtml, /id="detail" role="status" aria-live="polite"/);
  assert.match(extensionJs, /function setStatus/);
  assert.match(extensionJs, /function paintApplyState/);
});

test('normal Dashboard copy and API errors do not expose transport terminology', () => {
  const dashboardHtml = fs.readFileSync(path.join(root, 'dashboard', 'public', 'index.html'), 'utf8');
  const dashboardJs = fs.readFileSync(path.join(root, 'dashboard', 'public', 'app.js'), 'utf8');
  const dashboardServer = fs.readFileSync(path.join(root, 'dashboard', 'server.mjs'), 'utf8');
  const applicationState = fs.readFileSync(path.join(root, 'scripts', 'lib', 'application_state.mjs'), 'utf8');
  const executionSession = fs.readFileSync(path.join(root, 'application_executor', 'execution_session.mjs'), 'utf8');
  const extensionContent = fs.readFileSync(path.join(root, 'extensions', 'application_assistant', 'content.js'), 'utf8');
  const extensionPopup = fs.readFileSync(path.join(root, 'extensions', 'application_assistant', 'popup.js'), 'utf8');
  const fetchStart = dashboardJs.indexOf('async function fetchJSON');
  const fetchEnd = dashboardJs.indexOf('\nfunction executionBlockerText', fetchStart);
  const fetchSource = dashboardJs.slice(fetchStart, fetchEnd);

  assert.doesNotMatch(dashboardHtml, /ApplicationRun|Content Script|localhost handoff/i);
  assert.doesNotMatch(dashboardHtml, /APPLICATION EXECUTOR|>Executor mode|>Session not created<|>Executor Ready</i);
  assert.match(dashboardHtml, /AI FILL ASSISTANT/);
  assert.match(dashboardHtml, />Fill method/);
  assert.doesNotMatch(fetchSource, /new Error\(`[^`]*\$\{res\.status\}/);
  assert.doesNotMatch(fetchSource, /raw_response/);
  assert.match(fetchSource, /http_status/);
  assert.match(dashboardJs, /<summary>Advanced diagnostics<\/summary>/);
  assert.match(dashboardJs, /initializeDashboard\(\)\.catch\(error =>/);
  assert.match(dashboardJs, /handoffWindow\.opener = null/);
  assert.match(dashboardJs, /\['http:', 'https:'\]\.includes\(target\.protocol\)/);
  assert.doesNotMatch(dashboardJs, /failures\.push\(`\$\{jobId\}:/);
  assert.match(dashboardJs, /failures\.push\(`\$\{jobLabel\}:/);
  assert.doesNotMatch(dashboardJs, /Recommended: \$\{recommendation\.recommended_resume_id\}/);
  assert.doesNotMatch(dashboardJs, /packageResumeVisibleDetail[^\n]*content_hash/);
  assert.doesNotMatch(dashboardJs, /Checked GET \/api\//);
  assert.doesNotMatch(dashboardJs, /GET \/api\/settings failed/);
  assert.doesNotMatch(dashboardJs, /GET \/api\/provider-health failed/);
  assert.doesNotMatch(dashboardJs, /GET \/api\/daily-automation\/latest failed/);
  assert.doesNotMatch(dashboardJs, /Extension diagnostics unavailable:\s*\$\{/);
  assert.doesNotMatch(dashboardJs, /Application Session/);
  assert.doesNotMatch(dashboardJs, /Package, Session|previous Session|draft session|Executor selection was not saved/i);
  assert.match(dashboardJs, /function applicationStatusLabel/);
  assert.match(dashboardJs, /SESSION_CREATED: 'Ready to start'/);
  assert.match(dashboardJs, /executorRunStatus'\)\.textContent = applicationStatusLabel/);
  assert.match(dashboardHtml, /id="packageProfileVisible"/);
  assert.doesNotMatch(dashboardJs, /Content hash:/);
  assert.doesNotMatch(dashboardJs, /profile\.name \|\| profile\.id/);
  assert.doesNotMatch(extensionPopup, /item\.label \|\| item\.name \|\| item\.id/);
  assert.doesNotMatch(extensionContent, /item\.label \|\| item\.name \|\| item\.id/);
  const visibleTechnicalMessage = /(?:message:\s*|new Error\()[^\n]*(?:ApplicationExecutionSession|Application Session|GET \/api)/i;
  assert.doesNotMatch(dashboardServer, visibleTechnicalMessage);
  assert.doesNotMatch(applicationState, visibleTechnicalMessage);
  assert.doesNotMatch(executionSession, visibleTechnicalMessage);
});

test('critical browser runtimes contain no unexplained empty Promise catch', () => {
  const silentPromiseCatch = /\.catch\(\(?(?:[^)]*)\)?\s*=>\s*\{\s*\}\)/;
  for (const relative of [
    'browser_agent/run.mjs',
    'extensions/application_assistant/content.js'
  ]) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, silentPromiseCatch, relative);
  }
});

test('Extension product setup does not require manual Candidate Profile loading', () => {
  const extensionReadme = fs.readFileSync(path.join(root, 'extensions', 'application_assistant', 'README.md'), 'utf8');
  assert.doesNotMatch(extensionReadme, /Create `profile\.local\.json`/i);
  assert.doesNotMatch(extensionReadme, /Reload profile/i);
  assert.match(extensionReadme, /reviewed Package's approved safe-field mappings/);
});

test('release audit enumerates Unicode paths without Git quote-path loss', () => {
  const auditSource = fs.readFileSync(path.join(root, 'scripts', 'audit_github_release.mjs'), 'utf8');
  assert.match(auditSource, /core\.quotepath=false/);
  assert.ok(auditSource.includes(".split('\\0')"));
  assert.match(auditSource, /compiled_runtime_cache/);
  assert.match(auditSource, /goal_mode\|logs\|output\|tmp/);
});
