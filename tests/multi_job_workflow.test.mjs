import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeApplicationReview,
  prepareApplicationExecutionSession,
  recordApplicationExecutionSessionReport,
  recordApplicationReviewRescan,
  startApplicationExecutionSession,
  transitionApplicationState
} from '../scripts/lib/application_state.mjs';

function sessionFor(jobId, profileId, email) {
  return {
    schema: 'ApplicationExecutionSession',
    schema_version: '1.1',
    session_id: `session-${jobId}`,
    application_id: `application-${jobId}`,
    job_id: jobId,
    package_id: `package-${jobId}`,
    executor_type: jobId === 'job-a' ? 'extension' : 'local_browser_agent',
    target_url: `https://jobs.lever.co/example/${jobId}/apply`,
    execution_status: 'SESSION_CREATED',
    approved_profile_version: {
      profile_id: profileId,
      family_id: profileId,
      version: 1,
      approved_at: '2026-08-11T00:00:00.000Z',
      snapshot_digest: `sha256:${profileId}`
    },
    approved_field_mappings: [{
      canonical_key: 'email',
      value: email,
      source: `package-${jobId}`,
      confidence: 1,
      user_confirmed: true
    }],
    safety: {
      resume_upload_allowed: false,
      sensitive_answers_allowed: false,
      login_allowed: false,
      challenge_bypass_allowed: false,
      final_submit_allowed: false
    },
    idempotency_key: `prepare-${jobId}`
  };
}

test('two jobs own independent packages, sessions, attempts, reports, and review state', () => {
  let state = transitionApplicationState({}, {
    jobId: 'job-a', toStatus: 'PACKAGE_READY', initialStatus: 'APPROVED_FOR_PACKAGE', actor: 'test'
  }).state;
  state = transitionApplicationState(state, {
    jobId: 'job-b', toStatus: 'PACKAGE_READY', initialStatus: 'APPROVED_FOR_PACKAGE', actor: 'test'
  }).state;

  const preparedA = prepareApplicationExecutionSession(state, {
    jobId: 'job-a', actor: 'test', idempotencyKey: 'prepare-job-a',
    session: sessionFor('job-a', 'profile-a', 'candidate-a@example.test')
  });
  const preparedB = prepareApplicationExecutionSession(preparedA.state, {
    jobId: 'job-b', actor: 'test', idempotencyKey: 'prepare-job-b',
    session: sessionFor('job-b', 'profile-b', 'candidate-b@example.test')
  });

  assert.equal(Object.keys(preparedB.state.application_execution_sessions).length, 2);
  assert.notEqual(preparedA.session.session_id, preparedB.session.session_id);
  assert.notEqual(preparedA.session.package_id, preparedB.session.package_id);
  assert.equal(preparedB.state.application_status_overrides['job-a'].active_session_id, 'session-job-a');
  assert.equal(preparedB.state.application_status_overrides['job-b'].active_session_id, 'session-job-b');

  const startedA = startApplicationExecutionSession(preparedB.state, {
    jobId: 'job-a', actor: 'test', idempotencyKey: 'start-job-a', session: preparedA.session
  });
  const startedB = startApplicationExecutionSession(startedA.state, {
    jobId: 'job-b', actor: 'test', idempotencyKey: 'start-job-b', session: preparedB.session
  });
  assert.equal(startedB.state.application_execution_sessions['session-job-a'].execution_attempts.length, 1);
  assert.equal(startedB.state.application_execution_sessions['session-job-b'].execution_attempts.length, 1);

  const reportedA = recordApplicationExecutionSessionReport(startedB.state, {
    jobId: 'job-a', actor: 'extension', report: {
      total_fields_seen: 4,
      filled_fields_count: 3,
      skipped_fields_count: 1,
      fields_requiring_user_review_count: 1,
      application_submitted: false
    }
  });
  assert.equal(reportedA.record.application_status, 'NEEDS_REVIEW');
  assert.equal(reportedA.state.application_status_overrides['job-b'].application_status, 'EXECUTING');
  assert.equal(reportedA.state.application_execution_sessions['session-job-a'].reports.length, 1);
  assert.equal((reportedA.state.application_execution_sessions['session-job-b'].reports || []).length, 0);
  assert.equal(
    reportedA.state.application_execution_sessions['session-job-b'].approved_field_mappings[0].value,
    'candidate-b@example.test'
  );

  const rescannedA = recordApplicationReviewRescan(reportedA.state, {
    jobId: 'job-a', actor: 'extension', report: {
      detected_count: 4,
      required_count: 3,
      required_filled_count: 3,
      required_empty_count: 0,
      unknown_required_count: 0
    }
  });
  const readyA = completeApplicationReview(rescannedA.state, {
    jobId: 'job-a', actor: 'test', confirmed: true
  });
  assert.equal(readyA.record.application_status, 'READY_FOR_MANUAL_SUBMIT');
  assert.equal(readyA.state.application_status_overrides['job-b'].application_status, 'EXECUTING');
  assert.equal(readyA.state.application_execution_sessions['session-job-b'].latest_review_rescan, undefined);
});

test('rejected jobs require an audited restore before approval', () => {
  const rejected = transitionApplicationState({}, {
    jobId: 'job-rejected', toStatus: 'REJECTED', initialStatus: 'REVIEW_PENDING', actor: 'test'
  });
  assert.throws(() => transitionApplicationState(rejected.state, {
    jobId: 'job-rejected', toStatus: 'APPROVED_FOR_PACKAGE', actor: 'test'
  }), error => error.code === 'INVALID_APPLICATION_TRANSITION');

  const restored = transitionApplicationState(rejected.state, {
    jobId: 'job-rejected', toStatus: 'REVIEW_PENDING', actor: 'test', recovery: true
  });
  const approved = transitionApplicationState(restored.state, {
    jobId: 'job-rejected', toStatus: 'APPROVED_FOR_PACKAGE', actor: 'test'
  });
  assert.equal(approved.record.application_status, 'APPROVED_FOR_PACKAGE');
  assert.deepEqual(
    approved.state.audit_events.map(event => event.to_status),
    ['REJECTED', 'REVIEW_PENDING', 'APPROVED_FOR_PACKAGE']
  );
});
