import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateCompletionInsights,
  buildApplicationCompletionPlan,
  calculateObservedCompletion,
  numericConfidence
} from '../scripts/lib/application_completion.mjs';

const approvedProfile = {
  approved_for_real_applications: true,
  first_name: 'Synthetic',
  last_name: 'Candidate',
  full_name: 'Synthetic Candidate',
  email: 'candidate@local.invalid',
  phone: '000-000-0000',
  city: 'Fixture City',
  country: 'ZZ',
  linkedin: 'https://local.invalid/candidate'
};

test('confidence values normalize without exceeding the safe range', () => {
  assert.equal(numericConfidence('high'), 0.95);
  assert.equal(numericConfidence('medium'), 0.7);
  assert.equal(numericConfidence(2), 1);
  assert.equal(numericConfidence(-2), 0);
});

test('Greenhouse completion plan reuses candidate facts, resume metadata and answer memory', () => {
  const plan = buildApplicationCompletionPlan({
    job: { provider: 'greenhouse', url: 'https://boards.greenhouse.io/synthetic/jobs/123' },
    applicationProfile: approvedProfile,
    selectedResume: {
      file_reference: 'synthetic/resume.pdf',
      content_hash: 'sha256:synthetic',
      approved_at: '2026-07-23T00:00:00.000Z'
    },
    plannedAnswers: [{
      canonical_key: 'why_this_role',
      answer: 'Because this is a controlled local fixture.',
      source: 'user_confirmed',
      confidence: 1,
      user_confirmed: true,
      version: 2
    }],
    now: '2026-07-23T00:00:00.000Z'
  });

  assert.equal(plan.portal, 'greenhouse');
  assert.equal(plan.metric, 'application_completion_rate');
  assert.ok(plan.application_completion_rate >= 60);
  assert.ok(plan.fields.every(field =>
    Object.hasOwn(field, 'value')
    && Object.hasOwn(field, 'source')
    && Object.hasOwn(field, 'confidence')
    && Object.hasOwn(field, 'user_confirmed')
    && Object.hasOwn(field, 'last_used')
  ));
  assert.equal(plan.fields.find(field => field.field_key === 'resume_file').status, 'manual_required');
  assert.equal(plan.fields.find(field => field.field_key === 'why_this_role').status, 'auto_fill_ready');
});

test('sensitive fields require user confirmation even when a confirmed value exists', () => {
  const plan = buildApplicationCompletionPlan({
    job: { provider: 'greenhouse' },
    applicationProfile: {
      ...approvedProfile,
      work_authorization: 'fixture-authorized'
    }
  });
  const field = plan.fields.find(item => item.field_key === 'work_authorization');
  assert.equal(field.status, 'user_confirmation_required');
  assert.equal(field.risk, 'sensitive');
});

test('confirmed field memory raises mapping confidence but never supplies a candidate value', () => {
  const plan = buildApplicationCompletionPlan({
    job: { provider: 'unknown', url: 'https://careers.local.invalid/job/1' },
    applicationProfile: approvedProfile,
    fieldMemory: {
      records: [{
        portal: 'unknown',
        canonical_key: 'first_name',
        confidence: 0.98,
        user_confirmed: true,
        status: 'active'
      }]
    }
  });
  const remembered = plan.fields.find(item => item.field_key === 'first_name');
  const missingResume = plan.fields.find(item => item.field_key === 'resume_file');
  assert.equal(remembered.memory_source, 'form_field_memory');
  assert.equal(remembered.mapping_confidence, 0.98);
  assert.equal(missingResume.source, 'missing');
  assert.equal(missingResume.status, 'missing_value');
});

test('observed completion excludes hard-blocked controls and reports the core metric', () => {
  const result = calculateObservedCompletion({
    total_fields_seen: 12,
    filled_fields_count: 9,
    skipped_fields_count: 3,
    hard_blocked_fields_count: 2,
    fields_requiring_user_review_count: 1,
    suggested_questions_count: 0
  }, { now: '2026-07-23T00:00:00.000Z' });
  assert.equal(result.application_completion_rate, 90);
  assert.equal(result.measurable_fields_count, 10);
  assert.equal(result.ready_for_30_second_review, true);
});

test('completion resolves nested candidate facts through Resume Intelligence', () => {
  const plan = buildApplicationCompletionPlan({
    job: { provider: 'greenhouse' },
    applicationProfile: {
      approved_for_real_applications: true,
      identity: {
        first_name: 'Nested',
        last_name: 'Candidate',
        email: 'nested@local.invalid',
        phone: '000'
      },
      city: 'Fixture City',
      country: 'ZZ',
      links: { linkedin: 'https://local.invalid/nested' }
    }
  });
  assert.equal(plan.fields.find(field => field.field_key === 'first_name').value, 'Nested');
  assert.equal(plan.fields.find(field => field.field_key === 'linkedin').source, 'candidate_profile');
  assert.equal(plan.resume_intelligence_summary.core_fact_coverage_percent, 100);
});

test('completion insights aggregate only de-valued blockers and recommend the highest-value fact', () => {
  const insights = aggregateCompletionInsights([
    {
      blockers: [
        { field_key: 'linkedin', status: 'missing_value' },
        { field_key: 'resume_file', status: 'manual_required' }
      ],
      resume_intelligence_summary: { missing_core_fact_keys: ['linkedin'] }
    },
    {
      blockers: [{ field_key: 'linkedin', status: 'missing_value' }],
      resume_intelligence_summary: { missing_core_fact_keys: ['linkedin'] }
    },
    {
      phase: 'observed',
      unknown_fields_count: 2
    }
  ]);
  assert.equal(insights.contains_candidate_values, false);
  assert.deepEqual(insights.top_blockers[0], {
    field_key: 'linkedin',
    status: 'missing_value',
    count: 2
  });
  assert.deepEqual(insights.missing_core_facts[0], { fact_key: 'linkedin', count: 2 });
  assert.equal(insights.next_best_action.action, 'confirm_candidate_fact');
  assert.equal(insights.status_counts.unknown_question, 2);
  assert.equal(JSON.stringify(insights).includes('candidate@'), false);
});
