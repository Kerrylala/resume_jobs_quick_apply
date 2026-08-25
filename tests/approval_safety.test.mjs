import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  APPROVAL_SAFETY_STATUSES,
  ApprovalSafetyValidationError,
  createApprovalSafety,
  downgradeApprovalSafety,
  evaluateApplicationDecision,
  evaluateApprovalEligibility,
  normalizeApprovalSafety
} from '../scripts/lib/approval_safety.mjs';
import { scoreJob } from '../scripts/score_jobs.mjs';
import {
  assertPackageAllowed,
  createApplicationPackageDocuments
} from '../scripts/build_application_package_preview.mjs';
import { approvalQueueDecision, buildApprovalQueue } from '../scripts/build_approval_queue.mjs';

const syntheticConfig = {
  scoring_config_version: 'synthetic-test-v1',
  target_roles: [{
    keyword: 'Product Manager',
    weight: 100,
    enabled: true,
    aliases: [],
    terms: ['Product Manager']
  }],
  preferred_locations: [{
    keyword: 'Remote',
    weight: 100,
    enabled: true,
    aliases: [],
    terms: ['Remote']
  }],
  preferred_companies: [],
  excluded_keywords: [],
  excluded_companies: [],
  required_skills: ['roadmapping', 'analytics'],
  preferred_skills: ['experimentation'],
  workplace_modes: ['remote'],
  seniority_levels: ['mid'],
  posted_within_days: 30,
  job_types: ['full_time'],
  minimum_salary: 5000,
  maximum_jobs_to_open: 2,
  safety: {
    auto_approve: false,
    auto_submit: false,
    auto_upload_resume: false
  },
  scoring_weights: {
    base: 60,
    strong_role_match: 25,
    preferred_location: 10,
    preferred_company: 0
  },
  thresholds: {
    shortlist_candidate: 80,
    manual_review_candidate: 65,
    keep_in_queue: 50
  }
};

const syntheticJob = {
  job_id: 'synthetic-job-001',
  title: 'Product Manager',
  company: 'Synthetic Labs',
  location: 'Remote',
  remote_policy: 'remote',
  seniority: 'mid',
  job_type: 'full_time',
  salary_min: 6000,
  posted_at: new Date().toISOString(),
  provider: 'greenhouse',
  ats: 'greenhouse',
  url: 'https://boards.greenhouse.io/synthetic/jobs/123456',
  description_text: 'Synthetic role description for an offline contract test. '.repeat(8),
  info_quality: { score: 100 },
  confidence: 0.95,
  application_mode: 'REVIEW_ONLY',
  submit_allowed: false,
  upload_resume_allowed: false,
  final_submit_allowed: false
};

const approvedCareerProfile = {
  id: 'career-synthetic',
  family_id: 'career-synthetic',
  name: 'Synthetic Career Profile',
  version: 2,
  state: 'approved',
  user_approved: true,
  approved_at: '2026-01-15T00:00:00.000Z',
  identity: { full_name: 'Synthetic Candidate' }
};

test('approval queue is a derived report and does not create a parallel product queue', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-approval-queue-'));
  const dataDir = path.join(root, 'data');
  const reportsDir = path.join(root, 'reports');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'jobs_shortlist.json'), `${JSON.stringify([{ ...syntheticJob, match_score: 90 }], null, 2)}\n`);
  try {
    const result = buildApprovalQueue({ dataDir, reportsDir });
    assert.equal(result.approval_queue_count, 1);
    assert.equal(result.product_queue_file_created, false);
    assert.equal(fs.existsSync(path.join(reportsDir, 'approval_queue_latest.md')), true);
    assert.equal(fs.existsSync(path.join(dataDir, 'jobs_queue.json')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('canonical approval_safety passes without losing additional business fields', () => {
  const input = {
    status: 'safe_to_approve',
    safe_to_approve: true,
    reasons: ['synthetic_gate_passed'],
    evidence_version: 'synthetic-v1'
  };
  const normalized = normalizeApprovalSafety(input);

  assert.deepEqual(normalized, input);
  assert.notStrictEqual(normalized, input);
  assert.notStrictEqual(normalized.reasons, input.reasons);
});

test('known legacy statuses normalize to the canonical object', () => {
  for (const status of APPROVAL_SAFETY_STATUSES) {
    assert.deepEqual(normalizeApprovalSafety(status), {
      status,
      safe_to_approve: status === 'safe_to_approve',
      reasons: []
    });
  }
});

test('invalid value types and free text are rejected with field details', () => {
  for (const value of [null, 42, [], 'approve this job please']) {
    assert.throws(
      () => normalizeApprovalSafety(value),
      (error) => (
        error instanceof ApprovalSafetyValidationError &&
        error.code === 'INVALID_APPROVAL_SAFETY' &&
        error.field.startsWith('approval_safety') &&
        typeof error.expected === 'string' &&
        typeof error.actual === 'string'
      )
    );
  }
});

test('unknown status is rejected', () => {
  assert.throws(
    () => normalizeApprovalSafety({
      status: 'automatically_approved',
      safe_to_approve: false,
      reasons: []
    }),
    (error) => (
      error instanceof ApprovalSafetyValidationError &&
      error.field === 'approval_safety.status' &&
      error.actual === 'status "automatically_approved"'
    )
  );
});

test('missing required fields are rejected one field at a time', () => {
  const cases = [
    [{ safe_to_approve: false, reasons: [] }, 'approval_safety.status'],
    [{ status: 'needs_review', reasons: [] }, 'approval_safety.safe_to_approve'],
    [{ status: 'needs_review', safe_to_approve: false }, 'approval_safety.reasons']
  ];

  for (const [value, expectedField] of cases) {
    assert.throws(
      () => normalizeApprovalSafety(value),
      (error) => error instanceof ApprovalSafetyValidationError && error.field === expectedField
    );
  }
});

test('field types and status/boolean contradictions are rejected', () => {
  assert.throws(
    () => normalizeApprovalSafety({
      status: 'safe_to_approve',
      safe_to_approve: 'yes',
      reasons: []
    }),
    /approval_safety\.safe_to_approve: expected boolean; received string/
  );
  assert.throws(
    () => normalizeApprovalSafety({
      status: 'safe_to_approve',
      safe_to_approve: false,
      reasons: []
    }),
    /expected true when status is "safe_to_approve"; received false/
  );
  assert.throws(
    () => normalizeApprovalSafety({
      status: 'needs_review',
      safe_to_approve: false,
      reasons: 'synthetic'
    }),
    /approval_safety\.reasons: expected an array of non-empty strings; received string/
  );
});

test('normalization is idempotent', () => {
  const first = normalizeApprovalSafety({
    status: 'needs_review',
    safe_to_approve: false,
    reasons: ['synthetic_review'],
    evidence_version: 'synthetic-v1'
  });
  const second = normalizeApprovalSafety(first);
  assert.deepEqual(second, first);
});

test('downgrade converts legacy safety and preserves existing reasons and fields', () => {
  const canonical = createApprovalSafety(
    'safe_to_approve',
    true,
    ['synthetic_gate_passed'],
    { evidence_version: 'synthetic-v1' }
  );
  const downgraded = downgradeApprovalSafety(
    canonical,
    'enrichment_quality_below_safety_threshold'
  );

  assert.deepEqual(downgraded, {
    status: 'needs_review',
    safe_to_approve: false,
    reasons: [
      'synthetic_gate_passed',
      'enrichment_quality_below_safety_threshold'
    ],
    evidence_version: 'synthetic-v1'
  });
  assert.deepEqual(downgradeApprovalSafety(
    'safe_to_approve',
    'enrichment_quality_below_safety_threshold'
  ), {
    status: 'needs_review',
    safe_to_approve: false,
    reasons: ['enrichment_quality_below_safety_threshold']
  });
});

test('synthetic scoring output is readable by approval and package consumers', () => {
  const scored = scoreJob(syntheticJob, syntheticConfig);
  const scoredJob = {
    ...syntheticJob,
    page_type: scored.page_type,
    approval_safety: scored.approval_safety,
    recommended_decision: scored.recommended_decision
  };

  assert.deepEqual(scored.approval_safety, {
    status: 'safe_to_approve',
    safe_to_approve: true,
    reasons: []
  });
  assert.equal(evaluateApprovalEligibility(scoredJob).safe_to_approve, true);
  assert.equal(
    approvalQueueDecision({ ...scoredJob, match_score: scored.score }),
    'approve_for_manual_application_prep'
  );
  assert.doesNotThrow(() => assertPackageAllowed(scoredJob, {
    job_id: scoredJob.job_id,
    decision: 'approved',
    decided_at: '2026-07-23T00:00:00.000Z'
  }));
});

test('approval and package preparation share warning-only and hard-blocker decisions', () => {
  const legacySafeJob = {
    ...syntheticJob,
    page_type: 'job_detail',
    recommended_decision: 'approve',
    approval_safety: 'safe_to_approve'
  };
  assert.equal(evaluateApprovalEligibility(legacySafeJob).safe_to_approve, true);
  assert.doesNotThrow(() => assertPackageAllowed(legacySafeJob, { decision: 'approved' }));

  const unsafeJob = {
    ...legacySafeJob,
    approval_safety: 'needs_review',
    recommended_decision: 'manual_review',
    title_role_mismatch: true
  };
  assert.equal(evaluateApprovalEligibility(unsafeJob).safe_to_approve, false);
  const warningDecision = evaluateApplicationDecision(unsafeJob);
  assert.equal(warningDecision.allowed, true);
  assert.ok(warningDecision.warnings.includes('role_title_differs_continue_after_review'));
  assert.doesNotThrow(() => assertPackageAllowed(unsafeJob, { decision: 'approved' }));

  const hardBlockedJob = {
    ...legacySafeJob,
    upload_resume_allowed: true
  };
  const hardDecision = evaluateApplicationDecision(hardBlockedJob);
  assert.equal(hardDecision.allowed, false);
  assert.ok(hardDecision.blockers.includes('upload_resume_allowed_not_false'));
  assert.throws(
    () => assertPackageAllowed(hardBlockedJob, { decision: 'approved' }),
    (error) => error.code === 'PACKAGE_BLOCKED' && error.failures.includes('upload_resume_allowed_not_false')
  );
});

test('a real-format Ashby company/job-id URL is one job detail, not a company board', () => {
  const scored = scoreJob({
    ...syntheticJob,
    provider: 'ashby',
    ats: 'ashby',
    url: 'https://jobs.ashbyhq.com/example/f5bd96b7-2b90-4a91-8ebd-699ac32c0281',
    apply_url: 'https://jobs.ashbyhq.com/example/f5bd96b7-2b90-4a91-8ebd-699ac32c0281'
  }, syntheticConfig);
  assert.equal(scored.page_type, 'job_detail');
  assert.equal(scored.direct_posting_evidence, true);
});

test('a real-format Apple details URL is one direct company job posting', () => {
  const scored = scoreJob({
    ...syntheticJob,
    company: 'Apple',
    provider: 'generic_company_careers',
    ats: 'generic_company_careers',
    url: 'https://jobs.apple.com/en-us/details/200663490-3715/senior-product-manager',
    apply_url: 'https://jobs.apple.com/en-us/details/200663490-3715/senior-product-manager'
  }, syntheticConfig);
  assert.equal(scored.page_type, 'job_detail');
  assert.equal(scored.direct_posting_evidence, true);
});

test('configured role matching ignores harmless title punctuation', () => {
  const config = structuredClone(syntheticConfig);
  config.target_roles = [{
    keyword: 'Associate Product Manager AI',
    weight: 100,
    enabled: true,
    aliases: [],
    terms: ['Associate Product Manager AI']
  }];
  const scored = scoreJob({
    ...syntheticJob,
    title: 'Associate Product Manager (AI)'
  }, config);
  assert.equal(scored.target_role_match, true);
  assert.equal(scored.title_role_mismatch, false);
});

test('application package reports invalid approval_safety details without exposing job data', () => {
  const invalidJob = {
    ...syntheticJob,
    page_type: 'job_detail',
    recommended_decision: 'approve',
    approval_safety: {
      status: 'safe_to_approve',
      safe_to_approve: false,
      reasons: []
    }
  };

  assert.throws(
    () => assertPackageAllowed(invalidJob, { decision: 'approved' }),
    (error) => (
      error.code === 'PACKAGE_BLOCKED' &&
      error.failures.includes('approval_safety_invalid') &&
      error.details.approval_safety_error.field === 'job.approval_safety.safe_to_approve' &&
      !JSON.stringify(error.details).includes(invalidJob.title)
    )
  );
});

test('scoring exposes the complete deterministic G3 breakdown', () => {
  const scored = scoreJob(syntheticJob, syntheticConfig);
  assert.equal(scored.hard_filter.passed, true);
  assert.equal(scored.score_breakdown.final_score, scored.score);
  for (const field of [
    'title_match',
    'required_skills_match',
    'preferred_skills_match',
    'seniority_match',
    'technical_match',
    'experience_match',
    'education_match',
    'location_match',
    'remote_match',
    'salary_match',
    'career_direction_match',
    'candidate_fit_score',
    'candidate_context',
    'recency',
    'penalties',
    'matched_requirements',
    'missing_requirements',
    'uncertainty',
    'explanation'
  ]) assert.ok(Object.hasOwn(scored.score_breakdown, field), field);
});

test('hard filters block excluded companies without guessing authorization', () => {
  const scored = scoreJob({
    ...syntheticJob,
    company: 'Blocked Corp',
    work_authorization_required: 'US sponsorship'
  }, {
    ...syntheticConfig,
    excluded_companies: ['blocked corp'],
    work_authorization: null
  });
  assert.equal(scored.hard_filter.passed, false);
  assert.ok(scored.hard_filter.reasons.includes('excluded_company_match'));
  assert.ok(scored.hard_filter.uncertainty.includes('work_authorization_not_user_confirmed'));
  assert.equal(scored.approval_safety.safe_to_approve, false);
  assert.ok(scored.score <= 49);
});

test('application package documents expose resume, provenance and review state', () => {
  const scored = scoreJob(syntheticJob, syntheticConfig);
  const job = {
    ...syntheticJob,
    page_type: scored.page_type,
    recommended_decision: scored.recommended_decision,
    approval_safety: scored.approval_safety
  };
  const documents = createApplicationPackageDocuments({
    job,
    review: { decision: 'approved' },
    careerProfile: approvedCareerProfile,
    resumeProfiles: {
      active_resume_profile_id: 'resume_synthetic',
      items: [{
        id: 'resume_synthetic',
        enabled: true,
        version: 2,
        resume_file_path: 'synthetic/resume.pdf',
        content_hash: 'sha256:synthetic',
        approved_at: '2026-01-01T00:00:00.000Z'
      }]
    },
    questionBank: {
      answers: [{
        id: 'why_role',
        question: 'Why this role?',
        answer: 'Synthetic confirmed answer',
        source: 'user_confirmed',
        user_confirmed: true,
        confidence: 1,
        status: 'approved',
        approved_for_real_applications: true
      }]
    },
    now: '2026-02-01T00:00:00.000Z'
  });
  assert.equal(documents.application_id, 'application_synthetic-job-001');
  assert.equal(documents.selected_resume.resume_id, 'resume_synthetic');
  assert.equal(documents.resume_hash, 'sha256:synthetic');
  assert.equal(Object.hasOwn(documents, 'planned_answers'), false);
  assert.equal(Object.hasOwn(documents, 'answer_provenance'), false);
  assert.equal(Object.hasOwn(documents, 'cover_letter_draft'), false);
  assert.equal(documents.application_answers[0].source, 'user_confirmed');
  assert.equal(documents.application_answers[0].user_confirmed, true);
  assert.equal(documents.application_answers[0].version, 1);
  assert.ok(['needs_user_input', 'draft_ready'].includes(documents.cover_letter.status));
  assert.equal(documents.status, 'PACKAGE_READY');
  assert.equal(documents.approval_safety.safe_to_approve, true);
});

test('an uploaded but unapproved resume cannot make an application package ready', () => {
  const scored = scoreJob(syntheticJob, syntheticConfig);
  const documents = createApplicationPackageDocuments({
    job: {
      ...syntheticJob,
      page_type: scored.page_type,
      recommended_decision: scored.recommended_decision,
      approval_safety: scored.approval_safety
    },
    review: { decision: 'approved' },
    careerProfile: approvedCareerProfile,
    resumeProfiles: {
      active_resume_profile_id: 'resume_pending',
      items: [{
        id: 'resume_pending',
        enabled: true,
        version: 1,
        resume_file_path: 'synthetic/pending.pdf',
        content_hash: 'sha256:pending',
        approved_at: null
      }]
    },
    now: '2026-02-01T00:00:00.000Z'
  });
  assert.equal(documents.selected_resume, null);
  assert.equal(documents.resume_hash, '');
  assert.equal(documents.status, 'NEEDS_USER_INPUT');
});
