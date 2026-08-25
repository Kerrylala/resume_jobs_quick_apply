import crypto from 'node:crypto';

function text(value) {
  return String(value ?? '').trim();
}

function activeSearchProfile(searchPreferences = {}) {
  const profiles = Array.isArray(searchPreferences.search_profiles)
    ? searchPreferences.search_profiles
    : [];
  return profiles.find(profile => profile?.id === searchPreferences.active_search_profile_id) || null;
}

function stableSearchConfiguration(searchPreferences = {}) {
  const profile = activeSearchProfile(searchPreferences);
  if (!profile) return null;
  return {
    id: text(profile.id),
    enabled: profile.enabled !== false,
    target_roles: profile.target_roles || [],
    preferred_locations: profile.preferred_locations || [],
    workplace_modes: profile.workplace_modes || [],
    seniority_levels: profile.seniority_levels || [],
    required_skills: profile.required_skills || [],
    preferred_skills: profile.preferred_skills || [],
    excluded_keywords: profile.excluded_keywords || [],
    excluded_companies: profile.excluded_companies || [],
    posted_within_days: profile.posted_within_days ?? null,
    job_types: profile.job_types || [],
    minimum_salary: profile.minimum_salary ?? null,
    maximum_search_results: profile.maximum_search_results ?? null
  };
}

export function searchConfigurationFingerprint(searchPreferences = {}) {
  const configuration = stableSearchConfiguration(searchPreferences);
  if (!configuration) return '';
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(configuration)).digest('hex')}`;
}

function normalizeSearchRuns(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.runs)) return value.runs;
  return [];
}

function statusAtOrBeyond(status, targets) {
  return targets.includes(text(status));
}

const STEP_DEFINITIONS = Object.freeze([
  { number: 1, key: 'resume_uploaded', title: 'Upload your resume', detail: 'Add one PDF, DOCX, or UTF-8 TXT file to start.', action: 'Upload Resume', view: 'resume' },
  { number: 2, key: 'profile_approved', title: 'Review your AI Profile', detail: 'Edit, delete, add, and approve the facts for this resume.', action: 'Review Profile', view: 'profile' },
  { number: 3, key: 'search_configured', title: 'Create your job search', detail: 'Save a real role, location, and search configuration.', action: 'Create Job Search', view: 'job-search' },
  { number: 4, key: 'search_completed', title: 'Find matching jobs', detail: 'Run the configured provider for this saved search.', action: 'Find Jobs', view: 'job-search' },
  { number: 5, key: 'matches_available', title: 'Review match scores', detail: 'Review the scored jobs returned by this search.', action: 'Review Matches', view: 'job-matches' },
  { number: 6, key: 'job_approved', title: 'Approve the jobs you want', detail: 'Only jobs you approve can continue.', action: 'Approve Jobs', view: 'job-matches' },
  { number: 7, key: 'package_ready', title: 'Build an application package', detail: 'Prepare the selected resume and confirmed answers.', action: 'Build Package', view: 'applications' },
  { number: 8, key: 'fill_started', title: 'Start AI Fill Assistant', detail: 'Fill known fields and pause for user review.', action: 'AI Fill Assistant', view: 'applications' },
  { number: 9, key: 'review_complete', title: 'Review the application', detail: 'Resolve unknown, sensitive, and high-risk fields.', action: 'Review Application', view: 'applications' },
  { number: 10, key: 'submitted_manually', title: 'Submit yourself', detail: 'Review the final form and click Submit yourself.', action: 'Review Before Submit', view: 'applications' }
]);

export function buildWorkflowState({
  searchPreferences = {},
  resumeProfiles = {},
  resumeIntelligence = null,
  careerProfile = null,
  searchRuns = [],
  jobs = []
} = {}) {
  const activeResumeId = text(resumeProfiles.active_resume_id || resumeProfiles.active_resume_profile_id);
  const activeResume = (Array.isArray(resumeProfiles.items) ? resumeProfiles.items : [])
    .find(item => text(item?.resume_id || item?.id) === activeResumeId) || null;
  const searchProfile = activeSearchProfile(searchPreferences);
  const configurationFingerprint = searchConfigurationFingerprint(searchPreferences);
  const searchConfigured = Boolean(
    searchPreferences?.workflow_meta?.configured_at
    && searchProfile
    && searchProfile.enabled !== false
    && Array.isArray(searchProfile.target_roles)
    && searchProfile.target_roles.some(item => item?.enabled !== false && text(item?.keyword || item))
  );
  const matchingRuns = normalizeSearchRuns(searchRuns)
    .filter(run => text(run?.search_configuration_fingerprint) === configurationFingerprint);
  const searchCompleted = searchConfigured && matchingRuns.some(run => run?.status === 'completed');
  const currentJobs = (Array.isArray(jobs) ? jobs : [])
    .filter(job => text(job?.search_configuration_fingerprint) === configurationFingerprint);
  const scoredJobs = currentJobs.filter(job => job?.match_score !== null
    && job?.match_score !== undefined
    && Number.isFinite(Number(job.match_score)));
  const approvedJobs = currentJobs.filter(job => job?.approval_status === 'approved');
  const packageJobs = approvedJobs.filter(job =>
    job?.package_path
    || statusAtOrBeyond(job?.application_status, [
      'PACKAGE_READY',
      'FILL_APPROVED',
      'EXECUTOR_READY',
      'EXECUTING',
      'NEEDS_REVIEW',
      'READY_FOR_MANUAL_SUBMIT',
      'MANUALLY_SUBMITTED'
    ])
  );
  const fillJobs = packageJobs.filter(job => {
    const status = text(job?.application_status);
    if (statusAtOrBeyond(status, [
      'EXECUTOR_READY',
      'EXECUTING',
      'NEEDS_REVIEW',
      'READY_FOR_MANUAL_SUBMIT',
      'MANUALLY_SUBMITTED'
    ])) return true;
    return status === 'NEEDS_REVIEW' && Boolean(
      job?.fill_started_at
      || job?.active_session_id
      || job?.latest_fill_report
    );
  });
  const reviewedJobs = fillJobs.filter(job => statusAtOrBeyond(job?.application_status, [
    'READY_FOR_MANUAL_SUBMIT',
    'MANUALLY_SUBMITTED'
  ]));
  const submittedJobs = reviewedJobs.filter(job => job?.application_status === 'MANUALLY_SUBMITTED');

  const facts = {
    resume_uploaded: Boolean(activeResume && activeResume.resume_file_status === 'exists'),
    // The approved Career Profile is the only fact source the package builder
    // and executor accept; a legacy resume review alone must not report the
    // profile as approved (that contradiction hid the package-build 409).
    profile_approved: careerProfile?.user_approved === true,
    legacy_resume_review_approved: Boolean(resumeIntelligence?.current_review_approved),
    search_configured: searchConfigured,
    search_completed: searchCompleted,
    matches_available: searchCompleted && scoredJobs.length > 0,
    job_approved: approvedJobs.length > 0,
    package_ready: packageJobs.length > 0,
    fill_started: fillJobs.length > 0,
    review_complete: reviewedJobs.length > 0,
    submitted_manually: submittedJobs.length > 0
  };
  const steps = STEP_DEFINITIONS.map(step => ({ ...step, complete: facts[step.key] === true }));
  let currentStep = steps.find(step => !step.complete) || steps.at(-1);
  const noMatchesAfterSearch = searchCompleted && scoredJobs.length === 0;
  if (noMatchesAfterSearch) {
    currentStep = {
      ...currentStep,
      title: 'Choose another way to add jobs',
      detail: 'No jobs matched this run. Retry, edit the search, import a public job URL, or use the offline demo.',
      action: 'Try Another Source',
      view: 'job-search',
      blocking: false
    };
  }
  const unlockedViews = new Set(['home', 'resume']);
  if (facts.resume_uploaded) unlockedViews.add('profile');
  if (facts.profile_approved) {
    unlockedViews.add('job-search');
    unlockedViews.add('settings');
  }
  if (facts.search_completed) unlockedViews.add('job-matches');
  if (facts.job_approved) unlockedViews.add('applications');

  return {
    schema_version: '1.0',
    source: 'derived_current_domain_state',
    configuration_fingerprint: configurationFingerprint,
    active_resume_id: activeResumeId,
    active_search_profile_id: text(searchProfile?.id),
    facts,
    counts: {
      matching_search_runs: matchingRuns.length,
      current_search_jobs: currentJobs.length,
      scored_jobs: scoredJobs.length,
      approved_jobs: approvedJobs.length,
      package_ready_jobs: packageJobs.length
    },
    steps,
    current_step: currentStep,
    unlocked_views: [...unlockedViews],
    blocking: false,
    recovery_actions: noMatchesAfterSearch
      ? [
          { key: 'retry_search', title: 'Retry Search', view: 'job-search' },
          { key: 'edit_search', title: 'Edit Search Preferences', view: 'job-search' },
          { key: 'import_job_url', title: 'Import Job URL', view: 'job-search' },
          { key: 'offline_demo', title: 'Use Offline Demo', view: 'job-search' }
        ]
      : []
  };
}
