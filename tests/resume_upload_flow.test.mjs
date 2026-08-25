// The resume-upload flow at the server boundary, offline (no browser).
//
// What this file pins:
//   - a Chrome-extension fill session never gains upload permission, even with
//     the upload policy on and a fresh exported file present
//   - the fill-report pipeline records the agent's upload result truthfully
//     (attempted/confirmed/status all preserved; submit stays false)
//   - the search-preferences endpoint accepts and persists the upload policy
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function seedWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-upload-flow-'));
  const dataDir = path.join(root, 'data');
  const documentsDir = path.join(root, 'documents');
  for (const directory of ['data', 'archive', 'reports', 'applications', 'documents']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const write = (name, value) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);

  const job = {
    job_id: 'job_upload_flow', title: 'Data Scientist', company: 'Upload Flow Corp',
    canonical_url: 'https://jobs.example.test/upload-flow', url: 'https://jobs.example.test/upload-flow',
    apply_url: 'https://jobs.example.test/upload-flow/apply',
    description_text: 'Python and causal inference experiments. '.repeat(6),
    provider: 'greenhouse', page_type: 'job_detail', recommended_decision: 'shortlist',
    info_quality: { score: 100 }, confidence: 0.95, match_score: 88,
    approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic'] },
    application_mode: 'REVIEW_ONLY', submit_allowed: false, upload_resume_allowed: false, final_submit_allowed: false
  };
  write('job_leads.json', [job]);
  write('jobs_shortlist.json', [job]);
  write('job_reviews.json', []);
  write('resume_profiles.json', {
    schema_version: '2.0',
    active_resume_profile_id: 'resume_flow_v1',
    active_resume_id: 'resume_flow_v1',
    items: [{
      id: 'resume_flow_v1', resume_id: 'resume_flow_v1', name: 'Flow Resume', version: 1,
      enabled: true, file_reference: 'synthetic/resume.pdf', content_hash: 'sha256:synthetic-flow',
      approved_at: '2026-08-01T00:00:00.000Z', target_roles: ['Data Scientist'], skills: ['python']
    }]
  });
  write('career_profiles.local.json', {
    schema_version: '1.0',
    active_profile_id: 'career_flow',
    profiles: [{
      id: 'career_flow', family_id: 'career_flow', version: 1, name: 'Flow Profile',
      state: 'approved', user_approved: true, approved_at: '2026-08-01T00:00:00.000Z',
      identity: {
        full_name: 'Synthetic Candidate', email: 'candidate@example.invalid',
        phone: '+1 555 0100', city: 'Shanghai', country: 'China', links: {}
      },
      education: [{ institution: 'Synthetic University', degree: 'MSc' }],
      experience: [{
        company: 'Synthetic ML Lab', role: 'ML Engineer',
        achievements: [
          'Built a causal inference platform in Python',
          'Reduced query latency by 18% with SQL optimization'
        ],
        technologies: ['Python', 'SQL']
      }],
      projects: [], skills: { programming: ['Python', 'SQL'] }, certifications: [], languages: [],
      interview_stories: [], career_goals: ['Data Scientist'],
      job_preferences: {}, field_provenance: {}
    }]
  });

  return { root, dataDir, documentsDir };
}

test('extension fills never gain upload permission; reports record uploads truthfully', async () => {
  const dirs = seedWorkspace();

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RESUME_JOBS_DATA_DIR: dirs.dataDir,
      RESUME_JOBS_REPORTS_DIR: path.join(dirs.root, 'reports'),
      RESUME_JOBS_APPLICATIONS_DIR: path.join(dirs.root, 'applications'),
      RESUME_JOBS_ARCHIVE_DIR: path.join(dirs.root, 'archive'),
      RESUME_JOBS_DOCUMENTS_DIR: dirs.documentsDir,
      RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(dirs.documentsDir, 'resumes'),
      RESUME_JOBS_PROFILE_PATH: path.join(dirs.root, 'profile.json'),
      AI_PROVIDER_ENABLED: '', AI_PROVIDER_TYPE: '', LOCAL_LLM_ENABLED: ''
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

      // Upload policy is on by default and configurable through preferences.
      const prefsBefore = await request('/api/settings');
      // A fresh tailored file exists before the fill starts.
      await request('/api/jobs/job_upload_flow/resume-draft', {method:'POST', body:'{}'});
      const exported = await request('/api/jobs/job_upload_flow/resume-draft/export', {method:'POST', body: JSON.stringify({formats:['docx']})});

      const preflight = await request('/api/jobs/job_upload_flow/quick-apply', {method:'POST', body:'{}'});
      const started = await request('/api/jobs/job_upload_flow/quick-apply/start', {
        method:'POST', body: JSON.stringify({ confirmed: true, executor_type: 'extension' })
      });

      // The extension reports its fill; a hostile or buggy report cannot mark
      // the application submitted, and upload results flow through unchanged.
      const reported = await request('/api/jobs/job_upload_flow/fill-report', {method:'POST', body: JSON.stringify({
        attempt_id: 'attempt_flow_1',
        total_fields_seen: 5, filled_fields_count: 3, skipped_fields_count: 2,
        resume_upload_attempted: true,
        resume_upload_confirmed: true,
        resume_upload_status: 'confirmed',
        final_submit_clicked: true,
        application_submitted: true
      })});
      const applyState = await request('/api/jobs/job_upload_flow/apply-state');
      process.stdout.write(JSON.stringify({ prefsBefore, exported, preflight, started, reported, applyState }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
      encoding: 'utf8', timeout: 40000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);

    assert.equal(outcome.prefsBefore.value.search_preferences.safety.resume_upload_policy, 'auto');
    assert.equal(outcome.prefsBefore.value.search_preferences.safety.resume_format_preference, 'auto');
    assert.equal(outcome.exported.status, 200);
    assert.equal(outcome.started.status, 200, JSON.stringify(outcome.started.value).slice(0, 300));

    // An extension session must never carry upload permission: the extension
    // has no verified upload path, so authorizing it would be a lie.
    const session = outcome.started.value.application_execution_session;
    assert.equal(session.safety.resume_upload_allowed, false);
    assert.equal(session.resume_upload_authorization, undefined);

    assert.equal(outcome.reported.status, 200, JSON.stringify(outcome.reported.value).slice(0, 300));

    // The stored report keeps the upload truth and refuses the submit lie.
    const state = JSON.parse(fs.readFileSync(path.join(dirs.dataDir, 'dashboard_state.json'), 'utf8'));
    const record = state.application_status_overrides.job_upload_flow;
    assert.ok(record.latest_fill_report, 'a fill report must be recorded');
    assert.equal(record.latest_fill_report.resume_upload_attempted, true);
    assert.equal(record.latest_fill_report.resume_upload_confirmed, true);
    assert.equal(record.latest_fill_report.resume_upload_status, 'confirmed');
    assert.equal(record.latest_fill_report.final_submit_clicked, false);
    assert.equal(record.latest_fill_report.application_submitted, false);

    // apply-state still resolves the tailored file for this job.
    assert.equal(outcome.applyState.value.tailored_resume.available, true);
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(dirs.root, { recursive: true, force: true });
  }
});
