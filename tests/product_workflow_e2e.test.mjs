import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { discoverJobs } from '../scripts/discover_jobs.mjs';
import { mergeJobRecords } from '../scripts/lib/job_records.mjs';
import { createMockAIProvider } from '../scripts/lib/ai_provider.mjs';
import { normalizeSearchPreferences } from '../scripts/lib/search_preferences.mjs';
import { scoreJob } from '../scripts/score_jobs.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The offline guard blocks filesystem probes outside the project root, so the
// project-local Chrome for Testing runtime (which the installed-extension
// stage needs anyway) must be first — a system-wide browser path would always
// read as missing here and silently skip the browser stage.
function detectProjectChromeForTesting() {
  const base = path.join(PROJECT_ROOT, 'browser_runtime', 'chrome');
  let versions = [];
  try { versions = fs.readdirSync(base); } catch { return ''; }
  for (const version of versions.sort().reverse()) {
    const candidate = path.join(base, version, 'chrome-win64', 'chrome.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}
const BROWSER_EXECUTABLE = [
  process.env.CHROME_PATH,
  process.env.CHROMIUM_PATH,
  detectProjectChromeForTesting(),
].filter(Boolean).find(candidate => {
  try { return fs.existsSync(candidate); } catch { return false; }
});

// The real-Chromium stage is opt-in. The offline suite must stay deterministic
// and must not depend on a locally installed browser version. Set
// RESUME_JOBS_E2E_BROWSER=1 (see the test:browser:e2e package script) to run the
// real localhost Mock ATS stage.
const E2E_BROWSER_ENABLED = process.env.RESUME_JOBS_E2E_BROWSER === '1' && Boolean(BROWSER_EXECUTABLE);

// Deterministic stand-in for that stage. Only the three fields the later phases
// consume need realistic values; the browser-behaviour assertions run only when
// the real stage is enabled.
const SYNTHETIC_BROWSER_REPORT = {
  complex_form: { filled_fields_count: 6, skipped_risky_fields_count: 2 },
  local_form: { filled_fields_count: 6, total_fields_seen: 8 },
  suggested_new_rules_summary: [{ field: 'synthetic_stand_in', reason: 'offline_deterministic_run' }]
};

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function freeLoopbackPort() {
  const probe = spawnSync(process.execPath, ['-e', `
    const net = require('node:net');
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write(String(server.address().port));
      server.close();
    });
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  return Number(probe.stdout.trim());
}

function runClient(port, source, timeout = 60000) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const base = 'http://127.0.0.1:${port}';
    const request = async (pathname, options = {}) => {
      const response = await fetch(base + pathname, {
        headers: { 'Content-Type': 'application/json' },
        ...options
      });
      const value = await response.json();
      if (!response.ok) throw new Error(pathname + ': ' + response.status + ' ' + JSON.stringify(value));
      return value;
    };
    ${source}
  `], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function syntheticProfile() {
  const template = JSON.parse(fs.readFileSync(
    path.join(PROJECT_ROOT, 'extensions', 'application_assistant', 'profile.local.template.json'),
    'utf8'
  ));
  return {
    ...template,
    approved_for_real_applications: true,
    allow_autofill_real_sites: true,
    allow_resume_attach: false,
    allow_final_submit: false,
    review_required_before_real_applications: true,
    profile_type: 'synthetic_fixture',
    full_name: 'Synthetic Candidate',
    first_name: 'Synthetic',
    last_name: 'Candidate',
    email: 'candidate@local.invalid',
    phone: '000-000-0000',
    city: 'Fixture City',
    country: 'ZZ',
    profile_meta: {
      ...template.profile_meta,
      approved_for_real_applications: true,
      allow_autofill_real_sites: true,
      allow_resume_attach: false,
      allow_final_submit: false,
      review_required_before_real_applications: true
    }
  };
}

function syntheticTextPdf(lines) {
  const operators = lines.map((line, index) =>
    `${index ? '0 -20 Td\n' : ''}(${String(line).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj`
  ).join('\n');
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n${operators}\nET`;
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Length ${Buffer.byteLength(stream)} >>
stream
${stream}
endstream
endobj
%%EOF
`, 'latin1');
}

const scoringConfig = {
  scoring_config_version: 'synthetic-e2e-v1',
  target_roles: [{ keyword: 'Product Manager', weight: 100, enabled: true, aliases: [], terms: ['Product Manager'] }],
  preferred_locations: [{ keyword: 'Remote', weight: 100, enabled: true, aliases: [], terms: ['Remote'] }],
  preferred_companies: [],
  excluded_keywords: [],
  excluded_companies: [],
  required_skills: ['roadmapping', 'analytics'],
  preferred_skills: ['experimentation'],
  workplace_modes: ['remote'],
  seniority_levels: ['mid'],
  posted_within_days: 30,
  job_types: ['full_time'],
  minimum_salary: 5000,
  maximum_jobs_to_open: 1,
  safety: { auto_approve: false, auto_submit: false, auto_upload_resume: false },
  scoring_weights: { base: 60, strong_role_match: 25, preferred_location: 10, preferred_company: 0 },
  thresholds: { shortlist_candidate: 80, manual_review_candidate: 65, keep_in_queue: 50 }
};

test('G10 complete synthetic product workflow reaches audited manual-submit readiness', async () => {
  const requestedRoot = String(process.env.RESUME_JOBS_E2E_ROOT || '').trim();
  const root = requestedRoot
    ? path.resolve(requestedRoot)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-product-e2e-'));
  if (requestedRoot) {
    fs.mkdirSync(root, { recursive: true });
  }
  const dataDir = path.join(root, 'data');
  const reportsDir = path.join(root, 'reports');
  const applicationsDir = path.join(root, 'applications');
  const archiveDir = path.join(root, 'archive');
  const browserOutputDir = path.join(root, 'browser');
  const resumeLibraryDir = path.join(root, 'resume-library');
  const profilePath = path.join(root, 'synthetic-profile.json');
  for (const directory of [dataDir, reportsDir, applicationsDir, archiveDir, browserOutputDir, resumeLibraryDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const searchPreferences = normalizeSearchPreferences({
    active_search_profile_id: 'synthetic-e2e',
    search_profiles: [{
      id: 'synthetic-e2e',
      name: 'Synthetic E2E',
      enabled: true,
      target_roles: [{ keyword: 'Product Manager', weight: 100, enabled: true, aliases: [] }],
      preferred_locations: [{ keyword: 'Remote', weight: 100, enabled: true, aliases: [] }],
      workplace_modes: ['remote'],
      seniority_levels: ['mid'],
      required_skills: ['roadmapping', 'analytics'],
      preferred_skills: ['experimentation'],
      excluded_keywords: [],
      excluded_companies: [],
      posted_within_days: 30,
      job_types: ['full_time'],
      minimum_salary: 5000,
      maximum_search_results: 10,
      maximum_jobs_to_open: 1
    }],
    safety: { auto_approve: false, auto_submit: false, auto_upload_resume: false }
  }, { strict: true }).value;

  const discovery = await discoverJobs({
    fixture: true,
    dryRun: true,
    preferences: searchPreferences,
    maxQueries: 1,
    maxResultsPerQuery: 10
  });
  assert.equal(discovery.status, 'ok');
  assert.equal(discovery.network_accessed, false);
  assert.equal(discovery.job_leads_modified, false);

  const discoveredJob = {
    source: 'fixture',
    source_job_id: 'synthetic-e2e-001',
    title: 'Product Manager',
    company: 'Synthetic Labs',
    location: 'Remote',
    remote_policy: 'remote',
    seniority: 'mid',
    job_type: 'full_time',
    salary_min: 6000,
    posted_at: new Date().toISOString(),
    provider: 'greenhouse',
    ats: 'greenhouse',
    url: 'https://boards.greenhouse.io/synthetic/jobs/123456?utm_source=synthetic',
    description_text: 'Roadmapping analytics experimentation for a controlled offline product role. '.repeat(8),
    info_quality: { score: 100 },
    confidence: 0.95,
    application_mode: 'REVIEW_ONLY',
    submit_allowed: false,
    upload_resume_allowed: false,
    final_submit_allowed: false
  };
  const merged = mergeJobRecords([], [
    discoveredJob,
    { ...discoveredJob, source: 'fixture_duplicate', url: 'https://boards.greenhouse.io/synthetic/jobs/123456#details' }
  ], { now: '2026-07-23T00:00:00.000Z' });
  assert.equal(merged.jobs.length, 1);
  assert.equal(merged.duplicates_merged, 1);

  const scored = scoreJob(merged.jobs[0], scoringConfig);
  assert.equal(scored.hard_filter.passed, true);
  assert.equal(scored.approval_safety.safe_to_approve, true);
  assert.equal(scored.recommended_decision, 'approve');
  const job = {
    ...merged.jobs[0],
    page_type: scored.page_type,
    match_score: scored.score,
    score: scored.score,
    score_breakdown: scored.score_breakdown,
    hard_filter: scored.hard_filter,
    recommended_decision: scored.recommended_decision,
    approval_safety: scored.approval_safety,
    approval_warning: scored.approval_warning
  };

  const mockModel = createMockAIProvider({
    explain_match: { explanation: scored.score_breakdown.explanation }
  });
  assert.equal((await mockModel.healthCheck()).network_accessed, false);
  assert.equal((await mockModel.structuredTask({
    task: 'explain_match',
    fallback: { explanation: '' }
  })).model_used, true);

  writeJson(profilePath, syntheticProfile());
  writeJson(path.join(dataDir, 'search_preferences.json'), searchPreferences);
  writeJson(path.join(dataDir, 'jobs_shortlist.json'), [job]);
  writeJson(path.join(dataDir, 'job_leads.json'), [job]);
  writeJson(path.join(dataDir, 'job_reviews.json'), []);
  writeJson(path.join(dataDir, 'resume_profiles.json'), { items: [] });
  writeJson(path.join(dataDir, 'question_bank.json'), { answers: [] });
  writeJson(path.join(dataDir, 'dashboard_state.json'), {
    selected_job_ids: [],
    application_status_overrides: {},
    application_execution_sessions: {},
    audit_events: []
  });

  const port = freeLoopbackPort();
  const dashboard = spawn(process.execPath, [path.join(PROJECT_ROOT, 'dashboard', 'server.mjs')], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      RESUME_JOBS_DATA_DIR: dataDir,
      RESUME_JOBS_REPORTS_DIR: reportsDir,
      RESUME_JOBS_APPLICATIONS_DIR: applicationsDir,
      RESUME_JOBS_ARCHIVE_DIR: archiveDir,
      RESUME_JOBS_RESUME_LIBRARY_DIR: resumeLibraryDir,
      RESUME_JOBS_PROFILE_PATH: profilePath
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic Dashboard server did not start.')), 10000);
      dashboard.stdout.on('data', chunk => {
        if (String(chunk).includes('Dashboard server running')) {
          clearTimeout(timer);
          resolve();
        }
      });
      dashboard.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Synthetic Dashboard server exited early with ${code}.`));
      });
    });

    const jobId = job.job_id;
    const generalResumeBase64 = syntheticTextPdf([
      'Synthetic Candidate',
      'candidate@local.invalid',
      'Operations'
    ]).toString('base64');
    const productResumeBase64 = syntheticTextPdf([
      'Synthetic Candidate',
      'candidate@local.invalid',
      '+1 555-010-1234',
      'https://linkedin.com/in/synthetic-candidate',
      'Skills: roadmapping, analytics, experimentation'
    ]).toString('base64');
    const phaseOne = runClient(port, `
      const searchPreferences = ${JSON.stringify(searchPreferences)};
      const savedSearch = await request('/api/settings/search-preferences', {
        method: 'POST',
        body: JSON.stringify({ search_preferences: searchPreferences })
      });
      const savedGeneralResume = await request('/api/settings/resume-upload', {
        method: 'POST',
        body: JSON.stringify({
          file_name: 'synthetic-general.pdf',
          content_base64: '${generalResumeBase64}',
          display_name: 'Synthetic General Resume',
          target_roles: ['Operations'],
          language: 'en',
          activate: true,
          confirmed_local_copy: true
        })
      });
      const savedResume = await request('/api/settings/resume-upload', {
        method: 'POST',
        body: JSON.stringify({
          file_name: 'synthetic-e2e.pdf',
          content_base64: '${productResumeBase64}',
          display_name: 'Synthetic E2E Resume',
          target_roles: ['Product Manager'],
          language: 'en',
          activate: false,
          confirmed_local_copy: true
        })
      });
      const duplicateResume = await fetch(base + '/api/settings/resume-upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_name: 'synthetic-e2e-copy.pdf',
          content_base64: '${productResumeBase64}',
          display_name: 'Synthetic E2E Resume Copy',
          activate: false,
          confirmed_local_copy: true
        })
      });
      const renamedGeneralResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(savedGeneralResume.resume_profile.resume_id) + '/manage',
        {
          method: 'POST',
          body: JSON.stringify({ action: 'rename', name: 'Renamed Synthetic General Resume' })
        }
      );
      const duplicatedProductResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/manage',
        {
          method: 'POST',
          body: JSON.stringify({ action: 'duplicate' })
        }
      );
      const duplicatedResumeId = duplicatedProductResume.resume_profile.resume_id;
      const archivedDuplicateResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(duplicatedResumeId) + '/manage',
        {
          method: 'POST',
          body: JSON.stringify({ action: 'archive', confirmed: true })
        }
      );
      const restoredDuplicateResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(duplicatedResumeId) + '/manage',
        {
          method: 'POST',
          body: JSON.stringify({ action: 'restore' })
        }
      );
      const activatedProductResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/manage',
        {
          method: 'POST',
          body: JSON.stringify({ action: 'set_active' })
        }
      );
      const exportedProductResponse = await fetch(
        base + '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/export'
      );
      const exportedProductResume = {
        status: exportedProductResponse.status,
        content_type: exportedProductResponse.headers.get('content-type'),
        content_disposition: exportedProductResponse.headers.get('content-disposition'),
        size_bytes: (await exportedProductResponse.arrayBuffer()).byteLength
      };
      const deletedDuplicateResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(duplicatedResumeId) + '/manage',
        {
          method: 'POST',
          body: JSON.stringify({
            action: 'delete',
            confirmed: true,
            content_hash: duplicatedProductResume.resume_profile.content_hash
          })
        }
      );
      const workflowAfterResume = await request('/api/workflow-state');
      const liveSearchPreflightResponse = await fetch(base + '/api/run/discovery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const liveSearchPreflight = {
        status: liveSearchPreflightResponse.status,
        body: await liveSearchPreflightResponse.json()
      };
      const unconfirmedResumeApproval = await fetch(
        base + '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/approve',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content_hash: savedResume.resume_profile.content_hash })
        }
      );
      const staleResumeApproval = await fetch(
        base + '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/approve',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed: true, content_hash: 'sha256:stale-review' })
        }
      );
      const unconfirmedResumeAnalysis = await fetch(
        base + '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/analyze',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content_hash: savedResume.resume_profile.content_hash })
        }
      );
      const staleResumeAnalysis = await fetch(
        base + '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/analyze',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmed_local_analysis: true, content_hash: 'sha256:stale-analysis' })
        }
      );
      const analyzedResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/analyze',
        {
          method: 'POST',
          body: JSON.stringify({
            confirmed_local_analysis: true,
            content_hash: savedResume.resume_profile.content_hash
          })
        }
      );
      const settingsAfterAnalysis = await request('/api/settings');
      const unconfirmedSuggestionApply = await fetch(
        base + '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/apply-suggestions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confirmed_local_analysis: true,
            content_hash: savedResume.resume_profile.content_hash,
            analysis_snapshot_token: analyzedResume.analysis.snapshot_token,
            selected_suggestion_ids: ['resume_suggestion_linkedin']
          })
        }
      );
      const staleSuggestionApply = await fetch(
        base + '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/apply-suggestions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            confirmed_local_analysis: true,
            confirmed_apply: true,
            content_hash: savedResume.resume_profile.content_hash,
            analysis_snapshot_token: 'sha256:stale-analysis',
            selected_suggestion_ids: ['resume_suggestion_linkedin']
          })
        }
      );
      const appliedResumeSuggestions = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/apply-suggestions',
        {
          method: 'POST',
          body: JSON.stringify({
            confirmed_local_analysis: true,
            confirmed_apply: true,
            content_hash: savedResume.resume_profile.content_hash,
            analysis_snapshot_token: analyzedResume.analysis.snapshot_token,
            selected_suggestion_ids: ['resume_suggestion_linkedin']
          })
        }
      );
      const settingsAfterSuggestionApply = await request('/api/settings');
      const addedProfileFact = await request('/api/settings/candidate-profile/facts', {
        method: 'POST',
        body: JSON.stringify({
          action: 'add',
          fact_key: 'awards',
          value: ['Synthetic Award']
        })
      });
      const editedProfileFact = await request('/api/settings/candidate-profile/facts', {
        method: 'POST',
        body: JSON.stringify({
          action: 'edit',
          fact_key: 'awards',
          value: ['Updated Synthetic Award']
        })
      });
      const approvedProfileFact = await request('/api/settings/candidate-profile/facts', {
        method: 'POST',
        body: JSON.stringify({
          action: 'approve',
          fact_key: 'awards',
          confirmed: true
        })
      });
      const rejectedProfileFact = await request('/api/settings/candidate-profile/facts', {
        method: 'POST',
        body: JSON.stringify({
          action: 'reject',
          fact_key: 'awards',
          confirmed: true
        })
      });
      const readdedProfileFact = await request('/api/settings/candidate-profile/facts', {
        method: 'POST',
        body: JSON.stringify({
          action: 'add',
          fact_key: 'awards',
          value: ['Replacement Synthetic Award']
        })
      });
      const deletedProfileFact = await request('/api/settings/candidate-profile/facts', {
        method: 'POST',
        body: JSON.stringify({
          action: 'delete',
          fact_key: 'awards',
          confirmed: true
        })
      });
      const approvedResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(savedResume.resume_profile.resume_id) + '/approve',
        {
          method: 'POST',
          body: JSON.stringify({
            confirmed: true,
            content_hash: savedResume.resume_profile.content_hash
          })
        }
      );
      const approvedGeneralResume = await request(
        '/api/settings/resume-profiles/' + encodeURIComponent(savedGeneralResume.resume_profile.resume_id) + '/approve',
        {
          method: 'POST',
          body: JSON.stringify({
            confirmed: true,
            content_hash: savedGeneralResume.resume_profile.content_hash
          })
        }
      );
      const answerV1 = await request('/api/settings/question-answer', {
        method: 'POST',
        body: JSON.stringify({ answer: {
          original_question: 'Why are you interested in this role?',
          question_patterns: ['Why are you interested in this role?'],
          answer: 'I prefer this controlled offline role.',
          category: 'motivation',
          source: 'user_entered',
          user_confirmed: true,
          approved_for_real_applications: true,
          confidence: 1
        }})
      });
      const answerV2 = await request('/api/settings/question-answer', {
        method: 'POST',
        body: JSON.stringify({ answer: {
          original_question: 'Why are you interested in this role',
          question_patterns: ['Why are you interested in this role?'],
          answer: 'I prefer this controlled offline product role.',
          category: 'motivation',
          source: 'user_confirmed',
          user_confirmed: true,
          approved_for_real_applications: true,
          confidence: 1
        }})
      });
      const settingsReadiness = await request('/api/settings');
      const factConfirmation = await request('/api/settings/candidate-profile/confirm', {
        method: 'POST',
        body: JSON.stringify({
          confirmed: true,
          snapshot_token: settingsReadiness.resume_intelligence.snapshot_token
        })
      });
      const careerBeforePackage = await request('/api/career-brain');
      const approvedCareerProfile = await request('/api/career-brain/profiles', {
        method: 'POST',
        body: JSON.stringify({
          action: 'approve',
          profile_id: careerBeforePackage.active_profile_id,
          confirmed: true
        })
      });
      const workflowAfterProfile = await request('/api/workflow-state');
      const approved = await request('/api/jobs/${jobId}/approve', {
        method: 'POST',
        body: JSON.stringify({ reason: 'synthetic_e2e_review' })
      });
      const overflow = await fetch(base + '/api/workflow/selection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_ids: ['${jobId}', 'synthetic-overflow'] })
      });
      const selected = await request('/api/workflow/selection', {
        method: 'POST',
        body: JSON.stringify({ job_ids: ['${jobId}'] })
      });
      const built = await request('/api/jobs/${jobId}/build-package-preview', { method: 'POST' });
      const recommendedPackage = await request('/api/jobs/${jobId}/application-package');
      const overridden = await request('/api/jobs/${jobId}/build-package-preview', {
        method: 'POST',
        body: JSON.stringify({ resume_id: savedGeneralResume.resume_profile.resume_id })
      });
      const overridePackage = await request('/api/jobs/${jobId}/application-package');
      const rebuiltRecommended = await request('/api/jobs/${jobId}/build-package-preview', { method: 'POST' });
      const packageValue = await request('/api/jobs/${jobId}/application-package');
      const completionSummary = await request('/api/summary');
      const executorSelected = await request('/api/jobs/${jobId}/executor-selection', {
        method: 'POST',
        body: JSON.stringify({ executor_type: 'extension' })
      });
      const approvedFill = await request('/api/jobs/${jobId}/approve-fill', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true })
      });
      const started = await request('/api/jobs/${jobId}/start-fill', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, executor_type: 'extension', idempotency_key: 'synthetic-e2e-start' })
      });
      const replay = await request('/api/jobs/${jobId}/start-fill', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, executor_type: 'extension', idempotency_key: 'synthetic-e2e-start' })
      });
      const mismatchedQueryHandoffResponse = await fetch(
        base + '/api/extension/active-handoff?url=' + encodeURIComponent('${job.url}&gh_jid=another-job'),
        { headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }
      );
      const extensionHandoffResponse = await fetch(
        base + '/api/extension/active-handoff?url=' + encodeURIComponent('${job.url}'),
        { headers: { Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }
      );
      const extensionHandoff = await extensionHandoffResponse.json();
      const extensionDiagnosticResponse = await fetch(base + '/api/extension/diagnostics', {
        method: 'POST',
        headers: {
          Origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          current_url: '${job.url}',
          content_script_connected: true,
          extension_version: '1.0.0'
        })
      });
      const extensionDiagnostic = await extensionDiagnosticResponse.json();
      const extensionDiagnosticRead = await request('/api/extension/diagnostics');
      const unauthorizedExtensionDiagnostic = await fetch(base + '/api/extension/diagnostics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_url: '${job.url}', content_script_connected: true })
      });
      console.log(JSON.stringify({
        savedSearch, savedGeneralResume, savedResume, workflowAfterResume, liveSearchPreflight, approvedResume, approvedGeneralResume,
        duplicate_resume_status: duplicateResume.status,
        renamedGeneralResume, duplicatedProductResume, archivedDuplicateResume,
        restoredDuplicateResume, activatedProductResume, exportedProductResume,
        deletedDuplicateResume,
        unconfirmed_resume_approval_status: unconfirmedResumeApproval.status,
        stale_resume_approval_status: staleResumeApproval.status,
        unconfirmed_resume_analysis_status: unconfirmedResumeAnalysis.status,
        stale_resume_analysis_status: staleResumeAnalysis.status,
        analyzedResume, settingsAfterAnalysis,
        unconfirmed_suggestion_apply_status: unconfirmedSuggestionApply.status,
        stale_suggestion_apply_status: staleSuggestionApply.status,
        appliedResumeSuggestions, settingsAfterSuggestionApply,
        addedProfileFact, editedProfileFact, approvedProfileFact, rejectedProfileFact,
        readdedProfileFact, deletedProfileFact,
        answerV1, answerV2, settingsReadiness, factConfirmation, careerBeforePackage, approvedCareerProfile, workflowAfterProfile, approved,
        overflow_status: overflow.status, selected, built, recommendedPackage,
        overridden, overridePackage, rebuiltRecommended, packageValue,
        completionSummary, approvedFill, started, replay,
        mismatched_query_handoff_status: mismatchedQueryHandoffResponse.status,
        extension_handoff_status: extensionHandoffResponse.status,
        extensionHandoff,
        extension_diagnostic_status: extensionDiagnosticResponse.status,
        unauthorized_extension_diagnostic_status: unauthorizedExtensionDiagnostic.status,
        extensionDiagnostic,
        extensionDiagnosticRead
      }));
    `);

    assert.equal(phaseOne.savedSearch.status, 'ok');
    assert.equal(phaseOne.savedResume.status, 'ok');
    assert.ok(phaseOne.savedSearch.search_preferences.workflow_meta.configured_at);
    assert.equal(phaseOne.workflowAfterResume.source, 'derived_current_domain_state');
    assert.equal(phaseOne.workflowAfterResume.current_step.key, 'profile_approved');
    assert.equal(phaseOne.liveSearchPreflight.status, 409);
    assert.equal(phaseOne.liveSearchPreflight.body.code, 'LIVE_SEARCH_NOT_CONFIGURED');
    assert.equal(phaseOne.liveSearchPreflight.body.safety.network_accessed, false);
    assert.equal(phaseOne.savedResume.intake.content_parsed, true);
    assert.equal(phaseOne.savedResume.intake.candidate_facts_generated, true);
    assert.equal(phaseOne.savedResume.intake.candidate_facts_persisted, 0);
    assert.equal(phaseOne.savedResume.analysis.raw_text_included, false);
    assert.equal(phaseOne.savedResume.safety.model_called, false);
    assert.equal(phaseOne.savedResume.safety.existing_candidate_facts_overwritten, false);
    assert.equal(phaseOne.savedResume.intake.review_required, true);
    assert.equal(phaseOne.savedResume.safety.stored_locally, true);
    assert.equal(phaseOne.savedResume.safety.external_upload_performed, false);
    assert.equal(phaseOne.savedResume.safety.resume_attach_enabled, false);
    assert.equal(phaseOne.savedResume.safety.final_submit_enabled, false);
    assert.equal(phaseOne.savedResume.safety.automatically_approved, false);
    assert.equal(phaseOne.savedResume.resume_profile.approved_at, null);
    assert.equal(phaseOne.approvedResume.status, 'ok');
    assert.equal(phaseOne.approvedGeneralResume.status, 'ok');
    assert.ok(phaseOne.approvedResume.resume_profile.approved_at);
    assert.equal(phaseOne.approvedResume.safety.content_hash_reverified, true);
    assert.equal(phaseOne.approvedResume.safety.resume_attached, false);
    assert.equal(phaseOne.approvedResume.safety.real_site_opened, false);
    assert.equal(phaseOne.approvedResume.safety.final_submit_enabled, false);
    assert.equal(phaseOne.duplicate_resume_status, 409);
    assert.equal(phaseOne.renamedGeneralResume.resume_profile.name, 'Renamed Synthetic General Resume');
    assert.equal(phaseOne.duplicatedProductResume.resume_profile.approved_at, null);
    assert.equal(
      phaseOne.duplicatedProductResume.resume_profile.duplicated_from_resume_id,
      phaseOne.savedResume.resume_profile.resume_id
    );
    assert.ok(phaseOne.archivedDuplicateResume.resume_profile.archived_at);
    assert.equal(phaseOne.restoredDuplicateResume.resume_profile.archived_at, null);
    assert.equal(
      phaseOne.activatedProductResume.resume_profiles.active_resume_profile_id,
      phaseOne.savedResume.resume_profile.resume_id
    );
    assert.equal(phaseOne.exportedProductResume.status, 200);
    assert.equal(phaseOne.exportedProductResume.content_type, 'application/pdf');
    assert.match(phaseOne.exportedProductResume.content_disposition, /attachment/);
    assert.ok(phaseOne.exportedProductResume.size_bytes > 0);
    assert.equal(phaseOne.deletedDuplicateResume.deleted_local_copy, true);
    assert.equal(
      phaseOne.deletedDuplicateResume.resume_profiles.items.some(item =>
        item.resume_id === phaseOne.duplicatedProductResume.resume_profile.resume_id
      ),
      false
    );
    assert.equal(phaseOne.unconfirmed_resume_approval_status, 409);
    assert.equal(phaseOne.stale_resume_approval_status, 409);
    assert.equal(phaseOne.unconfirmed_resume_analysis_status, 409);
    assert.equal(phaseOne.stale_resume_analysis_status, 409);
    assert.equal(phaseOne.analyzedResume.status, 'ok');
    assert.equal(phaseOne.analyzedResume.analysis.analysis_mode, 'explicit_local_preview');
    assert.equal(phaseOne.analyzedResume.analysis.raw_text_included, false);
    assert.equal(phaseOne.analyzedResume.analysis.persistence.raw_text_saved, false);
    assert.equal(phaseOne.analyzedResume.analysis.persistence.suggestions_saved, false);
    assert.equal(phaseOne.analyzedResume.safety.content_hash_reverified, true);
    assert.equal(phaseOne.analyzedResume.safety.local_library_boundary_verified, true);
    assert.equal(phaseOne.analyzedResume.safety.external_request_performed, false);
    assert.equal(phaseOne.analyzedResume.safety.model_called, false);
    assert.equal(phaseOne.analyzedResume.safety.candidate_profile_modified, false);
    assert.equal(phaseOne.analyzedResume.safety.resume_profile_modified, false);
    assert.deepEqual(
      phaseOne.analyzedResume.analysis.suggestions.find(item => item.fact_key === 'linkedin').can_apply_to_existing_profile,
      true
    );
    assert.deepEqual(
      phaseOne.analyzedResume.analysis.suggestions.find(item => item.fact_key === 'email').value,
      'candidate@local.invalid'
    );
    assert.equal(
      phaseOne.settingsAfterAnalysis.resume_profiles.items.find(item => item.resume_id === 'synthetic_e2e_resume_v1').approved_at,
      null
    );
    assert.equal(phaseOne.settingsAfterAnalysis.resume_intelligence.summary.core_fact_coverage_percent, 86);
    assert.equal(phaseOne.unconfirmed_suggestion_apply_status, 409);
    assert.equal(phaseOne.stale_suggestion_apply_status, 409);
    assert.equal(phaseOne.appliedResumeSuggestions.status, 'ok');
    assert.deepEqual(
      phaseOne.appliedResumeSuggestions.applied.map(item => item.fact_key),
      ['linkedin']
    );
    assert.equal(phaseOne.appliedResumeSuggestions.safety.profile_approval_revoked, true);
    assert.equal(phaseOne.appliedResumeSuggestions.safety.review_required, true);
    assert.equal(phaseOne.appliedResumeSuggestions.safety.allow_autofill_real_sites_unchanged, true);
    assert.equal(phaseOne.appliedResumeSuggestions.safety.allow_resume_attach_unchanged, true);
    assert.equal(phaseOne.appliedResumeSuggestions.safety.allow_final_submit_unchanged, true);
    assert.equal(phaseOne.appliedResumeSuggestions.safety.raw_text_saved, false);
    assert.equal(phaseOne.appliedResumeSuggestions.safety.suggestions_saved, false);
    assert.equal(phaseOne.appliedResumeSuggestions.safety.resume_profile_modified, false);
    assert.equal(phaseOne.settingsAfterSuggestionApply.resume_intelligence.profile_approved, false);
    assert.equal(phaseOne.settingsAfterSuggestionApply.resume_intelligence.summary.core_fact_coverage_percent, 100);
    assert.equal(
      phaseOne.settingsAfterSuggestionApply.resume_intelligence.facts.find(item => item.fact_key === 'linkedin').value,
      'https://linkedin.com/in/synthetic-candidate'
    );
    assert.deepEqual(
      phaseOne.addedProfileFact.resume_intelligence.facts.find(item => item.fact_key === 'awards').value,
      ['Synthetic Award']
    );
    assert.deepEqual(
      phaseOne.editedProfileFact.resume_intelligence.facts.find(item => item.fact_key === 'awards').value,
      ['Updated Synthetic Award']
    );
    assert.equal(
      phaseOne.approvedProfileFact.resume_intelligence.facts.find(item => item.fact_key === 'awards').user_confirmed,
      true
    );
    assert.equal(
      phaseOne.rejectedProfileFact.resume_intelligence.facts.some(item => item.fact_key === 'awards'),
      false
    );
    assert.deepEqual(
      phaseOne.readdedProfileFact.resume_intelligence.facts.find(item => item.fact_key === 'awards').value,
      ['Replacement Synthetic Award']
    );
    assert.equal(
      phaseOne.deletedProfileFact.resume_intelligence.facts.some(item => item.fact_key === 'awards'),
      false
    );
    const storedResumeFiles = fs.readdirSync(resumeLibraryDir).sort();
    assert.deepEqual(storedResumeFiles, [
      'synthetic_e2e_resume_v1.pdf',
      'synthetic_general_resume_v1.pdf'
    ]);
    assert.equal(
      fs.readFileSync(path.join(resumeLibraryDir, storedResumeFiles[0])).subarray(0, 5).toString('ascii'),
      '%PDF-'
    );
    assert.equal(phaseOne.answerV1.version, 1);
    assert.equal(phaseOne.answerV2.version, 2);
    assert.equal(phaseOne.settingsReadiness.product_readiness.ready_to_search, true);
    assert.equal(phaseOne.settingsReadiness.product_readiness.checks.resume_selected, true);
    assert.ok(phaseOne.settingsReadiness.resume_intelligence.summary.available_fact_count > 0);
    assert.equal(phaseOne.settingsReadiness.candidate_profile.can_confirm_snapshot, true);
    assert.equal(phaseOne.settingsReadiness.product_readiness.confirmed_answer_count, 1);
    assert.equal(phaseOne.factConfirmation.status, 'ok');
    assert.equal(phaseOne.factConfirmation.safety.allow_autofill_real_sites_unchanged, true);
    assert.equal(phaseOne.factConfirmation.safety.allow_resume_attach_unchanged, true);
    assert.equal(phaseOne.factConfirmation.safety.allow_final_submit_unchanged, true);
    assert.equal(phaseOne.factConfirmation.safety.real_site_opened, false);
    assert.equal(phaseOne.factConfirmation.safety.current_resume_version_approved_for_package, true);
    assert.ok(phaseOne.factConfirmation.approved_resume.approved_at);
    assert.equal(phaseOne.approvedCareerProfile.profile.user_approved, true);
    assert.equal(phaseOne.approvedCareerProfile.profile.id, phaseOne.careerBeforePackage.active_profile_id);
    assert.equal(phaseOne.workflowAfterProfile.current_step.key, 'search_completed');
    assert.equal(phaseOne.approved.application_status, 'APPROVED_FOR_PACKAGE');
    assert.equal(phaseOne.approved.transition.to_status, 'APPROVED_FOR_PACKAGE');
    assert.equal(phaseOne.approved.transition.persisted, true);
    assert.equal(phaseOne.approved.next_action.label, 'Build Application Package');
    assert.equal(phaseOne.overflow_status, 409);
    assert.deepEqual(phaseOne.selected.selected_job_ids, [jobId]);
    assert.equal(phaseOne.built.application_status, 'PACKAGE_READY');
    assert.equal(phaseOne.built.transition.to_status, 'PACKAGE_READY');
    assert.equal(phaseOne.built.next_action.label, 'Review Application Package');
    assert.equal(phaseOne.built.resume_selection.mode, 'recommended');
    assert.equal(phaseOne.built.resume_selection.recommended_resume_id, 'synthetic_e2e_resume_v1');
    assert.equal(phaseOne.recommendedPackage.resume_recommendation.package_uses_recommendation, true);
    assert.equal(phaseOne.overridden.resume_selection.mode, 'user_override');
    assert.equal(phaseOne.overridePackage.selected_resume.resume_id, 'synthetic_general_resume_v1');
    assert.equal(phaseOne.overridePackage.resume_recommendation.recommended_resume_id, 'synthetic_e2e_resume_v1');
    assert.equal(phaseOne.overridePackage.resume_recommendation.package_uses_recommendation, false);
    assert.equal(phaseOne.rebuiltRecommended.resume_selection.mode, 'recommended');
    assert.equal(phaseOne.packageValue.application_id, `application_${jobId}`);
    assert.equal(phaseOne.packageValue.selected_resume.resume_id, 'synthetic_e2e_resume_v1');
    assert.equal(phaseOne.packageValue.planned_answers[0].source, 'user_confirmed');
    assert.equal(phaseOne.packageValue.planned_answers[0].version, 2);
    assert.equal(phaseOne.packageValue.application_completion.metric, 'application_completion_rate');
    assert.equal(phaseOne.packageValue.application_completion.portal, 'greenhouse');
    assert.ok(phaseOne.packageValue.resume_intelligence.summary.available_fact_count > 0);
    assert.equal(phaseOne.packageValue.resume_intelligence.storage_mode, 'derived_from_existing_sources');
    assert.equal(phaseOne.completionSummary.application_completion.insights.contains_candidate_values, false);
    assert.equal(phaseOne.completionSummary.application_completion.insights.records_analyzed, 1);
    assert.ok(phaseOne.completionSummary.application_completion.insights.top_blockers.length > 0);
    assert.equal(phaseOne.approvedFill.record.application_status, 'FILL_APPROVED');
    assert.equal(phaseOne.started.record.application_status, 'EXECUTING');
    assert.equal(phaseOne.started.safety.browser_opened_by_server, false);
    assert.equal(phaseOne.replay.idempotent_replay, true);
    assert.equal(phaseOne.replay.application_execution_session.session_id, phaseOne.started.application_execution_session.session_id);
    assert.equal(phaseOne.mismatched_query_handoff_status, 404);
    assert.equal(phaseOne.extension_handoff_status, 200);
    assert.equal(phaseOne.extensionHandoff.status, 'ok');
    assert.equal(phaseOne.extensionHandoff.application_id, phaseOne.packageValue.application_id);
    assert.equal(phaseOne.extensionHandoff.package_id, phaseOne.started.application_execution_session.package_id);
    assert.equal(phaseOne.extensionHandoff.session_id, phaseOne.started.application_execution_session.session_id);
    assert.deepEqual(phaseOne.extensionHandoff.approved_field_mappings, phaseOne.started.application_execution_session.approved_field_mappings);
    assert.equal(phaseOne.extension_diagnostic_status, 200);
    assert.equal(phaseOne.unauthorized_extension_diagnostic_status, 403);
    assert.equal(phaseOne.extensionDiagnostic.extension_installed, true);
    assert.equal(phaseOne.extensionDiagnostic.extension_connected, true);
    assert.equal(phaseOne.extensionDiagnostic.content_script_connected, true);
    assert.equal(phaseOne.extensionDiagnostic.active_handoff, true);
    assert.equal(phaseOne.extensionDiagnostic.connection_chain_ready, true);
    assert.equal(phaseOne.extensionDiagnostic.matched_application_id, phaseOne.packageValue.application_id);
    assert.equal(phaseOne.extensionDiagnostic.matched_job_id, jobId);
    assert.equal(phaseOne.extensionDiagnostic.matched_session_id, phaseOne.started.application_execution_session.session_id);
    assert.equal(phaseOne.extensionDiagnostic.native_messaging.required, false);
    assert.equal(phaseOne.extensionDiagnosticRead.connection_chain_ready, true);

    let browserReport = SYNTHETIC_BROWSER_REPORT;
    if (E2E_BROWSER_ENABLED) {
      const browser = spawnSync(process.execPath, [
        path.join(PROJECT_ROOT, 'scripts', 'test_job_apply_autofill_extension_local.mjs'),
        '--output-dir',
        browserOutputDir
      ], {
        cwd: PROJECT_ROOT,
        encoding: 'utf8',
        env: { ...process.env, CHROME_PATH: BROWSER_EXECUTABLE },
        timeout: 120000
      });
      assert.equal(browser.status, 0, browser.stderr || browser.stdout);
      browserReport = JSON.parse(fs.readFileSync(
        path.join(browserOutputDir, 'job_apply_autofill_local_test_result_001.json'),
        'utf8'
      ));
      // Installed-mode result (thin-bridge architecture): the extension is
      // really loaded into a Chrome for Testing profile and does its own
      // detection, planning, filling, verification and reporting.
      assert.equal(browserReport.success, true);
      assert.equal(browserReport.environment.temporary_chrome_profile, true);
      assert.equal(browserReport.environment.extension_really_installed, true);
      assert.equal(browserReport.safety.only_localhost_urls_used, true);
      assert.equal(browserReport.safety.real_websites_opened, false);
      assert.equal(browserReport.safety.submit_clicked, false);
      assert.equal(browserReport.safety.file_uploaded_by_extension, false);
      assert.equal(browserReport.safety.challenge_bypassed, false);
      assert.equal(browserReport.workflow.unknown_question_paused, true);
      assert.equal(browserReport.workflow.sensitive_question_paused, true);
      assert.equal(browserReport.workflow.challenge_paused, true);
      assert.equal(browserReport.workflow.continue_after_verification_filled, true);
      assert.ok(Number(browserReport.local_form.filled_fields_count) > 0);
      browserReport = {
        ...browserReport,
        complex_form: {
          filled_fields_count: Number(browserReport.local_form.filled_fields_count),
          skipped_risky_fields_count: Math.max(0,
            Number(browserReport.local_form.total_fields_seen) - Number(browserReport.local_form.filled_fields_count))
        },
        suggested_new_rules_summary: []
      };
    }

    const phaseTwo = runClient(port, `
      const needs = await request('/api/jobs/${jobId}/fill-report', {
        method: 'POST',
        body: JSON.stringify({
          filled_fields_count: ${Number(browserReport.complex_form.filled_fields_count || 0)},
          skipped_fields_count: ${Number(browserReport.complex_form.skipped_risky_fields_count || 0)},
          fields_requiring_user_review_count: 1,
          suggested_questions_count: ${Math.max(1, browserReport.suggested_new_rules_summary.length)}
        })
      });
      const recovered = await request('/api/jobs/${jobId}/start-fill', {
        method: 'POST',
        body: JSON.stringify({ confirmed: true, idempotency_key: 'synthetic-e2e-resume' })
      });
      const refilled = await request('/api/jobs/${jobId}/fill-report', {
        method: 'POST',
        body: JSON.stringify({
          filled_fields_count: ${Number(browserReport.complex_form.filled_fields_count || 0) + 1},
          skipped_fields_count: 0,
          fields_requiring_user_review_count: 0,
          suggested_questions_count: 0
        })
      });
      const rescanned = await request('/api/jobs/${jobId}/review-rescan-report', {
        method: 'POST',
        body: JSON.stringify({
          application_session_id: recovered.application_execution_session.session_id,
          scan_id: 'synthetic-e2e-review-scan',
          detected_count: ${Number(browserReport.complex_form.filled_fields_count || 0) + 1},
          required_count: 2,
          required_filled_count: 2,
          required_empty_count: 0,
          unknown_required_count: 0,
          form_accessible: true,
          challenge_scope: 'none',
          submit_control_detected: true,
          high_risk_blockers: [],
          submission_blockers: []
        })
      });
      const ready = await request('/api/jobs/${jobId}/review-complete', {
        method: 'POST',
        body: JSON.stringify({
          confirmed: true,
          application_session_id: recovered.application_execution_session.session_id
        })
      });
      const packageBeforeLockedRebuild = await request('/api/jobs/${jobId}/application-package');
      const lockedRebuild = await fetch(base + '/api/jobs/${jobId}/build-package-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume_id: 'synthetic_general_resume_v1' })
      });
      const lockedRebuildBody = await lockedRebuild.json();
      const packageAfterLockedRebuild = await request('/api/jobs/${jobId}/application-package');
      const audit = await request('/api/audit?job_id=${jobId}');
      const jobs = await request('/api/jobs');
      const summary = await request('/api/summary');
      console.log(JSON.stringify({
        needs, recovered, refilled, rescanned, ready,
        packageBeforeLockedRebuild,
        locked_rebuild_status: lockedRebuild.status,
        lockedRebuildBody,
        packageAfterLockedRebuild,
        audit, jobs, summary
      }));
    `);

    assert.equal(phaseTwo.needs.application_status, 'NEEDS_REVIEW');
    assert.equal(phaseTwo.recovered.application_execution_session.session_id, phaseOne.started.application_execution_session.session_id);
    assert.equal(phaseTwo.recovered.application_execution_session.recovery_count, 1);
    assert.equal(phaseTwo.refilled.application_status, 'NEEDS_REVIEW');
    assert.equal(phaseTwo.rescanned.review_rescan.required_empty_count, 0);
    assert.equal(phaseTwo.ready.application_status, 'READY_FOR_MANUAL_SUBMIT');
    assert.equal(phaseTwo.locked_rebuild_status, 409);
    assert.equal(phaseTwo.lockedRebuildBody.code, 'PACKAGE_REBUILD_LOCKED');
    assert.equal(phaseTwo.lockedRebuildBody.safety.package_files_modified, false);
    assert.equal(
      phaseTwo.packageAfterLockedRebuild.selected_resume.resume_id,
      phaseTwo.packageBeforeLockedRebuild.selected_resume.resume_id
    );
    assert.equal(
      phaseTwo.packageAfterLockedRebuild.selected_resume.content_hash,
      phaseTwo.packageBeforeLockedRebuild.selected_resume.content_hash
    );
    assert.equal(phaseTwo.audit.session_count, 1);
    assert.ok(phaseTwo.audit.event_count >= 7);
    assert.equal(phaseTwo.jobs[0].application_status, 'READY_FOR_MANUAL_SUBMIT');
    assert.equal(phaseTwo.jobs[0].application_completion.phase, 'observed');
    assert.equal(phaseTwo.jobs[0].application_completion.application_completion_rate, 100);
    assert.equal(phaseTwo.summary.application_completion.average_completion_rate, 100);
    assert.equal(phaseTwo.summary.application_completion.approved_jobs_measured, 1);
    assert.equal(phaseTwo.audit.application_execution_sessions[0].session_id, phaseOne.started.application_execution_session.session_id);
    assert.equal(phaseTwo.audit.application_execution_sessions[0].reports.at(-1).application_submitted, false);

    const persistedState = JSON.parse(fs.readFileSync(path.join(dataDir, 'dashboard_state.json'), 'utf8'));
    assert.equal(Object.keys(persistedState.application_execution_sessions).length, 1);
    assert.equal(
      persistedState.application_status_overrides[jobId].application_id,
      `application_${jobId}`
    );
  } finally {
    dashboard.kill();
  }
});
