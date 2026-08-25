import { createHash } from 'node:crypto';
import './shared_core.js';
import { normalizeExecutorMode } from './executor_interface.mjs';

const core = globalThis.ResumeJobsApplicationExecutorCore;
if (!core) throw new Error('Application Executor shared core failed to load.');

export const APPLICATION_EXECUTION_SESSION_SCHEMA = 'ApplicationExecutionSession';
export const APPLICATION_EXECUTION_SESSION_VERSION = '1.1';
export const APPLICATION_EXECUTION_SESSION_STATUSES = Object.freeze([
  'SESSION_CREATED',
  'EXECUTOR_READY',
  'EXTENSION_CONNECTED',
  'FIELDS_DETECTED',
  'FILLING',
  'NEEDS_REVIEW',
  'READY_FOR_MANUAL_SUBMIT',
  'CANCELLED',
  'COMPLETE',
  'FAILED'
]);

const SESSION_STATUS_SET = new Set(APPLICATION_EXECUTION_SESSION_STATUSES);
export const EXECUTOR_FIELD_KEYS = Object.freeze([
  'full_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'location',
  'linkedin_url',
  'github_url',
  'portfolio_url',
  // Ordinary, non-sensitive employment facts that live ATS forms ask for and
  // the online profile already holds. Adding them here is what lets the
  // approved-mapping builder carry them to the page at all.
  'current_company',
  'current_title',
  // Non-sensitive profile facts the ApplicationProfile projection derives
  // (education, preferred name, split city/country, experience span).
  // Sensitive topics (work authorization, sponsorship, salary, EEO…) are
  // deliberately NOT here: they are ask-every-time and never auto-filled.
  'preferred_name',
  'city',
  'country',
  'school',
  'degree',
  'major',
  'graduation_date',
  'years_experience'
]);

function text(value) {
  return String(value ?? '').trim();
}

function stableSessionId({ applicationId, jobId, packageId, idempotencyKey }) {
  const digest = createHash('sha256')
    .update([applicationId, jobId, packageId, idempotencyKey].map(text).join('\u001f'))
    .digest('hex')
    .slice(0, 20);
  return `execution_session_${digest}`;
}

function packageIdentity({ applicationPackage = {}, manifest = {}, job = {} }) {
  return {
    application_id: text(applicationPackage.application_id || manifest.application_id),
    job_id: text(applicationPackage.job_id || manifest.job_id || job.job_id),
    package_id: text(applicationPackage.package_id || manifest.package_id),
  };
}

export function approvedProfileVersionFromPackage(applicationPackage = {}) {
  const direct = applicationPackage.career_profile_reference;
  const embedded = applicationPackage.application_profile?.profile_meta?.career_profile_reference;
  const source = direct && typeof direct === 'object' ? direct : embedded && typeof embedded === 'object' ? embedded : {};
  const approved = source.user_approved === true
    || (Boolean(text(source.approved_at)) && applicationPackage.application_profile?.approved_for_real_applications === true);
  const version = Number.parseInt(source.version, 10);
  if (!approved || !text(source.profile_id) || !Number.isFinite(version) || version < 1 || !text(source.approved_at)) {
    const error = new Error('Application Package is not bound to an approved Career Profile version. Rebuild the package after approving the active profile.');
    error.code = 'APPROVED_PROFILE_VERSION_MISSING';
    throw error;
  }
  return {
    profile_id: text(source.profile_id),
    family_id: text(source.family_id),
    version,
    approved_at: text(source.approved_at),
    snapshot_digest: text(applicationPackage.application_profile?.profile_meta?.candidate_fact_review?.snapshot_digest),
  };
}

function normalizeExecutionStatus(source = {}) {
  const candidate = text(source.execution_status || source.status);
  if (SESSION_STATUS_SET.has(candidate)) return candidate;
  const legacy = {
    CONNECTING: 'EXECUTOR_READY',
    READY: 'EXTENSION_CONNECTED',
    FILL_STARTED: 'EXECUTOR_READY',
    NEEDS_USER_INPUT: 'NEEDS_REVIEW',
    READY_FOR_MANUAL_SUBMIT: 'READY_FOR_MANUAL_SUBMIT',
  };
  return legacy[candidate] || (candidate === 'FAILED' ? 'FAILED' : 'SESSION_CREATED');
}

function normalizeExecutionEvents(source = {}, executionStatus, now = '') {
  const events = Array.isArray(source.execution_events)
    ? source.execution_events.filter(event => event && typeof event === 'object').map(event => structuredClone(event))
    : [];
  if (!events.length && executionStatus) {
    events.push({ status: executionStatus, at: text(source.updated_at || source.created_at || now) || null });
  }
  return events;
}

export function transitionApplicationExecutionSession(input = {}, executionStatus, {
  now = new Date().toISOString(),
  details = {}
} = {}) {
  if (!SESSION_STATUS_SET.has(executionStatus)) {
    const error = new Error('The saved fill status is not recognized. Recover the fill setup before continuing.');
    error.code = 'INVALID_APPLICATION_EXECUTION_STATUS';
    throw error;
  }
  const session = normalizeApplicationExecutionSession(input);
  if (session.execution_status === executionStatus) return session;
  return {
    ...session,
    execution_status: executionStatus,
    execution_events: [...session.execution_events, {
      status: executionStatus,
      at: now,
      ...(details && typeof details === 'object' && !Array.isArray(details) ? structuredClone(details) : {})
    }].slice(-50),
    updated_at: now,
  };
}

export function buildApprovedFieldMappings(applicationPackage = {}) {
  if (applicationPackage.status !== 'PACKAGE_READY') {
    const error = new Error('Application Package must be PACKAGE_READY before execution.');
    error.code = 'APPLICATION_PACKAGE_NOT_READY';
    throw error;
  }
  const profile = applicationPackage.application_profile;
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
    const error = new Error('Application Package has no reviewed application profile.');
    error.code = 'APPLICATION_PACKAGE_PROFILE_MISSING';
    throw error;
  }
  const mappings = [];
  for (const canonicalKey of EXECUTOR_FIELD_KEYS) {
    const resolved = core.profileValue(profile, canonicalKey);
    const value = text(resolved?.value);
    if (!value || resolved?.user_confirmed === false) continue;
    mappings.push({
      canonical_key: canonicalKey,
      value,
      source: text(resolved?.source || 'application_package.application_profile'),
      confidence: Math.max(0, Math.min(1, Number(resolved?.confidence || 0.95))),
      user_confirmed: true,
      last_used: resolved?.last_used || null,
    });
  }
  const sensitiveReuseCategories = Array.isArray(applicationPackage.sensitive_reuse_categories)
    ? applicationPackage.sensitive_reuse_categories
    : [];
  for (const answer of Array.isArray(applicationPackage.application_answers) ? applicationPackage.application_answers : []) {
    const canonicalKey = text(answer?.canonical_key);
    const value = text(answer?.value);
    if (!canonicalKey || !value || answer?.user_confirmed !== true) continue;
    const isSensitiveAnswer = text(answer?.sensitive_category).toLowerCase() !== 'none'
      || text(answer?.risk_level).toLowerCase() === 'high';
    if (isSensitiveAnswer) {
      // A confirmed sensitive answer travels ONLY when the user's per-category
      // policy at package-build time was 'reuse' for its category. The field
      // classifier re-checks the same policy before any fill.
      const category = core.sensitiveQuestionCategory(
        `${text(answer?.original_question)} ${text(answer?.normalized_question)}`
      );
      if (!category || !sensitiveReuseCategories.includes(category)) continue;
    }
    if (mappings.some(mapping => mapping.canonical_key === canonicalKey)) continue;
    mappings.push({
      canonical_key: canonicalKey,
      value,
      source: text(answer?.source || 'answer_memory'),
      confidence: Math.max(0, Math.min(1, Number(answer?.confidence || 1))),
      user_confirmed: true,
      last_used: answer?.last_used || null,
      question_id: text(answer?.question_id),
      aliases: [
        answer?.original_question,
        ...(Array.isArray(answer?.question_patterns) ? answer.question_patterns : []),
        // Every wording this answer has been confirmed under, from any site.
        ...(Array.isArray(answer?.question_variants) ? answer.question_variants : [])
      ].map(text).filter(Boolean).slice(0, 25)
    });
  }
  return mappings;
}

export function approvedFieldProfile(session = {}) {
  return Object.fromEntries((Array.isArray(session.approved_field_mappings) ? session.approved_field_mappings : [])
    .filter(mapping => mapping?.user_confirmed === true && text(mapping?.canonical_key) && text(mapping?.value))
    .map(mapping => [mapping.canonical_key, {
      value: mapping.value,
      source: mapping.source || 'application_execution_session',
      confidence: Number(mapping.confidence || 0),
      user_confirmed: true,
      last_used: mapping.last_used || null,
    }]));
}

export function normalizeApplicationExecutionSession(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const executionStatus = normalizeExecutionStatus(source);
  const executorType = normalizeExecutorMode(source.executor_type || source.executor);
  const sessionId = text(source.session_id || source.run_id);
  const normalized = {
    ...structuredClone(source),
    schema: APPLICATION_EXECUTION_SESSION_SCHEMA,
    schema_version: APPLICATION_EXECUTION_SESSION_VERSION,
    session_id: sessionId,
    application_id: text(source.application_id),
    job_id: text(source.job_id),
    package_id: text(source.package_id),
    executor_type: executorType,
    target_url: text(source.target_url || source.url),
    approved_profile_version: source.approved_profile_version && typeof source.approved_profile_version === 'object'
      ? {
          profile_id: text(source.approved_profile_version.profile_id),
          family_id: text(source.approved_profile_version.family_id),
          version: Number.parseInt(source.approved_profile_version.version, 10) || 0,
          approved_at: text(source.approved_profile_version.approved_at),
          snapshot_digest: text(source.approved_profile_version.snapshot_digest),
        }
      : null,
    execution_status: executionStatus,
    execution_events: normalizeExecutionEvents(source, executionStatus),
    approved_field_mappings: Array.isArray(source.approved_field_mappings)
      ? structuredClone(source.approved_field_mappings)
      : [],
    active_attempt_id: text(source.active_attempt_id),
    execution_attempts: Array.isArray(source.execution_attempts)
      ? source.execution_attempts.filter(attempt => attempt && typeof attempt === 'object').map(attempt => ({
          attempt_id: text(attempt.attempt_id),
          started_at: text(attempt.started_at) || null,
          completed_at: text(attempt.completed_at) || null,
          executor_type: normalizeExecutorMode(attempt.executor_type || source.executor_type),
          detected_count: Number(attempt.detected_count || 0),
          filled_count: Number(attempt.filled_count || 0),
          skipped_count: Number(attempt.skipped_count || 0),
          failed_count: Number(attempt.failed_count || 0),
          challenge_scope: ['active', 'passive', 'none', 'unknown'].includes(text(attempt.challenge_scope).toLowerCase())
            ? text(attempt.challenge_scope).toLowerCase()
            : 'unknown',
          outcome: text(attempt.outcome || 'in_progress'),
          report_id: text(attempt.report_id),
        })).filter(attempt => attempt.attempt_id)
      : [],
    safety: {
      resume_upload_allowed: false,
      sensitive_answers_allowed: false,
      login_allowed: false,
      challenge_bypass_allowed: false,
      final_submit_allowed: false,
      ...(source.safety && typeof source.safety === 'object' ? structuredClone(source.safety) : {})
    },
  };
  delete normalized.status;
  delete normalized.run_id;
  delete normalized.executor;
  delete normalized.url;
  return normalized;
}

export function assertApplicationExecutionSession(input = {}) {
  const session = normalizeApplicationExecutionSession(input);
  const missing = ['session_id', 'application_id', 'job_id', 'package_id', 'target_url']
    .filter(key => !text(session[key]));
  if (missing.length) {
    const error = new Error('The saved fill setup is incomplete. Recover and rebuild it before continuing.');
    error.code = 'INVALID_APPLICATION_EXECUTION_SESSION';
    throw error;
  }
  let url;
  try { url = new URL(session.target_url); }
  catch {
    const error = new Error('The saved application page is invalid. Correct the job URL or recover the fill setup.');
    error.code = 'INVALID_APPLICATION_EXECUTION_SESSION';
    throw error;
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    const error = new Error('The application page must use a normal HTTP(S) web address.');
    error.code = 'INVALID_APPLICATION_EXECUTION_SESSION';
    throw error;
  }
  if (!session.approved_field_mappings.length) {
    const error = new Error('No approved safe fields are available for this fill attempt.');
    error.code = 'APPROVED_FIELD_MAPPINGS_MISSING';
    throw error;
  }
  const profileVersion = session.approved_profile_version;
  if (!profileVersion?.profile_id || !profileVersion?.approved_at || Number(profileVersion?.version || 0) < 1) {
    const error = new Error('This fill attempt has no approved Career Profile version.');
    error.code = 'APPROVED_PROFILE_VERSION_MISSING';
    throw error;
  }
  // Never negotiable: the product does not log in, does not touch challenges,
  // does not answer sensitive questions, does not press Submit.
  const prohibitedSafetyFlags = [
    'sensitive_answers_allowed',
    'login_allowed',
    'challenge_bypass_allowed',
    'final_submit_allowed'
  ];
  if (prohibitedSafetyFlags.some(key => session.safety[key] === true)) {
    const error = new Error('This fill attempt is blocked by the safety policy.');
    error.code = 'UNSAFE_APPLICATION_EXECUTION_SESSION';
    throw error;
  }
  // Resume upload is different: the user may authorize it — but only with an
  // explicit per-job authorization whose job matches THIS session. A bare
  // resume_upload_allowed:true with no matching authorization is still unsafe:
  // that shape is exactly what a bug cross-wiring two jobs would produce.
  if (session.safety.resume_upload_allowed === true) {
    const authorization = session.resume_upload_authorization;
    if (!authorization || String(authorization.job_id) !== String(session.job_id) || !text(authorization.sha256)) {
      const error = new Error('Resume upload is enabled without a matching per-job authorization.');
      error.code = 'UNSAFE_APPLICATION_EXECUTION_SESSION';
      throw error;
    }
  }
  return { ...session, target_url: url.href };
}

export function createApplicationExecutionSession({
  applicationPackage,
  manifest = {},
  job = {},
  executorType = 'local_browser_agent',
  targetUrl,
  idempotencyKey,
  resumeUpload = null,
  now = new Date().toISOString()
} = {}) {
  if (!text(idempotencyKey)) {
    const error = new Error('idempotencyKey is required');
    error.code = 'IDEMPOTENCY_KEY_REQUIRED';
    throw error;
  }
  const identity = packageIdentity({ applicationPackage, manifest, job });
  const approvedFieldMappings = buildApprovedFieldMappings(applicationPackage);
  const approvedProfileVersion = approvedProfileVersionFromPackage(applicationPackage);
  const session = {
    schema: APPLICATION_EXECUTION_SESSION_SCHEMA,
    schema_version: APPLICATION_EXECUTION_SESSION_VERSION,
    session_id: stableSessionId({
      applicationId: identity.application_id,
      jobId: identity.job_id,
      packageId: identity.package_id,
      idempotencyKey,
    }),
    ...identity,
    executor_type: normalizeExecutorMode(executorType),
    target_url: text(targetUrl),
    approved_profile_version: approvedProfileVersion,
    execution_status: 'SESSION_CREATED',
    execution_events: [{ status: 'SESSION_CREATED', at: now }],
    approved_field_mappings: approvedFieldMappings,
    // The user's per-category sensitive reuse policy, frozen at session
    // creation with the package it was built from.
    sensitive_reuse_categories: Array.isArray(applicationPackage.sensitive_reuse_categories)
      ? [...applicationPackage.sensitive_reuse_categories]
      : [],
    display: {
      company: text(job.company || applicationPackage?.job_information?.company),
      role: text(job.title || applicationPackage?.job_information?.title),
    },
    safety: {
      resume_upload_allowed: false,
      sensitive_answers_allowed: false,
      login_allowed: false,
      challenge_bypass_allowed: false,
      final_submit_allowed: false,
    },
    idempotency_key: text(idempotencyKey),
    idempotency_keys: [text(idempotencyKey)],
    created_at: now,
    updated_at: now,
    recovery_count: 0,
    reports: [],
    active_attempt_id: '',
    execution_attempts: [],
  };
  // Resume upload needs an explicit per-job authorization created by the
  // Dashboard against the current tailored file. The authorization is only
  // accepted when its job matches the job this session was built for — it is
  // never inferred, never carried over from another session.
  if (resumeUpload && resumeUpload.authorized === true) {
    const authorizedJobId = text(resumeUpload.job_id);
    if (authorizedJobId && authorizedJobId === text(identity.job_id) && text(resumeUpload.sha256)) {
      session.safety.resume_upload_allowed = true;
      session.resume_upload_authorization = {
        job_id: authorizedJobId,
        draft_id: text(resumeUpload.draft_id),
        profile_id: text(resumeUpload.profile_id),
        profile_version: Number(resumeUpload.profile_version || 0),
        sha256: text(resumeUpload.sha256),
        file_name: text(resumeUpload.file_name),
        format_preference: ['auto', 'pdf', 'docx'].includes(text(resumeUpload.format_preference))
          ? text(resumeUpload.format_preference)
          : 'auto',
        authorized_at: now,
      };
    }
  }
  return assertApplicationExecutionSession(session);
}
