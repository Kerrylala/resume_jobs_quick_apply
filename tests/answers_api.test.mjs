import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Answer Memory has full CRUD, derives reuse approval, and keeps sticky metadata on edits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-answers-'));
  const dataDir = path.join(root, 'data');
  const archiveDir = path.join(root, 'archive');
  for (const directory of [dataDir, archiveDir, path.join(root, 'reports'), path.join(root, 'applications'), path.join(root, 'resumes')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(dataDir, 'question_bank.json'), `${JSON.stringify({
    version: '2.0',
    answers: [{
      original_question: 'Do you require visa sponsorship?',
      answer: 'Synthetic sponsorship answer',
      source: 'user_confirmed',
      user_confirmed: true,
      canonical_key: 'sponsorship',
      risk_level: 'high',
      sensitive_category: 'work_authorization'
    }]
  }, null, 2)}\n`);

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
    const client = `
      const base = 'http://127.0.0.1:${port}';
      const request = async (url, options={}) => {
        const response = await fetch(base + url, {headers:{'content-type':'application/json'}, ...options});
        return {status: response.status, value: await response.json()};
      };
      const savedSafe = await request('/api/answers', {method:'POST', body:JSON.stringify({answer:{
        original_question:'What is your notice period?', answer:'Synthetic thirty days',
        source:'user_entered', scope:'global', sensitive_category:'none', user_confirmed:true
      }})});
      const listed = await request('/api/answers');
      const safeId = savedSafe.value.question_id;
      const highRisk = listed.value.answers.find(item => item.canonical_key === 'sponsorship');
      const updated = await request('/api/answers/'+encodeURIComponent(highRisk.question_id), {
        method:'PUT', body:JSON.stringify({answer:'Synthetic sponsorship answer v2', user_confirmed:true})
      });
      const fetchedSafe = await request('/api/answers/'+encodeURIComponent(safeId));
      const deleted = await request('/api/answers/'+encodeURIComponent(safeId), {method:'DELETE'});
      const missing = await request('/api/answers/'+encodeURIComponent(safeId));
      const finalList = await request('/api/answers');
      process.stdout.write(JSON.stringify({
        saved_safe: savedSafe.value,
        list_total: listed.value.total,
        safe_reusable: listed.value.safe_reusable_answers,
        updated: updated.value.answer_record,
        fetched_safe_status: fetchedSafe.status,
        deleted_status: deleted.status,
        missing_status: missing.status,
        final_total: finalList.value.total
      }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], { encoding: 'utf8', timeout: 20000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);

    assert.equal(outcome.saved_safe.user_confirmed, true);
    assert.equal(outcome.saved_safe.approved_for_real_applications, true);
    assert.equal(outcome.list_total, 2);
    assert.equal(outcome.safe_reusable, 1);

    assert.equal(outcome.updated.answer, 'Synthetic sponsorship answer v2');
    assert.equal(outcome.updated.version, 2);
    assert.equal(outcome.updated.canonical_key, 'sponsorship');
    assert.equal(outcome.updated.risk_level, 'high');
    assert.equal(outcome.updated.approved_for_real_applications, false);

    assert.equal(outcome.fetched_safe_status, 200);
    assert.equal(outcome.deleted_status, 200);
    assert.equal(outcome.missing_status, 404);
    assert.equal(outcome.final_total, 1);
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
