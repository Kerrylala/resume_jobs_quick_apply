import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildWorkflowState,
  searchConfigurationFingerprint
} from '../scripts/lib/workflow_state.mjs';

function searchPreferences(configured = true) {
  return {
    active_search_profile_id: 'product',
    workflow_meta: configured ? { configured_at: '2026-07-24T00:00:00.000Z' } : {},
    search_profiles: [{
      id: 'product',
      enabled: true,
      target_roles: [{ keyword: 'Product Manager', weight: 100, enabled: true, aliases: [] }],
      preferred_locations: [{ keyword: 'Remote', weight: 80, enabled: true, aliases: [] }],
      workplace_modes: ['remote'],
      seniority_levels: ['mid'],
      required_skills: [],
      preferred_skills: [],
      excluded_keywords: [],
      excluded_companies: [],
      posted_within_days: 30,
      job_types: ['full_time'],
      minimum_salary: null,
      maximum_search_results: 20
    }]
  };
}

const resumeProfiles = {
  active_resume_profile_id: 'resume_v1',
  items: [{
    resume_id: 'resume_v1',
    content_hash: 'sha256:resume',
    resume_file_status: 'exists'
  }]
};

test('Workflow State advances only from current domain records', () => {
  const empty = buildWorkflowState();
  assert.equal(empty.current_step.key, 'resume_uploaded');
  assert.equal(empty.source, 'derived_current_domain_state');

  const oldApproval = buildWorkflowState({
    resumeProfiles,
    resumeIntelligence: {
      profile_approved: true,
      current_review_approved: false
    }
  });
  assert.equal(oldApproval.current_step.key, 'profile_approved');

  const careerApproved = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: searchPreferences(false)
  });
  assert.equal(careerApproved.current_step.key, 'search_configured');

  // A legacy resume review alone no longer counts as an approved profile;
  // only the approved Career Profile unlocks the next step.
  const legacyReviewOnly = buildWorkflowState({
    resumeProfiles,
    resumeIntelligence: { current_review_approved: true },
    searchPreferences: searchPreferences(false)
  });
  assert.equal(legacyReviewOnly.current_step.key, 'profile_approved');
  assert.equal(legacyReviewOnly.facts.profile_approved, false);
  assert.equal(legacyReviewOnly.facts.legacy_resume_review_approved, true);

  const preferences = searchPreferences(true);
  const fingerprint = searchConfigurationFingerprint(preferences);
  const configured = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: [{ status: 'completed', search_configuration_fingerprint: 'sha256:old-search' }],
    jobs: [{ match_score: 99, approval_status: 'approved' }]
  });
  assert.equal(configured.current_step.key, 'search_completed');
  assert.equal(configured.counts.current_search_jobs, 0);

  const runs = [{ status: 'completed', search_configuration_fingerprint: fingerprint }];
  const searched = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: runs
  });
  assert.equal(searched.current_step.key, 'matches_available');
  assert.equal(searched.current_step.blocking, false);
  assert.equal(searched.current_step.view, 'job-search');
  assert.deepEqual(searched.recovery_actions.map(item => item.key), [
    'retry_search',
    'edit_search',
    'import_job_url',
    'offline_demo'
  ]);
  assert.ok(searched.unlocked_views.includes('job-matches'));

  const scoredJob = {
    job_id: 'job-1',
    search_configuration_fingerprint: fingerprint,
    match_score: 90,
    approval_status: 'pending',
    application_status: 'not_started'
  };
  const matches = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: runs,
    jobs: [scoredJob]
  });
  assert.equal(matches.current_step.key, 'job_approved');

  const approved = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: runs,
    jobs: [{ ...scoredJob, approval_status: 'approved', application_status: 'APPROVED_FOR_PACKAGE' }]
  });
  assert.equal(approved.current_step.key, 'package_ready');

  const packageReady = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: runs,
    jobs: [{ ...scoredJob, approval_status: 'approved', application_status: 'PACKAGE_READY' }]
  });
  assert.equal(packageReady.current_step.key, 'fill_started');

  const packageNeedsInput = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: runs,
    jobs: [{ ...scoredJob, approval_status: 'approved', application_status: 'APPROVED_FOR_PACKAGE' }]
  });
  assert.equal(packageNeedsInput.current_step.key, 'package_ready');

  const fillStarted = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: runs,
    jobs: [{ ...scoredJob, approval_status: 'approved', application_status: 'EXECUTING' }]
  });
  assert.equal(fillStarted.current_step.key, 'review_complete');

  const fillPaused = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: runs,
    jobs: [{
      ...scoredJob,
      approval_status: 'approved',
      application_status: 'NEEDS_REVIEW',
      fill_started_at: '2026-07-24T00:00:00.000Z'
    }]
  });
  assert.equal(fillPaused.current_step.key, 'review_complete');

  const ready = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: runs,
    jobs: [{ ...scoredJob, approval_status: 'approved', application_status: 'READY_FOR_MANUAL_SUBMIT' }]
  });
  assert.equal(ready.current_step.key, 'submitted_manually');

  const submitted = buildWorkflowState({
    resumeProfiles,
    careerProfile: { user_approved: true },
    searchPreferences: preferences,
    searchRuns: runs,
    jobs: [{ ...scoredJob, approval_status: 'approved', application_status: 'MANUALLY_SUBMITTED' }]
  });
  assert.equal(submitted.current_step.key, 'submitted_manually');
  assert.equal(submitted.current_step.complete, true);
});
