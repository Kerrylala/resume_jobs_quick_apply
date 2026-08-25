import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD_ACTIVE = process.env.RESUME_JOBS_OFFLINE_GUARD_ACTIVE === '1';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardRequired = GUARD_ACTIVE ? false : 'Run through npm test or npm run test:offline';
test('offline entry activates the network and project-write guard', { skip: guardRequired }, () => {
  assert.equal(process.env.RESUME_JOBS_OFFLINE_GUARD_ACTIVE, '1');
});

test('offline guard blocks writes inside the project', { skip: guardRequired }, async () => {
  const probe = path.join(PROJECT_ROOT, 'data', '__offline_test_guard_probe__.json');
  assert.equal(fs.existsSync(probe), false);
  assert.throws(
    () => fs.writeFileSync(probe, '{}'),
    (error) => error.code === 'OFFLINE_TEST_WRITE_BLOCKED'
  );
  assert.throws(
    () => fs.openSync(probe, 'w'),
    (error) => error.code === 'OFFLINE_TEST_WRITE_BLOCKED'
  );
  await assert.rejects(
    writeFile(probe, '{}'),
    (error) => error.code === 'OFFLINE_TEST_WRITE_BLOCKED'
  );
  assert.equal(fs.existsSync(probe), false);
});

test('offline guard blocks fetch and node:http network calls', { skip: guardRequired }, async () => {
  await assert.rejects(
    globalThis.fetch('https://offline-test.invalid'),
    (error) => error.code === 'OFFLINE_TEST_NETWORK_BLOCKED'
  );
  assert.throws(
    () => http.get('http://offline-test.invalid'),
    (error) => error.code === 'OFFLINE_TEST_NETWORK_BLOCKED'
  );
});

test('Dashboard HTTP integration uses synthetic temporary state for the real workflow endpoints', { skip: guardRequired }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-dashboard-test-'));
  const dataDir = path.join(root, 'data');
  const reportsDir = path.join(root, 'reports');
  const applicationsDir = path.join(root, 'applications');
  const archiveDir = path.join(root, 'archive');
  const resumeLibraryDir = path.join(root, 'resume-library');
  const profilePath = path.join(root, 'candidate-profile.json');
  const packageDir = path.join(applicationsDir, 'synthetic-job-001');
  for (const directory of [dataDir, reportsDir, applicationsDir, archiveDir, resumeLibraryDir, packageDir]) fs.mkdirSync(directory, { recursive: true });
  const writeJson = (filePath, value) => fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  writeJson(path.join(dataDir, 'search_preferences.json'), {
    active_search_profile_id: 'synthetic',
    search_profiles: [{
      id: 'synthetic',
      name: 'Synthetic Test',
      enabled: true,
      target_roles: ['Product Manager'],
      preferred_locations: ['Remote'],
      workplace_modes: ['remote'],
      seniority_levels: ['mid'],
      required_skills: [],
      preferred_skills: [],
      excluded_keywords: [],
      excluded_companies: [],
      posted_within_days: 30,
      job_types: ['full_time'],
      minimum_salary: null,
      maximum_search_results: 10,
      maximum_jobs_to_open: 1
    }]
  });
  writeJson(path.join(dataDir, 'jobs_shortlist.json'), [{
    job_id: 'synthetic-job-001',
    title: 'Product Manager',
    company: 'Synthetic Labs',
    location: 'Remote',
    provider: 'fixture',
    ats: 'fixture',
    url: 'http://127.0.0.1:8766/index.html',
    page_type: 'job_detail',
    recommended_decision: 'approve',
    approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic_test'] },
    application_mode: 'REVIEW_ONLY',
    submit_allowed: false,
    upload_resume_allowed: false,
    final_submit_allowed: false,
    match_score: 92
  }]);
  writeJson(path.join(dataDir, 'job_reviews.json'), [{
    job_id: 'synthetic-job-001',
    decision: 'approved',
    decided_at: '2026-01-01T00:00:00.000Z',
    decided_by: 'synthetic_test'
  }]);
  writeJson(path.join(dataDir, 'job_leads.json'), []);
  writeJson(path.join(dataDir, 'dashboard_state.json'), {
    version: '1.1.0',
    created_at: '2026-01-01T00:00:00.000Z',
    selected_job_ids: [],
    application_status_overrides: {
      'synthetic-job-001': {
        job_id: 'synthetic-job-001',
        package_status: 'preview_created',
        package_path: 'applications/synthetic-job-001'
      }
    },
    run_history: []
  });
  writeJson(path.join(packageDir, 'application_package.json'), {
    application_id: 'application_synthetic-job-001',
    job_id: 'synthetic-job-001',
    application_profile: {
      full_name: 'Synthetic Candidate',
      email: 'candidate@local.invalid',
      location: 'Remote'
    },
    selected_resume: { resume_id: 'synthetic-resume', version: 1, file_reference: 'synthetic.pdf', content_hash: 'synthetic-hash' },
    cover_letter_draft: { content: '', status: 'needs_user_input', provenance: 'not_generated', requires_review: true },
    planned_answers: [],
    answer_provenance: [],
    unanswered_questions: [],
    sensitive_questions: [],
    approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic_test'] },
    status: 'PACKAGE_READY',
    timestamps: { created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }
  });
  writeJson(path.join(packageDir, 'package_manifest.json'), {
    application_id: 'application_synthetic-job-001',
    job_id: 'synthetic-job-001',
    package_id: 'package_synthetic-job-001',
    package_status: 'preview_created'
  });

  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));

  const dashboard = spawn(process.execPath, [path.join(PROJECT_ROOT, 'dashboard', 'server.mjs')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: reportsDir,
      RESUME_JOBS_APPLICATIONS_DIR: applicationsDir,
      RESUME_JOBS_ARCHIVE_DIR: archiveDir,
      RESUME_JOBS_RESUME_LIBRARY_DIR: resumeLibraryDir,
      RESUME_JOBS_PROFILE_PATH: profilePath
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic Dashboard server did not start.')), 10000);
      dashboard.stdout.on('data', (chunk) => {
        if (String(chunk).includes('Dashboard server running')) {
          clearTimeout(timer);
          resolve();
        }
      });
      dashboard.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Synthetic Dashboard server exited early with ${code}.`));
      });
    });

    const client = `
      const base = 'http://127.0.0.1:${port}';
      const request = async (path, options = {}) => {
        const response = await fetch(base + path, { headers: { 'Content-Type': 'application/json' }, ...options });
        const value = await response.json();
        if (!response.ok) throw new Error(path + ': ' + response.status + ' ' + JSON.stringify(value));
        return value;
      };
      const resumeText = Buffer.from('Synthetic Candidate\\ncandidate@local.invalid\\nSkills: analytics, roadmapping\\nExperience\\n- Built a localhost workflow', 'utf8');
      const uploadedResume = await request('/api/settings/resume-upload', {
        method: 'POST',
        body: JSON.stringify({
          file_name: 'synthetic.txt',
          content_base64: resumeText.toString('base64'),
          display_name: 'Synthetic TXT Resume',
          activate: true,
          confirmed_local_copy: true
        })
      });
      const settingsAfterResume = await request('/api/settings');
      const workflow0 = await request('/api/workflow');
      const approvedResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(uploadedResume.resume_profile.resume_id) + '/approve',
        {
          method: 'POST',
          body: JSON.stringify({
            confirmed: true,
            content_hash: uploadedResume.resume_profile.content_hash
          })
        }
      );
      const careerBeforePackage = await request('/api/career-brain');
      const approvedCareerProfile = await request('/api/career-brain/profiles', {
        method: 'POST',
        body: JSON.stringify({
          action: 'approve',
          profile_id: careerBeforePackage.active_profile_id,
          confirmed: true
        })
      });
      const overflow = await fetch(base + '/api/workflow/selection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job_ids: ['synthetic-job-001', 'synthetic-job-002'] }) });
      const selected = await request('/api/workflow/selection', { method: 'POST', body: JSON.stringify({ job_ids: ['synthetic-job-001'] }) });
      const builtPackage = await request('/api/jobs/synthetic-job-001/build-package-preview', { method: 'POST' });
      const packageValue = await request('/api/jobs/synthetic-job-001/application-package');
      const executorBeforeStart = await request('/api/executor/status?job_id=synthetic-job-001');
      const executorSelected = await request('/api/jobs/synthetic-job-001/executor-selection', { method: 'POST', body: JSON.stringify({ executor_type: 'extension' }) });
      const approved = await request('/api/jobs/synthetic-job-001/approve-fill', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
      const started = await request('/api/jobs/synthetic-job-001/start-fill', { method: 'POST', body: JSON.stringify({ confirmed: true, executor_type: 'extension', idempotency_key: 'synthetic-start-1' }) });
      const startedReplay = await request('/api/jobs/synthetic-job-001/start-fill', { method: 'POST', body: JSON.stringify({ confirmed: true, executor_type: 'extension', idempotency_key: 'synthetic-start-1' }) });
      const handoffResponse = await fetch(base + '/api/extension/active-handoff?url=' + encodeURIComponent('http://127.0.0.1:8766/index.html'), { headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } });
      const handoff = await handoffResponse.json();
      const executorAfterHandoff = await request('/api/executor/status?job_id=synthetic-job-001');
      const unauthorizedHandoff = await fetch(base + '/api/extension/active-handoff?url=' + encodeURIComponent('http://127.0.0.1:8766/index.html'));
      const prematureSubmitted = await fetch(base + '/api/jobs/synthetic-job-001/submitted-manually', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true }) });
      const needs = await request('/api/jobs/synthetic-job-001/fill-report', { method: 'POST', body: JSON.stringify({ filled_fields_count: 2, skipped_fields_count: 1, fields_requiring_user_review_count: 1, suggested_questions_count: 1 }) });
      const recovered = await request('/api/jobs/synthetic-job-001/start-fill', { method: 'POST', body: JSON.stringify({ confirmed: true, idempotency_key: 'synthetic-resume-1' }) });
      const refilled = await request('/api/jobs/synthetic-job-001/fill-report', { method: 'POST', body: JSON.stringify({ filled_fields_count: 3, skipped_fields_count: 0, fields_requiring_user_review_count: 0, suggested_questions_count: 0 }) });
      const rescanned = await request('/api/jobs/synthetic-job-001/review-rescan-report', { method: 'POST', body: JSON.stringify({
        application_session_id: started.application_execution_session.session_id,
        scan_id: 'synthetic-review-scan-1', detected_count: 3, required_count: 3,
        required_filled_count: 3, required_empty_count: 0, unknown_required_count: 0,
        form_accessible: true, challenge_scope: 'none', submit_control_detected: true,
        high_risk_blockers: [], submission_blockers: []
      }) });
      const ready = await request('/api/jobs/synthetic-job-001/review-complete', { method: 'POST', body: JSON.stringify({
        confirmed: true, application_session_id: started.application_execution_session.session_id
      }) });
      const submitted = await request('/api/jobs/synthetic-job-001/submitted-manually', { method: 'POST', body: JSON.stringify({ confirmed: true }) });
      const historyAfterSubmit = await request('/api/applications/history');
      const jobs = await request('/api/jobs');
      const audit = await request('/api/audit?job_id=synthetic-job-001');
      const preflight = await fetch(base + '/api/jobs/synthetic-job-001/fill-report', { method: 'OPTIONS', headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Access-Control-Request-Method': 'POST' } });
      console.log(JSON.stringify({ uploadedResume, settingsAfterResume, workflow0, approvedResume, careerBeforePackage, approvedCareerProfile, overflow_status: overflow.status, selected, builtPackage, packageValue, executorBeforeStart, approved, started, startedReplay, handoff_status: handoffResponse.status, handoff, executorAfterHandoff, unauthorized_handoff_status: unauthorizedHandoff.status, premature_submitted_status: prematureSubmitted.status, needs, recovered, refilled, rescanned, ready, submitted, historyAfterSubmit, jobs, audit, preflight_status: preflight.status, preflight_origin: preflight.headers.get('access-control-allow-origin') }));
    `;
    const clientResult = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 30000
    });
    assert.equal(clientResult.status, 0, clientResult.stderr || clientResult.stdout);
    const result = JSON.parse(clientResult.stdout.trim());
    assert.equal(result.uploadedResume.intake.file_type, 'txt');
    assert.equal(result.uploadedResume.intake.content_parsed, true);
    assert.equal(result.uploadedResume.intake.candidate_facts_generated, true);
    assert.ok(result.uploadedResume.intake.candidate_facts_persisted >= 3);
    assert.equal(result.uploadedResume.safety.raw_text_saved, false);
    assert.equal(result.uploadedResume.safety.model_called, false);
    assert.equal(result.settingsAfterResume.resume_intelligence.profile_approved, false);
    assert.equal(
      result.settingsAfterResume.resume_intelligence.facts.find(fact => fact.fact_key === 'email').user_confirmed,
      false
    );
    assert.deepEqual(
      result.settingsAfterResume.resume_intelligence.facts.find(fact => fact.fact_key === 'skills').value,
      ['analytics', 'roadmapping']
    );
    assert.equal(result.workflow0.maximum_jobs_to_open, 1);
    assert.equal(result.overflow_status, 409);
    assert.deepEqual(result.selected.selected_job_ids, ['synthetic-job-001']);
    assert.equal(result.packageValue.application_id, 'application_synthetic-job-001');
    assert.equal(result.packageValue.execution_readiness.can_approve_fill, true);
    assert.equal(result.packageValue.execution_readiness.can_start_fill, false);
    assert.equal(result.executorBeforeStart.status, 'SESSION_NOT_CREATED');
    assert.equal(result.executorBeforeStart.package_id, result.builtPackage.package_id);
    assert.ok(result.executorBeforeStart.missing.includes('AI Fill approval'));
    assert.equal(result.approved.record.application_status, 'FILL_APPROVED');
    assert.equal(result.started.record.application_status, 'EXECUTING');
    assert.equal(result.started.safety.browser_opened_by_server, false);
    assert.equal(result.startedReplay.idempotent_replay, true);
    assert.equal(result.startedReplay.application_execution_session.session_id, result.started.application_execution_session.session_id);
    assert.equal(result.handoff_status, 200);
    assert.equal(result.handoff.session_id, result.started.application_execution_session.session_id);
    assert.deepEqual(result.handoff.approved_field_mappings, result.started.application_execution_session.approved_field_mappings);
    assert.equal(result.executorAfterHandoff.session_id, result.handoff.session_id);
    assert.equal(result.executorAfterHandoff.job_id, 'synthetic-job-001');
    assert.equal(result.executorAfterHandoff.package_id, result.builtPackage.package_id);
    assert.equal(result.executorAfterHandoff.approved_profile_version.profile_id, result.approvedCareerProfile.profile.id);
    assert.equal(result.executorAfterHandoff.execution_status, 'EXTENSION_CONNECTED');
    assert.equal(result.executorAfterHandoff.connected, true);
    assert.ok(result.executorAfterHandoff.missing.includes('Detected fields'));
    assert.equal(result.handoff.safety.resume_file_content_included, false);
    assert.equal(result.handoff.safety.final_submit_allowed, false);
    assert.equal(result.unauthorized_handoff_status, 403);
    assert.equal(result.premature_submitted_status, 409);
    assert.equal(result.needs.application_status, 'NEEDS_REVIEW');
    assert.equal(result.recovered.application_execution_session.session_id, result.started.application_execution_session.session_id);
    assert.equal(result.recovered.application_execution_session.recovery_count, 1);
    assert.equal(result.refilled.application_status, 'NEEDS_REVIEW');
    assert.equal(result.rescanned.review_rescan.required_empty_count, 0);
    assert.equal(result.ready.application_status, 'READY_FOR_MANUAL_SUBMIT');
    assert.equal(result.submitted.record.application_status, 'MANUALLY_SUBMITTED');
    // The submitted application lands in history as a public 'applied' entry —
    // the 已提交 tracking section in the Quick UI is built from exactly this.
    assert.equal(result.historyAfterSubmit.applications.some(entry => entry.state === 'applied' && entry.job_id === 'synthetic-job-001'), true);
    assert.equal(result.jobs[0].application_status, 'MANUALLY_SUBMITTED');
    assert.equal(result.audit.session_count, 1);
    assert.ok(result.audit.event_count >= 5);
    assert.equal(result.preflight_status, 204);
    assert.equal(result.preflight_origin, 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const dashboardHtml = fs.readFileSync(path.join(PROJECT_ROOT, 'dashboard', 'public', 'index.html'), 'utf8');
    const dashboardApp = fs.readFileSync(path.join(PROJECT_ROOT, 'dashboard', 'public', 'app.js'), 'utf8');
    for (const contract of ['buildSelectedPackagesBtn', 'packageReviewPanel', 'READY_FOR_MANUAL_SUBMIT']) assert.ok(dashboardHtml.includes(contract));
    for (const contract of ['/api/workflow/selection', '/application-package', '/approve-fill', '/start-fill', '/submitted-manually']) assert.ok(dashboardApp.includes(contract));
  } finally {
    dashboard.kill();
  }
});

test('application package CLI selects an approved synthetic resume using temporary product state', { skip: guardRequired }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-package-cli-'));
  const dataDir = path.join(root, 'data');
  const applicationsDir = path.join(root, 'applications');
  fs.mkdirSync(dataDir, { recursive: true });
  const writeJson = (name, value) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
  const job = {
    job_id: 'synthetic-cli-job', title: 'Product Manager', company: 'Synthetic Labs', location: 'Remote',
    provider: 'fixture', ats: 'fixture', url: 'https://example.invalid/jobs/1', apply_url: 'https://example.invalid/jobs/1',
    match_score: 92, page_type: 'job_detail', recommended_decision: 'approve',
    approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic'] },
    application_mode: 'REVIEW_ONLY', submit_allowed: false, upload_resume_allowed: false, final_submit_allowed: false
  };
  writeJson('jobs_shortlist.json', [job]);
  writeJson('job_reviews.json', [{ job_id: job.job_id, decision: 'approved', decided_at: '2026-08-06T00:00:00.000Z' }]);
  writeJson('question_bank.json', { answers: [] });
  writeJson('resume_profiles.json', {
    active_resume_id: 'synthetic-product-v1', active_resume_profile_id: 'synthetic-product-v1',
    items: [{
      resume_id: 'synthetic-product-v1', name: 'Synthetic Product Resume', version: 1,
      file_reference: 'temporary/synthetic.txt', content_hash: 'sha256:synthetic',
      approved_at: '2026-08-06T00:00:00.000Z', resume_file_status: 'exists',
      target_roles: ['Product Manager'], skills: ['roadmapping']
    }]
  });
  writeJson('career_profiles.local.json', {
    schema_version: '1.0',
    active_profile_id: 'career-synthetic-cli',
    profiles: [{
      id: 'career-synthetic-cli', family_id: 'career-synthetic-cli', name: 'Synthetic Career Profile',
      version: 1, state: 'approved', user_approved: true,
      created_at: '2026-08-06T00:00:00.000Z', updated_at: '2026-08-06T00:00:00.000Z',
      approved_at: '2026-08-06T00:00:00.000Z',
      identity: { full_name: 'Synthetic Candidate' }
    }]
  });
  writeJson('dashboard_state.json', {});
  const profilePath = path.join(root, 'profile.json');
  fs.writeFileSync(profilePath, `${JSON.stringify({
    approved_for_real_applications: true, allow_autofill_real_sites: false,
    allow_resume_attach: false, allow_final_submit: false, full_name: 'Synthetic Candidate',
    profile_meta: { candidate_fact_review: { snapshot_digest: 'sha256:synthetic-review' } }
  }, null, 2)}\n`);
  try {
    const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'build_application_package_preview.mjs'), '--job-id', job.job_id], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, RESUME_JOBS_DATA_DIR: dataDir, RESUME_JOBS_APPLICATIONS_DIR: applicationsDir, RESUME_JOBS_PROFILE_PATH: profilePath },
      encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.resume_selection.selected_resume.resume_id, 'synthetic-product-v1');
    assert.equal(value.summary.safety_flags.resume_uploaded, false);
    assert.equal(fs.existsSync(path.join(applicationsDir, job.job_id, 'application_package.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('profile validator reads a synthetic private profile and writes only to a temporary reports directory', { skip: guardRequired }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-profile-validator-'));
  const profilePath = path.join(root, 'profile.local.json');
  const reportsDir = path.join(root, 'reports');
  const template = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'extensions', 'application_assistant', 'profile.local.template.json'), 'utf8'));
  fs.writeFileSync(profilePath, `${JSON.stringify(template, null, 2)}\n`);
  try {
    const result = spawnSync(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'validate_profile_local.mjs')], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, RESUME_JOBS_PROFILE_PATH: profilePath, RESUME_JOBS_REPORTS_DIR: reportsDir },
      encoding: 'utf8', timeout: 15000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const value = JSON.parse(result.stdout);
    assert.equal(value.success, true);
    assert.equal(value.allow_final_submit, false);
    assert.equal(fs.existsSync(path.join(reportsDir, 'profile_local_validation_001.json')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
