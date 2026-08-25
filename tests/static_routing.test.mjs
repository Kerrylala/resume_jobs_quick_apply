// Quick Apply becomes the default UI at "/" while the original Dashboard stays
// reachable at "/advanced". That means the server now reads files off disk by
// request path, so the traversal guard is a security boundary, not a detail.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('static routing serves both UIs and refuses to escape their directories', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-static-'));
  for (const directory of ['data', 'archive', 'reports', 'applications', 'resumes']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }

  const probe = http.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));

  const dashboard = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), RESUME_JOBS_DATA_DIR: path.join(root, 'data'),
      RESUME_JOBS_REPORTS_DIR: path.join(root, 'reports'),
      RESUME_JOBS_APPLICATIONS_DIR: path.join(root, 'applications'),
      RESUME_JOBS_ARCHIVE_DIR: path.join(root, 'archive'),
      RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(root, 'resumes'),
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
      const get = async (url) => {
        const response = await fetch(base + url);
        const body = await response.text();
        return {
          status: response.status,
          type: response.headers.get('content-type') || '',
          length: body.length,
          leaks_package_json: body.includes('"resume-jobs-ai"'),
          leaks_server_source: body.includes('createServer')
        };
      };
      process.stdout.write(JSON.stringify({
        root: await get('/'),
        advanced: await get('/advanced'),
        advanced_asset: await get('/advanced/style.css'),
        legacy_app: await get('/app.js'),
        traversal_dots: await get('/../package.json'),
        traversal_encoded: await get('/..%2fpackage.json'),
        traversal_deep: await get('/advanced/../../package.json'),
        traversal_server: await get('/advanced/../server.mjs'),
        missing: await get('/does-not-exist.mjs'),
        api_still_json: await get('/api/summary')
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
      encoding: 'utf8', timeout: 20000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);

    // Both front ends are reachable.
    assert.equal(outcome.root.status, 200, '"/" must serve a UI');
    assert.match(outcome.root.type, /text\/html/);
    assert.equal(outcome.advanced.status, 200, 'the original Dashboard must stay reachable at /advanced');
    assert.match(outcome.advanced.type, /text\/html/);
    assert.equal(outcome.advanced_asset.status, 200);
    assert.match(outcome.advanced_asset.type, /text\/css/);
    assert.equal(outcome.legacy_app.status, 200, 'the original Dashboard references /app.js at the root');

    // Nothing outside the two UI directories is reachable.
    for (const key of ['traversal_dots', 'traversal_encoded', 'traversal_deep', 'traversal_server']) {
      assert.notEqual(outcome[key].status, 200, `${key} must not be served`);
      assert.equal(outcome[key].leaks_package_json, false, `${key} leaked package.json`);
      assert.equal(outcome[key].leaks_server_source, false, `${key} leaked server source`);
    }
    assert.equal(outcome.missing.status, 404);

    // API routes are unaffected by the static fallback.
    assert.equal(outcome.api_still_json.status, 200);
    assert.match(outcome.api_still_json.type, /application\/json/);
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
