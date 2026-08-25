export const APPROVAL_SAFETY_STATUSES = Object.freeze([
  'safe_to_approve',
  'needs_review',
  'review_only',
  'reject_candidate'
]);

const APPROVAL_SAFETY_STATUS_SET = new Set(APPROVAL_SAFETY_STATUSES);

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function statusDescription(status) {
  const text = String(status);
  return `status "${text.length > 80 ? `${text.slice(0, 77)}...` : text}"`;
}

export class ApprovalSafetyValidationError extends TypeError {
  constructor(field, expected, actual) {
    super(`${field}: expected ${expected}; received ${actual}`);
    this.name = 'ApprovalSafetyValidationError';
    this.code = 'INVALID_APPROVAL_SAFETY';
    this.field = field;
    this.expected = expected;
    this.actual = actual;
  }
}

function invalid(field, expected, actual) {
  throw new ApprovalSafetyValidationError(field, expected, actual);
}

function validateStatus(status, field) {
  if (typeof status !== 'string') {
    invalid(field, `one of ${APPROVAL_SAFETY_STATUSES.join(', ')}`, valueType(status));
  }
  if (!APPROVAL_SAFETY_STATUS_SET.has(status)) {
    invalid(field, `one of ${APPROVAL_SAFETY_STATUSES.join(', ')}`, statusDescription(status));
  }
  return status;
}

function validateReasons(reasons, field) {
  if (!Array.isArray(reasons)) invalid(field, 'an array of non-empty strings', valueType(reasons));
  return reasons.map((reason, index) => {
    if (typeof reason !== 'string') {
      invalid(`${field}[${index}]`, 'a non-empty string', valueType(reason));
    }
    if (!reason.trim()) {
      invalid(`${field}[${index}]`, 'a non-empty string', 'empty string');
    }
    return reason;
  });
}

export function normalizeApprovalSafety(value, options = {}) {
  const field = options.field || 'approval_safety';
  const allowLegacyString = options.allowLegacyString !== false;

  if (typeof value === 'string') {
    if (!allowLegacyString) invalid(field, 'a canonical approval_safety object', 'string');
    const status = validateStatus(value, field);
    return {
      status,
      safe_to_approve: status === 'safe_to_approve',
      reasons: []
    };
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(field, 'a canonical approval_safety object or known legacy status string', valueType(value));
  }

  for (const requiredField of ['status', 'safe_to_approve', 'reasons']) {
    if (!Object.prototype.hasOwnProperty.call(value, requiredField)) {
      invalid(`${field}.${requiredField}`, 'a required field', 'missing');
    }
  }

  const status = validateStatus(value.status, `${field}.status`);
  if (typeof value.safe_to_approve !== 'boolean') {
    invalid(`${field}.safe_to_approve`, 'boolean', valueType(value.safe_to_approve));
  }
  const expectedSafe = status === 'safe_to_approve';
  if (value.safe_to_approve !== expectedSafe) {
    invalid(
      `${field}.safe_to_approve`,
      `${expectedSafe} when status is "${status}"`,
      String(value.safe_to_approve)
    );
  }

  const reasons = validateReasons(value.reasons, `${field}.reasons`);
  return {
    ...value,
    status,
    safe_to_approve: expectedSafe,
    reasons: [...reasons]
  };
}

export function createApprovalSafety(status, safeToApprove, reasons = [], extra = {}) {
  return normalizeApprovalSafety({
    ...extra,
    status,
    safe_to_approve: safeToApprove,
    reasons
  }, {
    field: 'approval_safety',
    allowLegacyString: false
  });
}

export function evaluateApprovalEligibility(job, options = {}) {
  const field = options.field || 'job.approval_safety';
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    invalid('job', 'an object containing approval_safety', valueType(job));
  }
  if (!Object.prototype.hasOwnProperty.call(job, 'approval_safety')) {
    invalid(field, 'a canonical approval_safety object or known legacy status string', 'missing');
  }

  const approvalSafety = normalizeApprovalSafety(job.approval_safety, { field });
  return {
    approval_safety: approvalSafety,
    safe_to_approve: (
      job.page_type === 'job_detail' &&
      approvalSafety.status === 'safe_to_approve' &&
      approvalSafety.safe_to_approve === true &&
      job.recommended_decision === 'approve'
    )
  };
}

const HARD_APPLICATION_BLOCKERS = new Set([
  'approval_safety_invalid',
  'excluded_company_match',
  'excluded_keyword_match',
  'job_board_or_directory',
  'settings_safety_disables_auto_approval',
  'submit_allowed_not_false',
  'upload_resume_allowed_not_false',
  'final_submit_allowed_not_false',
  'weak_direct_posting_evidence'
]);

export function evaluateApplicationDecision(job, options = {}) {
  const field = options.field || 'job.approval_safety';
  const blockers = [];
  const warnings = [];
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return {
      allowed: false,
      safe_to_approve: false,
      blockers: ['job_record_invalid'],
      warnings,
      approval_safety: null,
      approval_safety_error: approvalSafetyErrorDetails(new Error('job_record_invalid'))
    };
  }

  let approvalSafety = null;
  let approvalSafetyError = null;
  try {
    approvalSafety = normalizeApprovalSafety(job.approval_safety, { field });
  } catch (error) {
    approvalSafetyError = approvalSafetyErrorDetails(error);
    blockers.push('approval_safety_invalid');
  }

  if (job.page_type !== 'job_detail') blockers.push(`page_type_${job.page_type || 'unknown'}_not_approvable`);
  if (job.job_board_or_directory_evidence === true) blockers.push('job_board_or_directory');
  if (job.direct_posting_evidence === false) blockers.push('weak_direct_posting_evidence');
  if (job.application_mode !== 'REVIEW_ONLY') blockers.push('application_mode_not_review_only');
  if (job.submit_allowed !== false) blockers.push('submit_allowed_not_false');
  if (job.upload_resume_allowed !== false) blockers.push('upload_resume_allowed_not_false');
  if (job.final_submit_allowed !== false) blockers.push('final_submit_allowed_not_false');

  const reasons = [
    ...(approvalSafety?.reasons || []),
    ...(Array.isArray(job.hard_filter?.reasons) ? job.hard_filter.reasons : [])
  ];
  for (const reason of reasons) {
    if (HARD_APPLICATION_BLOCKERS.has(reason)) blockers.push(reason);
    else warnings.push(reason);
  }
  for (const uncertainty of job.hard_filter?.uncertainty || []) warnings.push(uncertainty);
  if (job.recommended_decision && job.recommended_decision !== 'approve') warnings.push(`recommendation_${job.recommended_decision}`);
  if (job.title_role_mismatch === true || reasons.includes('target_role_not_matched_in_title')) {
    warnings.push('role_title_differs_continue_after_review');
  }

  const uniqueBlockers = [...new Set(blockers.filter(Boolean))];
  const uniqueWarnings = [...new Set(warnings.filter(reason => reason && !uniqueBlockers.includes(reason)))];
  return {
    allowed: uniqueBlockers.length === 0,
    safe_to_approve: uniqueBlockers.length === 0,
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    approval_safety: approvalSafety,
    approval_safety_error: approvalSafetyError,
    warning_only: uniqueBlockers.length === 0 && uniqueWarnings.length > 0
  };
}

export function downgradeApprovalSafety(value, reason, options = {}) {
  if (typeof reason !== 'string' || !reason.trim()) {
    invalid('approval_safety downgrade reason', 'a non-empty string', valueType(reason));
  }
  const current = normalizeApprovalSafety(value, {
    field: options.field || 'approval_safety'
  });
  const status = options.status || 'needs_review';
  const reasons = current.reasons.includes(reason)
    ? current.reasons
    : [...current.reasons, reason];
  return createApprovalSafety(status, false, reasons, current);
}

export function approvalSafetyErrorDetails(error) {
  if (!(error instanceof ApprovalSafetyValidationError)) {
    return {
      code: 'INVALID_APPROVAL_SAFETY',
      field: 'approval_safety',
      expected: 'a valid approval_safety value',
      actual: 'unknown',
      message: 'approval_safety validation failed'
    };
  }
  return {
    code: error.code,
    field: error.field,
    expected: error.expected,
    actual: error.actual,
    message: error.message
  };
}
