import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Dashboard learning review saves only confirmed scoped memory and creates a Career Brain draft', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-learning-'));
  const dataDir = path.join(root, 'data');
  const archiveDir = path.join(root, 'archive');
  for (const directory of [dataDir, archiveDir, path.join(root, 'reports'), path.join(root, 'applications'), path.join(root, 'resumes'), path.join(root, 'browser-sessions'), path.join(root, 'browser-profiles')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const writeJson = (name, value) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
  const jobId = 'synthetic-learning-job';
  const sessionId = 'synthetic-learning-session';
  writeJson('job_leads.json', [{
    job_id: jobId, title: 'Synthetic Role', company: 'Synthetic Employer', location: 'Remote',
    url: 'http://127.0.0.1/mock-ats/jobs/123456', application_url: 'http://127.0.0.1/mock-ats/jobs/123456',
    page_type: 'job_detail', approval_status: 'approved', safe_to_approve: true, application_status: 'NEEDS_REVIEW'
  }]);
  writeJson('jobs_shortlist.json', []);
  writeJson('job_reviews.json', [{ job_id: jobId, decision: 'approved' }]);
  writeJson('dashboard_state.json', {
    schema_version: '3.0', selected_job_ids: [jobId], audit_events: [],
    application_status_overrides: {
      [jobId]: { job_id: jobId, application_status: 'NEEDS_REVIEW', active_session_id: sessionId, fill_started_at: '2026-08-11T00:00:00.000Z' }
    },
    application_execution_sessions: {
      [sessionId]: {
        schema: 'ApplicationExecutionSession', schema_version: '1.1', session_id: sessionId,
        application_id: 'synthetic-learning-application', job_id: jobId, package_id: 'synthetic-learning-package',
        executor_type: 'local_browser_agent', target_url: 'http://127.0.0.1/mock-ats/jobs/123456', execution_status: 'NEEDS_REVIEW',
        approved_profile_version: { profile_id: 'career-approved', family_id: 'career-family', version: 1, approved_at: '2026-08-11T00:00:00.000Z' },
        approved_field_mappings: [{ canonical_key: 'full_name', value: 'Synthetic Candidate', source: 'fixture', confidence: 1, user_confirmed: true }],
        safety: { resume_upload_allowed: false, sensitive_answers_allowed: false, login_allowed: false, challenge_bypass_allowed: false, final_submit_allowed: false }
      }
    }
  });
  writeJson('career_profiles.local.json', {
    schema_version: '1.0', active_profile_id: 'career-approved', profiles: [{
      id: 'career-approved', family_id: 'career-family', version: 1, name: 'Synthetic Profile',
      state: 'approved', user_approved: true, approved_at: '2026-08-11T00:00:00.000Z',
      identity: { full_name: 'Synthetic Candidate', links: {} }, education: [], experience: [], projects: [],
      skills: {}, certifications: [], languages: [], interview_stories: [], career_goals: [], field_provenance: {}
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
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'), RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
      RESUME_JOBS_ARCHIVE_DIR: archiveDir, RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
      RESUME_JOBS_BROWSER_SESSIONS_DIR: path.join(root, 'browser-sessions'),
      RESUME_JOBS_BROWSER_PROFILES_DIR: path.join(root, 'browser-profiles'),
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
        const value = await response.json();
        return {response, value};
      };
      const baseline = [
        {field_ref:'field-1',tag:'input',type:'url',name:'linkedin',label:'LinkedIn',value:''},
        {field_ref:'field-2',tag:'textarea',type:'textarea',name:'safe_question',label:'What interests you about this role?',value:''},
        {field_ref:'field-3',tag:'input',type:'text',name:'authorization',label:'Are you authorized to work?',value:''},
        {field_ref:'field-4',tag:'input',type:'password',name:'password',label:'Password',value:''}
      ];
      const current = [
        {...baseline[0],value:'https://example.test/synthetic'},
        {...baseline[1],value:'Synthetic reusable answer'},
        {...baseline[2],value:'Synthetic high-risk answer'},
        {...baseline[3],value:'must-never-be-recorded'}
      ];
      const reported = await request('/api/jobs/${jobId}/learning-candidates/report', {
        method:'POST', body:JSON.stringify({application_session_id:'${sessionId}',baseline_snapshot:baseline,current_snapshot:current})
      });
      if(!reported.response.ok) throw new Error(JSON.stringify(reported.value));
      const listed = await request('/api/jobs/${jobId}/learning-candidates');
      const career = listed.value.candidates.find(item => item.suggested_destination === 'career_brain');
      const safe = listed.value.candidates.find(item => item.suggested_destination === 'answer_memory' && item.risk_level !== 'high');
      const high = listed.value.candidates.find(item => item.risk_level === 'high');
      const savedCareer = await request('/api/jobs/${jobId}/learning-candidates/'+encodeURIComponent(career.candidate_id)+'/decision', {
        method:'POST', body:JSON.stringify({decision:'save',destination:'career_brain',scope:'global',value:career.value})
      });
      const savedSafe = await request('/api/jobs/${jobId}/learning-candidates/'+encodeURIComponent(safe.candidate_id)+'/decision', {
        method:'POST', body:JSON.stringify({decision:'save',destination:'answer_memory',scope:'employer',value:safe.value})
      });
      const blockedHigh = await request('/api/jobs/${jobId}/learning-candidates/'+encodeURIComponent(high.candidate_id)+'/decision', {
        method:'POST', body:JSON.stringify({decision:'save',destination:'answer_memory',scope:'employer',value:high.value})
      });
      const rejectedHigh = await request('/api/jobs/${jobId}/learning-candidates/'+encodeURIComponent(high.candidate_id)+'/decision', {
        method:'POST', body:JSON.stringify({decision:'reject',scope:'do_not_save'})
      });
      process.stdout.write(JSON.stringify({
        candidate_count: reported.value.candidate_count,
        career_status: savedCareer.response.status,
        safe_status: savedSafe.response.status,
        high_status: blockedHigh.response.status,
        high_code: blockedHigh.value.code,
        rejected_status: rejectedHigh.response.status
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.deepEqual(response, {
      candidate_count: 3, career_status: 200, safe_status: 200,
      high_status: 409, high_code: 'HIGH_RISK_CONFIRMATION_REQUIRED', rejected_status: 200
    });

    const learning = JSON.parse(fs.readFileSync(path.join(dataDir, 'learning_candidates.local.json'), 'utf8'));
    assert.ok(learning.candidates.every(candidate => candidate.status === 'pending' || candidate.value === ''));
    assert.doesNotMatch(JSON.stringify(learning), /must-never-be-recorded/);
    const career = JSON.parse(fs.readFileSync(path.join(dataDir, 'career_profiles.local.json'), 'utf8'));
    assert.equal(career.profiles.find(profile => profile.id === 'career-approved').user_approved, true);
    const draft = career.profiles.find(profile => profile.state === 'draft');
    assert.ok(draft);
    assert.equal(draft.user_approved, false);
    const answers = JSON.parse(fs.readFileSync(path.join(dataDir, 'question_bank.json'), 'utf8'));
    assert.equal(answers.answers.length, 1);
    assert.equal(answers.answers[0].scope, 'employer');
    assert.equal(answers.answers[0].user_confirmed, true);
    const fieldMemory = JSON.parse(fs.readFileSync(path.join(dataDir, 'form_field_memory.local.json'), 'utf8'));
    assert.equal(fieldMemory.records.length, 2);
    assert.equal(Object.hasOwn(fieldMemory.records[0], 'value'), false);
    assert.equal(Object.hasOwn(fieldMemory.records[0], 'answer'), false);
  } finally {
    dashboard.kill();
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000);
      dashboard.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
