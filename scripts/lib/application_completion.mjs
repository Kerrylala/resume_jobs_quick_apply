import { PORTAL_ADAPTERS, resolvePortalAdapter } from './portal_adapters.mjs';
import {
  buildResumeIntelligence,
  resolveCandidateFact
} from './resume_intelligence.mjs';

const CONFIDENCE_LEVELS = Object.freeze({
  high: 0.95,
  medium: 0.7,
  low: 0.4,
  none: 0
});

const SENSITIVE_KEYS = new Set([
  'salary_expectation',
  'work_authorization',
  'visa_status',
  'sponsorship',
  'sponsorship_required',
  'date_of_birth',
  'nationality',
  'passport_number',
  'id_number',
  'gender',
  'race_ethnicity',
  'disability_status',
  'veteran_status',
  'eeo_gender',
  'eeo_race_ethnicity',
  'eeo_lgbtq',
  'eeo_non_binary_transgender',
  'eeo_pronouns',
  'eeo_disability',
  'eeo_veteran'
]);

const MANUAL_ONLY_KEYS = new Set(['resume_file', 'cover_letter_file']);

export const PORTAL_COMPLETION_PROFILES = Object.freeze(Object.fromEntries(
  Object.entries(PORTAL_ADAPTERS).map(([key, value]) => [key, Object.freeze({
    portal: value.portal,
    adapter_status: value.adapter_status,
    fields: value.expected_fields
  })])
));

function text(value) {
  return String(value ?? '').trim();
}

function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

export function numericConfidence(value) {
  if (typeof value === 'string' && Object.hasOwn(CONFIDENCE_LEVELS, value.toLowerCase())) {
    return CONFIDENCE_LEVELS[value.toLowerCase()];
  }
  return clamp(value);
}

function fieldMemoryRecord(fieldMemory, portal, key) {
  const records = Array.isArray(fieldMemory?.records) ? fieldMemory.records : [];
  return records
    .filter(record =>
      text(record?.portal).toLowerCase() === portal
      && text(record?.canonical_key) === key
      && record?.status !== 'rejected'
    )
    .sort((a, b) => {
      if (a.user_confirmed !== b.user_confirmed) return a.user_confirmed ? -1 : 1;
      return numericConfidence(b.confidence) - numericConfidence(a.confidence);
    })[0] || null;
}

function answerForKey(plannedAnswers, key) {
  return (Array.isArray(plannedAnswers) ? plannedAnswers : [])
    .filter(answer => text(answer?.canonical_key || answer?.profile_key || answer?.question_id) === key)
    .sort((a, b) => Number(b.version || 0) - Number(a.version || 0))[0] || null;
}

function resolveFieldValue({ key, applicationProfile, selectedResume, plannedAnswers, resumeIntelligence }) {
  if (key === 'resume_file') {
    const resumeReference = text(selectedResume?.file_reference || selectedResume?.resume_file_path);
    if (!resumeReference) {
      return {
        value: '',
        source: 'missing',
        confidence: 0,
        user_confirmed: false,
        last_used: null
      };
    }
    return {
      value: resumeReference,
      source: 'resume_library',
      confidence: selectedResume?.content_hash ? 1 : 0.75,
      user_confirmed: Boolean(selectedResume?.approved_at),
      last_used: selectedResume?.last_used || null
    };
  }
  const answer = answerForKey(plannedAnswers, key);
  if (answer) {
    return {
      value: text(answer.value ?? answer.answer),
      source: text(answer.source) || 'answer_memory',
      confidence: numericConfidence(answer.confidence),
      user_confirmed: answer.user_confirmed === true,
      last_used: answer.last_used || null
    };
  }
  const fact = resolveCandidateFact(resumeIntelligence, key);
  if (fact && text(fact.value)) {
    return {
      value: fact.value,
      source: fact.source,
      confidence: numericConfidence(fact.confidence),
      user_confirmed: fact.user_confirmed === true,
      last_used: fact.last_used || null
    };
  }
  return {
    value: '',
    source: 'missing',
    confidence: 0,
    user_confirmed: false,
    last_used: null
  };
}

function fieldStatus({ key, valueRecord, mappingConfidence }) {
  if (!text(valueRecord.value)) return { status: 'missing_value', reason: 'candidate_fact_or_answer_missing' };
  if (MANUAL_ONLY_KEYS.has(key)) return { status: 'manual_required', reason: 'file_upload_requires_user_action' };
  if (SENSITIVE_KEYS.has(key)) return { status: 'user_confirmation_required', reason: 'sensitive_or_high_risk_field' };
  if (mappingConfidence < 0.8) return { status: 'mapping_review_required', reason: 'field_mapping_confidence_below_threshold' };
  if (!valueRecord.user_confirmed) return { status: 'user_confirmation_required', reason: 'value_not_user_confirmed' };
  if (valueRecord.confidence < 0.8) return { status: 'user_confirmation_required', reason: 'value_confidence_below_threshold' };
  return { status: 'auto_fill_ready', reason: '' };
}

export function buildApplicationCompletionPlan({
  job = {},
  applicationProfile = {},
  selectedResume = null,
  plannedAnswers = [],
  fieldMemory = { records: [] },
  resumeIntelligence = null,
  now = new Date().toISOString()
} = {}) {
  const resolvedPortal = resolvePortalAdapter(job);
  const portal = resolvedPortal.portal;
  const adapterDefinition = resolvedPortal.adapter;
  const adapter = PORTAL_COMPLETION_PROFILES[portal] || PORTAL_COMPLETION_PROFILES.unknown;
  const candidateIntelligence = resumeIntelligence || buildResumeIntelligence({
    profile: applicationProfile,
    selectedResume,
    now
  });
  const fields = adapter.fields.map(field => {
    const memory = fieldMemoryRecord(fieldMemory, portal, field.key);
    const mappingConfidence = memory
      ? numericConfidence(memory.confidence)
      : (portal === 'unknown' ? 0.65 : 0.9);
    const valueRecord = resolveFieldValue({
      key: field.key,
      applicationProfile,
      selectedResume,
      plannedAnswers,
      resumeIntelligence: candidateIntelligence
    });
    const status = fieldStatus({ key: field.key, valueRecord, mappingConfidence });
    return {
      field_key: field.key,
      required: field.required === true,
      value: valueRecord.value,
      source: valueRecord.source,
      confidence: Number(valueRecord.confidence.toFixed(3)),
      mapping_confidence: Number(mappingConfidence.toFixed(3)),
      user_confirmed: valueRecord.user_confirmed,
      last_used: valueRecord.last_used,
      risk: SENSITIVE_KEYS.has(field.key) ? 'sensitive' : (MANUAL_ONLY_KEYS.has(field.key) ? 'manual_file' : 'normal'),
      status: status.status,
      blocked_reason: status.reason,
      memory_source: memory ? 'form_field_memory' : 'portal_baseline'
    };
  });

  const autoReady = fields.filter(field => field.status === 'auto_fill_ready').length;
  const confirmationReady = fields.filter(field => field.status === 'user_confirmation_required').length;
  const manualRequired = fields.filter(field => field.status === 'manual_required').length;
  const missing = fields.filter(field => field.status === 'missing_value').length;
  const mappingReview = fields.filter(field => field.status === 'mapping_review_required').length;
  const total = fields.length;
  const applicationCompletionRate = total ? Math.round((autoReady / total) * 100) : 0;
  const potentialCompletionRate = total
    ? Math.round(((autoReady + confirmationReady + manualRequired) / total) * 100)
    : 0;
  const confidenceValues = fields
    .filter(field => text(field.value))
    .map(field => Math.min(field.confidence, field.mapping_confidence));
  const averageConfidence = confidenceValues.length
    ? confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length
    : 0;
  const blockers = fields
    .filter(field => field.status !== 'auto_fill_ready')
    .map(field => ({
      field_key: field.field_key,
      status: field.status,
      reason: field.blocked_reason,
      risk: field.risk,
      required: field.required
    }));

  return {
    schema_version: '1.0',
    metric: 'application_completion_rate',
    phase: 'estimated',
    generated_at: now,
    portal,
    portal_adapter_status: adapter.adapter_status,
    portal_detection_confidence: Number(Number(resolvedPortal.detection.confidence || 0).toFixed(3)),
    portal_capabilities: adapterDefinition.capabilities,
    resume_intelligence_summary: candidateIntelligence.summary,
    application_completion_rate: applicationCompletionRate,
    potential_completion_rate: potentialCompletionRate,
    average_confidence: Number(averageConfidence.toFixed(3)),
    total_expected_fields: total,
    auto_fill_ready_count: autoReady,
    user_confirmation_required_count: confirmationReady,
    manual_required_count: manualRequired,
    missing_value_count: missing,
    mapping_review_required_count: mappingReview,
    estimated_user_review_seconds: Math.max(30, (confirmationReady * 12) + (manualRequired * 20) + (missing * 45) + (mappingReview * 30)),
    ready_for_30_second_review: applicationCompletionRate >= 90 && blockers.length <= 1,
    blockers,
    fields
  };
}

export function calculateObservedCompletion(report = {}, { now = new Date().toISOString() } = {}) {
  const filled = Math.max(0, Number(report.filled_fields_count || 0));
  const skipped = Math.max(0, Number(report.skipped_fields_count || 0));
  const total = Math.max(filled + skipped, Number(report.total_fields_seen || 0));
  const hardBlocked = Math.min(total, Math.max(0, Number(report.hard_blocked_fields_count || 0)));
  const measurable = Math.max(0, total - hardBlocked);
  const completionRate = measurable ? Math.round((Math.min(filled, measurable) / measurable) * 100) : 0;
  const reviewCount = Math.max(0, Number(report.fields_requiring_user_review_count || 0));
  const unknownCount = Math.max(0, Number(report.suggested_questions_count || 0));
  return {
    schema_version: '1.0',
    metric: 'application_completion_rate',
    phase: 'observed',
    calculated_at: now,
    application_completion_rate: completionRate,
    total_fields_seen: total,
    measurable_fields_count: measurable,
    automated_fields_count: Math.min(filled, measurable),
    hard_blocked_fields_count: hardBlocked,
    user_review_fields_count: reviewCount,
    unknown_fields_count: unknownCount,
    ready_for_30_second_review: completionRate >= 90 && reviewCount + unknownCount <= 1
  };
}

function sortedCounts(map, keyName, limit = 5) {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, limit);
}

export function aggregateCompletionInsights(records = []) {
  const usableRecords = (Array.isArray(records) ? records : []).filter(record =>
    record && typeof record === 'object'
  );
  const blockerCounts = new Map();
  const missingFactCounts = new Map();
  const statusCounts = {
    missing_value: 0,
    mapping_review_required: 0,
    user_confirmation_required: 0,
    manual_required: 0,
    unknown_question: 0
  };

  for (const record of usableRecords) {
    for (const blocker of Array.isArray(record.blockers) ? record.blockers : []) {
      const fieldKey = text(blocker?.field_key) || 'unknown_field';
      const status = text(blocker?.status) || 'user_confirmation_required';
      const countKey = `${fieldKey}\u0000${status}`;
      blockerCounts.set(countKey, (blockerCounts.get(countKey) || 0) + 1);
      if (Object.hasOwn(statusCounts, status)) statusCounts[status] += 1;
    }
    for (const factKey of Array.isArray(record.resume_intelligence_summary?.missing_core_fact_keys)
      ? record.resume_intelligence_summary.missing_core_fact_keys
      : []) {
      const normalized = text(factKey);
      if (normalized) missingFactCounts.set(normalized, (missingFactCounts.get(normalized) || 0) + 1);
    }
    const unknownCount = Math.max(0, Number(record.unknown_fields_count || 0));
    if (unknownCount) {
      statusCounts.unknown_question += unknownCount;
      const countKey = 'unknown_field\u0000unknown_question';
      blockerCounts.set(countKey, (blockerCounts.get(countKey) || 0) + unknownCount);
    }
  }

  const topBlockers = sortedCounts(blockerCounts, 'key').map(item => {
    const [fieldKey, status] = item.key.split('\u0000');
    return { field_key: fieldKey, status, count: item.count };
  });
  const missingCoreFacts = sortedCounts(missingFactCounts, 'fact_key');
  let nextBestAction = null;
  if (missingCoreFacts.length) {
    nextBestAction = {
      action: 'confirm_candidate_fact',
      field_key: missingCoreFacts[0].fact_key,
      message: `Add or confirm ${missingCoreFacts[0].fact_key} in the existing candidate profile.`
    };
  } else {
    const actionable = topBlockers.find(item => item.status === 'missing_value')
      || topBlockers.find(item => item.status === 'mapping_review_required')
      || topBlockers.find(item => item.status === 'user_confirmation_required')
      || topBlockers.find(item => item.status === 'manual_required')
      || topBlockers.find(item => item.status === 'unknown_question');
    if (actionable) {
      const actionMessages = {
        missing_value: 'Add a confirmed candidate fact or Answer Memory value.',
        mapping_review_required: 'Review and approve the field mapping after checking it.',
        user_confirmation_required: 'Confirm this value for the current application.',
        manual_required: 'Keep the reviewed file ready for manual upload.',
        unknown_question: 'Answer the new question and save it to Answer Memory after review.'
      };
      nextBestAction = {
        action: actionable.status,
        field_key: actionable.field_key,
        message: `${actionMessages[actionable.status]} Field: ${actionable.field_key}.`
      };
    }
  }

  return {
    records_analyzed: usableRecords.length,
    contains_candidate_values: false,
    status_counts: statusCounts,
    top_blockers: topBlockers,
    missing_core_facts: missingCoreFacts,
    next_best_action: nextBestAction
  };
}
