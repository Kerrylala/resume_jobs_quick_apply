import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { planFields } from '../application_executor/field_mapper.mjs';
import { classifyFieldSafety } from '../application_executor/safety_policy.mjs';
import { createApplicationExecution, assertRedactedExecutionReport } from '../application_executor/execution_report.mjs';
import { createApplicationExecutionSession } from '../application_executor/execution_session.mjs';
import { PlaywrightExecutor } from '../application_executor/playwright_executor.mjs';
import { adapterForUrl } from '../portal_adapters/index.mjs';
import {
  recordApplicationExecutionSessionReport,
  startApplicationExecutionSession,
  transitionApplicationState
} from '../scripts/lib/application_state.mjs';

function executorSession({ jobId = 'job-1', executorType = 'local_browser_agent', idempotencyKey = 'executor-session' } = {}) {
  return createApplicationExecutionSession({
    applicationPackage: {
      status: 'PACKAGE_READY', application_id: `application-${jobId}`, job_id: jobId,
      career_profile_reference: {
        profile_id: 'career-reviewed', family_id: 'career-reviewed', version: 3,
        user_approved: true, approved_at: '2026-08-10T00:00:00.000Z'
      },
      application_profile: {
        full_name: { value: 'Reviewed Candidate', source: 'career_brain', confidence: 1, user_confirmed: true },
        email: { value: 'reviewed@example.test', source: 'career_brain', confidence: 1, user_confirmed: true }
      }
    },
    manifest: { package_id: `package-${jobId}` },
    job: { job_id: jobId, company: 'Acme', title: 'Engineer' },
    executorType, targetUrl: `https://jobs.lever.co/acme/${jobId}/apply`, idempotencyKey
  });
}

test('extension bundle uses the byte-identical canonical executor core', async () => {
  const [source, bundled] = await Promise.all([
    readFile(new URL('../application_executor/shared_core.js', import.meta.url), 'utf8'),
    readFile(new URL('../extensions/application_assistant/executor_core.js', import.meta.url), 'utf8')
  ]);
  assert.equal(bundled, source);
});

test('shared safety policy blocks uploads and authentication and reviews sensitive fields', () => {
  assert.deepEqual(classifyFieldSafety({ label: 'Resume', type: 'file' }), { action: 'skip', reason: 'skipped_file_upload' });
  assert.deepEqual(classifyFieldSafety({ label: 'Password', type: 'password' }), { action: 'skip', reason: 'skipped_sensitive' });
  assert.deepEqual(classifyFieldSafety({ label: 'Gender', type: 'text' }), { action: 'review', reason: 'skipped_sensitive' });
  assert.deepEqual(classifyFieldSafety({ label: 'Email', type: 'email' }), { action: 'allow', reason: 'safe_known_field' });
});

test('shared field mapper fills reviewed values and leaves unknown fields blank', () => {
  const plans = planFields([
    { field_ref: 'field-1', label: 'Full name', type: 'text' },
    { field_ref: 'field-2', label: 'Email address', type: 'email' },
    { field_ref: 'field-3', label: 'Unusual new question', type: 'text' }
  ], {
    profile_confirmed: true,
    profile: { identity: { full_name: 'Reviewed Candidate', email: 'reviewed@example.test' } }
  });
  assert.deepEqual(plans.map(plan => plan.action), ['fill', 'fill', 'skip']);
});

test('portal registry detects supported and generic pages', () => {
  assert.equal(adapterForUrl('https://jobs.lever.co/acme/abc/apply').id, 'lever');
  assert.equal(adapterForUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=123').id, 'greenhouse');
  assert.equal(adapterForUrl('https://jobs.ashbyhq.com/acme/abc').id, 'ashby');
  assert.equal(adapterForUrl('https://careers.example.test/jobs/1').id, 'generic');
});

test('ApplicationExecutionSession is created only from a ready package and carries approved safe fields', () => {
  const session = executorSession();
  assert.equal(session.schema, 'ApplicationExecutionSession');
  assert.equal(session.executor_type, 'local_browser_agent');
  assert.equal(session.execution_status, 'SESSION_CREATED');
  assert.equal(session.approved_profile_version.profile_id, 'career-reviewed');
  assert.equal(Object.hasOwn(session, 'status'), false);
  // A first/last split derived from full_name is not user-confirmed, so only
  // explicitly confirmed identity fields become approved mappings.
  assert.deepEqual(session.approved_field_mappings.map(item => item.canonical_key), ['full_name', 'email']);
  const confirmedNames = createApplicationExecutionSession({
    applicationPackage: {
      status: 'PACKAGE_READY', application_id: 'application-named', job_id: 'job-named',
      career_profile_reference: {
        profile_id: 'career-reviewed', family_id: 'career-reviewed', version: 3,
        user_approved: true, approved_at: '2026-08-10T00:00:00.000Z'
      },
      application_profile: {
        full_name: { value: 'Reviewed Candidate', source: 'career_brain', confidence: 1, user_confirmed: true },
        first_name: { value: 'Reviewed', source: 'career_brain', confidence: 1, user_confirmed: true },
        last_name: { value: 'Candidate', source: 'career_brain', confidence: 1, user_confirmed: true },
        email: { value: 'reviewed@example.test', source: 'career_brain', confidence: 1, user_confirmed: true }
      }
    },
    manifest: { package_id: 'package-named' },
    job: { job_id: 'job-named' },
    targetUrl: 'https://jobs.lever.co/acme/job-named/apply', idempotencyKey: 'named-session'
  });
  assert.deepEqual(confirmedNames.approved_field_mappings.map(item => item.canonical_key), ['full_name', 'first_name', 'last_name', 'email']);
  assert.equal(session.safety.resume_upload_allowed, false);
  assert.equal(session.safety.final_submit_allowed, false);
  assert.equal(Object.hasOwn(session, 'profile'), false);
  assert.throws(() => createApplicationExecutionSession({
    applicationPackage: { status: 'NEEDS_USER_INPUT', application_profile: {} },
    manifest: { application_id: 'a', job_id: 'j', package_id: 'p' },
    targetUrl: 'https://example.test/apply', idempotencyKey: 'blocked'
  }), error => error.code === 'APPLICATION_PACKAGE_NOT_READY');
});

test('ApplicationExecutionSession carries confirmed safe Answer Memory but excludes high-risk answers', () => {
  const session = createApplicationExecutionSession({
    applicationPackage: {
      status: 'PACKAGE_READY', application_id: 'application-answer', job_id: 'job-answer', package_id: 'package-answer',
      career_profile_reference: {
        profile_id: 'career-reviewed', family_id: 'career-reviewed', version: 2,
        user_approved: true, approved_at: '2026-08-11T00:00:00.000Z'
      },
      application_profile: {
        full_name: { value: 'Synthetic Candidate', source: 'career_brain', confidence: 1, user_confirmed: true },
        profile_meta: { career_profile_reference: { profile_id: 'career-reviewed', version: 2, approved_at: '2026-08-11T00:00:00.000Z', user_approved: true } }
      },
      application_answers: [
        { question_id: 'safe-question', canonical_key: 'answer_safe', value: 'Synthetic safe answer', source: 'answer_memory', confidence: 1, user_confirmed: true, sensitive_category: 'none', risk_level: 'normal', original_question: 'Safe reusable question?' },
        { question_id: 'risk-question', canonical_key: 'answer_risk', value: 'Synthetic high-risk answer', source: 'answer_memory', confidence: 1, user_confirmed: true, sensitive_category: 'high_risk', risk_level: 'high', original_question: 'High-risk question?' }
      ]
    },
    job: {}, targetUrl: 'https://jobs.lever.co/example/job/apply', executorType: 'local_browser_agent', idempotencyKey: 'answer-session'
  });
  const safe = session.approved_field_mappings.find(mapping => mapping.canonical_key === 'answer_safe');
  assert.equal(safe.value, 'Synthetic safe answer');
  assert.deepEqual(safe.aliases, ['Safe reusable question?']);
  assert.equal(session.approved_field_mappings.some(mapping => mapping.canonical_key === 'answer_risk'), false);
});

test('Playwright executor consumes the session mappings and returns a redacted report', async () => {
  const fields = [
    { field_ref: 'field-1', label: 'Full name', type: 'text' },
    { field_ref: 'field-2', label: 'Email', type: 'email' },
    { field_ref: 'field-3', label: 'Resume', type: 'file' },
    { field_ref: 'field-4', label: 'Gender', type: 'text' }
  ];
  const filled = [];
  const report = await new PlaywrightExecutor().execute({
    ...executorSession(),
    runtime: {
      async getFields() { return fields; },
      async fillField(field, value) { filled.push([field.field_ref, value]); return true; }
    }
  });
  assert.deepEqual(filled, [['field-1', 'Reviewed Candidate'], ['field-2', 'reviewed@example.test']]);
  assert.deepEqual(report.counts, { detected: 4, filled: 2, skipped: 2, failed: 0 });
  assert.equal(report.safety.final_submit, false);
  assert.doesNotMatch(JSON.stringify(assertRedactedExecutionReport(report)), /Reviewed Candidate|reviewed@example\.test/);
});

test('Playwright executor reuses a confirmed safe answer for equivalent wording', async () => {
  const session = createApplicationExecutionSession({
    applicationPackage: {
      status: 'PACKAGE_READY', application_id: 'application-reuse', job_id: 'job-reuse', package_id: 'package-reuse',
      career_profile_reference: {
        profile_id: 'career-reviewed', family_id: 'career-reviewed', version: 2,
        user_approved: true, approved_at: '2026-08-11T00:00:00.000Z'
      },
      application_profile: {
        full_name: { value: 'Synthetic Candidate', source: 'career_brain', confidence: 1, user_confirmed: true }
      },
      application_answers: [{
        question_id: 'interest-question', canonical_key: 'answer_interest', value: 'Synthetic reusable answer',
        source: 'answer_memory', confidence: 1, user_confirmed: true, sensitive_category: 'none', risk_level: 'normal',
        original_question: 'What interests you about this role?'
      }]
    },
    job: {}, targetUrl: 'https://jobs.lever.co/example/reuse/apply', executorType: 'local_browser_agent', idempotencyKey: 'answer-reuse-session'
  });
  const filled = [];
  const report = await new PlaywrightExecutor().execute({
    ...session,
    runtime: {
      async getFields() { return [{ field_ref: 'field-interest', label: 'Why are you interested in this role?', type: 'textarea' }]; },
      async fillField(field, value) { filled.push([field.field_ref, value]); return true; }
    }
  });
  assert.deepEqual(filled, [['field-interest', 'Synthetic reusable answer']]);
  assert.equal(report.counts.filled, 1);
  assert.doesNotMatch(JSON.stringify(report), /Synthetic reusable answer/);
});

test('extension derives every value and rule from the ApplicationExecutionSession alone', async () => {
  const source = await readFile(new URL('../extensions/application_assistant/content.js', import.meta.url), 'utf8');
  // The thin bridge builds its planning context exclusively from the session
  // fetched fresh from the local app — no stored profiles, no local memory.
  assert.match(source, /function profileFromSession/);
  assert.match(source, /function siteRulesFromSession/);
  assert.match(source, /mapping\.user_confirmed !== true\) continue/);
  assert.match(source, /record\?\.user_confirmed !== true \|\| record\?\.status !== 'active'/);
  assert.doesNotMatch(source, /chrome\.storage/);
});

test('Browser Agent redacts candidate values in every execution screenshot', async () => {
  const source = await readFile(new URL('../browser_agent/run.mjs', import.meta.url), 'utf8');
  assert.match(source, /async function captureRedactedScreenshot/);
  assert.match(source, /textarea, select, \[contenteditable="true"\]/);
  assert.doesNotMatch(source, /await page\.screenshot\(\{ path: (?:beforePath|afterPath)/);
  assert.match(source, /candidate_values_redacted_in_all_screenshots: true/);
  assert.match(source, /--disable-crash-reporter/);
});

test('Playwright review re-scan records completion metadata without candidate values', async () => {
  const review = await new PlaywrightExecutor().review({
    ...executorSession(),
    scan_id: 'scan-1',
    runtime: {
      url: 'https://jobs.lever.co/acme/job-1/apply',
      async getFormReviewState() {
        return [
          { field_ref: 'field-1', label: 'Full name', type: 'text', required: true, visible: true, disabled: false, filled: true },
          { field_ref: 'field-2', label: 'Resume', type: 'file', required: true, visible: true, disabled: false, filled: false }
        ];
      },
      async getPageState() {
        return { application_form_accessible: true, challenge_scope: 'passive', submit_control_detected: true };
      }
    }
  });
  assert.equal(review.required_count, 2);
  assert.equal(review.required_filled_count, 1);
  assert.equal(review.file_upload_required, true);
  assert.equal(review.file_upload_present, false);
  assert.equal(review.high_risk_blockers.some(item => item.code === 'FILE_UPLOAD_REQUIRED'), true);
  assert.equal(review.submission_blockers.includes('CAPTCHA_OR_VERIFICATION_REQUIRES_MANUAL_COMPLETION'), true);
  assert.equal(review.candidate_values_recorded, false);
  assert.doesNotMatch(JSON.stringify(review), /Reviewed Candidate|reviewed@example\.test/);
});

test('ApplicationExecutionSession owns executor state and sanitized reports', () => {
  const approved = transitionApplicationState({}, {
    jobId: 'executor-job', toStatus: 'APPROVED_FOR_FILL', initialStatus: 'PACKAGE_READY',
    actor: 'test_user', now: '2026-08-10T00:00:00.000Z'
  });
  const session = executorSession({ jobId: 'executor-job', idempotencyKey: 'executor-start' });
  const started = startApplicationExecutionSession(approved.state, {
    jobId: 'executor-job', actor: 'test_user', idempotencyKey: 'executor-start', session,
    now: '2026-08-10T00:01:00.000Z'
  });
  const execution = createApplicationExecution({
    run_id: session.session_id, application_id: session.application_id, job_id: session.job_id,
    package_id: session.package_id, executor: session.executor_type, url: session.target_url,
    fields: [{ field: { label: 'Email', type: 'email' }, outcome: 'filled', mapping_key: 'email', source: 'application_package' }]
  });
  const recorded = recordApplicationExecutionSessionReport(started.state, {
    jobId: session.job_id, sessionId: session.session_id, actor: 'local_browser_agent',
    report: { application_execution: { ...execution, value: 'must-not-persist' } },
    now: '2026-08-10T00:02:00.000Z'
  });
  assert.equal(recorded.session.executor_type, 'local_browser_agent');
  assert.equal(recorded.session.execution_status, 'NEEDS_REVIEW');
  assert.deepEqual(recorded.session.execution_events.map(event => event.status), [
    'SESSION_CREATED', 'EXECUTOR_READY', 'FIELDS_DETECTED', 'FILLING', 'NEEDS_REVIEW'
  ]);
  assert.equal(recorded.report.application_execution.executor, 'local_browser_agent');
  assert.doesNotMatch(JSON.stringify(recorded.report), /must-not-persist/);
});

test('Dashboard and extension expose one execution-session contract without extension profile loading', async () => {
  const [html, appSource, serverSource, packageBuilderSource, manifestSource, popupSource, popupHtml, contentSource, backgroundSource] = await Promise.all([
    readFile(new URL('../dashboard/public/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../dashboard/public/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../dashboard/server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/build_application_package_preview.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../extensions/application_assistant/manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../extensions/application_assistant/popup.js', import.meta.url), 'utf8'),
    readFile(new URL('../extensions/application_assistant/popup.html', import.meta.url), 'utf8'),
    readFile(new URL('../extensions/application_assistant/content.js', import.meta.url), 'utf8'),
    readFile(new URL('../extensions/application_assistant/background.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="applicationExecutorMode"/);
  for (const id of ['executorSessionId', 'executorJobId', 'executorPackageId', 'executorProfileVersion', 'executorType', 'executorTargetUrl', 'executorRunStatus', 'executorBlockers']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const executorDiagnostics = html.match(/<details class="advanced-disclosure compact executor-reasons">\s*<summary>Advanced diagnostics<\/summary>([\s\S]*?)<\/details>/)?.[1] || '';
  for (const id of ['executorSessionId', 'executorJobId', 'executorPackageId', 'executorProfileVersion', 'executorType', 'executorTargetUrl']) {
    assert.match(executorDiagnostics, new RegExp(`id="${id}"`), `${id} must remain inside Advanced diagnostics`);
  }
  assert.doesNotMatch(appSource, /Application Package — \$\{jobId\}/);
  assert.match(appSource, /Application Package — \$\{packageJobLabel\}/);
  assert.match(appSource, /executor_mode:\s*executorMode/);
  assert.match(appSource, /Cannot start fill/);
  assert.match(serverSource, /createApplicationExecutionSession/);
  assert.match(serverSource, /application_execution_sessions/);
  assert.match(serverSource, /approved_profile_version/);
  assert.match(serverSource, /execution_status/);
  assert.match(serverSource, /approved_field_mappings:\s*selected\.session\.approved_field_mappings/);
  assert.doesNotMatch(packageBuilderSource, /extensions\/(?:job_apply_autofill|application_assistant)\/profile\.local\.json|profileCandidates|loadValidatedProfile/);
  // Thin-bridge invariants: the popup and content script keep no state, use
  // no storage, and speak only through the service-worker bridge; the shared
  // executor core is the single source of schema, safety, mapping, challenge
  // classification and report shape.
  assert.doesNotMatch(popupSource, /chrome\.storage|fetch\(/);
  assert.doesNotMatch(popupSource, /profile\.local|ApplicationRun|heartbeat|content script/i);
  // The Application Assistant popup speaks the minimal product vocabulary
  // only — the old developer UI (Fill safe fields / Continue after
  // verification / Needs you) must never come back.
  assert.match(popupHtml, /正在连接/);
  assert.match(popupHtml, /id="statusWord"/);
  assert.match(popupHtml, /id="primaryAction"/);
  assert.doesNotMatch(popupHtml, />Fill safe fields<|>Continue after verification<|Needs you|Fill known fields|Review issues|Learn questions/);
  assert.doesNotMatch(popupHtml, /ApplicationRun|heartbeat|content script|handoff|package|session|executor/i);
  for (const word of ['正在连接', '正在扫描', '正在填写', '发现新问题', '需要你处理', '等待登录', '准备提交', '已完成']) {
    assert.ok(popupSource.includes(word) || popupHtml.includes(word), `Assistant vocabulary must include ${word}`);
  }
  assert.match(contentSource, /ResumeJobsApplicationExecutorCore/);
  assert.match(contentSource, /core\.planFields\(/);
  assert.match(contentSource, /core\.classifyPageSafety\(/);
  assert.match(contentSource, /core\.createApplicationExecution\(/);
  // Scope, not equality: multi-step wizards keep assisting across step URLs.
  assert.match(contentSource, /core\.withinApplicationScope\(location\.href, session\.target_url\)/);
  assert.doesNotMatch(contentSource, /comparableExecutionUrl\(location\.href\) !== /);
  // The Assistant must inject on ANY https job site (dropbox.jobs and other
  // company-hosted careers domains), staying dormant until a session binds.
  assert.ok(manifestSource.includes('"https://*/*"'), 'content script must match all https sites');
  assert.doesNotMatch(contentSource, /chrome\.storage|fetch\(/);
  assert.match(contentSource, /resume_upload_attempted: false/);
  assert.match(backgroundSource, /\/api\/extension\/active-handoff/);
  assert.match(backgroundSource, /POST_FILL_REPORT/);
  assert.match(backgroundSource, /127\.0\.0\.1/);
  assert.doesNotMatch(backgroundSource, /chrome\.storage/);
  assert.doesNotMatch(backgroundSource, /https?:\/\/(?!127\.0\.0\.1)[a-z0-9.-]+/i);
  const manifest = JSON.parse(manifestSource);
  assert.equal(manifest.content_scripts[0].js[0], 'executor_core.js');
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.equal(manifest.permissions.includes('nativeMessaging'), false);
  assert.equal(manifest.permissions.includes('storage'), false);
});

test('application-page resolver prefers explicit apply URLs and upgrades Lever job pages', async () => {
  const serverSource = await readFile(new URL('../dashboard/server.mjs', import.meta.url), 'utf8');
  const start = serverSource.indexOf('function resolveApplicationPageUrl(job = {}) {');
  const end = serverSource.indexOf('\nfunction extensionIdFromOrigin', start);
  const resolveApplicationPageUrl = new Function(`${serverSource.slice(start, end)}\nreturn resolveApplicationPageUrl;`)();
  assert.equal(resolveApplicationPageUrl({ apply_url: 'https://jobs.lever.co/acme/role-1' }), 'https://jobs.lever.co/acme/role-1/apply');
  assert.equal(resolveApplicationPageUrl({ url: 'javascript:invalid' }), '');
});

test('extension service worker forwards the canonical execution session', async () => {
  const backgroundSource = await readFile(new URL('../extensions/application_assistant/background.js', import.meta.url), 'utf8');
  const calls = [];
  let listener = null;
  const handoff = { status: 'ok', execution_session: executorSession({ executorType: 'extension' }) };
  const context = vm.createContext({
    URL, encodeURIComponent,
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        json: async () => {
          if (String(url).includes('/active-hosts')) {
            // The privacy gate asks for active-session hosts BEFORE any page
            // URL leaves the tab — answer with the session's target host.
            return { status: 'ok', hosts: [new URL(handoff.execution_session.target_url).hostname.toLowerCase()] };
          }
          return String(url).includes('/active-handoff') ? handoff : { status: 'ok', connection_chain_ready: true };
        }
      };
    },
    chrome: { runtime: { getManifest: () => ({ version: '1.0.0' }), onMessage: { addListener: value => { listener = value; } } } }
  });
  vm.runInContext(backgroundSource, context, { filename: 'background.js' });
  const response = await new Promise(resolve => {
    assert.equal(listener({ type: 'CONNECT_CURRENT_APPLICATION', current_url: handoff.execution_session.target_url }, { tab: { url: handoff.execution_session.target_url } }, resolve), true);
  });
  assert.equal(response.execution_session.session_id, handoff.execution_session.session_id);
  // active-hosts privacy probe (no page data) + handoff + diagnostics POST.
  assert.equal(calls.length, 3);
  assert.ok(calls[0].url.includes('/api/extension/active-hosts'));
  assert.ok(!calls[0].url.includes('url='), 'the privacy probe must carry no page URL');
});
