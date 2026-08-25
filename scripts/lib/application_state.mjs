import { createHash } from 'node:crypto';
import { calculateObservedCompletion } from './application_completion.mjs';
import { createApplicationExecution } from '../../application_executor/execution_report.mjs';
import { normalizeExecutorMode } from '../../application_executor/executor_interface.mjs';
import {
  assertApplicationExecutionSession,
  normalizeApplicationExecutionSession,
  transitionApplicationExecutionSession
} from '../../application_executor/execution_session.mjs';

export const APPLICATION_STATUSES = Object.freeze([
  'DISCOVERED',
  'REVIEW_PENDING',
  'SAVED',
  'REJECTED',
  'APPROVED_FOR_PACKAGE',
  'PACKAGE_READY',
  'FILL_APPROVED',
  'EXECUTOR_READY',
  'EXECUTING',
  'NEEDS_REVIEW',
  'READY_FOR_MANUAL_SUBMIT',
  'MANUALLY_SUBMITTED',
  'RECOVERY_REQUIRED',
  'CANCELLED',
  'SUPERSEDED',
  'MANUAL_ONLY',
  'UNSUPPORTED'
]);

const STATUS_SET = new Set(APPLICATION_STATUSES);
const LEGACY_STATUS_MAP = new Map([
  ['not_started', 'REVIEW_PENDING'],
  ['pending', 'REVIEW_PENDING'],
  ['manual_review', 'REVIEW_PENDING'],
  ['normalized', 'REVIEW_PENDING'],
  ['scored', 'REVIEW_PENDING'],
  ['saved', 'SAVED'],
  ['approved', 'APPROVED_FOR_PACKAGE'],
  ['package_ready', 'PACKAGE_READY'],
  ['preview_created', 'PACKAGE_READY'],
  ['approved_for_fill', 'FILL_APPROVED'],
  ['fill_started', 'EXECUTING'],
  ['needs_user_input', 'NEEDS_REVIEW'],
  ['autofill_tested', 'NEEDS_REVIEW'],
  ['submitted_manually', 'MANUALLY_SUBMITTED'],
  ['interview', 'MANUALLY_SUBMITTED'],
  ['rejected', 'REJECTED'],
  ['failed', 'RECOVERY_REQUIRED'],
  ['blocked', 'RECOVERY_REQUIRED']
]);

const TRANSITIONS = new Map([
  ['DISCOVERED', new Set(['REVIEW_PENDING', 'MANUAL_ONLY', 'UNSUPPORTED', 'RECOVERY_REQUIRED', 'CANCELLED'])],
  ['REVIEW_PENDING', new Set(['SAVED', 'REJECTED', 'APPROVED_FOR_PACKAGE', 'MANUAL_ONLY', 'UNSUPPORTED', 'RECOVERY_REQUIRED', 'CANCELLED', 'MANUALLY_SUBMITTED'])],
  ['SAVED', new Set(['REVIEW_PENDING', 'REJECTED', 'APPROVED_FOR_PACKAGE', 'MANUAL_ONLY', 'UNSUPPORTED', 'RECOVERY_REQUIRED', 'CANCELLED', 'MANUALLY_SUBMITTED'])],
  ['APPROVED_FOR_PACKAGE', new Set(['PACKAGE_READY', 'REVIEW_PENDING', 'RECOVERY_REQUIRED', 'CANCELLED', 'MANUALLY_SUBMITTED'])],
  ['PACKAGE_READY', new Set(['FILL_APPROVED', 'REVIEW_PENDING', 'RECOVERY_REQUIRED', 'CANCELLED', 'MANUALLY_SUBMITTED'])],
  ['FILL_APPROVED', new Set(['EXECUTOR_READY', 'REVIEW_PENDING', 'RECOVERY_REQUIRED', 'CANCELLED', 'MANUALLY_SUBMITTED'])],
  ['EXECUTOR_READY', new Set(['EXECUTING', 'NEEDS_REVIEW', 'RECOVERY_REQUIRED', 'CANCELLED'])],
  ['EXECUTING', new Set(['NEEDS_REVIEW', 'RECOVERY_REQUIRED', 'CANCELLED'])],
  ['NEEDS_REVIEW', new Set(['EXECUTOR_READY', 'EXECUTING', 'READY_FOR_MANUAL_SUBMIT', 'RECOVERY_REQUIRED', 'CANCELLED', 'MANUALLY_SUBMITTED'])],
  ['READY_FOR_MANUAL_SUBMIT', new Set(['NEEDS_REVIEW', 'MANUALLY_SUBMITTED', 'RECOVERY_REQUIRED', 'CANCELLED'])],
  ['MANUALLY_SUBMITTED', new Set([])],
  ['REJECTED', new Set()],
  // A crashed or uncertain fill still belongs to the user: they can walk away
  // (不投了) or resolve the uncertainty by declaring they submitted on the
  // site. Structured recovery back into the flow goes through the recovery
  // whitelist below, not these edges.
  ['RECOVERY_REQUIRED', new Set(['CANCELLED', 'MANUALLY_SUBMITTED'])],
  ['CANCELLED', new Set([])],
  ['SUPERSEDED', new Set([])],
  ['MANUAL_ONLY', new Set([])],
  ['UNSUPPORTED', new Set([])]
]);

export function applicationAllowedTransitions(status) {
  const current = normalizeApplicationStatus(status);
  return [...(TRANSITIONS.get(current) || [])];
}

function safeSegment(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown';
}

function stableId(prefix, values) {
  const digest = createHash('sha256').update(values.map(value => String(value ?? '')).join('\u001f')).digest('hex').slice(0, 20);
  return `${prefix}_${digest}`;
}

export function normalizeApplicationExecutionState(input) {
  const state = structuredClone(input && typeof input === 'object' && !Array.isArray(input) ? input : {});
  if (!state.application_status_overrides || typeof state.application_status_overrides !== 'object' || Array.isArray(state.application_status_overrides)) {
    state.application_status_overrides = {};
  }
  const persistedSessions = state.application_execution_sessions && typeof state.application_execution_sessions === 'object' && !Array.isArray(state.application_execution_sessions)
    ? state.application_execution_sessions
    : {};
  const persistedLegacyRuns = state.legacy_application_runs && typeof state.legacy_application_runs === 'object' && !Array.isArray(state.legacy_application_runs)
    ? structuredClone(state.legacy_application_runs)
    : {};
  const rawApplicationRuns = state.application_runs && typeof state.application_runs === 'object' && !Array.isArray(state.application_runs)
    ? state.application_runs
    : {};
  state.application_execution_sessions = {};
  state.legacy_application_runs = persistedLegacyRuns;
  for (const [legacyId, value] of Object.entries(persistedSessions)) {
    if (!value || typeof value !== 'object') continue;
    const session = normalizeApplicationExecutionSession({ ...value, session_id: value.session_id || value.run_id || legacyId });
    try {
      const validSession = assertApplicationExecutionSession(session);
      state.application_execution_sessions[validSession.session_id || legacyId] = validSession;
    } catch (error) {
      state.legacy_application_runs[legacyId] = {
        ...structuredClone(value),
        legacy_run_id: value.run_id || value.session_id || legacyId,
        original_status: value.original_status || value.status || value.execution_status || '',
        migration_status: value.migration_status || 'RECOVERY_REQUIRED',
        migration_error_code: error.code || 'INVALID_APPLICATION_EXECUTION_SESSION',
        migration_error_message: error.message
      };
    }
  }
  for (const [legacyId, value] of Object.entries(rawApplicationRuns)) {
    if (!value || typeof value !== 'object') continue;
    const session = normalizeApplicationExecutionSession({ ...value, session_id: value.session_id || value.run_id || legacyId });
    try {
      const validSession = assertApplicationExecutionSession(session);
      state.application_execution_sessions[validSession.session_id || legacyId] = validSession;
    } catch (error) {
      state.legacy_application_runs[legacyId] = {
        ...structuredClone(value),
        legacy_run_id: value.run_id || value.session_id || legacyId,
        original_status: value.original_status || value.status || value.execution_status || '',
        migration_status: 'RECOVERY_REQUIRED',
        migration_error_code: error.code || 'INVALID_APPLICATION_EXECUTION_SESSION',
        migration_error_message: error.message
      };
    }
  }
  delete state.application_runs;
  for (const [jobId, value] of Object.entries(state.application_status_overrides)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = { ...value };
    if (record.application_status || record.status) {
      const canonicalStatus = normalizeApplicationStatus(record.application_status || record.status);
      record.application_status = canonicalStatus;
      record.status = canonicalStatus;
    }
    // Executor lifecycle belongs to ApplicationExecutionSession. Older
    // records cached it on the application overlay and could become stale.
    delete record.executor_status;
    delete record.executor_connected_at;
    if (!record.active_session_id && record.active_run_id && state.application_execution_sessions[record.active_run_id]) {
      record.active_session_id = record.active_run_id;
    } else if (record.active_run_id && state.legacy_application_runs[record.active_run_id]) {
      record.active_legacy_run_id = record.active_run_id;
      record.execution_recovery_required = true;
      record.execution_recovery_reason = state.legacy_application_runs[record.active_run_id].migration_error_code || 'LEGACY_EXECUTION_CONTEXT_INCOMPLETE';
    }
    if (record.active_session_id && !state.application_execution_sessions[record.active_session_id]) {
      if (state.legacy_application_runs[record.active_session_id]) {
        record.active_legacy_run_id = record.active_session_id;
        record.execution_recovery_required = true;
        record.execution_recovery_reason = state.legacy_application_runs[record.active_session_id].migration_error_code || 'LEGACY_EXECUTION_CONTEXT_INCOMPLETE';
      }
      delete record.active_session_id;
    }
    delete record.active_run_id;
    state.application_status_overrides[jobId] = record;
  }
  if (!Array.isArray(state.audit_events)) state.audit_events = [];
  state.audit_events = state.audit_events.map(event => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
    const migrated = { ...event };
    if (!migrated.session_id && migrated.run_id) migrated.session_id = migrated.run_id;
    delete migrated.run_id;
    return migrated;
  });
  state.application_state_schema_version = '3.0';
  return state;
}

function copyState(input) {
  return normalizeApplicationExecutionState(input);
}

export function normalizeApplicationStatus(value, fallback = 'REVIEW_PENDING') {
  const text = String(value || '').trim();
  if (!text) return fallback;
  if (STATUS_SET.has(text)) return text;
  const mapped = LEGACY_STATUS_MAP.get(text.toLowerCase());
  if (mapped) return mapped;
  const error = new Error(`Unknown application status: ${text}`);
  error.code = 'INVALID_APPLICATION_STATUS';
  error.status = text;
  throw error;
}

export function applicationIdForJob(jobId) {
  return `application_${safeSegment(jobId)}`;
}

export function deriveApplicationStatus({ job = {}, review = null, override = null } = {}) {
  const record = override && typeof override === 'object' ? override : {};
  if (record.application_status || record.status) {
    return normalizeApplicationStatus(record.application_status || record.status);
  }
  // A created preview only proves the job was approved for packaging; package
  // readiness is decided by the explicit application_status the build flow
  // writes from application_package.status, never inferred from this marker.
  if (record.package_status === 'preview_created' || job.package_status === 'preview_created') return 'APPROVED_FOR_PACKAGE';
  const decision = review?.decision || job.approval_status || '';
  if (decision === 'rejected') return 'REJECTED';
  if (decision === 'approved') return 'APPROVED_FOR_PACKAGE';
  if (decision === 'manual_review' || decision === 'pending') return 'REVIEW_PENDING';
  if (job.match_score !== undefined || job.score_breakdown) return 'REVIEW_PENDING';
  if (job.normalized_at || job.canonical_url) return 'DISCOVERED';
  return 'DISCOVERED';
}

export function appendAuditEvent(inputState, {
  jobId = '',
  applicationId = '',
  sessionId = '',
  eventType,
  actor,
  fromStatus = '',
  toStatus = '',
  reason = '',
  idempotencyKey = '',
  metadata = {},
  now = new Date().toISOString()
}) {
  if (!eventType || !actor) {
    const error = new Error('eventType and actor are required');
    error.code = 'INVALID_AUDIT_EVENT';
    throw error;
  }
  const state = copyState(inputState);
  if (idempotencyKey) {
    const existing = state.audit_events.find(event => event.idempotency_key === idempotencyKey && event.event_type === eventType);
    if (existing) return { state, event: existing, idempotent_replay: true };
  }
  const sequence = state.audit_events.length + 1;
  const event = {
    event_id: stableId('audit', [jobId, applicationId, sessionId, eventType, now, sequence]),
    sequence,
    timestamp: now,
    event_type: eventType,
    actor,
    job_id: String(jobId || ''),
    application_id: applicationId || (jobId ? applicationIdForJob(jobId) : ''),
    session_id: sessionId || '',
    from_status: fromStatus || '',
    to_status: toStatus || '',
    reason: reason || '',
    idempotency_key: idempotencyKey || '',
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? structuredClone(metadata) : {}
  };
  state.audit_events.push(event);
  state.audit_events = state.audit_events.slice(-1000);
  return { state, event, idempotent_replay: false };
}

export function transitionApplicationState(inputState, {
  jobId,
  toStatus,
  actor,
  reason = '',
  patch = {},
  initialStatus = 'REVIEW_PENDING',
  idempotencyKey = '',
  recovery = false,
  sessionId = '',
  now = new Date().toISOString()
}) {
  if (!jobId || !actor) {
    const error = new Error('jobId and actor are required');
    error.code = 'INVALID_APPLICATION_TRANSITION';
    throw error;
  }
  const target = normalizeApplicationStatus(toStatus);
  let state = copyState(inputState);
  const previous = state.application_status_overrides[String(jobId)] || {};
  const current = normalizeApplicationStatus(previous.application_status || previous.status || initialStatus);
  if (current === target) {
    const hasPatch = patch && typeof patch === 'object' && Object.keys(patch).length > 0;
    if (!hasPatch) return { state, record: previous, event: null, idempotent_replay: true };
    const applicationId = previous.application_id || applicationIdForJob(jobId);
    const record = {
      ...previous,
      ...structuredClone(patch),
      job_id: String(jobId),
      application_id: applicationId,
      status: target,
      application_status: target,
      updated_at: now,
      updated_by: actor
    };
    state.application_status_overrides[String(jobId)] = record;
    const audited = appendAuditEvent(state, {
      jobId,
      applicationId,
      sessionId,
      eventType: 'STATE_METADATA_UPDATED',
      actor,
      fromStatus: current,
      toStatus: target,
      reason,
      idempotencyKey,
      metadata: { recovery: Boolean(recovery), patch_keys: Object.keys(patch).sort() },
      now
    });
    return { state: audited.state, record, event: audited.event, idempotent_replay: audited.idempotent_replay };
  }
  const allowed = TRANSITIONS.get(current) || new Set();
  const recoveryAllowed = recovery && (
    (current === 'REJECTED' && target === 'REVIEW_PENDING')
    || (['CANCELLED', 'MANUAL_ONLY', 'UNSUPPORTED'].includes(current) && target === 'REVIEW_PENDING')
    || (current === 'NEEDS_REVIEW' && ['PACKAGE_READY', 'FILL_APPROVED', 'EXECUTOR_READY'].includes(target))
    || (['EXECUTOR_READY', 'EXECUTING'].includes(current) && target === 'PACKAGE_READY')
    || (current === 'FILL_APPROVED' && target === 'PACKAGE_READY')
    || (current === 'RECOVERY_REQUIRED'
      && ['REVIEW_PENDING', 'PACKAGE_READY', 'FILL_APPROVED', 'EXECUTOR_READY', 'NEEDS_REVIEW'].includes(target))
  );
  if (!allowed.has(target) && !recoveryAllowed) {
    const error = new Error(`Invalid application transition: ${current} -> ${target}`);
    error.code = 'INVALID_APPLICATION_TRANSITION';
    error.from_status = current;
    error.to_status = target;
    throw error;
  }
  const applicationId = previous.application_id || applicationIdForJob(jobId);
  const record = {
    ...previous,
    ...structuredClone(patch || {}),
    job_id: String(jobId),
    application_id: applicationId,
    status: target,
    application_status: target,
    updated_at: now,
    updated_by: actor
  };
  state.application_status_overrides[String(jobId)] = record;
  const audited = appendAuditEvent(state, {
    jobId,
    applicationId,
    sessionId,
    eventType: 'STATUS_TRANSITION',
    actor,
    fromStatus: current,
    toStatus: target,
    reason,
    idempotencyKey,
    metadata: { recovery: Boolean(recovery) },
    now
  });
  return { state: audited.state, record, event: audited.event, idempotent_replay: audited.idempotent_replay };
}

export function restartApplicationExecutionSetup(inputState, {
  jobId,
  actor,
  idempotencyKey,
  executorType = '',
  now = new Date().toISOString()
} = {}) {
  if (!jobId || !actor || !idempotencyKey) {
    const error = new Error('jobId, actor, and idempotencyKey are required');
    error.code = 'INVALID_FILL_SETUP_RESTART';
    throw error;
  }
  let state = copyState(inputState);
  const replayEvent = state.audit_events.find(event =>
    event?.idempotency_key === idempotencyKey && event?.reason === 'user_restarted_fill_setup'
  );
  if (replayEvent) {
    const record = state.application_status_overrides[String(jobId)] || {};
    const cancelledSession = replayEvent.session_id ? state.application_execution_sessions[replayEvent.session_id] : null;
    return { state, record, cancelled_session: cancelledSession, event: replayEvent, idempotent_replay: true };
  }
  const record = state.application_status_overrides[String(jobId)] || {};
  const sessionId = String(record.active_session_id || '');
  const session = sessionId ? state.application_execution_sessions[sessionId] : null;
  if (!session) {
    const error = new Error('No active fill attempt is available to restart.');
    error.code = 'APPLICATION_EXECUTION_SESSION_NOT_FOUND';
    throw error;
  }
  const currentStatus = normalizeApplicationStatus(record.application_status || record.status || 'PACKAGE_READY');
  if (currentStatus === 'MANUALLY_SUBMITTED') {
    const error = new Error('A manually submitted application cannot restart fill setup.');
    error.code = 'APPLICATION_ALREADY_SUBMITTED';
    throw error;
  }
  const selectedExecutor = executorType ? normalizeExecutorMode(executorType) : normalizeExecutorMode(session.executor_type);
  const cancelledSession = transitionApplicationExecutionSession(session, 'CANCELLED', {
    now,
    details: { reason: 'user_restarted_fill_setup', replacement_executor_type: selectedExecutor }
  });
  state.application_execution_sessions[sessionId] = {
    ...cancelledSession,
    cancelled_at: now,
    cancellation_reason: 'user_restarted_fill_setup',
    latest_review_rescan: null
  };
  const transitioned = transitionApplicationState(state, {
    jobId,
    toStatus: 'PACKAGE_READY',
    actor,
    reason: 'user_restarted_fill_setup',
    patch: {
      selected_executor_type: selectedExecutor,
      executor: selectedExecutor,
      browser_opened: false,
      previous_session_ids: [...new Set([...(record.previous_session_ids || []), sessionId])].slice(-25)
    },
    initialStatus: currentStatus,
    idempotencyKey,
    recovery: true,
    sessionId,
    now
  });
  const restartedRecord = { ...transitioned.record };
  delete restartedRecord.active_session_id;
  delete restartedRecord.active_attempt_id;
  delete restartedRecord.fill_started_at;
  delete restartedRecord.fill_approved_at;
  delete restartedRecord.fill_approved_by;
  delete restartedRecord.browser_agent;
  delete restartedRecord.latest_review_rescan;
  delete restartedRecord.review_rescan_received_at;
  transitioned.state.application_status_overrides[String(jobId)] = restartedRecord;
  return {
    ...transitioned,
    record: restartedRecord,
    cancelled_session: transitioned.state.application_execution_sessions[sessionId]
  };
}

export function prepareApplicationExecutionSession(inputState, {
  jobId,
  actor,
  idempotencyKey,
  session,
  initialStatus = 'PACKAGE_READY',
  now = new Date().toISOString()
}) {
  if (!jobId || !actor || !idempotencyKey) {
    const error = new Error('jobId, actor, and idempotencyKey are required');
    error.code = 'INVALID_APPLICATION_SESSION_PREPARATION';
    throw error;
  }
  let state = copyState(inputState);
  const requested = assertApplicationExecutionSession(session);
  if (String(requested.job_id) !== String(jobId)) {
    const error = new Error('This fill attempt belongs to a different job.');
    error.code = 'APPLICATION_EXECUTION_SESSION_MISMATCH';
    throw error;
  }
  const currentRecord = state.application_status_overrides[String(jobId)] || {};
  const active = currentRecord.active_session_id
    ? state.application_execution_sessions[currentRecord.active_session_id]
    : null;
  if (active) {
    const validActive = assertApplicationExecutionSession(active);
    const sameIdentity = validActive.job_id === requested.job_id
      && validActive.application_id === requested.application_id
      && validActive.package_id === requested.package_id
      && validActive.executor_type === requested.executor_type;
    if (!sameIdentity) {
      const error = new Error('This job already has a different active fill attempt. Cancel or recover it before replacing it.');
      error.code = 'ACTIVE_APPLICATION_SESSION_CONFLICT';
      error.session_id = validActive.session_id;
      throw error;
    }
    const currentStatus = normalizeApplicationStatus(
      currentRecord.application_status || currentRecord.status || initialStatus
    );
    if (currentStatus === 'FILL_APPROVED') {
      return { state, session: validActive, record: currentRecord, event: null, idempotent_replay: true };
    }
    const transitioned = transitionApplicationState(state, {
      jobId,
      toStatus: 'FILL_APPROVED',
      actor,
      reason: 'existing_application_session_approved_for_fill',
      patch: {
        active_session_id: validActive.session_id,
        selected_executor_type: validActive.executor_type,
        executor: validActive.executor_type
      },
      initialStatus: currentStatus,
      idempotencyKey,
      sessionId: validActive.session_id,
      now
    });
    return { ...transitioned, session: validActive };
  }
  const prepared = {
    ...requested,
    idempotency_key: requested.idempotency_key || idempotencyKey,
    idempotency_keys: [...new Set([...(requested.idempotency_keys || []), idempotencyKey])],
    updated_at: now
  };
  state.application_execution_sessions[prepared.session_id] = prepared;
  const transitioned = transitionApplicationState(state, {
    jobId,
    toStatus: 'FILL_APPROVED',
    actor,
    reason: 'application_package_reviewed_and_session_prepared',
    patch: {
      active_session_id: prepared.session_id,
      selected_executor_type: prepared.executor_type,
      executor: prepared.executor_type
    },
    initialStatus,
    idempotencyKey,
    sessionId: prepared.session_id,
    now
  });
  return { ...transitioned, session: prepared };
}

export function startApplicationExecutionSession(inputState, {
  jobId,
  actor,
  idempotencyKey,
  session,
  initialStatus = 'FILL_APPROVED',
  recovery = false,
  now = new Date().toISOString()
}) {
  if (!idempotencyKey) {
    const error = new Error('idempotencyKey is required');
    error.code = 'IDEMPOTENCY_KEY_REQUIRED';
    throw error;
  }
  let state = copyState(inputState);
  const requestedSession = assertApplicationExecutionSession(session);
  if (String(requestedSession.job_id) !== String(jobId)) {
    const error = new Error('This fill attempt belongs to a different job.');
    error.code = 'APPLICATION_EXECUTION_SESSION_MISMATCH';
    throw error;
  }
  const existing = Object.values(state.application_execution_sessions).find(item => item.idempotency_key === idempotencyKey);
  if (existing) {
    try {
      const validExisting = assertApplicationExecutionSession(existing);
      const record = state.application_status_overrides[String(jobId)] || {};
      return { state, session: validExisting, record, event: null, idempotent_replay: true };
    } catch {
      // A pre-1.1 session without an approved profile binding cannot own a new execution.
    }
  }
  const currentRecord = state.application_status_overrides[String(jobId)] || {};
  const activeSession = currentRecord.active_session_id ? state.application_execution_sessions[currentRecord.active_session_id] : null;
  let validActiveSession = null;
  try { if (activeSession) validActiveSession = assertApplicationExecutionSession(activeSession); }
  catch { validActiveSession = null; }

  const beginAttempt = (inputSession) => {
    const priorAttempts = Array.isArray(inputSession.execution_attempts)
      ? inputSession.execution_attempts.map(item => structuredClone(item))
      : [];
    const knownReportIds = new Set(priorAttempts.map(item => item.report_id).filter(Boolean));
    for (const [index, stored] of (inputSession.reports || []).entries()) {
      if (!stored || knownReportIds.has(stored.report_id)) continue;
      const execution = stored.application_execution || {};
      priorAttempts.push({
        attempt_id: execution.attempt_id || stableId('execution_attempt', [inputSession.session_id, stored.report_id || index]),
        started_at: execution.started_at || stored.timestamp || null,
        completed_at: execution.completed_at || stored.timestamp || null,
        executor_type: normalizeExecutorMode(execution.executor || inputSession.executor_type),
        detected_count: Number(execution.counts?.detected ?? stored.total_fields_seen ?? 0),
        filled_count: Number(execution.counts?.filled ?? stored.filled_fields_count ?? 0),
        skipped_count: Number(execution.counts?.skipped ?? stored.skipped_fields_count ?? 0),
        failed_count: Number(execution.counts?.failed ?? 0),
        challenge_scope: execution.challenge_scope || (execution.blocker?.reason === 'captcha_or_challenge_detected' ? 'unknown' : 'none'),
        outcome: stored.resulting_status || 'needs_review',
        report_id: stored.report_id || '',
      });
    }
    const attemptId = stableId('execution_attempt', [inputSession.session_id, idempotencyKey]);
    const existingAttempt = priorAttempts.find(item => item.attempt_id === attemptId);
    const attempt = existingAttempt || {
      attempt_id: attemptId,
      started_at: now,
      completed_at: null,
      executor_type: normalizeExecutorMode(inputSession.executor_type),
      detected_count: 0,
      filled_count: 0,
      skipped_count: 0,
      failed_count: 0,
      challenge_scope: 'unknown',
      outcome: 'in_progress',
      report_id: '',
    };
    return {
      ...inputSession,
      active_attempt_id: attemptId,
      execution_attempts: existingAttempt ? priorAttempts : [...priorAttempts, attempt].slice(-25),
    };
  };
  const transitionToExecuting = (inputStateForTransition, inputSession, {
    startReason,
    transitionInitialStatus,
    transitionRecovery = false
  }) => {
    const ready = transitionApplicationState(inputStateForTransition, {
      jobId,
      toStatus: 'EXECUTOR_READY',
      actor,
      reason: `${startReason}_executor_ready`,
      patch: { active_session_id: inputSession.session_id },
      initialStatus: transitionInitialStatus,
      idempotencyKey: `${idempotencyKey}:executor-ready`,
      recovery: transitionRecovery,
      sessionId: inputSession.session_id,
      now
    });
    return transitionApplicationState(ready.state, {
      jobId,
      toStatus: 'EXECUTING',
      actor,
      reason: startReason,
      patch: { active_session_id: inputSession.session_id },
      initialStatus: 'EXECUTOR_READY',
      idempotencyKey: `${idempotencyKey}:executing`,
      sessionId: inputSession.session_id,
      now
    });
  };
  if (validActiveSession && validActiveSession.execution_status === 'SESSION_CREATED') {
    const startedDraftSession = transitionApplicationExecutionSession({
      ...beginAttempt(validActiveSession),
      idempotency_keys: [...new Set([...(validActiveSession.idempotency_keys || [validActiveSession.idempotency_key]).filter(Boolean), idempotencyKey])],
      start_idempotency_key: idempotencyKey,
      updated_at: now
    }, 'EXECUTOR_READY', { now });
    state.application_execution_sessions[startedDraftSession.session_id] = startedDraftSession;
    const transitioned = transitionToExecuting(state, startedDraftSession, {
      startReason: 'prepared_session_started',
      transitionInitialStatus: initialStatus
    });
    return { ...transitioned, session: startedDraftSession };
  }
  if (validActiveSession && ['EXECUTOR_READY', 'EXTENSION_CONNECTED', 'FIELDS_DETECTED', 'FILLING'].includes(validActiveSession.execution_status)) {
    return { state, session: validActiveSession, record: currentRecord, event: null, idempotent_replay: true };
  }
  if (recovery && validActiveSession && validActiveSession.execution_status === 'NEEDS_REVIEW') {
    const recoveredSession = transitionApplicationExecutionSession({
      ...beginAttempt(validActiveSession),
      updated_at: now,
      recovery_count: Number(validActiveSession.recovery_count || 0) + 1,
      idempotency_keys: [...new Set([...(validActiveSession.idempotency_keys || [validActiveSession.idempotency_key]), idempotencyKey])]
    }, 'EXECUTOR_READY', { now, details: { reason: 'safe_recovery' } });
    state.application_execution_sessions[validActiveSession.session_id] = recoveredSession;
    const transitioned = transitionToExecuting(state, recoveredSession, {
      startReason: 'safe_recovery',
      transitionInitialStatus: 'NEEDS_REVIEW',
      transitionRecovery: true
    });
    return { ...transitioned, session: recoveredSession };
  }
  const executionSession = transitionApplicationExecutionSession({
    ...beginAttempt(requestedSession),
    idempotency_key: idempotencyKey,
    idempotency_keys: [idempotencyKey],
    created_at: requestedSession.created_at || now,
    updated_at: now,
    recovery_count: 0,
    reports: []
  }, 'EXECUTOR_READY', { now });
  state.application_execution_sessions[executionSession.session_id] = executionSession;
  const transitioned = transitionToExecuting(state, executionSession, {
    startReason: 'fill_started',
    transitionInitialStatus: initialStatus,
    transitionRecovery: recovery
  });
  return { ...transitioned, session: executionSession };
}

export function recoverLegacyApplicationExecutionState(inputState, {
  jobId,
  actor,
  recoveryIdempotencyKey,
  session,
  packagePath = '',
  packageFiles = [],
  applicationCompletion = null,
  now = new Date().toISOString()
}) {
  if (!jobId || !actor || !recoveryIdempotencyKey) {
    const error = new Error('jobId, actor, and recoveryIdempotencyKey are required');
    error.code = 'INVALID_EXECUTION_RECOVERY';
    throw error;
  }
  let state = copyState(inputState);
  const existingSession = Object.values(state.application_execution_sessions)
    .find(item => item.recovery_idempotency_key === recoveryIdempotencyKey);
  if (existingSession) {
    return {
      state,
      session: existingSession,
      record: state.application_status_overrides[String(jobId)] || {},
      event: null,
      idempotent_replay: true,
      superseded_legacy_run_ids: existingSession.superseded_legacy_run_ids || []
    };
  }

  const requestedSession = assertApplicationExecutionSession(session);
  if (String(requestedSession.job_id) !== String(jobId)) {
    const error = new Error('Recovery session job_id does not match the requested application.');
    error.code = 'APPLICATION_EXECUTION_SESSION_MISMATCH';
    throw error;
  }
  if (requestedSession.execution_status !== 'SESSION_CREATED') {
    const error = new Error('Recovery must prepare a new draft fill attempt before filling begins.');
    error.code = 'INVALID_EXECUTION_RECOVERY_SESSION';
    throw error;
  }

  const record = state.application_status_overrides[String(jobId)] || {};
  const legacyRunIds = [...new Set([
    record.active_legacy_run_id,
    ...Object.entries(state.legacy_application_runs || {})
      .filter(([, value]) => String(value?.job_id || '') === String(jobId))
      .map(([legacyId]) => legacyId)
  ].filter(Boolean))];
  const recoveryRequired = record.execution_recovery_required === true
    || legacyRunIds.length > 0
    || ['EXECUTING', 'NEEDS_REVIEW'].includes(normalizeApplicationStatus(record.application_status || record.status || 'REVIEW_PENDING'));
  if (!recoveryRequired) {
    const error = new Error('This application does not have an interrupted legacy execution to recover.');
    error.code = 'EXECUTION_RECOVERY_NOT_REQUIRED';
    throw error;
  }

  for (const legacyRunId of legacyRunIds) {
    const legacy = state.legacy_application_runs[legacyRunId] || {};
    state.legacy_application_runs[legacyRunId] = {
      ...legacy,
      legacy_run_id: legacy.legacy_run_id || legacy.run_id || legacyRunId,
      original_status: legacy.original_status || legacy.status || '',
      status: 'SUPERSEDED',
      migration_status: 'SUPERSEDED',
      superseded_at: now,
      superseded_by_session_id: requestedSession.session_id,
      superseded_reason: 'canonical_execution_recovery',
      application_record_snapshot: legacy.application_record_snapshot || {
        application_status: record.application_status || record.status || '',
        fill_approved_at: record.fill_approved_at || null,
        fill_started_at: record.fill_started_at || null,
        executor: record.executor || record.selected_executor_type || '',
        latest_fill_report: record.latest_fill_report || null,
        application_completion: record.application_completion || null
      }
    };
  }

  const recoveredSession = {
    ...requestedSession,
    recovery_idempotency_key: recoveryIdempotencyKey,
    superseded_legacy_run_ids: legacyRunIds,
    recovered_at: now,
    updated_at: now
  };
  state.application_execution_sessions[recoveredSession.session_id] = recoveredSession;
  const nextRecord = {
    ...record,
    job_id: String(jobId),
    application_id: recoveredSession.application_id,
    application_status: 'PACKAGE_READY',
    status: 'PACKAGE_READY',
    package_status: 'preview_created',
    package_id: recoveredSession.package_id,
    package_path: packagePath || record.package_path || '',
    package_files: Array.isArray(packageFiles) ? structuredClone(packageFiles) : [],
    application_completion: applicationCompletion && typeof applicationCompletion === 'object'
      ? structuredClone(applicationCompletion)
      : null,
    active_session_id: recoveredSession.session_id,
    active_legacy_run_id: '',
    execution_recovery_required: false,
    execution_recovery_reason: '',
    selected_executor_type: recoveredSession.executor_type,
    executor: recoveredSession.executor_type,
    fill_approved_at: null,
    fill_approved_by: null,
    fill_started_at: null,
    latest_fill_report: null,
    browser_opened: false,
    final_submit_allowed: false,
    recovered_at: now,
    updated_at: now,
    updated_by: actor
  };
  state.application_status_overrides[String(jobId)] = nextRecord;
  const audited = appendAuditEvent(state, {
    jobId,
    applicationId: recoveredSession.application_id,
    sessionId: recoveredSession.session_id,
    eventType: 'LEGACY_EXECUTION_SUPERSEDED',
    actor,
    fromStatus: record.application_status || record.status || '',
    toStatus: 'PACKAGE_READY',
    reason: 'canonical_execution_recovery',
    idempotencyKey: recoveryIdempotencyKey,
    metadata: {
      superseded_legacy_run_ids: legacyRunIds,
      package_id: recoveredSession.package_id,
      approved_profile_id: recoveredSession.approved_profile_version.profile_id,
      approved_profile_version: recoveredSession.approved_profile_version.version,
      executor_type: recoveredSession.executor_type
    },
    now
  });
  return {
    state: audited.state,
    session: recoveredSession,
    record: audited.state.application_status_overrides[String(jobId)],
    event: audited.event,
    idempotent_replay: false,
    superseded_legacy_run_ids: legacyRunIds
  };
}

export function recordApplicationExecutionSessionReport(inputState, {
  jobId,
  sessionId = '',
  actor,
  report = {},
  now = new Date().toISOString()
}) {
  let state = copyState(inputState);
  const record = state.application_status_overrides[String(jobId)] || {};
  const selectedSessionId = sessionId || record.active_session_id || '';
  const session = state.application_execution_sessions[selectedSessionId];
  if (!session || String(session.job_id) !== String(jobId)) {
    const error = new Error('No active fill attempt was found.');
    error.code = 'APPLICATION_EXECUTION_SESSION_NOT_FOUND';
    throw error;
  }
  const safeReport = {
    timestamp: typeof report.timestamp === 'string' ? report.timestamp : now,
    total_fields_seen: Number(report.total_fields_seen || 0),
    filled_fields_count: Number(report.filled_fields_count || 0),
    skipped_fields_count: Number(report.skipped_fields_count || 0),
    hard_blocked_fields_count: Number(report.hard_blocked_fields_count || 0),
    fields_requiring_user_review_count: Number(report.fields_requiring_user_review_count || 0),
    suggested_questions_count: Number(report.suggested_questions_count || 0),
    blocked_page_state: report.blocked_page_state === true,
    blocked_reason: typeof report.blocked_reason === 'string' ? report.blocked_reason : '',
    challenge_scope: ['active', 'passive', 'none', 'unknown'].includes(String(report.challenge_scope || report.application_execution?.challenge_scope || '').toLowerCase())
      ? String(report.challenge_scope || report.application_execution?.challenge_scope).toLowerCase()
      : 'none',
    submission_blocker: typeof (report.submission_blocker || report.application_execution?.submission_blocker) === 'string'
      ? String(report.submission_blocker || report.application_execution?.submission_blocker)
      : '',
    final_submit_clicked: false,
    application_submitted: false,
    resume_upload_attempted: report.resume_upload_attempted === true,
    resume_upload_confirmed: report.resume_upload_confirmed === true,
    resume_upload_status: typeof report.resume_upload_status === 'string' ? report.resume_upload_status.slice(0, 60) : '',
    executor: normalizeExecutorMode(session.executor_type || report.application_execution?.executor)
  };
  const submittedExecution = report.application_execution && typeof report.application_execution === 'object'
    ? report.application_execution
    : null;
  if (submittedExecution) {
    if (normalizeExecutorMode(submittedExecution.executor) !== normalizeExecutorMode(session.executor_type)) {
      const error = new Error('The fill method does not match the active fill attempt.');
      error.code = 'EXECUTOR_MISMATCH';
      throw error;
    }
    safeReport.application_execution = createApplicationExecution({
      ...submittedExecution,
      execution_id: selectedSessionId,
      run_id: selectedSessionId,
      application_id: session.application_id,
      job_id: String(jobId),
      package_id: session.package_id,
      executor: session.executor_type,
      fields: Array.isArray(submittedExecution.field_results)
        ? submittedExecution.field_results
        : Array.isArray(submittedExecution.fields)
          ? submittedExecution.fields
          : submittedExecution.fields || {},
      completed_at: submittedExecution.completed_at || now,
    });
    safeReport.total_fields_seen = safeReport.application_execution.counts.detected;
    safeReport.filled_fields_count = safeReport.application_execution.counts.filled;
    safeReport.skipped_fields_count = safeReport.application_execution.counts.skipped;
    safeReport.challenge_scope = safeReport.application_execution.challenge_scope || safeReport.challenge_scope;
    safeReport.submission_blocker = safeReport.application_execution.submission_blocker || safeReport.submission_blocker;
  }
  const applicationCompletion = calculateObservedCompletion(safeReport, { now });
  safeReport.application_completion = applicationCompletion;
  const reportKey = stableId('fill_report', [selectedSessionId, JSON.stringify(safeReport)]);
  const existingReport = (session.reports || []).find(item => item.report_id === reportKey);
  if (existingReport) return { state, session, record, report: existingReport, idempotent_replay: true };
  // NEEDS_REVIEW accepts further reports: a re-fill during review IS the retry
  // flow (the extension's "Continue after verification" reports through here).
  // Terminal states — ready-to-submit, submitted, cancelled — still refuse.
  if (!['SESSION_CREATED', 'EXECUTOR_READY', 'EXTENSION_CONNECTED', 'FIELDS_DETECTED', 'FILLING', 'NEEDS_REVIEW'].includes(session.execution_status)) {
    const error = new Error('The fill attempt is not active. Review or recover it before continuing.');
    error.code = 'APPLICATION_EXECUTION_SESSION_NOT_ACTIVE';
    throw error;
  }
  const uncertainSubmit = report.final_submit_clicked === true || report.application_submitted === true;
  const needsInput = uncertainSubmit
    || safeReport.blocked_page_state
    || Boolean(safeReport.blocked_reason)
    || safeReport.fields_requiring_user_review_count > 0
    || safeReport.suggested_questions_count > 0;
  // A safe-fill result always requires an explicit human review. Even a fully
  // filled form cannot become submission-ready from an executor report alone.
  const target = uncertainSubmit ? 'RECOVERY_REQUIRED' : 'NEEDS_REVIEW';
  const attemptId = safeReport.application_execution?.attempt_id || session.active_attempt_id
    || stableId('execution_attempt', [selectedSessionId, reportKey]);
  const storedReport = { report_id: reportKey, attempt_id: attemptId, ...safeReport, resulting_status: target };
  let updatedSession = session;
  if (safeReport.total_fields_seen > 0) {
    updatedSession = transitionApplicationExecutionSession(updatedSession, 'FIELDS_DETECTED', {
      now,
      details: { count: safeReport.total_fields_seen }
    });
  }
  updatedSession = transitionApplicationExecutionSession(updatedSession, 'FILLING', { now });
  const existingAttempts = Array.isArray(session.execution_attempts) ? session.execution_attempts : [];
  const completedAttempt = {
    attempt_id: attemptId,
    started_at: safeReport.application_execution?.started_at || safeReport.timestamp || now,
    completed_at: safeReport.application_execution?.completed_at || safeReport.timestamp || now,
    executor_type: normalizeExecutorMode(session.executor_type),
    detected_count: Number(safeReport.total_fields_seen || 0),
    filled_count: Number(safeReport.filled_fields_count || 0),
    skipped_count: Number(safeReport.skipped_fields_count || 0),
    failed_count: Number(safeReport.application_execution?.counts?.failed || 0),
    challenge_scope: safeReport.challenge_scope || 'none',
    outcome: safeReport.blocked_page_state
      ? 'blocked_active_challenge'
      : safeReport.submission_blocker
        ? 'safe_fill_complete_verification_required'
        : 'safe_fill_complete_needs_review',
    report_id: reportKey,
  };
  const updatedAttempts = existingAttempts.some(item => item.attempt_id === attemptId)
    ? existingAttempts.map(item => item.attempt_id === attemptId ? completedAttempt : item)
    : [...existingAttempts, completedAttempt];
  updatedSession = transitionApplicationExecutionSession({
    ...updatedSession,
    active_attempt_id: attemptId,
    execution_attempts: updatedAttempts.slice(-25),
    reports: [...(session.reports || []), storedReport].slice(-25),
    // A new fill attempt supersedes any earlier review scan; review completion
    // must be re-proven against this attempt's page state.
    latest_review_rescan: null
  }, 'NEEDS_REVIEW', { now });
  state.application_execution_sessions[selectedSessionId] = updatedSession;
  const transitioned = transitionApplicationState(state, {
    jobId,
    toStatus: target,
    actor,
    reason: uncertainSubmit ? 'submission_result_uncertain' : (needsInput ? 'user_input_required' : 'safe_fill_complete'),
    patch: {
      active_session_id: selectedSessionId,
      latest_fill_report: safeReport,
      latest_review_rescan: null,
      application_completion: applicationCompletion,
      fill_report_received_at: now
    },
    initialStatus: 'EXECUTING',
    idempotencyKey: reportKey,
    sessionId: selectedSessionId,
    now
  });
  return { ...transitioned, session: updatedSession, report: storedReport };
}

// A review re-scan is only trustworthy for the attempt and target it was taken
// against. The digest binds it to the page URL, package, and approved profile
// version so a retry, restart, or target change invalidates it (audit M4).
const REVIEW_RESCAN_TTL_MS = Math.max(60_000, Number(process.env.REVIEW_RESCAN_TTL_MS) || 24 * 60 * 60 * 1000);

export function reviewScanTargetDigest(session = {}) {
  const profile = session.approved_profile_version || {};
  return createHash('sha256').update([
    String(session.target_url || ''),
    String(session.package_id || ''),
    String(profile.profile_id || ''),
    String(profile.version || '')
  ].join('')).digest('hex').slice(0, 32);
}

function currentReviewAttemptId(session = {}) {
  const attempts = Array.isArray(session.execution_attempts) ? session.execution_attempts : [];
  return String(session.active_attempt_id || attempts[attempts.length - 1]?.attempt_id || '');
}

export function reviewScanFreshness(scan, session, { now = new Date().toISOString() } = {}) {
  if (!scan) return { fresh: false, reason: 'missing_scan' };
  if (!scan.review_scan_attempt_id || !scan.review_scan_target_digest || !scan.review_scan_created_at) {
    return { fresh: false, reason: 'missing_freshness_proof' };
  }
  if (scan.review_scan_attempt_id !== currentReviewAttemptId(session)) {
    return { fresh: false, reason: 'attempt_mismatch' };
  }
  if (scan.review_scan_target_digest !== reviewScanTargetDigest(session)) {
    return { fresh: false, reason: 'target_mismatch' };
  }
  const createdAt = Date.parse(scan.review_scan_created_at);
  const reference = Date.parse(now);
  if (!Number.isFinite(createdAt) || (Number.isFinite(reference) && reference - createdAt > REVIEW_RESCAN_TTL_MS)) {
    return { fresh: false, reason: 'scan_expired' };
  }
  return { fresh: true, reason: '' };
}

function normalizeReviewRescan(report = {}, now = new Date().toISOString(), { attemptId = '', targetDigest = '' } = {}) {
  const allowedBlockerCodes = new Set([
    'REQUIRED_FIELDS_INCOMPLETE',
    'REQUIRED_FIELD_UNKNOWN',
    'FILE_UPLOAD_REQUIRED',
    'LOGIN_REQUIRED',
    'ACTIVE_CHALLENGE',
    'FORM_NOT_ACCESSIBLE',
    'UNSUPPORTED_FORM'
  ]);
  const highRiskBlockers = Array.isArray(report.high_risk_blockers)
    ? report.high_risk_blockers
      .map(item => typeof item === 'string' ? { code: item, message: item } : item)
      .filter(item => item && allowedBlockerCodes.has(String(item.code || '')))
      .map(item => ({ code: String(item.code), message: String(item.message || item.code) }))
    : [];
  const submissionBlockers = Array.isArray(report.submission_blockers)
    ? report.submission_blockers.map(String).filter(Boolean).slice(0, 20)
    : [];
  const fields = Array.isArray(report.fields)
    ? report.fields.slice(0, 500).map(item => ({
        field_ref: String(item?.field_ref || ''),
        label: String(item?.label || '').slice(0, 200),
        normalized_question: String(item?.normalized_question || '').slice(0, 200),
        group_key: String(item?.group_key || item?.field_ref || '').slice(0, 120),
        group_label: String(item?.group_label || '').slice(0, 200),
        adapter: String(item?.adapter || '').slice(0, 40),
        type: String(item?.type || '').slice(0, 50),
        required: item?.required === true,
        filled: item?.filled === true,
        options: Array.isArray(item?.options)
          ? item.options.slice(0, 60).map(option => ({
              value: String(option?.value || '').slice(0, 200),
              label: String(option?.label || '').slice(0, 200)
            }))
          : [],
        mapped_key: String(item?.mapped_key || '').slice(0, 80),
        source: String(item?.source || '').slice(0, 80),
        confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null,
        sensitive: item?.sensitive === true,
        question_class: String(item?.question_class || '').slice(0, 30),
        status: String(item?.status || '').slice(0, 60),
        classification: String(item?.classification || '').slice(0, 100),
        reason: String(item?.reason || '').slice(0, 200)
      }))
    : [];
  return {
    scan_id: String(report.scan_id || stableId('review_rescan', [now, JSON.stringify({
      detected: report.detected_count,
      required: report.required_count,
      empty: report.required_empty_count,
      challenge: report.challenge_scope
    })])),
    scanned_at: typeof report.scanned_at === 'string' ? report.scanned_at : now,
    review_scan_attempt_id: String(report.review_scan_attempt_id || attemptId || ''),
    review_scan_target_digest: String(report.review_scan_target_digest || targetDigest || ''),
    review_scan_created_at: now,
    current_url: String(report.current_url || '').slice(0, 2000),
    detected_count: Math.max(0, Number(report.detected_count || fields.length || 0)),
    required_count: Math.max(0, Number(report.required_count || 0)),
    required_filled_count: Math.max(0, Number(report.required_filled_count || 0)),
    required_empty_count: Math.max(0, Number(report.required_empty_count || 0)),
    unknown_required_count: Math.max(0, Number(report.unknown_required_count || 0)),
    file_upload_required: report.file_upload_required === true,
    file_upload_present: report.file_upload_present === true,
    submit_control_detected: report.submit_control_detected === true,
    form_accessible: report.form_accessible !== false,
    challenge_scope: ['active', 'passive', 'none', 'unknown'].includes(String(report.challenge_scope || '').toLowerCase())
      ? String(report.challenge_scope).toLowerCase()
      : 'unknown',
    high_risk_blockers: highRiskBlockers,
    submission_blockers: submissionBlockers,
    fields,
    candidate_values_recorded: false,
    final_submit_clicked: false,
    resume_upload_attempted: false
  };
}

export function recordApplicationReviewRescan(inputState, {
  jobId,
  sessionId = '',
  actor,
  report = {},
  now = new Date().toISOString()
}) {
  let state = copyState(inputState);
  const record = state.application_status_overrides[String(jobId)] || {};
  const selectedSessionId = sessionId || record.active_session_id || '';
  const session = state.application_execution_sessions[selectedSessionId];
  if (!session || String(session.job_id) !== String(jobId)) {
    const error = new Error('No active fill attempt was found.');
    error.code = 'APPLICATION_EXECUTION_SESSION_NOT_FOUND';
    throw error;
  }
  if (!['NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT'].includes(session.execution_status)) {
    const error = new Error('The fill attempt is not ready for a review re-scan. Complete safe fill before continuing.');
    error.code = 'APPLICATION_REVIEW_RESCAN_NOT_ALLOWED';
    throw error;
  }
  const safeReport = normalizeReviewRescan(report, now, {
    attemptId: currentReviewAttemptId(session),
    targetDigest: reviewScanTargetDigest(session)
  });
  const existing = (session.review_rescans || []).find(item => item.scan_id === safeReport.scan_id);
  if (existing) return { state, session, record, review_rescan: existing, idempotent_replay: true };
  const updatedSession = {
    ...session,
    latest_review_rescan: safeReport,
    review_rescans: [...(session.review_rescans || []), safeReport].slice(-25),
    updated_at: now
  };
  state.application_execution_sessions[selectedSessionId] = updatedSession;
  const transitioned = transitionApplicationState(state, {
    jobId,
    toStatus: 'NEEDS_REVIEW',
    actor,
    reason: 'application_form_review_rescanned',
    patch: {
      active_session_id: selectedSessionId,
      latest_review_rescan: safeReport,
      review_rescan_received_at: now
    },
    initialStatus: normalizeApplicationStatus(record.application_status || record.status || 'NEEDS_REVIEW'),
    idempotencyKey: safeReport.scan_id,
    sessionId: selectedSessionId,
    now
  });
  return { ...transitioned, session: updatedSession, review_rescan: safeReport };
}

// The single source of review blockers: both "Mark review complete" and the
// user-facing checklist projection derive from this exact function, so they
// can never disagree about what still blocks submission.
// True when any report on this fill attempt's session carried a VERIFIED
// resume upload. Used to satisfy the file-upload checklist item on portals
// whose uploader empties the <input> after taking the file.
export function sessionResumeUploadConfirmed(session = {}) {
  const reports = Array.isArray(session?.reports) ? session.reports : [];
  return reports.some(report => report.resume_upload_confirmed === true
    || report.application_execution?.safety?.resume_uploaded === true);
}

export function computeReviewBlockers(scan = {}, { resumeUploadConfirmed = false } = {}) {
  const blockers = [...(scan.high_risk_blockers || [])];
  if (Number(scan.required_empty_count || 0) > 0 && !blockers.some(item => item.code === 'REQUIRED_FIELDS_INCOMPLETE')) {
    blockers.push({ code: 'REQUIRED_FIELDS_INCOMPLETE', message: `${scan.required_empty_count} required field(s) are still empty.` });
  }
  if (Number(scan.unknown_required_count || 0) > 0 && !blockers.some(item => item.code === 'REQUIRED_FIELD_UNKNOWN')) {
    blockers.push({ code: 'REQUIRED_FIELD_UNKNOWN', message: `${scan.unknown_required_count} required field(s) still need a user decision.` });
  }
  // Some uploaders (Greenhouse) move the file out of the <input> once their
  // own upload takes over, so a verified automatic upload can look "empty" to
  // a re-scan. A confirmed upload from this fill attempt satisfies the
  // requirement; anything less keeps the manual-attach blocker.
  if (scan.file_upload_required && !scan.file_upload_present && !resumeUploadConfirmed
    && !blockers.some(item => item.code === 'FILE_UPLOAD_REQUIRED')) {
    blockers.push({ code: 'FILE_UPLOAD_REQUIRED', message: 'A required file upload is still empty. Upload the resume manually, then re-scan.' });
  }
  if (scan.form_accessible === false && !blockers.some(item => item.code === 'FORM_NOT_ACCESSIBLE')) {
    blockers.push({ code: 'FORM_NOT_ACCESSIBLE', message: 'The application form is not currently accessible.' });
  }
  if (scan.challenge_scope === 'active' && !blockers.some(item => item.code === 'ACTIVE_CHALLENGE')) {
    blockers.push({ code: 'ACTIVE_CHALLENGE', message: 'Complete the visible verification manually, then re-scan.' });
  }
  return blockers;
}

export function completeApplicationReview(inputState, {
  jobId,
  sessionId = '',
  actor,
  confirmed = false,
  now = new Date().toISOString()
}) {
  if (confirmed !== true) {
    const error = new Error('confirmed=true is required after reviewing the current form.');
    error.code = 'APPLICATION_REVIEW_CONFIRMATION_REQUIRED';
    throw error;
  }
  let state = copyState(inputState);
  const record = state.application_status_overrides[String(jobId)] || {};
  const selectedSessionId = sessionId || record.active_session_id || '';
  const session = state.application_execution_sessions[selectedSessionId];
  if (!session || String(session.job_id) !== String(jobId)) {
    const error = new Error('No active fill attempt was found.');
    error.code = 'APPLICATION_EXECUTION_SESSION_NOT_FOUND';
    throw error;
  }
  const scan = session.latest_review_rescan || record.latest_review_rescan;
  if (!scan) {
    const error = new Error('Re-scan the current application form before completing review.');
    error.code = 'APPLICATION_REVIEW_RESCAN_REQUIRED';
    throw error;
  }
  const freshness = reviewScanFreshness(scan, session, { now });
  if (!freshness.fresh) {
    const error = new Error('The last review scan no longer matches the current fill attempt. Re-scan the application form before completing review.');
    error.code = 'APPLICATION_REVIEW_RESCAN_STALE';
    error.reason = freshness.reason;
    throw error;
  }
  const blockers = computeReviewBlockers(scan, { resumeUploadConfirmed: sessionResumeUploadConfirmed(session) });
  if (blockers.length) {
    const error = new Error(blockers[0].message || 'Application review still has high-risk blockers.');
    error.code = 'APPLICATION_REVIEW_BLOCKED';
    error.blockers = blockers;
    throw error;
  }
  const readySession = transitionApplicationExecutionSession(session, 'READY_FOR_MANUAL_SUBMIT', {
    now,
    details: { scan_id: scan.scan_id, confirmed_by: actor }
  });
  state.application_execution_sessions[selectedSessionId] = readySession;
  const transitioned = transitionApplicationState(state, {
    jobId,
    toStatus: 'READY_FOR_MANUAL_SUBMIT',
    actor,
    reason: 'user_completed_application_review',
    patch: {
      active_session_id: selectedSessionId,
      review_completed_at: now,
      review_completed_by: actor,
      latest_review_rescan: scan,
      final_submit_allowed: false
    },
    initialStatus: 'NEEDS_REVIEW',
    idempotencyKey: `review-complete:${selectedSessionId}:${scan.scan_id}`,
    sessionId: selectedSessionId,
    now
  });
  return { ...transitioned, session: readySession, review_rescan: scan };
}
