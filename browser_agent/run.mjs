import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { PlaywrightExecutor } from '../application_executor/playwright_executor.mjs';
import { assertApplicationExecutionSession } from '../application_executor/execution_session.mjs';
import { assertSafeExecutionRequest, comparableExecutionUrl, withinApplicationScope } from '../application_executor/safety_policy.mjs';
import { PlaywrightPageRuntime } from './playwright_runtime.mjs';
import { agentBrowserCandidates, executableSupportsLoadExtension } from '../scripts/lib/agent_browser.mjs';
import { learningFieldSignature } from '../scripts/lib/learning_candidates.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function firstExisting(candidates) {
  for (const candidate of candidates.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Continue to the next supported local browser.
    }
  }
  return '';
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

async function captureRedactedScreenshot(page, filePath) {
  await page.evaluate(() => {
    document.getElementById('resume-jobs-screenshot-redaction')?.remove();
    const style = document.createElement('style');
    style.id = 'resume-jobs-screenshot-redaction';
    style.textContent = [
      'input:not([type="file"]), textarea, select, [contenteditable="true"] {',
      '  color: transparent !important;',
      '  -webkit-text-fill-color: transparent !important;',
      '  text-shadow: none !important;',
      '  caret-color: transparent !important;',
      '}'
    ].join('\n');
    document.documentElement.appendChild(style);
  });
  try {
    await page.screenshot({ path: filePath, fullPage: true });
  } finally {
    await page.evaluate(() => document.getElementById('resume-jobs-screenshot-redaction')?.remove()).catch(() => {
      // Best-effort cleanup only: the redaction layer remaining in a closing page is the safe state.
    });
  }
}

const contextArgument = argument('context');
if (!contextArgument) throw new Error('--context must reference a Browser Agent session JSON file.');
const contextPath = path.resolve(contextArgument);
const rawSession = JSON.parse(await readFile(contextPath, 'utf8'));
const canonicalSession = assertApplicationExecutionSession(rawSession);
const session = { ...rawSession, ...canonicalSession, url: canonicalSession.target_url };
if (rawSession.authorized !== true) throw new Error('Browser Agent requires explicit user authorization from the Dashboard.');
// Login, challenge handling and submission are never allowed. Resume upload is
// allowed only with the per-job authorization the shared safety policy checks.
assertSafeExecutionRequest(session);
const resumeUploadRequested = session.upload_resume === true
  && session.safety?.resume_upload_allowed === true
  && session.resume_upload_authorization
  && String(session.resume_upload_authorization.job_id) === String(session.job_id);

const reportPath = path.resolve(argument('report', path.join(path.dirname(contextPath), 'ApplicationExecution.json')));
const statusPath = path.resolve(argument('status', path.join(path.dirname(contextPath), 'status.json')));
const screenshotDir = path.resolve(argument('screenshots', path.join(path.dirname(contextPath), 'screenshots')));
const profileDir = path.resolve(argument('profile-dir', path.join(path.dirname(contextPath), 'browser-profile')));
const retryCommandPath = path.resolve(argument('retry-command', path.join(path.dirname(contextPath), 'retry-command.json')));
const learningBaselinePath = path.join(path.dirname(reportPath), 'learning-baseline.private.json');
const initialAction = argument('initial-action', 'safe_fill');
await Promise.all([mkdir(screenshotDir, { recursive: true }), mkdir(profileDir, { recursive: true })]);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = await firstExisting(agentBrowserCandidates(PROJECT_ROOT));
if (!executablePath) throw new Error('Chrome or Microsoft Edge was not found. Set RESUME_JOBS_CHROME_EXECUTABLE.');

await writeJsonAtomic(statusPath, {
  status: 'STARTING',
  executor: 'local_browser_agent',
  session_id: session.session_id,
  job_id: session.job_id,
  url: session.url,
  updated_at: new Date().toISOString(),
});

let browserContext;
let shutdownRequested = false;

async function shutdownBrowserAgent() {
  if (shutdownRequested) return;
  shutdownRequested = true;
  if (browserContext) await browserContext.close().catch(() => {
    // Shutdown continues so the owning Dashboard can perform its bounded process-tree fallback.
  });
  process.exitCode = 0;
}

process.once('SIGTERM', () => { void shutdownBrowserAgent(); });
process.once('SIGINT', () => { void shutdownBrowserAgent(); });

// The Resume Jobs extension ships inside the agent's browser by default: one
// persistent profile, one browser system, both executors present. Branded
// Chrome 137+ ignores --load-extension, so this only works on the local
// Chrome for Testing runtime — the launch records which case happened rather
// than assuming. Set RESUME_JOBS_AGENT_LOAD_EXTENSION=0 to disable entirely.
const extensionDir = path.join(PROJECT_ROOT, 'extensions', 'application_assistant');
const loadExtension = process.env.RESUME_JOBS_AGENT_LOAD_EXTENSION !== '0'
  && executableSupportsLoadExtension(executablePath);
let extensionLoaded = false;

try {
  browserContext = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: hasFlag('headless-test'),
    viewport: null,
    acceptDownloads: false,
    args: [
      '--disable-features=Translate',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--no-default-browser-check',
      '--noerrdialogs',
      // The persistent profile survives hard kills; without this Chrome shows
      // the "restore pages?" bubble and can resurrect old tabs next to the
      // application page.
      '--hide-crash-restore-bubble',
      ...(loadExtension ? [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
      ] : []),
    ],
  });
  // Report the truth about the extension rather than assuming the flag worked:
  // its MV3 service worker registering in this context is the evidence.
  if (loadExtension) {
    const worker = browserContext.serviceWorkers().find(item => item.url().startsWith('chrome-extension://'))
      || await browserContext.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => null);
    extensionLoaded = Boolean(worker && worker.url().startsWith('chrome-extension://'));
  }
  // Exactly ONE tab: session restore after an unclean shutdown can reopen the
  // previous run's tabs — every page beyond the first is closed before the
  // application page loads.
  const pages = browserContext.pages();
  const page = pages[0] || await browserContext.newPage();
  for (const extra of browserContext.pages()) {
    if (extra !== page) await extra.close().catch(() => {
      // A tab that refuses to close is left alone; the application still runs in ours.
    });
  }
  await page.goto(session.url, { waitUntil: 'domcontentloaded', timeout: Number(session.navigation_timeout_ms || 45_000) });
  // SPA portals (Ashby, Workday…) paint the form well after domcontentloaded.
  // Wait — bounded — for real form controls before the first scan; a page
  // that never shows any is reported honestly by the scan itself.
  await page.waitForSelector('input, textarea, select', { timeout: 15_000 }).catch(() => {
    // No controls appeared in time (login wall, empty page): the scan itself
    // reports that state honestly instead of failing the launch.
  });
  await page.waitForTimeout(1_000);
  // The approved link may redirect across hosts: a boards.greenhouse.io job
  // link landing on the company's own careers domain (dropbox.jobs) is the
  // SAME application — the landing URL is the browser's own resolution of the
  // approved link, not user drift. Adopt it as the application anchor so the
  // classifier and every scope check measure against the page the link
  // actually opens; the original approved link is kept for the record.
  const approvedSourceUrl = session.url;
  const landedUrl = page.url();
  if (/^https?:\/\//i.test(landedUrl) && !withinApplicationScope(landedUrl, session.url)) {
    session.url = landedUrl;
    session.target_url = landedUrl;
    process.stdout.write(`Browser Agent: the approved link redirected to ${landedUrl}; assisting there.\n`);
  }
  const runtime = new PlaywrightPageRuntime(page);
  const executor = new PlaywrightExecutor();

  // Upload the tailored resume — only when the session carries the per-job
  // authorization, only the exact files the authorization fingerprints, and
  // only with real verification of the result. Every refusal names its reason.
  let resumeUploadConfirmedThisSession = false;
  const performResumeUpload = async (report) => {
    if (!resumeUploadRequested) return { attempted: false, status: 'not_requested' };
    // Once the file landed and was verified, later wizard steps must not try
    // again: a step without the resume widget would regress the truthful
    // "confirmed" report, and a lone unrelated file input could receive a
    // file the user never aimed at it.
    if (resumeUploadConfirmedThisSession) {
      return { attempted: false, status: 'already_confirmed_this_session' };
    }
    if (report.challenge_scope === 'active' || report.blocker?.blocked === true) {
      return {
        attempted: false, status: 'deferred_challenge',
        reason: 'A verification or blocker is active; the upload runs when filling continues on this same page.',
      };
    }
    if (report.has_password === true || report.has_otp === true) {
      return {
        attempted: false, status: 'deferred_login',
        reason: 'A login or verification prompt is on this page; the upload runs when filling continues past it.',
      };
    }
    const staged = session.staged_resume || {};
    const authorization = session.resume_upload_authorization;
    if (staged.job_id && String(staged.job_id) !== String(session.job_id)) {
      return {
        attempted: false, status: 'WRONG_JOB_BINDING',
        reason: `The staged resume belongs to job ${staged.job_id}, not this session's job ${session.job_id}.`,
      };
    }
    if (staged.stale_profile === true) {
      return {
        attempted: false, status: 'STALE_RESUME',
        reason: 'The staged resume was built from an older profile version. Regenerate it before uploading.',
      };
    }
    if (staged.sha256 && authorization.sha256 !== staged.sha256) {
      return {
        attempted: false, status: 'WRONG_JOB_BINDING',
        reason: 'The staged resume is not the file this upload authorization was issued for.',
      };
    }
    const candidates = [];
    let fingerprintMismatch = false;
    for (const [format, pathKey, shaKey] of [['pdf', 'pdf_path', 'pdf_sha256'], ['docx', 'docx_path', 'docx_sha256']]) {
      const filePath = staged[pathKey];
      if (!filePath) continue;
      let bytes;
      try { bytes = await readFile(filePath); }
      catch { continue; }
      const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const recorded = staged[shaKey];
      if (recorded && recorded !== sha256) { fingerprintMismatch = true; continue; }
      candidates.push({ format, path: filePath, name: path.basename(filePath) });
    }
    if (candidates.length === 0) {
      return fingerprintMismatch
        ? {
            attempted: false, status: 'STALE_RESUME',
            reason: 'The resume file on disk no longer matches the fingerprint it was authorized with.',
          }
        : { attempted: false, status: 'UPLOAD_FAILED', reason: 'No staged resume file exists on disk.' };
    }
    const result = await runtime.attachResume({
      files: candidates,
      format_preference: authorization.format_preference || 'auto',
    });
    return { attempted: true, ...result };
  };

  const executeAttempt = async (attemptId) => {
    const safeAttemptId = String(attemptId || `execution_attempt_${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, '_');
    const attemptDir = path.join(path.dirname(reportPath), 'attempts', safeAttemptId);
    const attemptScreenshotDir = path.join(attemptDir, 'screenshots');
    const attemptReportPath = path.join(attemptDir, 'ApplicationExecution.json');
    await mkdir(attemptScreenshotDir, { recursive: true });
    const beforePath = path.join(attemptScreenshotDir, 'before-fill.png');
    const afterPath = path.join(attemptScreenshotDir, 'after-fill.png');
    await captureRedactedScreenshot(page, beforePath);
    await captureRedactedScreenshot(page, path.join(screenshotDir, 'before-fill.png'));
    // Upload BEFORE filling: portals with their own resume-parse autofill
    // (Ashby) rewrite the form when the file lands. Uploading first lets that
    // storm pass, then OUR user-confirmed values are written last and win —
    // the reverse order is how a verified full name became the portal
    // parser's guess on the live page after the report already said "filled".
    const preFillPageState = await runtime.getPageState().catch(() => ({}));
    const resumeUpload = await performResumeUpload({
      challenge_scope: preFillPageState.challenge_scope || 'none',
      blocker: { blocked: preFillPageState.challenge_scope === 'active' },
      has_password: preFillPageState.has_password === true,
      has_otp: preFillPageState.has_otp === true,
    });
    if (resumeUpload.status === 'confirmed') resumeUploadConfirmedThisSession = true;
    if (resumeUpload.attempted === true && resumeUpload.status === 'confirmed' && resumeUpload.already_uploaded !== true) {
      // Let the portal's own parse/autofill finish mutating the form: wait
      // until two consecutive snapshots agree (bounded at ~15s).
      let previousDigest = '';
      for (let settle = 0; settle < 10; settle += 1) {
        await page.waitForTimeout(1_500);
        const snapshot = await runtime.getPrivateLearningSnapshot().catch(() => []);
        const digest = createHash('sha256')
          .update(JSON.stringify(snapshot.map(field => [field.field_ref, field.value])))
          .digest('hex');
        if (digest === previousDigest) break;
        previousDigest = digest;
      }
    }
    // Values previous attempts authored (from the baseline): anything ELSE
    // found in a field is the user's own edit and must never be overwritten.
    let authoredPageValues = [];
    try {
      const baselineDocument = JSON.parse(await readFile(learningBaselinePath, 'utf8'));
      authoredPageValues = (Array.isArray(baselineDocument?.fields) ? baselineDocument.fields : [])
        .map(field => field.value).filter(Boolean);
    } catch {
      // First attempt: nothing authored yet.
    }
    const report = await executor.execute({
      ...session,
      active_attempt_id: safeAttemptId,
      attempt_id: safeAttemptId,
      executor: 'local_browser_agent',
      runtime,
      authored_page_values: authoredPageValues,
      started_at: new Date().toISOString(),
    });
    // The baseline is "what the PRODUCT authored", never "what the page held":
    // on a re-fill the live page still contains the user's own typing, and a
    // full-page snapshot would absorb those values into the baseline — after
    // which the learning diff could never report them again. So an existing
    // baseline is only ever UPDATED for the fields this attempt actually
    // wrote; everything else keeps its previous baseline entry.
    const pageSnapshot = await runtime.getPrivateLearningSnapshot();
    const attemptFieldResults = Array.isArray(report.field_results)
      ? report.field_results
      : Array.isArray(report.fields) ? report.fields : [];
    const writtenRefs = new Set(attemptFieldResults
      .filter(field => field.outcome === 'filled')
      .map(field => String(field.field_ref || '')));
    let baselineFields = pageSnapshot;
    try {
      const existingBaseline = JSON.parse(await readFile(learningBaselinePath, 'utf8'));
      const previousFields = Array.isArray(existingBaseline?.fields) ? existingBaseline.fields : [];
      const merged = new Map(previousFields.map(field => [learningFieldSignature(field), field]));
      for (const field of pageSnapshot) {
        if (writtenRefs.has(String(field.field_ref || ''))) {
          merged.set(learningFieldSignature(field), field);
        }
      }
      baselineFields = [...merged.values()];
    } catch {
      // First attempt: the page just loaded, nothing user-typed exists yet —
      // the full snapshot IS the authored baseline.
    }
    await writeJsonAtomic(learningBaselinePath, {
      schema_version: '1.0',
      session_id: session.session_id,
      attempt_id: safeAttemptId,
      captured_at: new Date().toISOString(),
      fields: baselineFields
    });
    // The report tells the truth about the upload: what was attempted, what
    // was verified, and why anything was refused.
    report.resume_upload = resumeUpload;
    report.safety = {
      ...report.safety,
      upload_attempted: resumeUpload.attempted === true,
      resume_uploaded: resumeUpload.status === 'confirmed',
    };
    const reportFields = Array.isArray(report.field_results)
      ? report.field_results
      : Array.isArray(report.fields)
        ? report.fields
        : [];
    await captureRedactedScreenshot(page, afterPath);
    await captureRedactedScreenshot(page, path.join(screenshotDir, 'after-fill.png'));
    await Promise.all([writeJsonAtomic(attemptReportPath, report), writeJsonAtomic(reportPath, report)]);
    let callback = { status: 'not_configured' };
    if (session.callback_url) {
      try {
        const response = await fetch(session.callback_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            application_session_id: session.session_id,
            attempt_id: safeAttemptId,
            timestamp: report.completed_at,
            total_fields_seen: report.counts.detected,
            filled_fields_count: report.counts.filled,
            skipped_fields_count: report.counts.skipped,
            failed_fields_count: report.counts.failed,
            hard_blocked_fields_count: reportFields.filter(field => /skipped_(?:file_upload|sensitive|captcha_control|submit|not_visible)/.test(field.reason)).length,
            fields_requiring_user_review_count: report.counts.skipped + report.counts.failed,
            suggested_questions_count: 0,
            blocked_page_state: report.blocker?.blocked === true,
            blocked_reason: report.blocker?.reason || '',
            challenge_scope: report.challenge_scope || 'none',
            submission_blocker: report.submission_blocker || '',
            final_submit_clicked: false,
            application_submitted: false,
            resume_upload_attempted: resumeUpload.attempted === true,
            resume_upload_confirmed: resumeUpload.status === 'confirmed',
            resume_upload_status: resumeUpload.status,
            application_execution: report,
          }),
        });
        callback = response.ok
          ? { status: 'sent', http_status: response.status }
          : { status: 'failed', http_status: response.status };
      } catch (error) {
        callback = { status: 'failed', reason: String(error?.message || error) };
      }
    }
    await writeJsonAtomic(statusPath, {
      status: report.challenge_scope === 'active' ? 'VERIFICATION_REQUIRED' : 'PAUSED_FOR_USER_REVIEW',
      executor: 'local_browser_agent',
      session_id: session.session_id,
      attempt_id: safeAttemptId,
      job_id: session.job_id,
      package_id: session.package_id,
      url: page.url(),
      portal: report.portal,
      counts: report.counts,
      challenge_scope: report.challenge_scope || 'none',
      submission_blocker: report.submission_blocker || '',
      challenge_evidence: report.challenge_evidence || [],
      resume_upload: resumeUpload,
      reasons: reportFields.filter((field) => field.outcome !== 'filled').map((field) => field.reason),
      reason_groups: report.reason_groups || {},
      report_path: attemptReportPath,
      latest_report_path: reportPath,
      extension_loaded: extensionLoaded,
      extension_service_worker_active: (() => { try { return browserContext.serviceWorkers().some(worker => worker.url().startsWith("chrome-extension://")); } catch { return false; } })(),
      dashboard_callback: callback,
      screenshots: [beforePath, afterPath],
      candidate_values_redacted_in_all_screenshots: true,
      updated_at: new Date().toISOString(),
      safety: report.safety,
    });
    process.stdout.write(`Browser Agent attempt ${safeAttemptId} paused for review. Report: ${attemptReportPath}\n`);
  };

  const performReviewRescan = async (scanId) => {
    const safeScanId = String(scanId || `review_rescan_${Date.now()}`).replace(/[^a-zA-Z0-9._-]+/g, '_');
    const reviewRescan = await executor.review({
      ...session,
      executor: 'local_browser_agent',
      runtime,
      scan_id: safeScanId
    });
    let learning = { status: 'not_configured', candidate_count: 0 };
    if (session.learning_callback_url) {
      try {
        const baselineDocument = JSON.parse(await readFile(learningBaselinePath, 'utf8'));
        const currentSnapshot = await runtime.getPrivateLearningSnapshot();
        const response = await fetch(session.learning_callback_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            application_session_id: session.session_id,
            baseline_snapshot: Array.isArray(baselineDocument?.fields) ? baselineDocument.fields : [],
            current_snapshot: currentSnapshot
          })
        });
        const result = await response.json().catch(() => ({}));
        learning = response.ok
          ? { status: 'sent', http_status: response.status, candidate_count: Number(result.candidate_count || 0) }
          : { status: 'failed', http_status: response.status, candidate_count: 0 };
      } catch (error) {
        learning = { status: 'failed', reason: String(error?.message || error), candidate_count: 0 };
      }
    }
    let callback = { status: 'not_configured' };
    if (session.review_rescan_callback_url) {
      try {
        const response = await fetch(session.review_rescan_callback_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            application_session_id: session.session_id,
            ...reviewRescan
          })
        });
        callback = response.ok
          ? { status: 'sent', http_status: response.status }
          : { status: 'failed', http_status: response.status };
      } catch (error) {
        callback = { status: 'failed', reason: String(error?.message || error) };
      }
    }
    let previousStatus = {};
    let previousStatusWarning = '';
    try { previousStatus = JSON.parse(await readFile(statusPath, 'utf8')); }
    catch { previousStatusWarning = 'The previous local status could not be read; this re-scan wrote a fresh status.'; }
    await writeJsonAtomic(statusPath, {
      ...previousStatus,
      previous_status_warning: previousStatusWarning,
      status: 'REVIEW_RESCANNED',
      executor: 'local_browser_agent',
      session_id: session.session_id,
      job_id: session.job_id,
      package_id: session.package_id,
      url: page.url(),
      review_rescan: reviewRescan,
      review_rescan_callback: callback,
      learning_candidate_callback: learning,
      learning_candidates_detected_count: learning.candidate_count,
      updated_at: new Date().toISOString(),
      safety: {
        upload_attempted: false,
        login_attempted: false,
        challenge_attempted: false,
        submit_attempted: false,
        final_submit: false
      }
    });
    process.stdout.write(`Browser Agent review re-scan ${safeScanId} completed.\n`);
  };

  // The user said they finished a verification the product is not allowed to
  // touch (Cloudflare, CAPTCHA, a login, an MFA prompt). Nothing here bypasses
  // anything: the page is simply re-read, and safe filling continues only if
  // the page is still the approved one and the challenge is genuinely gone.
  // The window, the persistent profile, the page and the session are the same
  // ones throughout — that is the whole point of resuming rather than restarting.
  const continueAfterVerification = async (attemptId) => {
    const pageState = await runtime.getPageState();
    // Scope, not equality: a verification often returns to a different step
    // URL of the SAME application (wizard portals). A foreign page still
    // refuses below.
    const onApprovedUrl = withinApplicationScope(pageState.url, session.url);

    if (!onApprovedUrl) {
      // Refuse to fill a page the user was never shown the approval for.
      await writeJsonAtomic(statusPath, {
        status: 'VERIFICATION_URL_MISMATCH',
        executor: 'local_browser_agent',
        session_id: session.session_id,
        job_id: session.job_id,
        url: pageState.url,
        approved_url: session.url,
        reason: 'The browser is no longer on the approved application page, so filling did not continue.',
        updated_at: new Date().toISOString(),
        safety: {
          upload_attempted: false, login_attempted: false, challenge_attempted: false,
          submit_attempted: false, final_submit: false
        }
      });
      process.stdout.write('Browser Agent did not continue: the page is no longer the approved application URL.\n');
      return;
    }

    // executeAttempt re-classifies the page. If the challenge is still up it
    // reports needs_user_input again and fills nothing, so a premature click on
    // "I finished verifying" simply leaves the user waiting, never bypassing.
    await executeAttempt(attemptId);
  };

  if (initialAction === 'review_rescan') await performReviewRescan(argument('scan-id'));
  else await executeAttempt(session.active_attempt_id);
  if (!hasFlag('close-after-fill')) {
    // Live watch: while the window is open the page is MONITORED, not just
    // parked. Every WATCH_TICK the (read-only) learning snapshot is digested;
    // when the digest has changed AND then held still for one full tick — the
    // user stopped typing — a review re-scan runs, which refreshes the
    // checklist and reports new hand-typed answers as learning candidates.
    // Nothing here focuses, fills, or mutates the page.
    const WATCH_TICK_MS = 10_000;
    let lastWatchAt = Date.now();
    let lastDigest = '';
    let lastReportedDigest = '';
    let watchScanRunning = false;
    let pageNavigatedReported = false;
    // The dashboard mints a FRESH attempt id for retry/continue commands;
    // auto step-fills must use the newest one, or a later automatic report
    // would flip the session back to a stale attempt and silently invalidate
    // completed review scans.
    let currentAttemptId = session.active_attempt_id;
    // Multi-step wizards advance through several URLs of the same
    // application. Each step the user reaches is filled ONCE automatically
    // (executeAttempt re-runs its own page-safety classification, fills only
    // confirmed answers, and never touches buttons), then monitored like any
    // other page. Navigation clicks stay the user's. Guard rails: a step URL
    // is auto-filled at most once per session (a portal oscillating between
    // two URLs must not refill forever, and Back-navigation to an
    // already-filled step must not clobber the user's edits there), a hard
    // cap bounds automatic attempts, and a fill never starts while the user
    // has a form control focused.
    const autoFilledStepUrls = new Set([comparableExecutionUrl(session.url), comparableExecutionUrl(page.url())]);
    const MAX_AUTO_STEP_FILLS = 8;
    let autoStepFills = 0;
    const watchTick = async () => {
      if (watchScanRunning) return;
      watchScanRunning = true;
      try {
        // Outside the application's scope (post-submit success screen on
        // another host, a login redirect, the user browsing away): never scan
        // and never feed the learning pipeline from a foreign page — record
        // the fact once so the product can suggest declaring what happened.
        if (!withinApplicationScope(page.url(), session.url)) {
          if (!pageNavigatedReported) {
            pageNavigatedReported = true;
            let previousStatus = {};
            try { previousStatus = JSON.parse(await readFile(statusPath, 'utf8')); } catch { previousStatus = {}; }
            await writeJsonAtomic(statusPath, {
              ...previousStatus,
              status: 'PAGE_NAVIGATED',
              current_url: page.url(),
              approved_url: session.url,
              approved_source_url: approvedSourceUrl,
              updated_at: new Date().toISOString(),
            });
          }
          return;
        }
        pageNavigatedReported = false;
        const currentStepUrl = comparableExecutionUrl(page.url());
        if (!autoFilledStepUrls.has(currentStepUrl) && autoStepFills < MAX_AUTO_STEP_FILLS) {
          // A new step of the same application: wait for the page to settle
          // AND the user to be idle, then fill it once.
          await page.waitForSelector('input, textarea, select', { timeout: 10_000 }).catch(() => {
            // A step without controls (interstitial, review screen) is simply
            // scanned; the attempt below reports what it saw honestly.
          });
          // Two agreeing learning snapshots = the page stopped mutating and
          // the user stopped typing (same settle rule the re-scan uses).
          // Short interval: a fresh wizard step is usually still — the user
          // is waiting for the assistant, not the other way around.
          let previousDigest = '';
          for (let settle = 0; settle < 6; settle += 1) {
            const settleSnapshot = await runtime.getPrivateLearningSnapshot().catch(() => []);
            const settleDigest = createHash('sha256')
              .update(JSON.stringify(settleSnapshot.map(field => [field.field_ref, field.value])))
              .digest('hex');
            if (settleDigest === previousDigest) break;
            previousDigest = settleDigest;
            await page.waitForTimeout(800);
          }
          const userIsTyping = await page.evaluate(() => {
            const active = document.activeElement;
            return Boolean(active && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
          }).catch(() => false);
          if (userIsTyping) return; // not marked filled — retried next tick
          autoFilledStepUrls.add(currentStepUrl);
          autoStepFills += 1;
          await executeAttempt(currentAttemptId);
          lastDigest = '';
          lastReportedDigest = '';
          return;
        }
        const snapshot = await runtime.getPrivateLearningSnapshot();
        const digest = createHash('sha256')
          .update(snapshot.map(field => `${learningFieldSignature(field)}${field.value}`).sort().join('\n'))
          .digest('hex');
        if (digest === lastDigest && digest !== lastReportedDigest) {
          // Two quiet ticks in a row: the user paused — report the truth once.
          await performReviewRescan(`watch_${Date.now()}`);
          lastReportedDigest = digest;
        }
        lastDigest = digest;
      } catch {
        // The page is navigating or closing; the next tick (or the close
        // handler below) reports honestly.
      } finally {
        watchScanRunning = false;
      }
    };
    // Page navigation triggers an IMMEDIATE tick — waiting out the 10s poll
    // after every wizard step made each step feel stuck.
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) lastWatchAt = 0;
    });
    while (!page.isClosed() && !shutdownRequested) {
      let command = null;
      try {
        command = JSON.parse(await readFile(retryCommandPath, 'utf8'));
      } catch {
        // A retry command is optional while the user reviews the current page.
      }
      if (command) {
        await unlink(retryCommandPath).catch(() => {
          // A missing/replaced one-shot command is harmless; the parsed command is already in memory.
        });
        if (command.command === 'retry_safe_fill' && command.session_id === session.session_id && command.attempt_id) {
          currentAttemptId = command.attempt_id;
          autoFilledStepUrls.add(comparableExecutionUrl(page.url()));
          await executeAttempt(command.attempt_id);
        } else if (command.command === 'review_rescan' && command.session_id === session.session_id && command.scan_id) {
          await performReviewRescan(command.scan_id);
          lastReportedDigest = lastDigest;
        } else if (command.command === 'continue_after_verification'
          && command.session_id === session.session_id && command.attempt_id) {
          currentAttemptId = command.attempt_id;
          autoFilledStepUrls.add(comparableExecutionUrl(page.url()));
          await continueAfterVerification(command.attempt_id);
        }
      }
      if (Date.now() - lastWatchAt >= WATCH_TICK_MS) {
        lastWatchAt = Date.now();
        await watchTick();
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    // Explicit recovery state: the user closed the window (rather than the
    // Dashboard shutting the agent down). The persistent profile keeps their
    // sign-ins, so starting the fill again reopens exactly where they were.
    if (!shutdownRequested && page.isClosed()) {
      await writeJsonAtomic(statusPath, {
        status: 'BROWSER_WINDOW_CLOSED',
        executor: 'local_browser_agent',
        session_id: session.session_id,
        job_id: session.job_id,
        url: session.url,
        extension_loaded: extensionLoaded,
      extension_service_worker_active: (() => { try { return browserContext.serviceWorkers().some(worker => worker.url().startsWith("chrome-extension://")); } catch { return false; } })(),
        reason: 'The browser window was closed. Start the fill again to reopen this application; your sign-ins are kept in the saved browser profile.',
        updated_at: new Date().toISOString(),
        safety: {
          upload_attempted: false, login_attempted: false, challenge_attempted: false,
          submit_attempted: false, final_submit: false
        }
      });
    }
  }
} catch (error) {
  await writeJsonAtomic(statusPath, {
    status: 'FAILED',
    executor: 'local_browser_agent',
    session_id: session.session_id,
    job_id: session.job_id,
    url: session.url,
    reason: String(error?.message || error),
    updated_at: new Date().toISOString(),
    safety: {
      upload_attempted: false,
      login_attempted: false,
      challenge_attempted: false,
      submit_attempted: false,
      final_submit: false,
    },
  });
  throw error;
} finally {
  if (hasFlag('close-after-fill') && browserContext) await browserContext.close().catch(() => {
    // Process exit remains the final owned-browser cleanup boundary for test/one-shot mode.
  });
}
