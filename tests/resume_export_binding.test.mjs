// The export chain over real HTTP: draft → DOCX on disk → binding that
// preflight, apply-state and the Browser Agent session all resolve identically.
//
// The catastrophic failure this file exists to prevent is cross-contamination:
// job A's application must never be able to see, stage, or attach job B's
// tailored resume. Both directions are asserted by reading the actual files.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { extractDocxText } from '../scripts/lib/resume_document_intelligence.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('exports bind per job and never cross-contaminate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-export-'));
  const dataDir = path.join(root, 'data');
  const documentsDir = path.join(root, 'documents');
  for (const directory of ['data', 'archive', 'reports', 'applications', 'documents']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const writeJson = (name, value) => fs.writeFileSync(path.join(dataDir, name), `${JSON.stringify(value, null, 2)}\n`);

  const jobA = {
    job_id: 'job_alpha', title: 'Data Scientist', company: 'Alpha Analytics Corp',
    canonical_url: 'https://jobs.example.test/alpha', url: 'https://jobs.example.test/alpha',
    apply_url: 'https://jobs.example.test/alpha/apply',
    description_text: 'Python and causal inference experiments. '.repeat(6),
    provider: 'greenhouse', page_type: 'job_detail', recommended_decision: 'shortlist',
    info_quality: { score: 100 }, confidence: 0.95, match_score: 88,
    approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic_test'] },
    application_mode: 'REVIEW_ONLY', submit_allowed: false, upload_resume_allowed: false, final_submit_allowed: false
  };
  const jobB = {
    job_id: 'job_beta', title: 'Data Engineer', company: 'Beta Pipelines GmbH',
    canonical_url: 'https://jobs.example.test/beta', url: 'https://jobs.example.test/beta',
    apply_url: 'https://jobs.example.test/beta/apply',
    description_text: 'SQL query optimization and latency work.'
  };
  writeJson('job_leads.json', [jobA, jobB]);
  writeJson('jobs_shortlist.json', [jobA, jobB]);
  writeJson('job_reviews.json', []);
  writeJson('resume_profiles.json', {
    schema_version: '2.0',
    active_resume_profile_id: 'resume_export_v1',
    active_resume_id: 'resume_export_v1',
    items: [{
      id: 'resume_export_v1', resume_id: 'resume_export_v1', name: 'Export Resume', version: 1,
      enabled: true, file_reference: 'synthetic/resume.pdf', content_hash: 'sha256:synthetic-export',
      approved_at: '2026-08-01T00:00:00.000Z', target_roles: ['Data Scientist'], skills: ['python']
    }]
  });
  writeJson('career_profiles.local.json', {
    schema_version: '1.0',
    active_profile_id: 'career_export',
    profiles: [{
      id: 'career_export', family_id: 'career_export', version: 1, name: 'Export Profile',
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
      RESUME_JOBS_DOCUMENTS_DIR: documentsDir,
      RESUME_JOBS_RESUME_LIBRARY_DIR: path.join(documentsDir, 'resumes'),
      RESUME_JOBS_PROFILE_PATH: path.join(root, 'profile.json'),
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

      // Export with no draft must refuse, not invent.
      const noDraft = await request('/api/jobs/job_alpha/resume-draft/export', {method:'POST', body:'{}'});

      // Generate and export both jobs' drafts (DOCX only: the offline suite
      // never launches a browser).
      await request('/api/jobs/job_alpha/resume-draft', {method:'POST', body:'{}'});
      await request('/api/jobs/job_beta/resume-draft', {method:'POST', body:'{}'});
      const exportA = await request('/api/jobs/job_alpha/resume-draft/export', {method:'POST', body: JSON.stringify({formats:['docx']})});
      const exportB = await request('/api/jobs/job_beta/resume-draft/export', {method:'POST', body: JSON.stringify({formats:['docx']})});

      const stateA = await request('/api/jobs/job_alpha/apply-state');
      const stateB = await request('/api/jobs/job_beta/apply-state');
      const preflightA = await request('/api/jobs/job_alpha/quick-apply', {method:'POST', body:'{}'});

      // Editing the profile bumps its version — the exported file goes stale.
      await request('/api/application-profile', {
        method:'PUT', body: JSON.stringify({ patch: { skills: { ai_tools: ['PyTorch'] } } })
      });
      const staleState = await request('/api/jobs/job_alpha/apply-state');

      process.stdout.write(JSON.stringify({ noDraft, exportA, exportB, stateA, stateB, preflightA, staleState }));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', client], {
      encoding: 'utf8', timeout: 40000, windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const outcome = JSON.parse(result.stdout);

    // Refusal before generation.
    assert.equal(outcome.noDraft.status, 409);
    assert.equal(outcome.noDraft.value.code, 'RESUME_DRAFT_NOT_FOUND');

    // Both exports produced verified DOCX files.
    for (const exported of [outcome.exportA, outcome.exportB]) {
      assert.equal(exported.status, 200, JSON.stringify(exported.value).slice(0, 300));
      assert.equal(exported.value.verified.docx_text_ok, true, 'the text-layer round-trip must pass');
      assert.match(exported.value.files.docx_sha256, /^sha256:[0-9a-f]{64}$/);
      assert.equal(exported.value.safety.resume_uploaded, false);
    }

    // The files live in per-job directories and carry per-draft names.
    const docxA = path.resolve(ROOT, outcome.exportA.value.files.docx);
    const docxB = path.resolve(ROOT, outcome.exportB.value.files.docx);
    assert.notEqual(docxA, docxB);
    assert.ok(docxA.includes('job_alpha') && docxB.includes('job_beta'));

    // Cross-contamination check, on the actual bytes: each file mentions its
    // own candidate and neither mentions the other job's company.
    const textA = extractDocxText(fs.readFileSync(docxA)).text;
    const textB = extractDocxText(fs.readFileSync(docxB)).text;
    for (const [label, text] of [['A', textA], ['B', textB]]) {
      assert.ok(text.includes('Synthetic Candidate'), `file ${label} must carry the candidate name`);
    }
    assert.equal(textA.includes('Beta Pipelines GmbH'), false, 'job A\'s resume must not mention job B\'s employer');
    assert.equal(textB.includes('Alpha Analytics Corp'), false, 'job B\'s resume must not mention job A\'s employer');

    // Every consumer resolves the same binding.
    assert.equal(outcome.stateA.value.tailored_resume.available, true);
    assert.equal(outcome.stateB.value.tailored_resume.available, true);
    assert.notEqual(
      outcome.stateA.value.tailored_resume.file_name,
      outcome.stateB.value.tailored_resume.file_name,
      'two jobs must never share a resume file'
    );
    assert.equal(outcome.stateA.value.tailored_resume.stale_profile, false);
    assert.equal(outcome.preflightA.status, 200, JSON.stringify(outcome.preflightA.value).slice(0, 300));
    assert.equal(outcome.preflightA.value.preflight.tailored_resume.available, true);
    assert.equal(
      outcome.preflightA.value.preflight.tailored_resume.file_name,
      outcome.stateA.value.tailored_resume.file_name,
      'preflight and apply-state must name the same file'
    );

    // A profile edit after export marks the file stale — visibly.
    assert.equal(
      outcome.staleState.value.tailored_resume.stale_profile, true,
      'a resume exported from an older profile version must say so'
    );
  } finally {
    dashboard.kill();
    await new Promise(resolve => dashboard.once('exit', resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
