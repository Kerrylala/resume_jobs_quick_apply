import assert from 'node:assert/strict';
import test from 'node:test';

import { createApplicationExecutionSession } from '../application_executor/execution_session.mjs';
import { PlaywrightExecutor } from '../application_executor/playwright_executor.mjs';
import { classifyPageSafety } from '../application_executor/safety_policy.mjs';
import {
  recordApplicationExecutionSessionReport,
  startApplicationExecutionSession,
  transitionApplicationState
} from '../scripts/lib/application_state.mjs';

function readySession(idempotencyKey = 'challenge-session') {
  return createApplicationExecutionSession({
    applicationPackage: {
      status: 'PACKAGE_READY',
      application_id: 'application-passive-challenge',
      job_id: 'job-passive-challenge',
      career_profile_reference: {
        profile_id: 'career-reviewed', family_id: 'career-reviewed', version: 1,
        user_approved: true, approved_at: '2026-08-11T00:00:00.000Z'
      },
      application_profile: {
        full_name: { value: 'Reviewed Candidate', user_confirmed: true, confidence: 1 },
        email: { value: 'reviewed@example.test', user_confirmed: true, confidence: 1 },
        phone: { value: '+1 555 0100', user_confirmed: true, confidence: 1 },
        location: { value: 'San Diego, CA', user_confirmed: true, confidence: 1 },
        linkedin: { value: 'https://linkedin.example/reviewed', user_confirmed: true, confidence: 1 }
      }
    },
    manifest: { package_id: 'package-passive-challenge' },
    job: { job_id: 'job-passive-challenge', company: 'Acme', title: 'Engineer' },
    executorType: 'local_browser_agent',
    targetUrl: 'https://jobs.lever.co/acme/job-passive-challenge/apply',
    idempotencyKey
  });
}

const passiveFields = [
  { field_ref: 'name', label: 'Full name', type: 'text', visible: true },
  { field_ref: 'email', label: 'Email', type: 'email', visible: true },
  { field_ref: 'phone', label: 'Phone', type: 'tel', visible: true },
  { field_ref: 'location', label: 'Current location', type: 'text', visible: true },
  { field_ref: 'linkedin', label: 'LinkedIn URL', type: 'url', visible: true },
  { field_ref: 'captcha', name: 'g-recaptcha-response', label: 'reCAPTCHA', type: 'hidden', visible: false },
  { field_ref: 'resume', label: 'Resume/CV', type: 'file', visible: true },
  { field_ref: 'gender', label: 'Gender', type: 'text', visible: true },
  { field_ref: 'submit', label: 'Submit application', type: 'submit', visible: true }
];

test('passive challenge blocks submission but permits reviewed safe fields', async () => {
  const filled = [];
  const session = readySession();
  const report = await new PlaywrightExecutor().execute({
    ...session,
    active_attempt_id: 'attempt-passive',
    runtime: {
      async getFields() { return passiveFields; },
      async getPageState() {
        return {
          url: session.target_url,
          application_form_accessible: true,
          accessible_application_control_count: 8,
          has_challenge: true,
          challenge_scope: 'passive',
          challenge: {
            present: true, scope: 'passive', active_blocking: false,
            application_form_accessible: true, accessible_application_control_count: 8,
            evidence: ['selector=textarea[name="g-recaptcha-response"];tag=textarea;visible=false;inside_form=true']
          }
        };
      },
      async fillField(field) { filled.push(field.field_ref); return true; }
    }
  });
  assert.deepEqual(filled, ['name', 'email', 'phone', 'location', 'linkedin']);
  assert.equal(report.challenge_scope, 'passive');
  assert.equal(report.submission_blocker, 'CAPTCHA_REQUIRES_USER');
  assert.equal(report.blocker.blocked, false);
  assert.equal(report.counts.filled, 5);
  assert.equal(report.field_results.find(item => item.field_ref === 'captcha').reason, 'skipped_captcha_control');
  assert.equal(report.field_results.find(item => item.field_ref === 'resume').reason, 'skipped_file_upload');
  assert.equal(report.field_results.find(item => item.field_ref === 'gender').reason, 'skipped_sensitive');
  assert.equal(report.field_results.find(item => item.field_ref === 'submit').reason, 'skipped_submit');
  assert.equal(report.field_results.find(item => item.field_ref === 'location').reason, 'requires_manual_location_confirmation');
  assert.equal(report.safety.challenge_attempted, false);
  assert.equal(report.safety.submit_attempted, false);
});

test('active challenge fills nothing and reports field-level reasons', async () => {
  const session = readySession('active-challenge');
  let fillCalled = false;
  const report = await new PlaywrightExecutor().execute({
    ...session,
    active_attempt_id: 'attempt-active',
    runtime: {
      async getFields() { return passiveFields; },
      async getPageState() {
        return {
          url: session.target_url,
          application_form_accessible: false,
          accessible_application_control_count: 0,
          has_challenge: true,
          challenge_scope: 'active',
          challenge: { present: true, scope: 'active', active_blocking: true, evidence: ['selector=.challenge-overlay;visible=true'] }
        };
      },
      async fillField() { fillCalled = true; return true; }
    }
  });
  assert.equal(fillCalled, false);
  assert.equal(report.counts.filled, 0);
  assert.equal(report.challenge_scope, 'active');
  assert.equal(report.blocker.reason, 'active_challenge_blocks_form');
  assert.equal(report.field_results.find(item => item.field_ref === 'captcha').reason, 'skipped_captcha_control');
  assert.equal(report.field_results.find(item => item.field_ref === 'name').reason, 'skipped_not_visible');
  assert.notEqual(new Set(report.field_results.map(item => item.reason)).size, 1);
});

test('cookie or privacy text is not classified as a challenge', () => {
  assert.deepEqual(classifyPageSafety({
    url: 'https://jobs.lever.co/acme/job-passive-challenge/apply',
    title: 'Application',
    text: 'We use cookies. Review our privacy policy.',
    has_challenge: false,
    application_form_accessible: true,
    accessible_application_control_count: 5
  }, 'https://jobs.lever.co/acme/job-passive-challenge/apply'), {
    action: 'allow', reason: 'approved_application_page', challenge_scope: 'none', submission_blocker: ''
  });
});

test('retry preserves the old report and creates a new attempt on the same session', () => {
  const approved = transitionApplicationState({}, {
    jobId: 'job-passive-challenge', toStatus: 'APPROVED_FOR_FILL', initialStatus: 'PACKAGE_READY',
    actor: 'test', now: '2026-08-11T00:00:00.000Z'
  });
  const session = readySession('initial-attempt');
  const started = startApplicationExecutionSession(approved.state, {
    jobId: session.job_id, actor: 'test', idempotencyKey: 'initial-attempt', session,
    now: '2026-08-11T00:01:00.000Z'
  });
  const recorded = recordApplicationExecutionSessionReport(started.state, {
    jobId: session.job_id, sessionId: session.session_id, actor: 'test',
    report: {
      blocked_page_state: true,
      blocked_reason: 'captcha_or_challenge_detected',
      fields_requiring_user_review_count: 32,
      application_execution: {
        execution_id: session.session_id, run_id: session.session_id,
        application_id: session.application_id, job_id: session.job_id, package_id: session.package_id,
        executor: session.executor_type, url: session.target_url, active_attempt_id: started.session.active_attempt_id,
        status: 'needs_user_input', blocked_reason: 'captcha_or_challenge_detected',
        fields: Array.from({ length: 32 }, (_, index) => ({
          field: { field_ref: `field-${index + 1}`, label: `Field ${index + 1}`, type: 'text' },
          outcome: 'skipped', reason: 'captcha_or_challenge_detected'
        }))
      }
    },
    now: '2026-08-11T00:02:00.000Z'
  });
  const retried = startApplicationExecutionSession(recorded.state, {
    jobId: session.job_id, actor: 'test', idempotencyKey: 'retry-attempt', session: recorded.session,
    initialStatus: 'NEEDS_USER_INPUT', recovery: true, now: '2026-08-11T00:03:00.000Z'
  });
  assert.equal(retried.session.session_id, session.session_id);
  assert.equal(Object.keys(retried.state.application_execution_sessions).length, 1);
  assert.equal(retried.session.reports.length, 1);
  assert.equal(retried.session.execution_attempts.length, 2);
  assert.notEqual(retried.session.execution_attempts[0].attempt_id, retried.session.execution_attempts[1].attempt_id);
  assert.equal(retried.session.execution_attempts[1].outcome, 'in_progress');
});
