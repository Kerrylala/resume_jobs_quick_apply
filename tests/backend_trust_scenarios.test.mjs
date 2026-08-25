import assert from 'node:assert/strict';
import test from 'node:test';

import { upsertAnswerMemory } from '../scripts/lib/candidate_records.mjs';
import { careerProfileToApplicationProfile } from '../scripts/lib/career_brain.mjs';
import { createApplicationPackageDocuments } from '../scripts/build_application_package_preview.mjs';
import { createApplicationExecutionSession } from '../application_executor/execution_session.mjs';
import { planFields } from '../application_executor/field_mapper.mjs';

const JOB = {
  job_id: 'scenario-job-001',
  title: 'Product Manager',
  company: 'Synthetic Labs',
  location: 'Remote',
  url: 'https://boards.greenhouse.io/synthetic/jobs/777',
  provider: 'greenhouse',
  ats: 'greenhouse',
  page_type: 'job_detail',
  recommended_decision: 'shortlist',
  description_text: 'Synthetic description. '.repeat(10),
  info_quality: { score: 100 },
  confidence: 0.95,
  approval_safety: { status: 'safe_to_approve', safe_to_approve: true, reasons: ['synthetic_test'] },
  application_mode: 'REVIEW_ONLY',
  submit_allowed: false,
  upload_resume_allowed: false,
  final_submit_allowed: false
};

const CAREER_PROFILE = {
  id: 'career-scenario', family_id: 'career-scenario', version: 3, name: 'Scenario Profile',
  state: 'approved', user_approved: true, approved_at: '2026-08-10T00:00:00.000Z',
  identity: {
    full_name: 'Synthetic Candidate', first_name: 'Synthetic', last_name: 'Candidate',
    email: 'candidate@example.test', phone: '+86 555 0100', city: 'Shanghai', country: 'China',
    links: { linkedin: 'https://linkedin.example.test/in/synthetic' }
  },
  education: [], experience: [], projects: [], skills: {}, certifications: [], languages: [],
  interview_stories: [], career_goals: ['Product Manager'],
  job_preferences: { work_authorization: 'Citizen of China', sponsorship: 'Not required' },
  field_provenance: {}
};

const RESUME_PROFILES = {
  active_resume_profile_id: 'resume_scenario_v1',
  items: [{
    id: 'resume_scenario_v1', resume_id: 'resume_scenario_v1', name: 'Scenario Resume', version: 1,
    enabled: true, file_reference: 'synthetic/resume.pdf', content_hash: 'sha256:scenario',
    approved_at: '2026-08-01T00:00:00.000Z', target_roles: ['Product Manager'], skills: []
  }]
};

test('Scenario A: a user-confirmed safe answer is reusable in the next package', () => {
  const memory = upsertAnswerMemory({ answers: [] }, {
    original_question: 'What interests you about this role?',
    answer: 'Synthetic confirmed interest answer',
    source: 'user_confirmed',
    user_confirmed: true,
    canonical_key: 'answer_interest',
    sensitive_category: 'none',
    risk_level: 'normal'
  }, { now: '2026-08-15T00:00:00.000Z' });
  assert.equal(memory.answers[0].approved_for_real_applications, true);

  const documents = createApplicationPackageDocuments({
    job: JOB,
    review: { decision: 'approved' },
    questionBank: memory,
    resumeProfiles: RESUME_PROFILES,
    careerProfile: CAREER_PROFILE,
    now: '2026-08-15T00:00:00.000Z'
  });
  const reused = documents.application_answers.find(answer => answer.canonical_key === 'answer_interest');
  assert.ok(reused, 'the confirmed safe answer must appear in application_answers');
  assert.equal(reused.value, 'Synthetic confirmed interest answer');
  assert.equal(reused.user_confirmed, true);

  const session = createApplicationExecutionSession({
    applicationPackage: documents,
    manifest: { package_id: 'package-scenario' },
    job: JOB,
    targetUrl: JOB.url,
    idempotencyKey: 'scenario-a'
  });
  assert.ok(session.approved_field_mappings.some(mapping => mapping.canonical_key === 'answer_interest'));
});

test('Scenario A guard: sensitive and high-risk answers never auto-fill even when stored', () => {
  let memory = upsertAnswerMemory({ answers: [] }, {
    original_question: 'Do you require sponsorship?',
    answer: 'Synthetic sensitive answer',
    source: 'user_confirmed',
    user_confirmed: true,
    canonical_key: 'sponsorship',
    sensitive_category: 'work_authorization',
    risk_level: 'high'
  });
  const documents = createApplicationPackageDocuments({
    job: JOB,
    review: { decision: 'approved' },
    questionBank: memory,
    resumeProfiles: RESUME_PROFILES,
    careerProfile: CAREER_PROFILE
  });
  assert.equal(documents.application_answers.some(answer => answer.canonical_key === 'sponsorship'), false);
  assert.ok(documents.form_answers.requires_review.some(item => item.risk_level === 'high'));
});

test('Scenario B: a saved location travels from Career Brain to the browser fill plan', () => {
  const projected = careerProfileToApplicationProfile(CAREER_PROFILE, {});
  assert.equal(projected.location, 'Shanghai, China');

  const documents = createApplicationPackageDocuments({
    job: JOB,
    review: { decision: 'approved' },
    questionBank: { answers: [] },
    resumeProfiles: RESUME_PROFILES,
    careerProfile: CAREER_PROFILE
  });
  assert.equal(documents.application_profile.location, 'Shanghai, China');
  assert.equal(documents.application_profile.work_authorization, 'Citizen of China');
  assert.equal(documents.application_profile.work_situation.sponsorship, 'Not required');

  const session = createApplicationExecutionSession({
    applicationPackage: documents,
    manifest: { package_id: 'package-scenario-b' },
    job: JOB,
    targetUrl: JOB.url,
    idempotencyKey: 'scenario-b'
  });
  const locationMapping = session.approved_field_mappings.find(mapping => mapping.canonical_key === 'location');
  assert.ok(locationMapping, 'the executor location key must be populated from the projection');
  assert.equal(locationMapping.value, 'Shanghai, China');

  const plans = planFields([
    { field_ref: 'field-1', label: 'Current location', type: 'text' },
    { field_ref: 'field-2', label: 'Email address', type: 'email' }
  ], {
    profile_confirmed: true,
    profile: Object.fromEntries(session.approved_field_mappings.map(mapping => [
      mapping.canonical_key,
      { value: mapping.value, source: mapping.source, confidence: mapping.confidence, user_confirmed: mapping.user_confirmed }
    ]))
  });
  assert.equal(plans[0].action, 'fill');
  assert.equal(plans[0].mapping.value, 'Shanghai, China');
  assert.equal(plans[0].reason, 'requires_manual_location_confirmation');
  assert.equal(plans[1].action, 'fill');
});
