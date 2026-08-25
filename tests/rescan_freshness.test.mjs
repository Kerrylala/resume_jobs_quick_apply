import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeApplicationReview,
  prepareApplicationExecutionSession,
  recordApplicationExecutionSessionReport,
  recordApplicationReviewRescan,
  restartApplicationExecutionSetup,
  startApplicationExecutionSession,
  transitionApplicationState
} from '../scripts/lib/application_state.mjs';

function executionSession(jobId, idempotencyKey = 'session-key') {
  return {
    schema: 'ApplicationExecutionSession', schema_version: '1.1',
    session_id: `session-${jobId}`, application_id: `application-${jobId}`,
    job_id: jobId, package_id: `package-${jobId}`, executor_type: 'extension',
    target_url: `https://jobs.lever.co/acme/${jobId}/apply`, execution_status: 'SESSION_CREATED',
    approved_profile_version: {
      profile_id: 'career-reviewed', family_id: 'career-reviewed', version: 2,
      approved_at: '2026-01-01T00:00:00.000Z', snapshot_digest: 'sha256:reviewed'
    },
    approved_field_mappings: [{ canonical_key: 'email', value: 'reviewed@example.test', source: 'application_package', confidence: 1, user_confirmed: true }],
    safety: { resume_upload_allowed: false, sensitive_answers_allowed: false, login_allowed: false, challenge_bypass_allowed: false, final_submit_allowed: false },
    idempotency_key: idempotencyKey
  };
}

function stateWithCleanRescan(jobId, { now = '2026-08-15T00:00:00.000Z' } = {}) {
  const packageReady = transitionApplicationState({}, {
    jobId, toStatus: 'PACKAGE_READY', initialStatus: 'APPROVED_FOR_PACKAGE', actor: 'user', now
  });
  const prepared = prepareApplicationExecutionSession(packageReady.state, {
    jobId, actor: 'user', idempotencyKey: `prepare-${jobId}`, session: executionSession(jobId, `prepare-${jobId}`), now
  });
  const started = startApplicationExecutionSession(prepared.state, {
    jobId, actor: 'user', idempotencyKey: `start-${jobId}`, session: prepared.session, now
  });
  const paused = recordApplicationExecutionSessionReport(started.state, {
    jobId, actor: 'browser_agent', now, report: {
      total_fields_seen: 3, filled_fields_count: 2, skipped_fields_count: 1,
      fields_requiring_user_review_count: 1
    }
  });
  const scanned = recordApplicationReviewRescan(paused.state, {
    jobId, actor: 'browser_agent', now, report: {
      scan_id: 'scan-clean', detected_count: 3, required_count: 2,
      required_filled_count: 2, required_empty_count: 0
    }
  });
  return { state: scanned.state, sessionId: scanned.session.session_id, now };
}

test('a clean re-scan carries a freshness proof and review completes against it', () => {
  const { state, sessionId, now } = stateWithCleanRescan('fresh-job');
  const scan = state.application_execution_sessions[sessionId].latest_review_rescan;
  assert.ok(scan.review_scan_attempt_id);
  assert.equal(scan.review_scan_target_digest.length, 32);
  assert.ok(scan.review_scan_created_at);
  const ready = completeApplicationReview(state, { jobId: 'fresh-job', actor: 'user', confirmed: true, now });
  assert.equal(ready.record.application_status, 'READY_FOR_MANUAL_SUBMIT');
});

test('a retry fill report clears the earlier re-scan so review cannot reuse it', () => {
  const { state, sessionId } = stateWithCleanRescan('retry-job');
  state.application_execution_sessions[sessionId] = {
    ...state.application_execution_sessions[sessionId],
    execution_status: 'FILLING'
  };
  const retried = recordApplicationExecutionSessionReport(state, {
    jobId: 'retry-job', actor: 'browser_agent', now: '2026-08-15T01:00:00.000Z', report: {
      total_fields_seen: 4, filled_fields_count: 3, skipped_fields_count: 1
    }
  });
  assert.equal(retried.state.application_execution_sessions[sessionId].latest_review_rescan, null);
  assert.equal(retried.record.latest_review_rescan, null);
  assert.throws(
    () => completeApplicationReview(retried.state, { jobId: 'retry-job', actor: 'user', confirmed: true }),
    error => error.code === 'APPLICATION_REVIEW_RESCAN_REQUIRED'
  );
});

test('a legacy persisted scan without a freshness proof is rejected as stale', () => {
  const { state, sessionId } = stateWithCleanRescan('legacy-job');
  const session = state.application_execution_sessions[sessionId];
  const legacyScan = { ...session.latest_review_rescan };
  delete legacyScan.review_scan_attempt_id;
  delete legacyScan.review_scan_target_digest;
  delete legacyScan.review_scan_created_at;
  state.application_execution_sessions[sessionId] = { ...session, latest_review_rescan: legacyScan };
  assert.throws(
    () => completeApplicationReview(state, { jobId: 'legacy-job', actor: 'user', confirmed: true }),
    error => error.code === 'APPLICATION_REVIEW_RESCAN_STALE' && error.reason === 'missing_freshness_proof'
  );
});

test('a scan taken for a different attempt is rejected as stale', () => {
  const { state, sessionId } = stateWithCleanRescan('attempt-job');
  const session = state.application_execution_sessions[sessionId];
  state.application_execution_sessions[sessionId] = { ...session, active_attempt_id: 'a-different-attempt' };
  assert.throws(
    () => completeApplicationReview(state, { jobId: 'attempt-job', actor: 'user', confirmed: true }),
    error => error.code === 'APPLICATION_REVIEW_RESCAN_STALE' && error.reason === 'attempt_mismatch'
  );
});

test('a scan taken against a different target page or package is rejected as stale', () => {
  const { state, sessionId } = stateWithCleanRescan('target-job');
  const session = state.application_execution_sessions[sessionId];
  state.application_execution_sessions[sessionId] = {
    ...session,
    target_url: 'https://jobs.lever.co/acme/target-job/apply?step=2'
  };
  assert.throws(
    () => completeApplicationReview(state, { jobId: 'target-job', actor: 'user', confirmed: true }),
    error => error.code === 'APPLICATION_REVIEW_RESCAN_STALE' && error.reason === 'target_mismatch'
  );
});

test('an expired scan is rejected as stale after the freshness TTL', () => {
  const { state } = stateWithCleanRescan('ttl-job');
  assert.throws(
    () => completeApplicationReview(state, {
      jobId: 'ttl-job', actor: 'user', confirmed: true, now: '2026-08-17T00:00:01.000Z'
    }),
    error => error.code === 'APPLICATION_REVIEW_RESCAN_STALE' && error.reason === 'scan_expired'
  );
});

test('restarting fill setup clears the persisted re-scan on the session and record', () => {
  const { state, sessionId } = stateWithCleanRescan('restart-job');
  const restarted = restartApplicationExecutionSetup(state, {
    jobId: 'restart-job', actor: 'user', idempotencyKey: 'restart-1'
  });
  assert.equal(Object.hasOwn(restarted.record, 'latest_review_rescan'), false);
  assert.equal(restarted.state.application_execution_sessions[sessionId].latest_review_rescan, null);
});
