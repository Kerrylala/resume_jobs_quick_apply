import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildApplicationProfileView } from '../scripts/lib/application_profile_view.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function approvedCareerProfile() {
  return {
    id: 'career-approved', family_id: 'career-family', version: 1, name: 'Synthetic Profile',
    state: 'approved', user_approved: true, approved_at: '2026-08-15T00:00:00.000Z',
    identity: {
      full_name: 'Synthetic Candidate', first_name: 'Synthetic', last_name: 'Candidate',
      email: 'candidate@example.test', phone: '+1 555 0100', city: 'Shanghai', country: 'China',
      links: { linkedin: 'https://linkedin.example.test/in/synthetic' }
    },
    education: [], experience: [], projects: [], skills: {}, certifications: [], languages: [],
    interview_stories: [], career_goals: [],
    job_preferences: { work_authorization: 'Citizen', sponsorship: 'Not required' },
    field_provenance: {}
  };
}

test('the readiness view counts executor-usable fields and safe reusable answers from one source', () => {
  const view = buildApplicationProfileView({
    careerProfile: approvedCareerProfile(),
    answerMemory: {
      answers: [
        { original_question: 'Notice period?', answer: 'Synthetic 30 days', source: 'user_confirmed', user_confirmed: true },
        { original_question: 'Sponsorship?', answer: 'Synthetic', source: 'user_confirmed', user_confirmed: true, risk_level: 'high' },
        { original_question: 'Why us?', answer: 'Synthetic', source: 'model_suggested' }
      ]
    }
  });
  assert.equal(view.approved, true);
  assert.equal(view.readiness.basic_fields.total, 9);
  assert.equal(view.readiness.ready_for_safe_fill, true);
  assert.ok(view.readiness.basic_fields.filled >= 6);
  assert.deepEqual(view.readiness.basic_fields.missing.sort(), ['github_url', 'portfolio_url'].sort());
  assert.equal(view.readiness.saved_answers, 2);
  assert.equal(view.readiness.safe_reusable_answers, 1);
  assert.equal(view.profile.location, 'Shanghai, China');
});

test('an unapproved profile is never ready and asks the user to approve it', () => {
  const view = buildApplicationProfileView({
    careerProfile: { ...approvedCareerProfile(), user_approved: false },
    answerMemory: { answers: [] }
  });
  assert.equal(view.approved, false);
  assert.equal(view.profile, null);
  assert.equal(view.readiness.ready_for_safe_fill, false);
  assert.equal(view.readiness.needs_user[0].kind, 'profile_approval');
});

test('GET and PUT /api/application-profile read and patch the Career Brain with versioning intact', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-profile-api-'));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'career_profiles.local.json'), `${JSON.stringify({
    schema_version: '1.0', active_profile_id: 'career-approved',
    profiles: [approvedCareerProfile()]
  }, null, 2)}\n`);

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
      const base = 'http://127.0.0.1:${port}';
      const request = async (url, options={}) => {
        const response = await fetch(base + url, {headers:{'content-type':'application/json'}, ...options});
        return {status: response.status, value: await response.json()};
      };
      const before = await request('/api/application-profile');
      const editedOnly = await request('/api/application-profile', {
        method:'PUT',
        body: JSON.stringify({patch:{identity:{city:'Beijing'},job_preferences:{notice_period:'30 days'}}})
      });
      const afterEdit = await request('/api/application-profile');
      const reapproved = await request('/api/application-profile', {
        method:'PUT',
        body: JSON.stringify({patch:{identity:{city:'Beijing'}}, approve:true, confirmed:true})
      });
      const rejectedPatch = await request('/api/application-profile', {
        method:'PUT', body: JSON.stringify({patch:{identity:{allow_final_submit:true}}})
      });
      process.stdout.write(JSON.stringify({
        before: {approved: before.value.approved, location: before.value.profile.location,
                 ready: before.value.readiness.ready_for_safe_fill},
        edited_status: editedOnly.status,
        after_edit: {approved: afterEdit.value.approved, ready: afterEdit.value.readiness.ready_for_safe_fill},
        reapproved: {status: reapproved.status, approved: reapproved.value.approved,
                     location: reapproved.value.profile ? reapproved.value.profile.location : null,
                     notice: reapproved.value.profile ? reapproved.value.profile.work_situation.notice_period : null},
        rejected_patch_status: rejectedPatch.status,
        rejected_patch_code: rejectedPatch.value.code
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);
    assert.equal(outcome.before.approved, true);
    assert.equal(outcome.before.location, 'Shanghai, China');
    assert.equal(outcome.before.ready, true);
    assert.equal(outcome.edited_status, 200);
    assert.equal(outcome.after_edit.approved, false);
    assert.equal(outcome.after_edit.ready, false);
    assert.equal(outcome.reapproved.status, 200);
    assert.equal(outcome.reapproved.approved, true);
    assert.equal(outcome.reapproved.location, 'Beijing, China');
    assert.equal(outcome.reapproved.notice, '30 days');
    assert.equal(outcome.rejected_patch_status, 400);
    assert.equal(outcome.rejected_patch_code, 'EMPTY_APPLICATION_PROFILE_PATCH');
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
