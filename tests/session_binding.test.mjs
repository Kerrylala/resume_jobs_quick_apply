// Requirement: Package / Session / Job / Profile must have one unambiguous
// association.
//
// The failure this prevents is filling a real employer form from stale
// material: the user edits their profile or rebuilds the application package,
// but a fill attempt created against the *previous* package is still open and
// types the old values into the page. Nothing about that is visible on screen,
// which is why it needs invariants rather than care.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  prepareApplicationExecutionSession,
  reviewScanTargetDigest,
  transitionApplicationState
} from '../scripts/lib/application_state.mjs';

const NOW = '2026-08-18T00:00:00.000Z';

function session({
  jobId = 'job-a',
  packageId = 'package-a',
  applicationId = 'application-a',
  executor = 'local_browser_agent',
  profileVersion = 1,
  targetUrl = 'https://jobs.lever.co/acme/job-a/apply'
} = {}) {
  return {
    schema: 'ApplicationExecutionSession',
    schema_version: '1.1',
    session_id: `session-${jobId}-${packageId}`,
    application_id: applicationId,
    job_id: jobId,
    package_id: packageId,
    executor_type: executor,
    target_url: targetUrl,
    execution_status: 'SESSION_CREATED',
    approved_profile_version: {
      profile_id: 'career-reviewed',
      family_id: 'career-reviewed',
      version: profileVersion,
      approved_at: '2026-01-01T00:00:00.000Z',
      snapshot_digest: 'sha256:reviewed'
    },
    approved_field_mappings: [{
      canonical_key: 'email', value: 'candidate@example.test',
      source: 'application_package', confidence: 1, user_confirmed: true
    }],
    safety: {
      resume_upload_allowed: false, sensitive_answers_allowed: false,
      login_allowed: false, challenge_bypass_allowed: false, final_submit_allowed: false
    },
    idempotency_key: `key-${packageId}`
  };
}

function packageReadyState(jobId) {
  return transitionApplicationState({}, {
    jobId, toStatus: 'PACKAGE_READY', initialStatus: 'APPROVED_FOR_PACKAGE', actor: 'user', now: NOW
  }).state;
}

test('a fill attempt cannot be attached to a different job', () => {
  const state = packageReadyState('job-a');
  assert.throws(
    () => prepareApplicationExecutionSession(state, {
      jobId: 'job-a', actor: 'user', idempotencyKey: 'k', now: NOW,
      session: session({ jobId: 'job-b' })
    }),
    error => error.code === 'APPLICATION_EXECUTION_SESSION_MISMATCH'
  );
});

test('rebuilding the package does not silently take over the open fill attempt', () => {
  // The first attempt is open against package-a.
  let state = packageReadyState('job-a');
  const first = prepareApplicationExecutionSession(state, {
    jobId: 'job-a', actor: 'user', idempotencyKey: 'first', now: NOW, session: session()
  });
  state = first.state;

  // The package is rebuilt — new package id, same job.
  assert.throws(
    () => prepareApplicationExecutionSession(state, {
      jobId: 'job-a', actor: 'user', idempotencyKey: 'second', now: NOW,
      session: session({ packageId: 'package-b' })
    }),
    error => error.code === 'ACTIVE_APPLICATION_SESSION_CONFLICT',
    'a fill attempt built from a newer package must not quietly replace the open one'
  );
});

test('switching executor mid-flight is a conflict, not a silent swap', () => {
  let state = packageReadyState('job-a');
  state = prepareApplicationExecutionSession(state, {
    jobId: 'job-a', actor: 'user', idempotencyKey: 'first', now: NOW, session: session()
  }).state;

  assert.throws(
    () => prepareApplicationExecutionSession(state, {
      jobId: 'job-a', actor: 'user', idempotencyKey: 'second', now: NOW,
      session: session({ executor: 'extension' })
    }),
    error => error.code === 'ACTIVE_APPLICATION_SESSION_CONFLICT'
  );
});

test('re-preparing the identical attempt is an idempotent replay, not a conflict', () => {
  // Retrying the same request (a double click, a retried POST) must be safe.
  let state = packageReadyState('job-a');
  const first = prepareApplicationExecutionSession(state, {
    jobId: 'job-a', actor: 'user', idempotencyKey: 'same', now: NOW, session: session()
  });
  const second = prepareApplicationExecutionSession(first.state, {
    jobId: 'job-a', actor: 'user', idempotencyKey: 'same', now: NOW, session: session()
  });
  assert.equal(second.session.session_id, first.session.session_id);
});

test('a page scan is bound to the exact package, profile version and target page', () => {
  // The digest is what makes a scan from a previous attempt unusable. If any of
  // these stopped contributing, a stale scan could approve a new attempt.
  const base = session();
  const digest = reviewScanTargetDigest(base);
  assert.equal(digest.length, 32);

  const variants = {
    'a rebuilt package': session({ packageId: 'package-b' }),
    'a different target page': session({ targetUrl: 'https://jobs.lever.co/acme/job-a/apply?step=2' }),
    'a newer approved profile version': session({ profileVersion: 2 })
  };
  for (const [label, variant] of Object.entries(variants)) {
    assert.notEqual(
      reviewScanTargetDigest(variant), digest,
      `${label} must invalidate an earlier page scan`
    );
  }

  // And an unrelated change must not churn the digest, or every scan would be
  // considered stale and review could never complete.
  assert.equal(
    reviewScanTargetDigest({ ...base, session_id: 'session-renamed', idempotency_key: 'other' }),
    digest
  );
});

test('two jobs never share a fill attempt', () => {
  let stateA = packageReadyState('job-a');
  stateA = prepareApplicationExecutionSession(stateA, {
    jobId: 'job-a', actor: 'user', idempotencyKey: 'a', now: NOW, session: session()
  }).state;

  let stateB = packageReadyState('job-b');
  stateB = prepareApplicationExecutionSession(stateB, {
    jobId: 'job-b', actor: 'user', idempotencyKey: 'b', now: NOW,
    session: session({
      jobId: 'job-b', packageId: 'package-b', applicationId: 'application-b',
      targetUrl: 'https://jobs.lever.co/acme/job-b/apply'
    })
  }).state;

  const sessionA = stateA.application_status_overrides['job-a'].active_session_id;
  const sessionB = stateB.application_status_overrides['job-b'].active_session_id;
  assert.notEqual(sessionA, sessionB);
  assert.notEqual(
    reviewScanTargetDigest(stateA.application_execution_sessions[sessionA]),
    reviewScanTargetDigest(stateB.application_execution_sessions[sessionB]),
    'each job must have its own scan identity'
  );
});
