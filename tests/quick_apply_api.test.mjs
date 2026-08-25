import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Quick Apply preflight, checklist, and start are thin orchestrations over the existing flow', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-quick-apply-'));
  const dataDir = path.join(root, 'data');
  const applicationsDir = path.join(root, 'applications');
  for (const directory of [dataDir, applicationsDir, path.join(root, 'archive'), path.join(root, 'reports'), path.join(root, 'resumes')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const writeJson = (name, value) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
  const jobId = 'quick-apply-job-001';
  const job = {
    job_id: jobId,
    title: 'Product Manager',
    company: 'Synthetic Labs',
    location: 'Remote',
    url: 'https://boards.greenhouse.io/synthetic/jobs/123456',
    canonical_url: 'https://boards.greenhouse.io/synthetic/jobs/123456',
    apply_url: 'https://boards.greenhouse.io/synthetic/jobs/123456',
    provider: 'greenhouse',
    ats: 'greenhouse',
    page_type: 'job_detail',
    recommended_decision: 'shortlist',
    description_text: 'Synthetic role description for the quick apply contract test. '.repeat(6),
    info_quality: { score: 100 },
    confidence: 0.95,
    match_score: 88,
    approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic_test'] },
    application_mode: 'REVIEW_ONLY',
    submit_allowed: false,
    upload_resume_allowed: false,
    final_submit_allowed: false
  };
  writeJson('jobs_shortlist.json', [job]);
  writeJson('job_leads.json', [job]);
  writeJson('job_reviews.json', []);
  writeJson('question_bank.json', {
    version: '2.0',
    answers: [{
      original_question: 'What interests you about this role?',
      answer: 'Synthetic reusable interest answer',
      source: 'user_confirmed',
      user_confirmed: true,
      canonical_key: 'answer_interest',
      sensitive_category: 'none',
      risk_level: 'normal'
    }]
  });
  writeJson('resume_profiles.json', {
    schema_version: '2.0',
    active_resume_profile_id: 'resume_quick_v1',
    items: [{
      id: 'resume_quick_v1',
      resume_id: 'resume_quick_v1',
      name: 'Quick Apply Resume',
      version: 1,
      enabled: true,
      file_reference: 'synthetic/resume.pdf',
      content_hash: 'sha256:synthetic-quick',
      approved_at: '2026-08-01T00:00:00.000Z',
      target_roles: ['Product Manager'],
      skills: ['roadmapping']
    }]
  });
  writeJson('career_profiles.local.json', {
    schema_version: '1.0',
    active_profile_id: 'career-quick',
    profiles: [{
      id: 'career-quick', family_id: 'career-quick', version: 1, name: 'Quick Apply Profile',
      state: 'approved', user_approved: true, approved_at: '2026-08-01T00:00:00.000Z',
      identity: {
        full_name: 'Synthetic Candidate', first_name: 'Synthetic', last_name: 'Candidate',
        email: 'candidate@example.test', phone: '+1 555 0100', city: 'Shanghai', country: 'China',
        links: { linkedin: 'https://linkedin.example.test/in/synthetic' }
      },
      education: [], experience: [], projects: [], skills: {}, certifications: [], languages: [],
      interview_stories: [], career_goals: ['Product Manager'],
      job_preferences: { work_authorization: 'Citizen', sponsorship: 'Not required' },
      field_provenance: {}
    }]
  });

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'), RESUME_JOBS_APPLICATIONS_DIR: applicationsDir,
      RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'), RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
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
      const preflight = await request('/api/jobs/${jobId}/quick-apply', {method:'POST', body:'{}'});
      const startUnconfirmed = await request('/api/jobs/${jobId}/quick-apply/start', {method:'POST', body:'{}'});
      const started = await request('/api/jobs/${jobId}/quick-apply/start', {method:'POST', body:JSON.stringify({
        confirmed: true,
        executor_type: 'extension',
        confirmed_answers: [{
          original_question: 'What is your notice period?',
          answer: 'Synthetic thirty days',
          source: 'user_confirmed',
          user_confirmed: true,
          sensitive_category: 'none',
          risk_level: 'normal'
        }]
      })});
      const answers = await request('/api/answers');
      const checklistBefore = await request('/api/applications/${jobId}/checklist');
      const needs = await request('/api/jobs/${jobId}/fill-report', {method:'POST', body:JSON.stringify({
        filled_fields_count: 2, skipped_fields_count: 1, fields_requiring_user_review_count: 1
      })});
      const rescanBlocked = await request('/api/jobs/${jobId}/review-rescan-report', {method:'POST', body:JSON.stringify({
        scan_id: 'quick-scan-blocked', detected_count: 3, required_count: 2,
        required_filled_count: 1, required_empty_count: 1, form_accessible: true, challenge_scope: 'none'
      })});
      const checklistBlocked = await request('/api/applications/${jobId}/checklist');
      const completeBlocked = await request('/api/jobs/${jobId}/review-complete', {method:'POST', body:JSON.stringify({confirmed:true})});
      const rescanClean = await request('/api/jobs/${jobId}/review-rescan-report', {method:'POST', body:JSON.stringify({
        scan_id: 'quick-scan-clean', detected_count: 3, required_count: 2,
        required_filled_count: 2, required_empty_count: 0, form_accessible: true, challenge_scope: 'none'
      })});
      const checklistClean = await request('/api/applications/${jobId}/checklist');
      const completed = await request('/api/jobs/${jobId}/review-complete', {method:'POST', body:JSON.stringify({confirmed:true})});
      const checklistReady = await request('/api/applications/${jobId}/checklist');
      process.stdout.write(JSON.stringify({
        preflight: {status: preflight.status, app_status: preflight.value.application_status,
                    ready: preflight.value.preflight.ready_for_start,
                    safe_answers: preflight.value.preflight.safe_answers_count,
                    recommended: preflight.value.executor.recommended,
                    steps: preflight.value.steps.map(item => item.step)},
        start_unconfirmed_status: startUnconfirmed.status,
        started: {status: started.status, steps: started.value.steps ? started.value.steps.map(item => item.step) : [],
                  session_status: started.value.application_execution_session ? started.value.application_execution_session.execution_status : ''},
        saved_answer_total: answers.value.total,
        checklist_before: {things_left: checklistBefore.value.things_left, scan_state: checklistBefore.value.scan_state,
                           can_complete: checklistBefore.value.can_mark_review_complete},
        needs_status: needs.status,
        rescan_blocked_status: rescanBlocked.status,
        checklist_blocked: {items: checklistBlocked.value.items.map(item => item.id),
                            can_complete: checklistBlocked.value.can_mark_review_complete},
        complete_blocked: {status: completeBlocked.status, code: completeBlocked.value.code},
        rescan_clean_status: rescanClean.status,
        checklist_clean: {things_left: checklistClean.value.things_left, can_complete: checklistClean.value.can_mark_review_complete},
        completed_status: completed.status,
        checklist_ready: {can_submit: checklistReady.value.can_mark_submitted, things_left: checklistReady.value.things_left}
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);

    assert.equal(outcome.preflight.status, 200);
    assert.deepEqual(outcome.preflight.steps, ['approve_job', 'build_package']);
    assert.equal(outcome.preflight.app_status, 'PACKAGE_READY');
    assert.equal(outcome.preflight.ready, true);
    assert.ok(outcome.preflight.safe_answers >= 1);
    assert.equal(outcome.preflight.recommended, 'local_browser_agent');

    assert.equal(outcome.start_unconfirmed_status, 409);
    assert.equal(outcome.started.status, 200);
    assert.ok(outcome.started.steps.includes('save_confirmed_answers'));
    assert.ok(outcome.started.steps.includes('start_fill'));
    assert.equal(outcome.saved_answer_total, 2);

    assert.equal(outcome.checklist_before.scan_state, 'missing');
    assert.equal(outcome.checklist_before.can_complete, false);
    assert.equal(outcome.needs_status, 200);
    assert.equal(outcome.rescan_blocked_status, 200);
    assert.ok(outcome.checklist_blocked.items.includes('required_fields'));
    assert.equal(outcome.checklist_blocked.can_complete, false);
    assert.equal(outcome.complete_blocked.status, 409);
    assert.equal(outcome.complete_blocked.code, 'APPLICATION_REVIEW_BLOCKED');

    assert.equal(outcome.rescan_clean_status, 200);
    assert.equal(outcome.checklist_clean.can_complete, true);
    assert.equal(outcome.completed_status, 200);
    assert.equal(outcome.checklist_ready.can_submit, true);
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
