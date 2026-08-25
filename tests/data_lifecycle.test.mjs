// Contract for the two delete actions a normal user gets.
//
//   "Clear job materials"     removes the online profile, resumes, tailored
//                             documents, saved answers and learned field rules
//                             — but KEEPS the record of what you already
//                             applied to.
//   "Delete all user data"    removes everything, including the browser
//                             profile that holds logged-in sessions.
//
// The distinction only matters if it actually holds, so this test asserts what
// survives as carefully as what disappears.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freePort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  return port;
}

function seedWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-lifecycle-'));
  const dirs = {
    root,
    data: path.join(root, 'data'),
    archive: path.join(root, 'archive'),
    reports: path.join(root, 'reports'),
    applications: path.join(root, 'applications'),
    documents: path.join(root, 'documents'),
    resumes: path.join(root, 'documents', 'resumes'),
    browserProfiles: path.join(root, 'browser_profiles'),
    browserSessions: path.join(root, 'browser_sessions')
  };
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true });

  const write = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

  // Job-seeking materials.
  write(path.join(dirs.data, 'career_profiles.local.json'), {
    schema_version: '1.0',
    active_profile_id: 'career_synthetic',
    profiles: [{ id: 'career_synthetic', family_id: 'career_synthetic', version: 1, state: 'approved', user_approved: true }]
  });
  write(path.join(dirs.data, 'question_bank.json'), {
    version: '2.0',
    answers: [{ original_question: 'Synthetic question?', answer: 'Synthetic answer', user_confirmed: true }]
  });
  write(path.join(dirs.data, 'resume_profiles.json'), {
    schema_version: '2.0', active_resume_id: 'synthetic_v1', active_resume_profile_id: 'synthetic_v1', items: []
  });
  write(path.join(dirs.data, 'form_field_memory.local.json'), { version: '1.0', records: [] });
  fs.writeFileSync(path.join(dirs.resumes, 'synthetic_v1.txt'), 'synthetic resume text\n');
  fs.mkdirSync(path.join(dirs.applications, 'job_history'), { recursive: true });
  fs.writeFileSync(path.join(dirs.applications, 'job_history', 'application_package.json'), '{}\n');

  // History that must survive "clear job materials".
  write(path.join(dirs.data, 'job_reviews.json'), [
    { job_id: 'job_history', decision: 'approved' },
    { job_id: 'job_inflight', decision: 'approved' }
  ]);
  write(path.join(dirs.data, 'job_leads.json'), [
    { job_id: 'job_history', title: 'Synthetic Role' },
    { job_id: 'job_inflight', title: 'Synthetic Role Two' }
  ]);
  write(path.join(dirs.data, 'dashboard_state.json'), {
    version: '1.1.0',
    created_at: '2026-01-01T00:00:00.000Z',
    application_status_overrides: {
      job_history: {
        job_id: 'job_history',
        application_status: 'MANUALLY_SUBMITTED',
        active_session_id: 'session-history',
        latest_review_rescan: { scan_id: 'stale' }
      },
      job_inflight: {
        job_id: 'job_inflight',
        application_status: 'EXECUTING',
        active_session_id: 'session-inflight'
      }
    },
    application_execution_sessions: {
      'session-history': { session_id: 'session-history', job_id: 'job_history' },
      'session-inflight': { session_id: 'session-inflight', job_id: 'job_inflight' }
    },
    audit_events: [{ event: 'synthetic_audit_event', at: '2026-01-01T00:00:00.000Z' }],
    run_history: []
  });

  // Browser state: personal data, must not survive a full reset.
  fs.writeFileSync(path.join(dirs.browserProfiles, 'cookies.synthetic'), 'synthetic\n');

  return dirs;
}

function startDashboard(dirs, port) {
  return spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RESUME_JOBS_DATA_DIR: dirs.data,
      RESUME_JOBS_REPORTS_DIR: dirs.reports,
      RESUME_JOBS_APPLICATIONS_DIR: dirs.applications,
      RESUME_JOBS_ARCHIVE_DIR: dirs.archive,
      RESUME_JOBS_DOCUMENTS_DIR: dirs.documents,
      RESUME_JOBS_RESUME_LIBRARY_DIR: dirs.resumes,
      RESUME_JOBS_BROWSER_PROFILES_DIR: dirs.browserProfiles,
      RESUME_JOBS_BROWSER_SESSIONS_DIR: dirs.browserSessions,
      RESUME_JOBS_PROFILE_PATH: path.join(dirs.root, 'profile.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

function awaitReady(dashboard) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 10000);
    dashboard.stdout.on('data', chunk => {
      if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
    });
    dashboard.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}.`)); });
  });
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

test('clearing job materials removes candidate data but keeps application history', async () => {
  const dirs = seedWorkspace();
  const port = await freePort();
  const dashboard = startDashboard(dirs, port);
  try {
    await awaitReady(dashboard);

    const outcome = callApi(port, `
      const unconfirmed = await request('/api/data/clear-job-materials', {
        method:'POST', body: JSON.stringify({ confirmed: true })
      });
      const wrongText = await request('/api/data/clear-job-materials', {
        method:'POST', body: JSON.stringify({ confirmed: true, confirmation_text: 'nope' })
      });
      const cleared = await request('/api/data/clear-job-materials', {
        method:'POST', body: JSON.stringify({ confirmed: true, confirmation_text: 'CLEAR JOB MATERIALS' })
      });
      process.stdout.write(JSON.stringify({
        unconfirmed_status: unconfirmed.status,
        unconfirmed_code: unconfirmed.value.code,
        keeps: unconfirmed.value.keeps,
        wrong_text_status: wrongText.status,
        cleared_status: cleared.status,
        cleared: cleared.value
      }));
    `);

    // The confirmation gate states what goes and what stays before doing anything.
    assert.equal(outcome.unconfirmed_status, 409);
    assert.equal(outcome.unconfirmed_code, 'CLEAR_JOB_MATERIALS_CONFIRMATION_REQUIRED');
    assert.ok(outcome.keeps.includes('application history'));
    assert.equal(outcome.wrong_text_status, 409, 'a mistyped confirmation must not delete anything');
    assert.equal(outcome.cleared_status, 200);
    assert.equal(outcome.cleared.scope, 'job_materials_only');

    // Materials are gone.
    for (const name of ['career_profiles.local.json', 'question_bank.json', 'form_field_memory.local.json']) {
      assert.equal(fs.existsSync(path.join(dirs.data, name)), false, `${name} should have been cleared`);
    }
    assert.deepEqual(fs.readdirSync(dirs.resumes), [], 'uploaded resumes should have been cleared');
    assert.deepEqual(fs.readdirSync(dirs.applications), [], 'prepared application files should have been cleared');

    // History survives.
    const reviews = JSON.parse(fs.readFileSync(path.join(dirs.data, 'job_reviews.json'), 'utf8'));
    assert.equal(reviews.length, 2, 'job decisions are history, not materials');
    assert.ok(fs.existsSync(path.join(dirs.data, 'job_leads.json')), 'discovered jobs are not candidate materials');

    const state = JSON.parse(fs.readFileSync(path.join(dirs.data, 'dashboard_state.json'), 'utf8'));
    assert.ok(state.application_status_overrides.job_history, 'a submitted application must stay in history');
    assert.equal(
      state.application_status_overrides.job_history.application_status,
      'MANUALLY_SUBMITTED'
    );
    assert.equal(
      state.application_status_overrides.job_inflight,
      undefined,
      'an in-flight application refers to deleted materials and must not linger'
    );
    assert.equal(
      state.application_status_overrides.job_history.active_session_id,
      undefined,
      'history must not point at a session that no longer exists'
    );
    assert.deepEqual(state.application_execution_sessions, {});
    assert.equal(state.audit_events.length, 1, 'audit events are history');
    assert.equal(state.local_reset_scope, 'job_materials_only');
    assert.equal(outcome.cleared.preserved.application_history_count, 1);
    assert.equal(outcome.cleared.preserved.in_flight_applications_discarded, 1);

    // A backup exists for every destructive write.
    assert.ok(fs.readdirSync(dirs.archive).length > 0, 'clearing must leave a restorable backup');
    assert.ok(
      fs.readdirSync(dirs.archive).some(name => name.startsWith('career_profiles.local.json.')),
      'the online profile must be backed up before deletion'
    );
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('deleting one uploaded resume leaves the confirmed online profile intact', async () => {
  // The online profile is the source of truth. An uploaded resume is only the
  // document the profile was generated from, so removing it must not roll back
  // facts the user already confirmed.
  const dirs = seedWorkspace();
  fs.writeFileSync(path.join(dirs.data, 'resume_profiles.json'), `${JSON.stringify({
    schema_version: '2.0',
    active_resume_id: 'synthetic_v1',
    active_resume_profile_id: 'synthetic_v1',
    items: [{
      id: 'synthetic_v1',
      resume_id: 'synthetic_v1',
      name: 'Synthetic Resume',
      version: 1,
      resume_file_path: 'documents/resumes/synthetic_v1.txt',
      content_hash: 'sha256:synthetic',
      approved_at: '2026-01-01T00:00:00.000Z',
      enabled: true
    }]
  }, null, 2)}\n`);
  const profileBefore = fs.readFileSync(path.join(dirs.data, 'career_profiles.local.json'), 'utf8');

  const port = await freePort();
  const dashboard = startDashboard(dirs, port);
  try {
    await awaitReady(dashboard);

    const outcome = callApi(port, `
      const unconfirmed = await request('/api/settings/resume-profiles/synthetic_v1/manage', {
        method:'POST', body: JSON.stringify({ action: 'delete', confirmed: true })
      });
      const deleted = await request('/api/settings/resume-profiles/synthetic_v1/manage', {
        method:'POST',
        body: JSON.stringify({ action: 'delete', confirmed: true, content_hash: 'sha256:synthetic' })
      });
      const profile = await request('/api/profile/full');
      process.stdout.write(JSON.stringify({
        unconfirmed_status: unconfirmed.status,
        deleted_status: deleted.status,
        deleted_local_copy: deleted.value.deleted_local_copy,
        profile_has_sections: Boolean(profile.value.sections),
        profile_approved: profile.value.approved
      }));
    `);

    assert.equal(outcome.unconfirmed_status, 409, 'deleting a resume needs the current content hash');
    assert.equal(outcome.deleted_status, 200);

    const registry = JSON.parse(fs.readFileSync(path.join(dirs.data, 'resume_profiles.json'), 'utf8'));
    assert.deepEqual(registry.items, [], 'the deleted resume must leave the registry');

    assert.equal(outcome.profile_has_sections, true, 'the online profile must survive resume deletion');
    assert.equal(
      fs.readFileSync(path.join(dirs.data, 'career_profiles.local.json'), 'utf8'),
      profileBefore,
      'deleting a resume must not rewrite the online profile at all'
    );
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});

test('deleting all user data also clears the browser profile holding logged-in sessions', async () => {
  const dirs = seedWorkspace();
  const port = await freePort();
  const dashboard = startDashboard(dirs, port);
  try {
    await awaitReady(dashboard);

    const outcome = callApi(port, `
      const reset = await request('/api/settings/reset-local-data', {
        method:'POST', body: JSON.stringify({ confirmed: true, confirmation_text: 'RESET LOCAL DATA' })
      });
      process.stdout.write(JSON.stringify({ status: reset.status, value: reset.value }));
    `);

    assert.equal(outcome.status, 200);
    assert.ok(outcome.value.removed_categories.includes('browser_profiles'));
    // The most destructive action must still be recoverable: every data
    // store is archived BEFORE the wipe, and the backups actually hold the
    // pre-wipe content (a 0-byte backup once shipped — data was deleted
    // with an empty "backup" beside it).
    assert.ok(Array.isArray(outcome.value.pre_wipe_backups) && outcome.value.pre_wipe_backups.length > 0,
      'reset must archive the data stores before deleting them');
    const careerBackup = fs.readdirSync(dirs.archive)
      .filter(name => name.startsWith('career_profiles.local.json.'))
      .map(name => path.join(dirs.archive, name))
      .sort()
      .pop();
    assert.ok(careerBackup, 'the career profile store must be among the pre-wipe backups');
    assert.ok(fs.statSync(careerBackup).size > 0, 'the pre-wipe backup must not be empty');
    assert.ok(fs.readFileSync(careerBackup, 'utf8').includes('career_synthetic'),
      'the backup must hold the real pre-wipe store content');
    assert.deepEqual(
      fs.readdirSync(dirs.browserProfiles),
      [],
      'a full delete must drop the browser profile: it holds logged-in sessions'
    );
    assert.equal(fs.existsSync(path.join(dirs.data, 'job_reviews.json')), true, 'state files are re-seeded empty');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dirs.data, 'job_reviews.json'), 'utf8')), []);
    assert.equal(fs.existsSync(path.join(dirs.data, 'job_leads.json')), false, 'a full delete removes discovered jobs');
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});
