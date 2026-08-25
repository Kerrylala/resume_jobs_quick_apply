import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createApprovalSafety } from '../scripts/lib/approval_safety.mjs';
import { normalizeCareerProfile } from '../scripts/lib/career_brain.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JOB_ID = 'job_76d22281aeca76ae';

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function freeLoopbackPort() {
  const probe = spawnSync(process.execPath, ['-e', `
    const net = require('node:net');
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  return Number(probe.stdout.trim());
}

function runClient(port, source) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const base = 'http://127.0.0.1:${port}';
    const request = async (pathname, options = {}) => {
      const response = await fetch(base + pathname, {
        headers: { 'Content-Type': 'application/json' },
        ...options
      });
      return { http_status: response.status, value: await response.json() };
    };
    ${source}
  `], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function approvedCareerProfile() {
  return normalizeCareerProfile({
    id: 'career-approved-v1', family_id: 'career-family', name: 'Recovery Candidate', version: 1,
    state: 'approved', user_approved: true, approved_at: '2026-08-01T00:00:00.000Z',
    source_resume_ids: ['resume-v1'],
    identity: {
      full_name: 'Recovery Candidate', first_name: 'Recovery', last_name: 'Candidate',
      email: 'candidate@local.invalid', phone: '000-000-0000', current_location: 'Remote',
      links: { linkedin: 'https://linkedin.example/recovery', github: '', portfolio: '', other: [] }
    },
    education: [], experience: [], projects: [],
    skills: { programming: ['JavaScript'], ai_tools: [], frameworks: [], cloud: [], data: [], business: [] },
    certifications: [], languages: [], interview_stories: [], career_goals: ['Software Engineer']
  }, { now: '2026-08-01T00:00:00.000Z' });
}

test('exact legacy FILL_STARTED fixture recovers through the product API without erasing history or starting execution', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-legacy-recovery-'));
  const dataDir = path.join(root, 'data');
  const applicationsDir = path.join(root, 'applications');
  const archiveDir = path.join(root, 'archive');
  const reportsDir = path.join(root, 'reports');
  const resumeLibraryDir = path.join(root, 'resume-library');
  for (const directory of [dataDir, applicationsDir, archiveDir, reportsDir, resumeLibraryDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const job = {
    job_id: JOB_ID, title: 'Software Engineer, Benchmarking', company: 'Epoch AI', location: 'Remote',
    description_text: 'Software engineering and benchmarking for AI research.',
    provider: 'lever', ats: 'lever', page_type: 'job_detail',
    url: `https://jobs.lever.co/epoch/${JOB_ID}/apply`,
    apply_url: `https://jobs.lever.co/epoch/${JOB_ID}/apply`,
    match_score: 88, recommended_decision: 'approve', approval_status: 'approved',
    approval_safety: createApprovalSafety('safe_to_approve', true, []),
    application_mode: 'REVIEW_ONLY', submit_allowed: false,
    upload_resume_allowed: false, final_submit_allowed: false
  };
  const approvedProfile = approvedCareerProfile();
  const activeDraft = normalizeCareerProfile({
    ...approvedProfile,
    id: 'career-active-v2', family_id: approvedProfile.family_id, version: 2,
    state: 'draft', user_approved: false, approved_at: null,
    parent_version_id: approvedProfile.id, updated_at: '2026-08-02T00:00:00.000Z'
  }, { now: '2026-08-02T00:00:00.000Z' });
  const resumeFile = path.join(resumeLibraryDir, 'resume-v1.pdf');
  fs.writeFileSync(resumeFile, '%PDF-1.4\n% recovery fixture\n', 'utf8');
  const resume = {
    id: 'resume-v1', resume_id: 'resume-v1', name: 'Approved Resume', version: 1,
    file_reference: resumeFile, resume_file_path: resumeFile,
    content_hash: 'sha256:approved-resume', approved_at: '2026-08-01T00:00:00.000Z',
    enabled: true, archived_at: null, target_roles: ['Software Engineer'], skills: ['JavaScript'],
    allow_resume_attach: false, allow_final_submit: false
  };
  writeJson(path.join(dataDir, 'jobs_shortlist.json'), [job]);
  writeJson(path.join(dataDir, 'job_reviews.json'), [{
    job_id: JOB_ID, decision: 'approved', decided_at: '2026-08-01T00:00:00.000Z', decided_by: 'fixture'
  }]);
  writeJson(path.join(dataDir, 'career_profiles.local.json'), {
    schema_version: '1.0', active_profile_id: activeDraft.id, profiles: [approvedProfile, activeDraft]
  });
  writeJson(path.join(dataDir, 'resume_profiles.json'), {
    active_resume_profile_id: resume.resume_id, items: [resume]
  });
  writeJson(path.join(dataDir, 'question_bank.json'), { version: '2.0', answers: [] });
  writeJson(path.join(dataDir, 'dashboard_state.json'), {
    version: '1.1.0', selected_job_ids: [JOB_ID],
    application_status_overrides: {
      [JOB_ID]: {
        job_id: JOB_ID, application_id: `application_${JOB_ID}`,
        application_status: 'FILL_STARTED', status: 'FILL_STARTED',
        package_id: 'legacy-package', package_path: `applications/${JOB_ID}`,
        fill_approved_at: '2026-08-03T00:00:00.000Z',
        fill_started_at: '2026-08-03T00:01:00.000Z',
        active_run_id: 'legacy-run', latest_fill_report: { counts: { detected: 2, filled: 1 } }
      }
    },
    application_runs: {
      'legacy-run': {
        run_id: 'legacy-run', application_id: `application_${JOB_ID}`, job_id: JOB_ID,
        status: 'FILL_STARTED', reports: [{ report_id: 'legacy-report', detected: 2, filled: 1 }]
      }
    },
    audit_events: [{ event_id: 'legacy-audit', event_type: 'FILL_STARTED', job_id: JOB_ID }]
  });
  const oldPackageDir = path.join(applicationsDir, JOB_ID);
  writeJson(path.join(oldPackageDir, 'application_package.json'), {
    application_id: `application_${JOB_ID}`, job_id: JOB_ID, status: 'PACKAGE_READY',
    career_profile_reference: {
      profile_id: activeDraft.id, family_id: activeDraft.family_id, version: 2,
      user_approved: false, approved_at: null
    },
    selected_resume: { resume_id: resume.resume_id, version: 1, approved_at: resume.approved_at },
    application_profile: { profile_meta: { candidate_fact_review: { snapshot_digest: 'sha256:legacy-draft' } } }
  });
  writeJson(path.join(oldPackageDir, 'package_manifest.json'), {
    application_id: `application_${JOB_ID}`, job_id: JOB_ID, package_id: 'legacy-package', files: []
  });

  const port = freeLoopbackPort();
  const dashboard = spawn(process.execPath, [path.join(PROJECT_ROOT, 'dashboard', 'server.mjs')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env, PORT: String(port),
      RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: reportsDir,
      RESUME_JOBS_APPLICATIONS_DIR: applicationsDir,
      RESUME_JOBS_ARCHIVE_DIR: archiveDir,
      RESUME_JOBS_RESUME_LIBRARY_DIR: resumeLibraryDir
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Recovery fixture Dashboard did not start.')), 10_000);
      dashboard.stdout.on('data', chunk => {
        if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
      });
      dashboard.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Recovery fixture Dashboard exited early with ${code}.`));
      });
    });

    const result = runClient(port, `
      const before = await request('/api/jobs/${JOB_ID}/application-package');
      const blockedRebuild = await request('/api/jobs/${JOB_ID}/build-package-preview', {
        method: 'POST', body: JSON.stringify({ resume_id: 'resume-v1' })
      });
      const selected = await request('/api/jobs/${JOB_ID}/executor-selection', {
        method: 'POST', body: JSON.stringify({ executor_type: 'local_browser_agent' })
      });
      const recovered = await request('/api/jobs/${JOB_ID}/recover-execution', {
        method: 'POST', body: JSON.stringify({
          confirmed: true, idempotency_key: 'recover-exact-fixture', executor_type: 'local_browser_agent'
        })
      });
      const replay = await request('/api/jobs/${JOB_ID}/recover-execution', {
        method: 'POST', body: JSON.stringify({
          confirmed: true, idempotency_key: 'recover-exact-fixture', executor_type: 'local_browser_agent'
        })
      });
      const after = await request('/api/jobs/${JOB_ID}/application-package');
      const draftExtension = await request('/api/jobs/${JOB_ID}/executor-selection', {
        method: 'POST', body: JSON.stringify({ executor_type: 'extension' })
      });
      const draftLocal = await request('/api/jobs/${JOB_ID}/executor-selection', {
        method: 'POST', body: JSON.stringify({ executor_type: 'local_browser_agent' })
      });
      const executorStatus = await request('/api/executor/status?job_id=${JOB_ID}');
      const approved = await request('/api/jobs/${JOB_ID}/approve-fill', {
        method: 'POST', body: JSON.stringify({ confirmed: true })
      });
      const ready = await request('/api/jobs/${JOB_ID}/application-package');
      process.stdout.write(JSON.stringify({ before, blockedRebuild, selected, recovered, replay, after, draftExtension, draftLocal, executorStatus, approved, ready }));
    `);

    assert.equal(result.before.http_status, 200);
    assert.equal(result.before.value.execution_recovery.required, true);
    assert.equal(result.blockedRebuild.http_status, 409);
    assert.equal(result.blockedRebuild.value.code, 'LEGACY_EXECUTION_RECOVERY_REQUIRED');
    assert.equal(result.blockedRebuild.value.recovery_action.label, 'Recover and rebuild');
    assert.equal(result.selected.value.executor_type, 'local_browser_agent');
    assert.equal(result.recovered.http_status, 200);
    assert.equal(result.recovered.value.application_status, 'PACKAGE_READY');
    assert.equal(result.recovered.value.application_execution_session.schema_version, '1.1');
    assert.equal(result.recovered.value.application_execution_session.execution_status, 'SESSION_CREATED');
    assert.equal(result.recovered.value.application_execution_session.executor_type, 'local_browser_agent');
    assert.equal(result.recovered.value.approved_profile_version.profile_id, approvedProfile.id);
    assert.equal(result.recovered.value.resume_version.resume_id, resume.resume_id);
    assert.deepEqual(result.recovered.value.superseded_legacy_run_ids, ['legacy-run']);
    assert.equal(result.replay.value.idempotent_replay, true);
    assert.equal(result.replay.value.application_execution_session.session_id, result.recovered.value.application_execution_session.session_id);
    assert.equal(result.after.value.execution_recovery.required, false);
    assert.equal(result.after.value.application_status, 'PACKAGE_READY');
    assert.equal(result.after.value.execution_readiness.can_approve_fill, true);
    assert.equal(result.after.value.fill_started_at, null);
    assert.equal(result.draftExtension.value.application_execution_session.executor_type, 'extension');
    assert.equal(result.draftLocal.value.application_execution_session.executor_type, 'local_browser_agent');
    assert.equal(result.executorStatus.value.session_id, result.recovered.value.application_execution_session.session_id);
    assert.equal(result.executorStatus.value.package_id, result.recovered.value.package_id);
    assert.equal(result.executorStatus.value.approved_profile_version.profile_id, approvedProfile.id);
    assert.equal(result.executorStatus.value.executor, 'local_browser_agent');
    assert.equal(result.executorStatus.value.url, job.apply_url);
    assert.equal(result.approved.http_status, 200);
    assert.equal(result.ready.value.application_status, 'FILL_APPROVED');
    assert.equal(result.ready.value.execution_readiness.can_start_fill, true);
    assert.equal(result.ready.value.application_execution_session.execution_status, 'SESSION_CREATED');

    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'dashboard_state.json'), 'utf8'));
    assert.equal(persisted.legacy_application_runs['legacy-run'].status, 'SUPERSEDED');
    assert.equal(persisted.legacy_application_runs['legacy-run'].reports[0].report_id, 'legacy-report');
    assert.equal(persisted.audit_events.some(event => event.event_id === 'legacy-audit'), true);
    assert.equal(Object.keys(persisted.application_execution_sessions).length, 1);
    assert.equal(persisted.application_status_overrides[JOB_ID].latest_fill_report, null);
    assert.equal(fs.readdirSync(archiveDir).length >= 7, true);
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
  }
});
