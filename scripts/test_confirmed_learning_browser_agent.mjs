import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  buildLearningCandidates,
  confirmFormFieldMapping,
  decideLearningCandidate,
  finalizeLearningCandidate,
  recordLearningCandidates
} from './lib/learning_candidates.mjs';

async function findBrowser() {
  const candidates = [
    process.env.RESUME_JOBS_CHROME_EXECUTABLE,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  return '';
}

async function waitForJson(filePath, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8'));
      if (predicate(value)) return value;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)}.`);
}

async function removeTemporaryRoot(directory, { attempts = 6, throwOnFailure = false } = {}) {
  const expectedParent = path.resolve(os.tmpdir()).toLocaleLowerCase('en-US');
  const resolved = path.resolve(directory);
  if (!resolved.toLocaleLowerCase('en-US').startsWith(`${expectedParent}${path.sep}`)
      || !path.basename(resolved).startsWith('resume-jobs-confirmed-learning-')) {
    throw new Error('Refusing to remove a path outside the confirmed-learning test boundary.');
  }
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(resolved, { recursive: true, force: true });
      return true;
    } catch (error) {
      lastError = error;
      if (!['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (throwOnFailure) throw lastError;
  return false;
}

async function removeStaleTestRoots() {
  const entries = await readdir(os.tmpdir(), { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('resume-jobs-confirmed-learning-')) continue;
    await removeTemporaryRoot(path.join(os.tmpdir(), entry.name), { attempts: 2 });
  }
}

const activeAgents = new Set();

function startAgent(args, browser) {
  const child = spawn(process.execPath, [path.resolve('browser_agent/run.mjs'), ...args], {
    cwd: path.resolve('.'),
    env: { ...process.env, RESUME_JOBS_CHROME_EXECUTABLE: browser },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const state = { result: null };
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      const result = { code, output };
      state.result = result;
      activeAgents.delete(agent);
      resolve(result);
    });
  });
  const agent = { child, closed, state };
  activeAgents.add(agent);
  return agent;
}

async function waitForAgentStatus(agent, filePath, predicate, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'not_written';
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(filePath, 'utf8'));
      lastStatus = String(value.status || 'unknown');
      if (value.status === 'FAILED') throw new Error(`Browser Agent failed: ${value.reason || 'unknown error'}`);
      if (predicate(value)) return value;
    } catch (error) {
      if (/Browser Agent failed:/.test(String(error?.message || ''))) throw error;
    }
    if (agent.state.result) {
      throw new Error(`Browser Agent exited before the expected status (exit ${agent.state.result.code}): ${agent.state.result.output}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${path.basename(filePath)} (last status: ${lastStatus}).`);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const browser = await findBrowser();
if (!browser) throw new Error('Chrome or Edge is required for the confirmed-learning Browser Agent test.');

await removeStaleTestRoots();
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-confirmed-learning-'));
let receivedCandidates = [];
const firstSession = {
  authorized: true,
  profile_confirmed: true,
  final_submit: false,
  upload_resume: false,
  login: false,
  solve_challenge: false,
  schema: 'ApplicationExecutionSession',
  schema_version: '1.1',
  session_id: 'learning-first-session',
  application_id: 'learning-first-application',
  job_id: 'learning-first-job',
  package_id: 'learning-first-package',
  executor_type: 'local_browser_agent',
  execution_status: 'EXECUTOR_READY',
  approved_profile_version: {
    profile_id: 'career-learning-v1', family_id: 'career-learning', version: 1,
    approved_at: '2026-08-11T00:00:00.000Z', snapshot_digest: 'sha256:learning-v1'
  },
  approved_field_mappings: [
    { canonical_key: 'full_name', value: 'Synthetic Candidate', source: 'fixture', confidence: 1, user_confirmed: true }
  ],
  safety: {
    resume_upload_allowed: false, sensitive_answers_allowed: false, login_allowed: false,
    challenge_bypass_allowed: false, final_submit_allowed: false
  }
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/learning') {
    const body = await readBody(req);
    receivedCandidates = buildLearningCandidates({
      session: firstSession,
      baselineSnapshot: body.baseline_snapshot,
      currentSnapshot: body.current_snapshot,
      now: '2026-08-11T00:01:00.000Z'
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', candidate_count: receivedCandidates.length }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const manualScript = req.url === '/first' ? `<script>
    setTimeout(() => {
      const changes = {
        current_location: 'Synthetic City',
        linkedin: 'https://example.test/synthetic-profile',
        interest: 'Synthetic reusable answer',
        candidate_hub: 'https://example.test/synthetic-hub'
      };
      for (const [id, value] of Object.entries(changes)) {
        const element = document.getElementById(id);
        element.value = value;
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, 2500);
  </script>` : '';
  const interestLabel = req.url === '/second'
    ? 'Why are you interested in this role?'
    : 'What interests you about this role?';
  res.end(`<!doctype html><html><body><form>
    <label for="name">Full name</label><input id="name" name="name">
    <label for="current_location">Current location</label><input id="current_location" name="current_location">
    <label for="linkedin">LinkedIn</label><input id="linkedin" name="linkedin" type="url">
    <label for="interest">${interestLabel}</label><textarea id="interest" name="interest"></textarea>
    <label for="candidate_hub">Preferred professional hub</label><input id="candidate_hub" name="candidate_hub" type="url">
    <label for="resume">Resume</label><input id="resume" name="resume" type="file">
    <button type="submit">Submit application</button>
  </form>${manualScript}</body></html>`);
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

try {
  const { port } = server.address();
  firstSession.target_url = `http://127.0.0.1:${port}/first`;
  firstSession.url = firstSession.target_url;
  firstSession.learning_callback_url = `http://127.0.0.1:${port}/learning`;
  const firstDir = path.join(temporaryRoot, 'first');
  const firstContext = path.join(firstDir, 'context.json');
  const firstStatus = path.join(firstDir, 'status.json');
  const firstReport = path.join(firstDir, 'ApplicationExecution.json');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(firstDir, { recursive: true }));
  await writeFile(firstContext, JSON.stringify(firstSession, null, 2));
  const firstAgent = startAgent([
    '--context', firstContext, '--report', firstReport, '--status', firstStatus,
    '--screenshots', path.join(firstDir, 'screenshots'), '--profile-dir', path.join(firstDir, 'profile'), '--headless-test'
  ], browser);
  await waitForAgentStatus(firstAgent, firstStatus, value => value.status === 'PAUSED_FOR_USER_REVIEW');
  await new Promise(resolve => setTimeout(resolve, 2800));
  await writeFile(path.join(firstDir, 'retry-command.json'), JSON.stringify({
    command: 'review_rescan', session_id: firstSession.session_id, scan_id: 'learning-review-rescan'
  }));
  const rescanned = await waitForAgentStatus(firstAgent, firstStatus, value => value.status === 'REVIEW_RESCANNED');
  assert.equal(rescanned.learning_candidate_callback.status, 'sent');
  assert.equal(receivedCandidates.length, 4);
  firstAgent.child.kill('SIGTERM');
  const firstClosed = await firstAgent.closed;
  assert.ok(firstClosed.code === 0 || firstClosed.code === null, firstClosed.output);

  let learningStore = recordLearningCandidates({}, receivedCandidates, { now: '2026-08-11T00:01:00.000Z' });
  let fieldMemory = {};
  const confirmed = [];
  for (const original of receivedCandidates) {
    const isHub = original.field_ref === 'candidate_hub' || /professional hub/i.test(original.label);
    const decided = decideLearningCandidate(learningStore, {
      candidateId: original.candidate_id,
      decision: 'save',
      destination: isHub ? 'career_brain' : original.suggested_destination,
      scope: original.suggested_destination === 'answer_memory' ? 'global' : 'global',
      now: '2026-08-11T00:02:00.000Z'
    });
    learningStore = decided.store;
    const candidate = isHub
      ? { ...decided.candidate, canonical_path: 'identity.links.portfolio', executor_key: 'portfolio_url' }
      : decided.candidate;
    fieldMemory = confirmFormFieldMapping(fieldMemory, candidate, { now: '2026-08-11T00:02:00.000Z' });
    confirmed.push(candidate);
    learningStore = finalizeLearningCandidate(learningStore, original.candidate_id, {
      destination: candidate.selected_destination
    }, { now: '2026-08-11T00:03:00.000Z' });
  }
  assert.doesNotMatch(JSON.stringify(fieldMemory), /Synthetic City|Synthetic reusable answer|synthetic-profile|synthetic-hub/);
  assert.equal(learningStore.candidates.every(candidate => candidate.value === ''), true);

  const byLabel = pattern => confirmed.find(candidate => pattern.test(candidate.label));
  const location = byLabel(/current location/i);
  const linkedin = byLabel(/linkedin/i);
  const interest = byLabel(/interests you/i);
  const hub = byLabel(/professional hub/i);
  assert.ok(location && linkedin && interest && hub);
  const secondSession = {
    ...firstSession,
    session_id: 'learning-second-session',
    application_id: 'learning-second-application',
    job_id: 'learning-second-job',
    package_id: 'learning-second-package',
    target_url: `http://127.0.0.1:${port}/second`,
    url: `http://127.0.0.1:${port}/second`,
    learning_callback_url: '',
    approved_profile_version: {
      profile_id: 'career-learning-v2', family_id: 'career-learning', version: 2,
      approved_at: '2026-08-11T00:04:00.000Z', snapshot_digest: 'sha256:learning-v2'
    },
    approved_field_mappings: [
      firstSession.approved_field_mappings[0],
      { canonical_key: 'location', value: location.value, source: 'approved_learning_draft', confidence: 1, user_confirmed: true },
      { canonical_key: 'linkedin_url', value: linkedin.value, source: 'approved_learning_draft', confidence: 1, user_confirmed: true },
      { canonical_key: 'portfolio_url', value: hub.value, source: 'approved_learning_draft', confidence: 1, user_confirmed: true },
      {
        canonical_key: interest.executor_key, value: interest.value, source: 'confirmed_answer_memory',
        confidence: 1, user_confirmed: true, question_id: interest.executor_key,
        aliases: [interest.original_question]
      }
    ],
    field_memory: fieldMemory
  };
  const secondDir = path.join(temporaryRoot, 'second');
  const secondContext = path.join(secondDir, 'context.json');
  const secondStatus = path.join(secondDir, 'status.json');
  const secondReport = path.join(secondDir, 'ApplicationExecution.json');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(secondDir, { recursive: true }));
  await writeFile(secondContext, JSON.stringify(secondSession, null, 2));
  const secondAgent = startAgent([
    '--context', secondContext, '--report', secondReport, '--status', secondStatus,
    '--screenshots', path.join(secondDir, 'screenshots'), '--profile-dir', path.join(secondDir, 'profile'),
    '--headless-test', '--close-after-fill'
  ], browser);
  const secondClosed = await secondAgent.closed;
  assert.equal(secondClosed.code, 0, secondClosed.output);
  const report = JSON.parse(await readFile(secondReport, 'utf8'));
  const status = JSON.parse(await readFile(secondStatus, 'utf8'));
  assert.equal(report.counts.detected, 6);
  assert.equal(report.counts.filled, 5);
  assert.equal(report.counts.skipped, 1);
  assert.equal(report.safety.upload_attempted, false);
  assert.equal(report.safety.submit_attempted, false);
  assert.equal(report.safety.final_submit, false);
  assert.equal(status.candidate_values_redacted_in_all_screenshots, true);
  assert.doesNotMatch(JSON.stringify(report), /Synthetic Candidate|Synthetic City|Synthetic reusable answer|synthetic-profile|synthetic-hub/);
  await Promise.all(status.screenshots.map(file => access(file)));
  process.stdout.write('Confirmed-learning Browser Agent acceptance: PASS (4 candidates reviewed; 5 safe fields reused; values redacted).\n');
} finally {
  for (const agent of activeAgents) agent.child.kill('SIGTERM');
  await Promise.all([...activeAgents].map(agent => agent.closed.catch(() => null)));
  await new Promise(resolve => server.close(resolve));
  await removeTemporaryRoot(temporaryRoot);
}
