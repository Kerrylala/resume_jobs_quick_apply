// Server round-trips for the endpoints added in the backend-freeze round:
// tailored resume drafts, company careers import, AI status, and application
// history. One workspace, one server, every contract exercised over real HTTP.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('resume drafts, careers import, AI status and history behave as frozen', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-freeze-'));
  const dataDir = path.join(root, 'data');
  for (const directory of ['data', 'archive', 'reports', 'applications', 'resumes']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const writeJson = (name, value) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);

  writeJson('job_leads.json', [{
    job_id: 'job_freeze',
    title: 'Data Scientist',
    company: 'Synthetic Corp',
    canonical_url: 'https://jobs.example.test/freeze',
    url: 'https://jobs.example.test/freeze',
    apply_url: 'https://jobs.example.test/freeze/apply',
    description_text: 'Python and causal inference work on experimentation.'
  }]);
  writeJson('jobs_shortlist.json', []);
  writeJson('career_profiles.local.json', {
    schema_version: '1.0',
    active_profile_id: 'career_freeze',
    profiles: [{
      id: 'career_freeze', family_id: 'career_freeze', version: 1, name: 'Freeze Profile',
      state: 'approved', user_approved: true, approved_at: '2026-08-01T00:00:00.000Z',
      identity: {
        full_name: 'Synthetic Candidate', email: 'candidate@example.invalid',
        phone: '+1 555 0100', city: 'Shanghai', country: 'China', links: {}
      },
      education: [{ institution: 'Synthetic University', degree: 'MSc' }],
      experience: [{
        company: 'Synthetic ML Lab', role: 'ML Engineer',
        achievements: ['Built a causal inference platform in Python'],
        technologies: ['Python']
      }],
      projects: [], skills: { programming: ['Python'] }, certifications: [], languages: [],
      interview_stories: [], career_goals: ['Data Scientist'],
      job_preferences: {}, field_provenance: {}
    }]
  });
  // A submitted application for the history endpoint.
  writeJson('dashboard_state.json', {
    version: '1.1.0',
    created_at: '2026-01-01T00:00:00.000Z',
    application_status_overrides: {
      job_done: {
        job_id: 'job_done', application_status: 'MANUALLY_SUBMITTED',
        title: 'Old Role', company: 'Old Corp', submitted_at: '2026-08-10T00:00:00.000Z'
      },
      job_inflight: { job_id: 'job_inflight', application_status: 'EXECUTING' }
    },
    application_execution_sessions: {},
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
      RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json'),
      // No AI configured: the draft must degrade honestly.
      AI_PROVIDER_ENABLED: '', AI_PROVIDER_TYPE: '', AI_PROVIDER_API_KEY: '', LOCAL_LLM_ENABLED: ''
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

      // --- Tailored resume drafts ---
      const missingDraft = await request('/api/jobs/job_freeze/resume-draft');
      const generated = await request('/api/jobs/job_freeze/resume-draft', {method:'POST', body:'{}'});
      const fetched = await request('/api/jobs/job_freeze/resume-draft');
      const unknownJob = await request('/api/jobs/job_absent/resume-draft', {method:'POST', body:'{}'});
      const deleted = await request('/api/jobs/job_freeze/resume-draft', {method:'DELETE'});
      const goneAfterDelete = await request('/api/jobs/job_freeze/resume-draft');

      // --- Cover letter lifecycle ---
      const noLetter = await request('/api/jobs/job_freeze/cover-letter');
      const letterGen = await request('/api/jobs/job_freeze/cover-letter', {method:'POST', body:'{}'});
      const letterGot = await request('/api/jobs/job_freeze/cover-letter');
      const letterGone = await request('/api/jobs/job_freeze/cover-letter', {method:'DELETE'});

      // --- Company careers import ---
      const unconfirmed = await request('/api/jobs/import-company-careers', {
        method:'POST', body: JSON.stringify({url:'https://boards.greenhouse.io/synthetic'})
      });

      // --- AI status + history ---
      const aiStatus = await request('/api/ai/status');
      const history = await request('/api/applications/history');

      process.stdout.write(JSON.stringify({
        missingDraft, generated, fetched, unknownJob, deleted, goneAfterDelete,
        noLetter, letterGen, letterGot, letterGone,
        unconfirmed, aiStatus, history
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
      encoding: 'utf8', timeout: 30000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);

    // Draft lifecycle.
    assert.equal(outcome.missingDraft.status, 404, 'no draft exists until the user asks for one');
    assert.equal(outcome.generated.status, 200, JSON.stringify(outcome.generated.value).slice(0, 300));
    const draft = outcome.generated.value.draft;
    assert.equal(draft.job_id, 'job_freeze');
    assert.equal(draft.profile_id, 'career_freeze');
    assert.equal(draft.provenance_complete, true);
    assert.equal(
      draft.ai.status, 'provider_disabled',
      'with no AI configured the draft must say so, not pretend'
    );
    // The deterministic draft still tailors: the Python experience is present
    // and every block item carries fact_refs.
    const blocks = draft.blocks;
    assert.ok(blocks.some(block => block.kind === 'experience'));
    for (const block of blocks) {
      for (const item of block.items || []) assert.ok(item.fact_refs?.length, `${block.kind} item missing fact_refs`);
      for (const entry of block.entries || []) assert.ok(entry.fact_refs?.length, `${block.kind} entry missing fact_refs`);
    }

    assert.equal(outcome.fetched.status, 200);
    assert.equal(outcome.fetched.value.draft.draft_id, draft.draft_id);
    assert.equal(outcome.unknownJob.status, 404);
    assert.equal(outcome.deleted.status, 200);
    assert.equal(outcome.goneAfterDelete.status, 404);

    // Cover letter lifecycle mirrors resume drafts, with the honest bridge.
    assert.equal(outcome.noLetter.status, 404);
    assert.equal(outcome.letterGen.status, 200, JSON.stringify(outcome.letterGen.value).slice(0, 300));
    const letter = outcome.letterGen.value.letter;
    assert.equal(letter.ai.status, 'provider_disabled');
    assert.ok(letter.paragraphs.length >= 3);
    assert.ok(letter.paragraphs[0].text.includes('Synthetic Corp'));
    assert.equal(outcome.letterGot.status, 200);
    assert.equal(outcome.letterGone.status, 200);

    // Careers import demands the same explicit confirmation as URL import.
    assert.equal(outcome.unconfirmed.status, 409);
    assert.equal(outcome.unconfirmed.value.code, 'PUBLIC_FETCH_CONFIRMATION_REQUIRED');

    // AI status: useful facts, no credential.
    assert.equal(outcome.aiStatus.status, 200);
    assert.equal(outcome.aiStatus.value.enabled, false);
    assert.equal(outcome.aiStatus.value.safety.credential_returned, false);
    assert.equal(JSON.stringify(outcome.aiStatus.value).includes('api_key'), false);

    // History: terminal states only, plain public vocabulary.
    assert.equal(outcome.history.status, 200);
    assert.equal(outcome.history.value.total, 1);
    assert.equal(outcome.history.value.applications[0].job_id, 'job_done');
    assert.equal(outcome.history.value.applications[0].state, 'applied');
    assert.equal(
      outcome.history.value.applications.some(entry => entry.job_id === 'job_inflight'),
      false,
      'in-flight applications belong to apply-state, not history'
    );
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nothing generates a tailored resume except the user-triggered endpoint', () => {
  // Token spend is a user decision. The generator must have exactly one call
  // site: its own POST handler. Quick-apply, packaging and discovery must not
  // reach it.
  const serverSource = fs.readFileSync(path.join(ROOT, 'dashboard', 'server.mjs'), 'utf8');
  const calls = serverSource.match(/buildDeterministicDraft\(/g) || [];
  assert.equal(calls.length, 1, 'buildDeterministicDraft must be called only by the resume-draft handler');

  const taskCalls = serverSource.match(/task:\s*'resume_tailoring'/g) || [];
  assert.equal(taskCalls.length, 1, 'the resume_tailoring AI task must have exactly one call site');
});
