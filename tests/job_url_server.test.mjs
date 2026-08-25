import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Dashboard imports an explicitly confirmed localhost job URL into the current search', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-url-import-'));
  const dataDir = path.join(root, 'data');
  const archiveDir = path.join(root, 'archive');
  for (const directory of [dataDir, archiveDir, path.join(root, 'reports'), path.join(root, 'applications'), path.join(root, 'resumes')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const writeJson = (name, value) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);
  writeJson('search_preferences.json', {
    active_search_profile_id: 'url-test',
    workflow_meta: { configured_at: '2026-08-06T00:00:00.000Z' },
    search_profiles: [{
      id: 'url-test', name: 'URL Test', enabled: true,
      target_roles: [{ keyword: 'Engineer', enabled: true }], preferred_locations: [],
      workplace_modes: ['any'], seniority_levels: ['any'], required_skills: [], preferred_skills: [],
      excluded_keywords: [], excluded_companies: [], posted_within_days: 30, job_types: ['full_time'],
      minimum_salary: null, maximum_search_results: 10, maximum_jobs_to_open: 1
    }]
  });
  writeJson('job_leads.json', []);
  writeJson('search_runs.json', []);
  writeJson('jobs_shortlist.json', []);

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
    const malformedClient = `
      const http = await import('node:http');
      const response = await new Promise((resolve, reject) => {
        const request = http.request({hostname:'127.0.0.1',port:${port},path:'/%ZZ',method:'GET'}, res => {
          let body=''; res.on('data', chunk => { body += chunk; });
          res.on('end', () => resolve({status:res.statusCode,body}));
        });
        request.on('error', reject); request.end();
      });
      process.stdout.write(JSON.stringify(response));
    `;
    const malformedResult = spawnSync(process.execPath, ['--input-type=module', '-e', malformedClient], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(malformedResult.status, 0, malformedResult.stderr);
    const malformedResponse = JSON.parse(malformedResult.stdout);
    assert.equal(malformedResponse.status, 400);
    assert.equal(JSON.parse(malformedResponse.body).code, 'INVALID_REQUEST_URL');
    assert.equal(dashboard.exitCode, null);
    const crossOriginClient = `
      const response = await fetch('http://127.0.0.1:${port}/api/settings/reset-local-data', {
        method:'POST', headers:{'content-type':'text/plain','origin':'https://attacker.example'},
        body:JSON.stringify({confirmed:true,confirmation_text:'RESET LOCAL DATA'})
      });
      process.stdout.write(JSON.stringify({
        status:response.status,
        value:await response.json(),
        security_headers:{
          frame:response.headers.get('x-frame-options'),
          nosniff:response.headers.get('x-content-type-options'),
          referrer:response.headers.get('referrer-policy'),
          csp:response.headers.get('content-security-policy')
        }
      }));
    `;
    const crossOriginResult = spawnSync(process.execPath, ['--input-type=module', '-e', crossOriginClient], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(crossOriginResult.status, 0, crossOriginResult.stderr);
    const crossOriginResponse = JSON.parse(crossOriginResult.stdout);
    assert.equal(crossOriginResponse.status, 403);
    assert.equal(crossOriginResponse.value.code, 'UNTRUSTED_REQUEST_ORIGIN');
    assert.equal(crossOriginResponse.security_headers.frame, 'DENY');
    assert.equal(crossOriginResponse.security_headers.nosniff, 'nosniff');
    assert.equal(crossOriginResponse.security_headers.referrer, 'no-referrer');
    assert.match(crossOriginResponse.security_headers.csp, /frame-ancestors 'none'/);
    const wrongLocalOriginClient = `
      const response = await fetch('http://127.0.0.1:${port}/api/settings/reset-local-data', {
        method:'POST', headers:{'content-type':'application/json','origin':'http://localhost:1'},
        body:JSON.stringify({confirmed:true,confirmation_text:'RESET LOCAL DATA'})
      });
      process.stdout.write(JSON.stringify({status:response.status,value:await response.json()}));
    `;
    const wrongLocalOriginResult = spawnSync(process.execPath, ['--input-type=module', '-e', wrongLocalOriginClient], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(wrongLocalOriginResult.status, 0, wrongLocalOriginResult.stderr);
    const wrongLocalOriginResponse = JSON.parse(wrongLocalOriginResult.stdout);
    assert.equal(wrongLocalOriginResponse.status, 403);
    assert.equal(wrongLocalOriginResponse.value.code, 'UNTRUSTED_REQUEST_ORIGIN');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'search_preferences.json'), 'utf8')).active_search_profile_id, 'url-test');
    const client = `
      const base = 'http://127.0.0.1:${port}';
      const response = await fetch(base + '/api/jobs/import-url', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({url: base + '/mock-ats/jobs/123456', confirmed_public_fetch: true})
      });
      const value = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(value));
      process.stdout.write(JSON.stringify(value));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, 'completed');
    assert.equal(response.job.source, 'user_supplied_url');
    assert.equal(response.safety.application_submitted, false);
    const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, 'job_leads.json'), 'utf8'));
    const runs = JSON.parse(fs.readFileSync(path.join(dataDir, 'search_runs.json'), 'utf8'));
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].search_configuration_fingerprint, runs[0].search_configuration_fingerprint);
    assert.equal(runs[0].network_accessed, false);
  } finally {
    dashboard.kill();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Dashboard blocks corrupted local JSON without replacing it or exposing raw errors', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-corruption-guard-'));
  const dataDir = path.join(root, 'data');
  for (const directory of [dataDir, path.join(root, 'archive'), path.join(root, 'reports'), path.join(root, 'applications'), path.join(root, 'resumes')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, 'job_leads.json'), '[]\n');
  const corruptedPath = path.join(dataDir, 'jobs_shortlist.json');
  const corruptedContent = '{broken synthetic json\n';
  fs.writeFileSync(corruptedPath, corruptedContent);

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  let stderr = '';
  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'), RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
      RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'), RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
      RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json')
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  dashboard.stderr.on('data', chunk => { stderr += String(chunk); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dashboard did not start.')), 10000);
      dashboard.stdout.on('data', chunk => {
        if (String(chunk).includes('Dashboard server running')) { clearTimeout(timer); resolve(); }
      });
      dashboard.once('exit', code => { clearTimeout(timer); reject(new Error(`Dashboard exited with ${code}.`)); });
    });
    const client = `
      const response = await fetch('http://127.0.0.1:${port}/api/jobs');
      const value = await response.json();
      process.stdout.write(JSON.stringify({status: response.status, value}));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.status, 500);
    assert.equal(response.value.code, 'LOCAL_DATA_READ_FAILED');
    assert.match(response.value.message, /Restore it from a backup|Reset Local Data/);
    assert.doesNotMatch(response.value.message, /Unexpected token|resume-jobs-corruption-guard/i);
    assert.equal(fs.readFileSync(corruptedPath, 'utf8'), corruptedContent);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.doesNotMatch(stderr, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    assert.doesNotMatch(stderr, /broken synthetic json/i);
    assert.match(stderr, /local_data_read_failed/);
    assert.match(stderr, /dashboard_request_failed/);
    assert.deepEqual(fs.readdirSync(dataDir).filter(name => /\.tmp$/i.test(name)), []);
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a first-run user can import a job link before configuring any search', async () => {
  // Pasting a link is the first thing a new user does and the only discovery
  // path that always works. Requiring a saved target role first made the very
  // first action fail, which inverted the intended onboarding order.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-first-run-import-'));
  const dataDir = path.join(root, 'data');
  for (const directory of [dataDir, path.join(root, 'archive'), path.join(root, 'reports'), path.join(root, 'applications'), path.join(root, 'resumes')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  // Deliberately no search_preferences.json: this is a brand new install.

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'), RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
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
      const response = await fetch(base + '/api/jobs/import-url', {
        method: 'POST', headers: {'content-type':'application/json'},
        body: JSON.stringify({url: base + '/mock-ats/jobs/123456', confirmed_public_fetch: true})
      });
      process.stdout.write(JSON.stringify({status: response.status, value: await response.json()}));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);

    assert.equal(outcome.status, 200, 'importing a link must not require search configuration');
    assert.equal(outcome.value.status, 'completed');
    assert.equal(
      outcome.value.scored_against_preferences, false,
      'the response must say plainly that the job could not be scored yet'
    );
    assert.match(
      outcome.value.message, /target role/i,
      'the message must tell the user what to add to get a match score'
    );

    const jobs = JSON.parse(fs.readFileSync(path.join(dataDir, 'job_leads.json'), 'utf8'));
    assert.equal(jobs.length, 1, 'the job is stored even without preferences');
    assert.equal(jobs[0].source, 'user_supplied_url');
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
