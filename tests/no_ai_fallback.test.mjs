// Requirement: AI is an optional enhancement. With no provider configured, job
// import, matching, profile management, answers and safe filling must all still
// work — and the product must never invent an AI result to fill the gap.
//
// The dishonest failure mode this guards against is a fabricated score: a
// deterministic number presented as if a model produced it. That would make two
// jobs look comparable when they are not.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { canonicalMatchScores } from '../scripts/lib/hybrid_matching.mjs';
import { createAIProvider } from '../scripts/lib/ai_provider.mjs';
import { enrichJobsWithLocalModel } from '../scripts/enrich_jobs_with_local_model.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('with no AI, a match score is honestly labelled and never fabricated', () => {
  const deterministicOnly = canonicalMatchScores({
    match_score: 76,
    score_breakdown: { components: [] }
  });

  assert.equal(deterministicOnly.ai_used, false);
  assert.equal(deterministicOnly.score_method, 'deterministic');
  assert.equal(
    deterministicOnly.semantic_score, null,
    'a semantic score must be null when no model ran, never a stand-in number'
  );
  assert.equal(
    deterministicOnly.combined_score, deterministicOnly.deterministic_score,
    'without AI the canonical sort key is the deterministic score itself'
  );
  assert.equal(deterministicOnly.confidence, null);
});

test('a disabled provider returns the caller fallback and touches no network', async () => {
  const provider = createAIProvider({
    env: {},
    config: { enabled: false, type: 'disabled' },
    fetchImpl: () => { throw new Error('a disabled provider must not make requests'); }
  });
  const result = await provider.structuredTask({
    task: 'resume_tailoring',
    input: {},
    fallback: { drafted: false, reason: 'no_ai' }
  });
  assert.equal(result.status, 'fallback');
  assert.equal(result.value.drafted, false);

  const health = await provider.healthCheck();
  assert.equal(health.status, 'DISABLED');
  assert.equal(health.network_accessed, false);
});

test('job enrichment finishes when the local model is switched off mid-run', async () => {
  // The provider surfaces network and configuration errors by design, so each
  // caller decides how to degrade. Enrichment previously did not, and a closed
  // LM Studio aborted the entire run — losing every job already processed.
  const provider = createAIProvider({
    env: {},
    config: {
      enabled: true, type: 'local_openai_compatible',
      baseUrl: 'http://127.0.0.1:1234/v1', model: 'synthetic', retries: 0
    },
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
  });

  const jobs = [
    { job_id: 'job-a', title: 'Synthetic Role A', company: 'Synthetic Corp', match_score: 71 },
    { job_id: 'job-b', title: 'Synthetic Role B', company: 'Synthetic Corp', match_score: 64 }
  ];

  const result = await enrichJobsWithLocalModel({
    provider, jobs, searchPreferences: {}, careerProfile: null, maxJobs: 10
  });

  assert.equal(result.jobs.length, 2, 'every job must still come back when the model is unreachable');
  for (const job of result.jobs) {
    assert.equal(job.ai_enrichment.model_used, false);
    assert.equal(
      job.ai_enrichment.source, 'deterministic_fallback',
      'a job that could not be enriched must say so rather than look AI-scored'
    );
    // canonicalMatchScores is the contract the rest of the product sorts and
    // labels by, so that is where "no invented score" has to hold.
    const scores = canonicalMatchScores(job);
    assert.equal(
      scores.semantic_score, null,
      'no semantic score may be invented for an unreachable model'
    );
    assert.equal(scores.ai_used, false);
    assert.equal(scores.score_method, 'deterministic');
  }
});

test('the whole backend answers normally with no AI configured', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-no-ai-'));
  const dataDir = path.join(root, 'data');
  for (const directory of ['data', 'archive', 'reports', 'applications', 'resumes']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  // Deliberately no ai_provider.local.json.
  fs.writeFileSync(path.join(dataDir, 'job_leads.json'), '[]\n');

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'),
      RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
      RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'),
      RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
      RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json'),
      // Make sure no ambient credential leaks in from the developer machine.
      AI_PROVIDER_ENABLED: '', AI_PROVIDER_TYPE: '', AI_PROVIDER_API_KEY: '',
      LOCAL_LLM_ENABLED: ''
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
      const get = async (url) => {
        const response = await fetch(base + url);
        return { status: response.status, value: await response.json() };
      };
      const imported = await fetch(base + '/api/jobs/import-url', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({ url: base + '/mock-ats/jobs/123456', confirmed_public_fetch: true })
      });
      process.stdout.write(JSON.stringify({
        summary: await get('/api/summary'),
        jobs: await get('/api/jobs'),
        profile: await get('/api/profile/full'),
        answers: await get('/api/answers'),
        settings: await get('/api/settings'),
        executors: await get('/api/executor-capabilities'),
        import_status: imported.status
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
      encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);

    // Everything a user needs to manage their search answers normally.
    for (const key of ['summary', 'jobs', 'profile', 'answers', 'settings', 'executors']) {
      assert.equal(outcome[key].status, 200, `${key} must work without AI`);
    }
    // Importing a job link — the primary discovery path — needs no model.
    assert.equal(outcome.import_status, 200, 'link import must work without AI');

    // Filling still has a real executor available.
    assert.equal(outcome.executors.value.recommended, 'local_browser_agent');

    // And the settings screen reports AI as off rather than pretending.
    const ai = outcome.settings.value.ai_provider || outcome.settings.value.aiProvider || {};
    assert.notEqual(ai.enabled, true, 'no provider is configured, so AI must not report itself enabled');
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
