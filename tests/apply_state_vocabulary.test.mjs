// /api/jobs/:id/apply-state is the single read the Quick Apply UI uses to
// render a job's status. It exists so the front end never has to map internal
// state names itself — the original Dashboard did, and promptly invented a
// fifth readiness vocabulary that disagreed with the server.
//
// The contract: one plain word, plus the checklist, plus whether the user can
// act. No state-machine constants, no session or package identifiers.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything the product promises never to show a normal user.
const INTERNAL_VOCABULARY = [
  'PACKAGE_READY', 'FILL_APPROVED', 'EXECUTOR_READY', 'EXECUTING', 'NEEDS_REVIEW',
  'READY_FOR_MANUAL_SUBMIT', 'MANUALLY_SUBMITTED', 'RECOVERY_REQUIRED',
  'package_id', 'session_id', 'executor_type', 'approved_field_mappings'
];

const PUBLIC_STATES = new Set([
  'found', 'saved', 'rejected', 'preparing', 'filling', 'needs_you',
  'awaiting_verification', 'ready_to_submit', 'applied', 'manual_only'
]);

test('apply-state answers in plain words and leaks no internal vocabulary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-apply-state-'));
  const dataDir = path.join(root, 'data');
  for (const directory of [dataDir, path.join(root, 'archive'), path.join(root, 'reports'), path.join(root, 'applications'), path.join(root, 'resumes')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const writeJson = (name, value) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);

  writeJson('job_leads.json', [{
    job_id: 'job_synthetic',
    title: 'Synthetic Data Scientist',
    company: 'Synthetic Corp',
    canonical_url: 'https://jobs.example.test/synthetic',
    url: 'https://jobs.example.test/synthetic',
    apply_url: 'https://jobs.example.test/synthetic/apply'
  }]);
  writeJson('jobs_shortlist.json', []);
  // A job mid-flight, paused on a challenge the user has to clear personally.
  writeJson('dashboard_state.json', {
    version: '1.1.0',
    created_at: '2026-01-01T00:00:00.000Z',
    application_status_overrides: {
      job_synthetic: {
        job_id: 'job_synthetic',
        application_status: 'NEEDS_REVIEW',
        active_session_id: 'session-synthetic',
        challenge_scope: 'active'
      }
    },
    application_execution_sessions: {
      'session-synthetic': {
        schema: 'ApplicationExecutionSession',
        schema_version: '1.1',
        session_id: 'session-synthetic',
        application_id: 'application_job_synthetic',
        job_id: 'job_synthetic',
        package_id: 'package-synthetic',
        executor_type: 'local_browser_agent',
        execution_status: 'NEEDS_REVIEW',
        approved_profile_version: {
          profile_id: 'career_synthetic',
          family_id: 'career_synthetic',
          version: 1,
          approved_at: '2026-01-01T00:00:00.000Z',
          snapshot_digest: 'sha256:synthetic'
        },
        approved_field_mappings: [{
          canonical_key: 'email', value: 'candidate@example.test',
          source: 'application_package', confidence: 1, user_confirmed: true
        }],
        safety: {
          resume_upload_allowed: false, sensitive_answers_allowed: false,
          login_allowed: false, challenge_bypass_allowed: false, final_submit_allowed: false
        },
        target_url: 'https://jobs.example.test/synthetic/apply',
        // What a real re-scan reports when the page put up a challenge.
        latest_review_rescan: {
          scan_id: 'scan-synthetic',
          challenge_scope: 'active',
          detected_count: 4,
          required_count: 3,
          required_filled_count: 2,
          required_empty_count: 1
        }
      }
    },
    audit_events: [],
    run_history: []
  });

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'),
      RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
      RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'),
      RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
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
      const base = 'http://127.0.0.1:${port}';
      const applyState = await fetch(base + '/api/jobs/job_synthetic/apply-state');
      const checklist = await fetch(base + '/api/applications/job_synthetic/checklist');
      const missing = await fetch(base + '/api/jobs/job_absent/apply-state');
      process.stdout.write(JSON.stringify({
        apply_state: await applyState.json(),
        apply_state_raw: undefined,
        checklist: await checklist.json(),
        missing_status: missing.status
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
      encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    const applyState = outcome.apply_state;

    assert.equal(applyState.status, 'ok');
    assert.equal(applyState.title, 'Synthetic Data Scientist');
    assert.equal(applyState.company, 'Synthetic Corp');

    // One plain word, from a closed vocabulary.
    assert.ok(
      PUBLIC_STATES.has(applyState.state),
      `"${applyState.state}" is not one of the states the product shows users`
    );
    // A challenge the user must clear is its own state, not "needs you".
    assert.equal(
      applyState.state, 'awaiting_verification',
      'a page stuck on a live challenge must say it is waiting for the user to verify'
    );
    assert.equal(applyState.needs_attention_reason, 'verification_required');

    // The checklist is the same computation the review gate uses.
    assert.equal(applyState.things_left, outcome.checklist.things_left);
    assert.deepEqual(
      applyState.checklist.map(item => item.id),
      outcome.checklist.items.map(item => item.id),
      'apply-state and the checklist endpoint must render the same list'
    );

    // Nothing internal leaks, at any depth.
    const serialized = JSON.stringify(applyState);
    for (const term of INTERNAL_VOCABULARY) {
      assert.equal(
        serialized.includes(term), false,
        `apply-state leaked internal vocabulary: ${term}`
      );
    }

    assert.equal(outcome.missing_status, 404);
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
