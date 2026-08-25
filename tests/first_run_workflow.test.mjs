import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function freeLoopbackPort() {
  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

async function waitForDashboard(process) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 10000);
    process.stdout.on('data', chunk => {
      if (String(chunk).includes('Dashboard server running')) {
        clearTimeout(timer);
        resolve();
      }
    });
    process.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Dashboard exited early with ${code}.`));
    });
  });
}

function requestJson(base, url, options = {}) {
  const script = `
    const response = await fetch(${JSON.stringify(base + url)}, ${JSON.stringify({
      method: options.method || 'GET',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      ...(options.body ? { body: options.body } : {})
    })});
    const value = await response.json();
    process.stdout.write(JSON.stringify({ status: response.status, ok: response.ok, value }));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: 15000, windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  return { response: { status: parsed.status, ok: parsed.ok }, value: parsed.value };
}

test('empty local data completes automatic resume intake, Profile versions, settings, and safe reset', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-first-run-'));
  const directories = {
    data: path.join(tempRoot, 'data'),
    reports: path.join(tempRoot, 'reports'),
    applications: path.join(tempRoot, 'applications'),
    archive: path.join(tempRoot, 'archive'),
    resumes: path.join(tempRoot, 'resumes'),
    browserProfiles: path.join(tempRoot, 'browser_profiles'),
    browserSessions: path.join(tempRoot, 'browser_sessions')
  };
  Object.values(directories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));
  fs.writeFileSync(path.join(directories.archive, 'pre-reset-backup.txt'), 'synthetic backup that must survive reset');
  fs.writeFileSync(path.join(directories.reports, 'old-report.json'), '{}');
  fs.writeFileSync(path.join(directories.applications, 'old-application.json'), '{}');
  fs.writeFileSync(path.join(directories.browserProfiles, 'old-browser-state.txt'), 'synthetic');
  fs.writeFileSync(path.join(directories.browserSessions, 'old-session.txt'), 'synthetic');

  const port = await freeLoopbackPort();
  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RESUME_JOBS_DATA_DIR: directories.data,
      RESUME_JOBS_REPORTS_DIR: directories.reports,
      RESUME_JOBS_APPLICATIONS_DIR: directories.applications,
      RESUME_JOBS_ARCHIVE_DIR: directories.archive,
      RESUME_JOBS_RESUME_LIBRARY_DIR: directories.resumes,
      RESUME_JOBS_BROWSER_PROFILES_DIR: directories.browserProfiles,
      RESUME_JOBS_BROWSER_SESSIONS_DIR: directories.browserSessions
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  const base = `http://127.0.0.1:${port}`;
  async function request(url, options = {}) {
    return requestJson(base, url, options);
  }

  try {
    await waitForDashboard(dashboard);
    const initial = (await request('/api/settings')).value;
    assert.equal(initial.workflow_state.facts.resume_uploaded, false);

    const resumeText = [
      'Synthetic Candidate',
      'candidate@local.invalid',
      'Skills: JavaScript, analytics, roadmapping',
      'Experience',
      '- Product analyst at Synthetic Company',
      'Projects',
      '- Resume Jobs local demo',
      'Languages: English, Chinese'
    ].join('\n');
    const uploaded = (await request('/api/settings/resume-upload', {
      method: 'POST',
      body: JSON.stringify({
        file_name: 'synthetic-first-run.txt',
        content_base64: Buffer.from(resumeText).toString('base64'),
        display_name: 'Synthetic First Run',
        activate: false,
        confirmed_local_copy: true
      })
    })).value;
    assert.equal(uploaded.status, 'ok');
    assert.equal(uploaded.next_view, 'career-brain');
    assert.equal(uploaded.intake.content_parsed, true);
    assert.ok(uploaded.intake.candidate_facts_persisted >= 3);
    assert.equal(uploaded.resume_profiles.active_resume_profile_id, uploaded.resume_profile.resume_id);
    assert.equal(uploaded.safety.career_brain_draft_created, true);
    assert.equal(uploaded.career_brain.active_profile.user_approved, false);
    assert.deepEqual(uploaded.career_brain.active_profile.source_resume_ids, [uploaded.resume_profile.resume_id]);
    assert.equal(Object.hasOwn(uploaded.career_brain.active_profile, 'raw_resume_text'), false);

    const profilePath = path.join(directories.data, 'candidate_profile.local.json');
    assert.equal(fs.existsSync(profilePath), true);
    const afterUpload = (await request('/api/settings')).value;
    assert.equal(afterUpload.workflow_state.current_step.key, 'profile_approved');
    assert.ok(afterUpload.resume_intelligence.facts.some(fact => fact.fact_key === 'email'));
    assert.ok(afterUpload.resume_intelligence.facts.some(fact => fact.fact_key === 'projects'));
    assert.equal(afterUpload.career_brain.active_profile.state, 'draft');

    const savedCareerVersion = await request('/api/career-brain/profiles', {
      method: 'POST',
      body: JSON.stringify({
        action: 'save_version',
        profile_id: afterUpload.career_brain.active_profile_id,
        profile: {
          ...afterUpload.career_brain.active_profile,
          career_goals: ['AI Solutions Engineer'],
          job_preferences: { countries: ['China', 'Singapore'], remote: 'hybrid' }
        }
      })
    });
    assert.equal(savedCareerVersion.response.status, 200);
    assert.equal(savedCareerVersion.value.profile.version, 2);
    assert.equal(savedCareerVersion.value.profile.user_approved, false);
    const approvedCareer = await request('/api/career-brain/profiles', {
      method: 'POST',
      body: JSON.stringify({ action: 'approve', profile_id: savedCareerVersion.value.profile.id, confirmed: true })
    });
    assert.equal(approvedCareer.response.status, 200);
    assert.equal(approvedCareer.value.profile.user_approved, true);
    assert.equal((await request(`/api/career-brain/profiles/${approvedCareer.value.profile.id}/export`)).value.profile.id, approvedCareer.value.profile.id);

    const sensitive = await request('/api/settings/candidate-profile/facts', {
      method: 'POST',
      body: JSON.stringify({
        action: 'add',
        fact_key: 'work_authorization',
        value: 'Synthetic user-entered value'
      })
    });
    assert.equal(sensitive.response.status, 200);
    assert.equal(sensitive.value.resume_intelligence.facts.find(fact => fact.fact_key === 'work_authorization').status, 'user_confirmation_required');

    const firstVersion = (await request('/api/settings/candidate-profile/versions', {
      method: 'POST',
      body: JSON.stringify({ action: 'create', name: 'First run profile' })
    })).value;
    assert.equal(firstVersion.candidate_profile_versions.items.length, 1);
    await request('/api/settings/candidate-profile/facts', {
      method: 'POST',
      body: JSON.stringify({ action: 'edit', fact_key: 'full_name', value: 'Changed Candidate' })
    });
    const restored = await request('/api/settings/candidate-profile/versions', {
      method: 'POST',
      body: JSON.stringify({
        action: 'activate',
        version_id: firstVersion.version.version_id,
        confirmed: true
      })
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.value.resume_intelligence.facts.find(fact => fact.fact_key === 'full_name').value, 'Synthetic Candidate');
    assert.equal(restored.value.resume_intelligence.current_review_approved, false);

    const aiSaved = await request('/api/settings/ai-provider', {
      method: 'POST',
      body: JSON.stringify({ ai_provider: {
        enabled: false,
        type: 'local_openai_compatible',
        base_url: 'http://127.0.0.1:1234/v1',
        model: 'synthetic-local-model',
        timeout_ms: 15000
      } })
    });
    assert.equal(aiSaved.response.status, 200);
    assert.equal(aiSaved.value.ai_provider.model, 'synthetic-local-model');
    const searchSourceSaved = await request('/api/settings/job-search-sources', {
      method: 'POST',
      body: JSON.stringify({ providers: [{
        id: 'searxng_search', enabled: false,
        endpoint: 'http://127.0.0.1:8888/search', timeout_ms: 12000, max_results_per_query: 5
      }] })
    });
    assert.equal(searchSourceSaved.response.status, 200);
    assert.equal(searchSourceSaved.value.job_search_sources.providers[0].saved_endpoint, 'http://127.0.0.1:8888/search');

    const rejectedReset = await request('/api/settings/reset-local-data', {
      method: 'POST', body: JSON.stringify({ confirmed: true, confirmation_text: 'RESET' })
    });
    assert.equal(rejectedReset.response.status, 409);
    const reset = await request('/api/settings/reset-local-data', {
      method: 'POST', body: JSON.stringify({ confirmed: true, confirmation_text: 'RESET LOCAL DATA' })
    });
    assert.equal(reset.response.status, 200);
    assert.equal(reset.value.next_view, 'resume');
    assert.equal(fs.existsSync(profilePath), false);
    assert.equal(fs.existsSync(path.join(directories.data, 'career_profiles.local.json')), false);
    assert.deepEqual(fs.readdirSync(directories.resumes), []);
    assert.deepEqual(fs.readdirSync(directories.reports), []);
    assert.deepEqual(fs.readdirSync(directories.applications), []);
    assert.deepEqual(fs.readdirSync(directories.browserProfiles), []);
    assert.deepEqual(fs.readdirSync(directories.browserSessions), []);
    assert.equal(fs.readdirSync(directories.archive).includes('pre-reset-backup.txt'), true);
    const afterReset = (await request('/api/settings')).value;
    assert.equal(afterReset.workflow_state.facts.resume_uploaded, false);
    assert.equal(afterReset.resume_profiles.items.length, 0);
    assert.equal(afterReset.resume_intelligence.summary.available_fact_count, 0);
  } finally {
    dashboard.kill();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('Reset Local Data preserves an explicitly configured profile outside product-owned directories', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-external-profile-reset-'));
  const directories = {
    data: path.join(tempRoot, 'data'),
    reports: path.join(tempRoot, 'reports'),
    applications: path.join(tempRoot, 'applications'),
    archive: path.join(tempRoot, 'archive'),
    resumes: path.join(tempRoot, 'resumes'),
    browserProfiles: path.join(tempRoot, 'browser_profiles'),
    browserSessions: path.join(tempRoot, 'browser_sessions')
  };
  Object.values(directories).forEach(directory => fs.mkdirSync(directory, { recursive: true }));
  const externalProfile = path.join(tempRoot, 'user-managed-profile.json');
  const originalBytes = Buffer.from('{"schema_version":"1.0","synthetic_external_profile":true}\n');
  fs.writeFileSync(externalProfile, originalBytes);
  const port = await freeLoopbackPort();
  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RESUME_JOBS_DATA_DIR: directories.data,
      RESUME_JOBS_REPORTS_DIR: directories.reports,
      RESUME_JOBS_APPLICATIONS_DIR: directories.applications,
      RESUME_JOBS_ARCHIVE_DIR: directories.archive,
      RESUME_JOBS_RESUME_LIBRARY_DIR: directories.resumes,
      RESUME_JOBS_BROWSER_PROFILES_DIR: directories.browserProfiles,
      RESUME_JOBS_BROWSER_SESSIONS_DIR: directories.browserSessions,
      RESUME_JOBS_PROFILE_PATH: externalProfile
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  try {
    await waitForDashboard(dashboard);
    const { response, value: result } = requestJson(`http://127.0.0.1:${port}`, '/api/settings/reset-local-data', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true, confirmation_text: 'RESET LOCAL DATA' })
    });
    assert.equal(response.status, 200);
    assert.equal(result.external_profile_preserved, true);
    assert.deepEqual(fs.readFileSync(externalProfile), originalBytes);
  } finally {
    dashboard.kill();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
