import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalizeExecutorMode } from '../application_executor/executor_interface.mjs';
import { createApplicationExecutionSession } from '../application_executor/execution_session.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the Local Browser Agent is the default executor for unknown and empty selections', () => {
  assert.equal(normalizeExecutorMode(''), 'local_browser_agent');
  assert.equal(normalizeExecutorMode(undefined), 'local_browser_agent');
  assert.equal(normalizeExecutorMode('typo-mode'), 'local_browser_agent');
  assert.equal(normalizeExecutorMode('browser_agent'), 'local_browser_agent');
  assert.equal(normalizeExecutorMode('extension'), 'extension');
});

test('a session created without an explicit executor uses the Local Browser Agent', () => {
  const session = createApplicationExecutionSession({
    applicationPackage: {
      status: 'PACKAGE_READY', application_id: 'application-cap', job_id: 'cap-job', package_id: 'package-cap',
      career_profile_reference: {
        profile_id: 'career-cap', family_id: 'career-cap', version: 1,
        user_approved: true, approved_at: '2026-08-15T00:00:00.000Z'
      },
      application_profile: {
        full_name: 'Synthetic Candidate', email: 'candidate@example.test',
        approved_for_real_applications: true
      },
      application_answers: []
    },
    job: { job_id: 'cap-job' },
    targetUrl: 'https://jobs.lever.co/acme/cap-job/apply',
    idempotencyKey: 'cap-session'
  });
  assert.equal(session.executor_type, 'local_browser_agent');
});

test('GET /api/executor-capabilities reports an honest default and experimental extension', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-capabilities-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'),
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'),
      RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
      RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json')
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
    const client = `
      const response = await fetch('http://127.0.0.1:${port}/api/executor-capabilities');
      process.stdout.write(JSON.stringify({status: response.status, value: await response.json()}));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const { status, value } = JSON.parse(result.stdout);
    assert.equal(status, 200);
    assert.equal(value.recommended, 'local_browser_agent');
    const agent = value.executors.local_browser_agent;
    const extension = value.executors.extension;
    assert.equal(typeof agent.available, 'boolean');
    assert.equal(agent.experimental, false);
    assert.equal(agent.supports_rescan, true);
    assert.equal(agent.supports_learning, true);
    assert.equal(extension.experimental, true);
    assert.equal(extension.supports_rescan, false);
    assert.equal(extension.available, false);
    assert.ok(extension.requirements.length >= 1);
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
