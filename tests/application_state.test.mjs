import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APPLICATION_STATUSES,
  appendAuditEvent,
  deriveApplicationStatus,
  normalizeApplicationExecutionState,
  normalizeApplicationStatus,
  completeApplicationReview,
  prepareApplicationExecutionSession,
  recordApplicationExecutionSessionReport,
  recordApplicationReviewRescan,
  recoverLegacyApplicationExecutionState,
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

test('canonical states and legacy read-boundary mappings are explicit', () => {
  assert.equal(APPLICATION_STATUSES.length, 17);
  assert.equal(normalizeApplicationStatus('package_ready'), 'PACKAGE_READY');
  assert.equal(normalizeApplicationStatus('APPROVED_FOR_FILL'), 'FILL_APPROVED');
  assert.equal(normalizeApplicationStatus('FILL_STARTED'), 'EXECUTING');
  assert.equal(normalizeApplicationStatus('NEEDS_USER_INPUT'), 'NEEDS_REVIEW');
  assert.equal(normalizeApplicationStatus('submitted_manually'), 'MANUALLY_SUBMITTED');
  assert.throws(() => normalizeApplicationStatus('maybe_done'), error => error.code === 'INVALID_APPLICATION_STATUS');
  const normalized = normalizeApplicationExecutionState({
    application_status_overrides: {
      job: { application_status: 'PACKAGE_READY', executor_status: 'STALE_EXECUTOR_CACHE' }
    }
  });
  assert.equal(Object.hasOwn(normalized.application_status_overrides.job, 'executor_status'), false);
});

test('incomplete legacy ApplicationRun state becomes recovery-required without inventing a valid session', () => {
  const migrated = normalizeApplicationExecutionState({
    application_status_overrides: { job: { active_run_id: 'legacy-run' } },
    application_runs: {
      'legacy-run': {
        run_id: 'legacy-run', application_id: 'application-job', job_id: 'job', package_id: 'package-job',
        executor: 'extension', url: 'https://jobs.lever.co/acme/job/apply', status: 'FILL_STARTED',
        approved_field_mappings: [{ canonical_key: 'email', value: 'reviewed@example.test', user_confirmed: true }]
      }
    }
  });
  assert.equal(Object.hasOwn(migrated, 'application_runs'), false);
  assert.equal(migrated.application_status_overrides.job.active_session_id, undefined);
  assert.equal(migrated.application_status_overrides.job.active_legacy_run_id, 'legacy-run');
  assert.equal(migrated.application_status_overrides.job.execution_recovery_required, true);
  assert.equal(migrated.legacy_application_runs['legacy-run'].migration_status, 'RECOVERY_REQUIRED');
  assert.equal(Object.keys(migrated.application_execution_sessions).length, 0);
});

test('legacy fill recovery preserves history, revokes stale approval, creates one draft session, and is idempotent', () => {
  const legacyState = {
    selected_job_ids: ['legacy-job'],
    application_status_overrides: {
      'legacy-job': {
        job_id: 'legacy-job', application_id: 'application-legacy-job',
        application_status: 'FILL_STARTED', status: 'FILL_STARTED',
        active_run_id: 'legacy-run', package_id: 'old-package',
        fill_approved_at: '2026-01-01T00:00:00.000Z',
        fill_started_at: '2026-01-01T00:01:00.000Z',
        latest_fill_report: { counts: { detected: 3 } }
      }
    },
    application_runs: {
      'legacy-run': {
        run_id: 'legacy-run', application_id: 'application-legacy-job', job_id: 'legacy-job',
        status: 'FILL_STARTED', reports: [{ timestamp: '2026-01-01T00:02:00.000Z', detected: 3 }]
      }
    },
    audit_events: [{ event_id: 'old-audit', event_type: 'FILL_STARTED' }]
  };
  const freshSession = executionSession('legacy-job', 'fresh-session-key');
  const recovered = recoverLegacyApplicationExecutionState(legacyState, {
    jobId: 'legacy-job', actor: 'user', recoveryIdempotencyKey: 'recover-once',
    session: freshSession, packagePath: 'applications/legacy-job',
    packageFiles: ['applications/legacy-job/application_package.json'],
    now: '2026-01-01T00:03:00.000Z'
  });
  assert.equal(recovered.record.application_status, 'PACKAGE_READY');
  assert.equal(recovered.record.fill_approved_at, null);
  assert.equal(recovered.record.fill_started_at, null);
  assert.equal(recovered.record.active_session_id, freshSession.session_id);
  assert.equal(recovered.session.schema_version, '1.1');
  assert.equal(recovered.session.execution_status, 'SESSION_CREATED');
  assert.equal(recovered.state.legacy_application_runs['legacy-run'].status, 'SUPERSEDED');
  assert.equal(recovered.state.legacy_application_runs['legacy-run'].reports.length, 1);
  assert.equal(recovered.state.audit_events.some(event => event.event_id === 'old-audit'), true);
  assert.equal(recovered.state.audit_events.at(-1).event_type, 'LEGACY_EXECUTION_SUPERSEDED');

  const replay = recoverLegacyApplicationExecutionState(recovered.state, {
    jobId: 'legacy-job', actor: 'user', recoveryIdempotencyKey: 'recover-once',
    session: freshSession, now: '2026-01-01T00:04:00.000Z'
  });
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.session.session_id, freshSession.session_id);
  assert.equal(Object.keys(replay.state.application_execution_sessions).length, 1);
  assert.equal(replay.state.audit_events.length, recovered.state.audit_events.length);
});

test('job status is derived without rewriting legacy records', () => {
  assert.equal(deriveApplicationStatus({ job: { match_score: 88 } }), 'REVIEW_PENDING');
  assert.equal(deriveApplicationStatus({ review: { decision: 'approved' } }), 'APPROVED_FOR_PACKAGE');
  assert.equal(deriveApplicationStatus({ override: { package_status: 'preview_created' } }), 'APPROVED_FOR_PACKAGE');
  assert.equal(deriveApplicationStatus({
    override: { application_status: 'PACKAGE_READY', package_status: 'preview_created' }
  }), 'PACKAGE_READY');
});

test('restart fill setup preserves and cancels the prior session before executor reselection', () => {
  const prepared = prepareApplicationExecutionSession({}, {
    jobId: 'job-restart', actor: 'test', idempotencyKey: 'prepare-restart',
    session: executionSession('job-restart'), initialStatus: 'PACKAGE_READY',
    now: '2026-08-12T00:00:00.000Z'
  });
  const started = startApplicationExecutionSession(prepared.state, {
    jobId: 'job-restart', actor: 'test', idempotencyKey: 'start-restart',
    session: prepared.session, initialStatus: 'FILL_APPROVED',
    now: '2026-08-12T00:01:00.000Z'
  });
  const restarted = restartApplicationExecutionSetup(started.state, {
    jobId: 'job-restart', actor: 'test', idempotencyKey: 'restart-setup',
    executorType: 'local_browser_agent', now: '2026-08-12T00:02:00.000Z'
  });
  assert.equal(restarted.record.application_status, 'PACKAGE_READY');
  assert.equal(restarted.record.active_session_id, undefined);
  assert.equal(restarted.record.selected_executor_type, 'local_browser_agent');
  assert.equal(restarted.cancelled_session.execution_status, 'CANCELLED');
  assert.ok(restarted.state.application_execution_sessions[prepared.session.session_id]);
  assert.deepEqual(restarted.record.previous_session_ids, [prepared.session.session_id]);
  const replay = restartApplicationExecutionSetup(restarted.state, {
    jobId: 'job-restart', actor: 'test', idempotencyKey: 'restart-setup',
    executorType: 'local_browser_agent', now: '2026-08-12T00:03:00.000Z'
  });
  assert.equal(replay.idempotent_replay, true);
});

test('transitions append audit events and reject unsafe jumps', () => {
  const approved = transitionApplicationState({}, {
    jobId: 'synthetic-1',
    toStatus: 'APPROVED_FOR_PACKAGE',
    initialStatus: 'REVIEW_PENDING',
    actor: 'synthetic_user',
    now: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(approved.record.application_status, 'APPROVED_FOR_PACKAGE');
  assert.equal(approved.state.audit_events.length, 1);
  // MANUALLY_SUBMITTED is reachable from every active status (the user's own
  // declaration is ground truth), so the unsafe jump here is skipping the
  // package/fill approvals straight into execution.
  assert.throws(
    () => transitionApplicationState(approved.state, {
      jobId: 'synthetic-1',
      toStatus: 'EXECUTING',
      actor: 'synthetic_user'
    }),
    error => error.code === 'INVALID_APPLICATION_TRANSITION'
  );
});

test('start fill is idempotent and creates one ApplicationExecutionSession', () => {
  const packageReady = transitionApplicationState({}, {
    jobId: 'synthetic-2',
    toStatus: 'FILL_APPROVED',
    initialStatus: 'PACKAGE_READY',
    actor: 'synthetic_user',
    now: '2026-01-01T00:00:00.000Z'
  });
  const first = startApplicationExecutionSession(packageReady.state, {
    jobId: 'synthetic-2',
    actor: 'synthetic_user',
    idempotencyKey: 'start-key-1',
    session: executionSession('synthetic-2', 'start-key-1'),
    now: '2026-01-01T00:01:00.000Z'
  });
  const replay = startApplicationExecutionSession(first.state, {
    jobId: 'synthetic-2',
    actor: 'synthetic_user',
    idempotencyKey: 'start-key-1',
    session: executionSession('synthetic-2', 'start-key-1'),
    now: '2026-01-01T00:02:00.000Z'
  });
  assert.equal(Object.keys(first.state.application_execution_sessions).length, 1);
  assert.equal(replay.session.session_id, first.session.session_id);
  assert.equal(replay.idempotent_replay, true);
});

test('fill reports pause, recover the same execution session, and never trust submit claims', () => {
  const approved = transitionApplicationState({}, {
    jobId: 'synthetic-3',
    toStatus: 'FILL_APPROVED',
    initialStatus: 'PACKAGE_READY',
    actor: 'synthetic_user',
    now: '2026-01-01T00:00:00.000Z'
  });
  const started = startApplicationExecutionSession(approved.state, {
    jobId: 'synthetic-3',
    actor: 'synthetic_user',
    idempotencyKey: 'start-key-3',
    session: executionSession('synthetic-3', 'start-key-3'),
    now: '2026-01-01T00:01:00.000Z'
  });
  const paused = recordApplicationExecutionSessionReport(started.state, {
    jobId: 'synthetic-3',
    actor: 'synthetic_extension',
    report: { suggested_questions_count: 1 },
    now: '2026-01-01T00:02:00.000Z'
  });
  assert.equal(paused.record.application_status, 'NEEDS_REVIEW');
  const recovered = startApplicationExecutionSession(paused.state, {
    jobId: 'synthetic-3',
    actor: 'synthetic_user',
    idempotencyKey: 'resume-key-3',
    session: executionSession('synthetic-3', 'resume-key-3'),
    recovery: true,
    now: '2026-01-01T00:03:00.000Z'
  });
  assert.equal(recovered.session.session_id, started.session.session_id);
  assert.equal(recovered.session.recovery_count, 1);
  const uncertain = recordApplicationExecutionSessionReport(recovered.state, {
    jobId: 'synthetic-3',
    actor: 'synthetic_extension',
    report: { application_submitted: true },
    now: '2026-01-01T00:04:00.000Z'
  });
  assert.equal(uncertain.record.application_status, 'RECOVERY_REQUIRED');
  assert.equal(uncertain.report.application_submitted, false);
});

test('prepared sessions are job-bound and review advances only after a clean explicit re-scan', () => {
  const packageReady = transitionApplicationState({}, {
    jobId: 'review-job', toStatus: 'PACKAGE_READY', initialStatus: 'APPROVED_FOR_PACKAGE', actor: 'user'
  });
  const prepared = prepareApplicationExecutionSession(packageReady.state, {
    jobId: 'review-job', actor: 'user', idempotencyKey: 'prepare-review-job',
    session: executionSession('review-job', 'prepare-review-job')
  });
  assert.equal(prepared.record.application_status, 'FILL_APPROVED');
  assert.equal(prepared.record.active_session_id, prepared.session.session_id);

  const started = startApplicationExecutionSession(prepared.state, {
    jobId: 'review-job', actor: 'user', idempotencyKey: 'start-review-job', session: prepared.session
  });
  assert.equal(started.record.application_status, 'EXECUTING');
  assert.equal(started.state.audit_events.at(-2).to_status, 'EXECUTOR_READY');
  const paused = recordApplicationExecutionSessionReport(started.state, {
    jobId: 'review-job', actor: 'browser_agent', report: {
      total_fields_seen: 3, filled_fields_count: 2, skipped_fields_count: 1,
      fields_requiring_user_review_count: 1
    }
  });
  const blockedScan = recordApplicationReviewRescan(paused.state, {
    jobId: 'review-job', actor: 'browser_agent', report: {
      scan_id: 'scan-blocked', detected_count: 3, required_count: 2,
      required_filled_count: 1, required_empty_count: 1,
      high_risk_blockers: [{ code: 'REQUIRED_FIELDS_INCOMPLETE', message: 'One field remains.' }]
    }
  });
  assert.throws(() => completeApplicationReview(blockedScan.state, {
    jobId: 'review-job', actor: 'user', confirmed: true
  }), error => error.code === 'APPLICATION_REVIEW_BLOCKED');

  const cleanScan = recordApplicationReviewRescan(blockedScan.state, {
    jobId: 'review-job', actor: 'browser_agent', report: {
      scan_id: 'scan-clean', detected_count: 3, required_count: 2,
      required_filled_count: 2, required_empty_count: 0,
      challenge_scope: 'passive', submission_blockers: ['CAPTCHA_REQUIRES_MANUAL_COMPLETION']
    }
  });
  const ready = completeApplicationReview(cleanScan.state, {
    jobId: 'review-job', actor: 'user', confirmed: true
  });
  assert.equal(ready.record.application_status, 'READY_FOR_MANUAL_SUBMIT');
  assert.equal(ready.session.execution_status, 'READY_FOR_MANUAL_SUBMIT');
  assert.equal(ready.review_rescan.submission_blockers.length, 1);
});

test('audit idempotency keys do not duplicate events', () => {
  const first = appendAuditEvent({}, {
    eventType: 'SELECTION_CHANGED',
    actor: 'synthetic_user',
    idempotencyKey: 'selection-1',
    metadata: { selected_count: 1 },
    now: '2026-01-01T00:00:00.000Z'
  });
  const replay = appendAuditEvent(first.state, {
    eventType: 'SELECTION_CHANGED',
    actor: 'synthetic_user',
    idempotencyKey: 'selection-1',
    metadata: { selected_count: 1 },
    now: '2026-01-01T00:00:01.000Z'
  });
  assert.equal(replay.state.audit_events.length, 1);
  assert.equal(replay.idempotent_replay, true);
});

test('only explicit compatible recovery paths reopen terminal states', () => {
  const rejected = transitionApplicationState({}, {
    jobId: 'job-reset',
    toStatus: 'REJECTED',
    initialStatus: 'REVIEW_PENDING',
    actor: 'user',
    reason: 'rejected'
  });
  const reset = transitionApplicationState(rejected.state, {
    jobId: 'job-reset',
    toStatus: 'REVIEW_PENDING',
    actor: 'user',
    reason: 'explicit_reset',
    recovery: true
  });
  assert.equal(reset.record.application_status, 'REVIEW_PENDING');

  const failed = transitionApplicationState({}, {
    jobId: 'job-retry',
    toStatus: 'RECOVERY_REQUIRED',
    initialStatus: 'EXECUTING',
    actor: 'system',
    reason: 'browser_failed'
  });
  const retried = transitionApplicationState(failed.state, {
    jobId: 'job-retry',
    toStatus: 'FILL_APPROVED',
    actor: 'user',
    reason: 'explicit_retry',
    recovery: true
  });
  assert.equal(retried.record.application_status, 'FILL_APPROVED');

  assert.throws(
    () => transitionApplicationState(failed.state, {
      jobId: 'job-retry',
      toStatus: 'FILL_APPROVED',
      actor: 'system',
      reason: 'implicit_retry'
    }),
    error => error.code === 'INVALID_APPLICATION_TRANSITION'
  );
});

test('package validation metadata does not misuse the post-fill review state', () => {
  const needsResume = transitionApplicationState({}, {
    jobId: 'job-package-resume',
    toStatus: 'APPROVED_FOR_PACKAGE',
    initialStatus: 'REVIEW_PENDING',
    actor: 'package_builder',
    reason: 'approved_resume_missing',
    patch: { package_status: 'needs_user_input' }
  });
  assert.equal(needsResume.record.application_status, 'APPROVED_FOR_PACKAGE');
  assert.equal(needsResume.record.package_status, 'needs_user_input');
  const rebuilt = transitionApplicationState(needsResume.state, {
    jobId: 'job-package-resume', toStatus: 'PACKAGE_READY', actor: 'user', reason: 'approved_resume_selected'
  });
  assert.equal(rebuilt.record.application_status, 'PACKAGE_READY');
});

test('a pre-execution package rebuild revokes fill approval and returns to package review', () => {
  const approved = transitionApplicationState({}, {
    jobId: 'synthetic-rebuild',
    toStatus: 'FILL_APPROVED',
    initialStatus: 'PACKAGE_READY',
    actor: 'synthetic_user',
    patch: { fill_approved_at: '2026-01-01T00:00:00.000Z' }
  });
  assert.throws(() => transitionApplicationState(approved.state, {
    jobId: 'synthetic-rebuild',
    toStatus: 'PACKAGE_READY',
    actor: 'synthetic_user'
  }), error => error.code === 'INVALID_APPLICATION_TRANSITION');
  const rebuilt = transitionApplicationState(approved.state, {
    jobId: 'synthetic-rebuild',
    toStatus: 'PACKAGE_READY',
    actor: 'synthetic_user',
    recovery: true,
    patch: { fill_approved_at: null, fill_approved_by: null }
  });
  assert.equal(rebuilt.record.application_status, 'PACKAGE_READY');
  assert.equal(rebuilt.record.fill_approved_at, null);
});
