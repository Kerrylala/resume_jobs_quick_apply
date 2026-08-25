import fs from 'fs';
import path from 'path';
import { evaluateApplicationDecision } from './lib/approval_safety.mjs';
import {
  normalizeAnswerMemory,
  selectBestResumeProfile
} from './lib/candidate_records.mjs';
import { buildApplicationCompletionPlan } from './lib/application_completion.mjs';
import { buildResumeIntelligence } from './lib/resume_intelligence.mjs';
import { isMainModule, projectRootFromMetaUrl } from './lib/project_paths.mjs';
import { careerProfileToApplicationProfile, normalizeCareerBrainStore } from './lib/career_brain.mjs';
import { buildApplicationPackage2Sections } from './lib/application_package_2.mjs';
import { normalizeSearchPreferences } from './lib/search_preferences.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const dataDir = path.resolve(process.env.RESUME_JOBS_DATA_DIR || path.join(root, 'data'));
const applicationsDir = path.resolve(process.env.RESUME_JOBS_APPLICATIONS_DIR || path.join(root, 'applications'));

const BLOCKED_ANSWER_RE = /\b(salary|compensation|start date|available to start|visa|sponsorship|work authorization|eeo|equal employment|reference|referee)\b/i;
const PLACEHOLDER_RE = /\b(alex example|placeholder|todo|tbd|unknown|requires user review)\b/i;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return fallback; throw err; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--job-id') args.jobId = argv[++i];
    else if (argv[i] === '--resume-id') args.resumeId = argv[++i];
  }
  return args;
}

function safeSegment(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'unknown_job';
}


function profileGateError(message, details = {}) {
  const err = new Error(message);
  err.code = 'PROFILE_MISSING_OR_INVALID';
  err.reason = 'profile_missing_or_invalid';
  err.details = details;
  return err;
}

export function validateSelectedProfile(profile, selectedProfilePath, validatorReport = {}) {
  const requiredBooleans = [
    'approved_for_real_applications',
    'allow_resume_attach',
    'allow_final_submit'
  ];
  const failures = [];
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) failures.push('profile_not_object');
  for (const key of requiredBooleans) {
    if (typeof profile?.[key] !== 'boolean') failures.push(`${key}_not_boolean`);
  }
  if (profile?.approved_for_real_applications !== true) failures.push('approved_for_real_applications_not_true');
  if (profile?.allow_resume_attach !== false) failures.push('allow_resume_attach_not_false');
  if (profile?.allow_final_submit !== false) failures.push('allow_final_submit_not_false');
  if (!profile?.profile_meta?.candidate_fact_review?.snapshot_digest) {
    failures.push('candidate_fact_review_missing');
  }
  const text = JSON.stringify(profile || {});
  if (PLACEHOLDER_RE.test(text)) failures.push('placeholder_or_example_value_detected');
  if (failures.length) {
    throw profileGateError('Profile required before package preview', {
      selected_profile_path: path.relative(root, selectedProfilePath),
      failures,
      validator_report: validatorReport
    });
  }
}

function reviewedCareerApplicationProfile(careerProfile) {
  if (careerProfile?.user_approved !== true) return null;
  const profile = careerProfileToApplicationProfile(careerProfile, {
    allow_autofill_real_sites: false,
    allow_resume_attach: false,
    allow_final_submit: false
  });
  const validatorReport = {
    success: true,
    status: 'career_brain_profile_review',
    note: 'The active Career Profile was explicitly approved by the user. Package creation remains review-only.'
  };
  const careerProfilePath = path.join(dataDir, 'career_profiles.local.json');
  validateSelectedProfile(profile, careerProfilePath, validatorReport);
  return {
    profile,
    profile_path: path.relative(root, careerProfilePath),
    validator_report: validatorReport
  };
}

function latestReviewFor(jobId, reviews) {
  return [...reviews]
    .filter((review) => String(review?.job_id) === String(jobId))
    .sort((a, b) => String(b.decided_at || '').localeCompare(String(a.decided_at || '')))[0] || null;
}

export function isSafeToApprove(job) {
  return evaluateApplicationDecision(job).allowed;
}

export function assertPackageAllowed(job, review) {
  const failures = [];
  let approvalSafetyError = null;
  if (!job) failures.push('job_not_found');
  if (review?.decision !== 'approved' && job?.approval_status !== 'approved') failures.push('approval_status_not_approved');
  if (job) {
    const decision = evaluateApplicationDecision(job);
    failures.push(...decision.blockers);
    approvalSafetyError = decision.approval_safety_error;
  }
  const uniqueFailures = [...new Set(failures)];
  if (uniqueFailures.length) {
    const err = new Error(`Package preview blocked: ${uniqueFailures.join(', ')}`);
    err.code = 'PACKAGE_BLOCKED';
    err.failures = uniqueFailures;
    if (approvalSafetyError) err.details = { approval_safety_error: approvalSafetyError };
    throw err;
  }
}

function answerScopeMatchesJob(answer, job = {}) {
  const scope = String(answer?.scope || 'global').toLowerCase();
  const key = String(answer?.scope_key || '').trim().toLocaleLowerCase('en-US');
  if (scope === 'global') return true;
  if (!key) return false;
  if (scope === 'employer') return String(job.company || '').trim().toLocaleLowerCase('en-US') === key;
  if (scope === 'role') return String(job.title || '').trim().toLocaleLowerCase('en-US') === key;
  if (scope === 'country') return String(job.country || job.location || '').toLocaleLowerCase('en-US').includes(key);
  if (scope === 'portal') return [job.ats, job.provider, job.portal]
    .some(value => String(value || '').trim().toLocaleLowerCase('en-US') === key);
  return false;
}

function buildFormAnswers(questionBank, job = {}, { sensitiveReuseCategories = [] } = {}) {
  const normalizedBank = normalizeAnswerMemory(questionBank);
  const core = globalThis.ResumeJobsApplicationExecutorCore;
  // A USER-CONFIRMED sensitive answer whose category the user set to 'reuse'
  // may travel with its value; everything else sensitive stays value-withheld
  // in requires_review. AI-suggested answers can never enter here.
  const sensitiveReusable = (answer) => {
    if (answer?.user_confirmed !== true || answer?.reuse_policy === 'never') return false;
    const category = core?.sensitiveQuestionCategory?.(
      `${answer.original_question || ''} ${answer.normalized_question || ''}`
    ) || '';
    return Boolean(category) && sensitiveReuseCategories.includes(category);
  };
  const approvedAnswers = (normalizedBank.answers || [])
    .filter((answer) => answerScopeMatchesJob(answer, job))
    .filter((answer) => {
      // Explicit per-category user policy admits a confirmed sensitive answer
      // with its value; otherwise only ordinary auto-reusable answers pass,
      // still subject to the sensitive-topic blocklist.
      if (sensitiveReusable(answer)) return true;
      if (answer?.approved_for_real_applications !== true) return false;
      return !BLOCKED_ANSWER_RE.test(`${answer.category || ''} ${(answer.question_patterns || []).join(' ')} ${answer.keywords || ''} ${answer.original_question || ''} ${answer.normalized_question || ''}`);
    })
    .filter((answer) => typeof answer.answer === 'string' && answer.answer.trim() && !PLACEHOLDER_RE.test(answer.answer));

  const answers = approvedAnswers.map((answer) => ({
    id: answer.id,
    canonical_key: answer.canonical_key || answer.profile_key || '',
    category: answer.category || 'general',
    risk_level: answer.risk_level || 'normal',
    sensitive_category: answer.sensitive_category || 'none',
    question_patterns: answer.question_patterns || [],
    question_variants: answer.question_variants || [],
    keywords: answer.keywords || [],
    original_question: answer.original_question || '',
    normalized_question: answer.normalized_question || '',
    scope: answer.scope || 'global',
    scope_key: answer.scope_key || '',
    answer: answer.answer,
    status: 'approved',
    approved_for_real_applications: answer.approved_for_real_applications === true,
    sensitive_reuse: answer.approved_for_real_applications !== true,
    requires_review: false
  }));

  // Every stored answer that cannot auto-fill (sensitive, high-risk, or held
  // back by the topic blocklist) surfaces here for explicit per-use review
  // instead of silently vanishing from the package.
  const answerIds = new Set(answers.map((answer) => answer.id));
  const requiresReview = (normalizedBank.answers || [])
    .filter((answer) => answerScopeMatchesJob(answer, job))
    .filter((answer) => !answerIds.has(answer.id))
    .filter((answer) => answer?.user_confirmed === true || answer?.risk_level === 'high')
    .map((answer) => ({
      id: answer.id,
      category: answer.category || (answer.risk_level === 'high' ? 'high_risk' : 'general'),
      risk_level: answer.risk_level || 'normal',
      sensitive_category: answer.sensitive_category || 'none',
      original_question: answer.original_question || '',
      question_patterns: answer.question_patterns || [],
      status: 'requires_review',
      requires_review: true,
      answer: ''
    }));

  return {
    application_mode: 'REVIEW_ONLY',
    allow_final_submit: false,
    allow_resume_attach: false,
    excluded_topics: ['salary', 'start_date', 'visa', 'sponsorship', 'EEO', 'references'],
    answers,
    requires_review: requiresReview
  };
}

export function createApplicationPackageDocuments({
  job,
  review,
  questionBank = { answers: [] },
  resumeProfiles = { items: [] },
  careerProfile = null,
  resumeId = '',
  sensitiveReuseCategories = [],
  now = new Date().toISOString()
}) {
  assertPackageAllowed(job, review);
  if (careerProfile?.user_approved !== true) {
    throw profileGateError('Approve the active Career Profile before building an Application Package.', {
      failures: ['active_career_profile_not_approved']
    });
  }
  const resumeSelection = selectBestResumeProfile(resumeProfiles, job, {
    preferredResumeId: resumeId
  });
  if (resumeId && !resumeSelection.selected_resume) {
    const err = new Error('Requested resume is missing, disabled, unapproved, unverified, or unavailable.');
    err.code = 'RESUME_OVERRIDE_NOT_ELIGIBLE';
    err.details = {
      requested_resume_id: String(resumeId),
      candidates: resumeSelection.selection.candidates
    };
    throw err;
  }
  const selectedResume = resumeSelection.selected_resume;
  const formAnswers = buildFormAnswers(questionBank, job, { sensitiveReuseCategories });
  const applicationId = `application_${safeSegment(job.job_id)}`;
  const plannedAnswers = formAnswers.answers.map(answer => {
    const source = normalizeAnswerMemory(questionBank).answers.find(item => item.id === answer.id);
    return {
      question_id: answer.id,
      canonical_key: source?.canonical_key || source?.profile_key || answer.canonical_key || '',
      original_question: source?.original_question || answer.original_question || '',
      normalized_question: source?.normalized_question || answer.normalized_question || '',
      question_patterns: source?.question_patterns || answer.question_patterns || [],
      question_variants: source?.question_variants || answer.question_variants || [],
      scope: source?.scope || answer.scope || 'global',
      scope_key: source?.scope_key || answer.scope_key || '',
      risk_level: source?.risk_level || answer.risk_level || 'normal',
      answer: answer.answer,
      value: answer.answer,
      source: source?.source || 'historical_confirmed',
      version: source?.version || 1,
      user_confirmed: source?.user_confirmed === true,
      confidence: Number(source?.confidence || 0),
      sensitive_category: source?.sensitive_category || 'none',
      last_used: source?.last_used || null
    };
  });
  const unansweredQuestions = formAnswers.requires_review.map(answer => ({
    question_id: answer.id,
    category: answer.category,
    reason: 'requires_user_review'
  }));
  const sensitiveQuestions = [
    ...plannedAnswers.filter(answer => answer.sensitive_category !== 'none'),
    ...formAnswers.requires_review.filter(answer => answer.risk_level === 'high')
  ];
  const eligibility = evaluateApplicationDecision(job);
  // The legacy candidate profile carries facts the user answered in preflight
  // (location, links, name parts) — the same fallback the readiness view
  // uses, so what the preflight shows as known is what the fill can use.
  let legacyFacts = {};
  try { legacyFacts = JSON.parse(fs.readFileSync(path.join(dataDir, 'candidate_profile.local.json'), 'utf8')) || {}; }
  catch { legacyFacts = {}; }
  const applicationProfile = careerProfileToApplicationProfile(careerProfile, legacyFacts);
  const resumeIntelligence = buildResumeIntelligence({
    profile: applicationProfile,
    selectedResume,
    now
  });
  const applicationCompletion = buildApplicationCompletionPlan({
    job,
    applicationProfile,
    selectedResume,
    plannedAnswers,
    resumeIntelligence,
    now
  });
  const coverLetterDraft = {
    content: '',
    status: 'needs_user_input',
    provenance: 'not_generated',
    requires_review: true
  };
  const package2 = buildApplicationPackage2Sections({
    job,
    careerProfile: careerProfile || {},
    selectedResume,
    plannedAnswers,
    unansweredQuestions,
    sensitiveQuestions,
    coverLetterDraft,
    hybridMatch: job.hybrid_match || null,
    now
  });
  return {
    application_id: applicationId,
    job_id: String(job.job_id),
    selected_resume: selectedResume ? {
      resume_id: selectedResume.resume_id,
      version: selectedResume.version,
      file_reference: selectedResume.file_reference,
      content_hash: selectedResume.content_hash,
      approved_at: selectedResume.approved_at
    } : null,
    resume_hash: selectedResume?.content_hash || '',
    // planned_answers, answer_provenance, and cover_letter_draft are retired
    // for new packages: application_answers and cover_letter (package v2
    // sections) are the canonical serializations. Old packages keep them and
    // readers stay compatible for one release.
    confidence: plannedAnswers.length
      ? Math.min(...plannedAnswers.map(answer => answer.confidence))
      : 0,
    unanswered_questions: unansweredQuestions,
    sensitive_questions: sensitiveQuestions,
    resume_intelligence: resumeIntelligence,
    application_completion: applicationCompletion,
    ...package2,
    approval_safety: eligibility.approval_safety,
    status: selectedResume?.approved_at ? 'PACKAGE_READY' : 'NEEDS_USER_INPUT',
    // The user's per-category sensitive policy AT BUILD TIME: the executor may
    // auto-fill a confirmed sensitive answer only for these categories.
    sensitive_reuse_categories: [...sensitiveReuseCategories],
    timestamps: {
      created_at: now,
      updated_at: now
    },
    application_profile: applicationProfile,
    form_answers: formAnswers
  };
}

function buildSummary({ job, formAnswers, packageId }) {
  const autoFill = formAnswers.answers.map((answer) => `- ${answer.category}: ${answer.id}`).join('\n') || '- None; no approved real-application answers are available.';
  const review = formAnswers.requires_review.map((answer) => `- ${answer.category}: ${answer.id}`).join('\n') || '- Any site-specific, salary, start date, visa/sponsorship, EEO, or references questions.';
  return `# Application Package Preview\n\nPackage ID: ${packageId}\n\n## Job\n\n- Title: ${job.title || ''}\n- Company: ${job.company || ''}\n- Location: ${job.location || job.country_or_region || ''}\n- Provider: ${job.provider || ''}\n- ATS: ${job.ats || ''}\n- URL: ${job.url || ''}\n- Apply URL: ${job.apply_url || job.url || ''}\n- Score: ${job.match_score || 0}\n- Page Type: ${job.page_type || 'unknown'}\n- Recommended Decision: ${job.recommended_decision || 'manual_review'}\n\n## Auto-fill Eligible Fields\n\n${autoFill}\n\n## Must Review Manually\n\n${review}\n\n## Safety\n\n- Does not open webpages.\n- Does not click Apply, Submit, Send, Confirm, Continue, or Next.\n- Does not upload or attach a resume.\n- Does not log in.\n- Does not handle CAPTCHA/OTP.\n- Does not submit applications.\n`;
}

export function buildApplicationPackagePreview(jobId, { resumeId = '', careerProfileId = '' } = {}) {
  if (!jobId) {
    const err = new Error('Missing --job-id');
    err.code = 'BAD_ARGS';
    throw err;
  }

  const jobs = readJson(path.join(dataDir, 'jobs_shortlist.json'), []);
  const reviews = readJson(path.join(dataDir, 'job_reviews.json'), []);
  const questionBank = readJson(path.join(dataDir, 'question_bank.json'), { answers: [] });
  const resumeProfiles = readJson(path.join(dataDir, 'resume_profiles.json'), { items: [] });
  const careerBrain = normalizeCareerBrainStore(readJson(path.join(dataDir, 'career_profiles.local.json'), {}));
  const selectedCareerProfileId = String(careerProfileId || careerBrain.active_profile_id || '');
  const careerProfile = careerBrain.profiles.find(item => item.id === selectedCareerProfileId) || null;
  readJson(path.join(dataDir, 'dashboard_state.json'), {});

  const job = jobs.find((item) => String(item?.job_id) === String(jobId));
  const review = latestReviewFor(jobId, reviews);
  assertPackageAllowed(job, review);
  const reviewedProfile = reviewedCareerApplicationProfile(careerProfile);
  if (!reviewedProfile) {
    throw profileGateError('Approve the active Career Profile before building an Application Package.', {
      failures: ['active_career_profile_not_approved'],
      active_profile_id: careerBrain.active_profile_id || '',
      selected_profile_id: selectedCareerProfileId
    });
  }
  const { profile_path, validator_report } = reviewedProfile;
  const transientResumeSelection = selectBestResumeProfile(resumeProfiles, job, {
    preferredResumeId: resumeId
  });

  const safeJobId = safeSegment(jobId);
  const createdAt = new Date().toISOString();
  const packageId = `package_${safeJobId}_${createdAt.replace(/[:.]/g, '-')}`;
  const outputDir = path.join(applicationsDir, safeJobId);
  const relOutputDir = path.relative(root, outputDir);

  const jobSnapshot = {
    job_id: job.job_id,
    title: job.title,
    company: job.company,
    location: job.location || job.country_or_region || '',
    provider: job.provider,
    ats: job.ats,
    url: job.url,
    apply_url: job.apply_url || job.url,
    match_score: job.match_score,
    match_reasons: job.match_reasons || [],
    page_type: job.page_type,
    recommended_decision: job.recommended_decision
  };
  let sensitiveReuseCategories = [];
  try {
    const preferences = normalizeSearchPreferences(
      JSON.parse(fs.readFileSync(path.join(dataDir, 'search_preferences.json'), 'utf8'))
    ).value;
    sensitiveReuseCategories = Object.entries(preferences.safety?.sensitive_policies || {})
      .filter(([, policy]) => policy === 'reuse')
      .map(([category]) => category);
  } catch {
    sensitiveReuseCategories = [];
  }
  const packageDocuments = createApplicationPackageDocuments({
    job,
    review,
    questionBank,
    resumeProfiles,
    careerProfile,
    resumeId,
    sensitiveReuseCategories,
    now: createdAt
  });
  const applicationProfile = packageDocuments.application_profile;
  const formAnswers = packageDocuments.form_answers;
  const manifest = {
    application_id: packageDocuments.application_id,
    package_id: packageId,
    job_id: String(jobId),
    created_at: createdAt,
    files: [
      'job_snapshot.json',
      'application_profile.json',
      'form_answers.json',
      'application_package.json',
      'package_summary.md',
      'package_manifest.json'
    ],
    safety_flags: {
      browser_opened: false,
      application_form_opened: false,
      apply_submit_clicked: false,
      login_attempted: false,
      resume_uploaded: false,
      captcha_otp_handled: false,
      chrome_extension_modified: false,
      automatic_submission: false,
      allow_final_submit: false,
      allow_resume_attach: false,
      application_mode: 'REVIEW_ONLY'
    },
    package_status: 'preview_created',
    profile_path,
    profile_validation_status: validator_report.status || 'valid'
  };

  fs.mkdirSync(outputDir, { recursive: true });
  writeJson(path.join(outputDir, 'job_snapshot.json'), jobSnapshot);
  writeJson(path.join(outputDir, 'application_profile.json'), applicationProfile);
  writeJson(path.join(outputDir, 'form_answers.json'), formAnswers);
  writeJson(path.join(outputDir, 'application_package.json'), packageDocuments);
  fs.writeFileSync(path.join(outputDir, 'package_summary.md'), buildSummary({ job, formAnswers, packageId }), 'utf8');
  writeJson(path.join(outputDir, 'package_manifest.json'), manifest);

  return {
    status: 'ok',
    package_status: 'preview_created',
    package_id: packageId,
    application_id: packageDocuments.application_id,
    job_id: String(jobId),
    package_path: relOutputDir,
    files: manifest.files.map((file) => path.join(relOutputDir, file)),
    summary: {
      title: job.title,
      company: job.company,
      auto_fill_answer_count: formAnswers.answers.length,
      requires_review_count: formAnswers.requires_review.length,
      application_completion_rate: packageDocuments.application_completion.application_completion_rate,
      completion_blocker_count: packageDocuments.application_completion.blockers.length,
      estimated_user_review_seconds: packageDocuments.application_completion.estimated_user_review_seconds,
      candidate_fact_count: packageDocuments.resume_intelligence.summary.available_fact_count,
      core_fact_coverage_percent: packageDocuments.resume_intelligence.summary.core_fact_coverage_percent,
      safety_flags: manifest.safety_flags,
      profile_path,
      profile_validation_status: validator_report.status || 'valid'
    },
    resume_selection: {
      ...transientResumeSelection.selection,
      selected_resume: transientResumeSelection.selected_resume ? {
        resume_id: transientResumeSelection.selected_resume.resume_id,
        name: transientResumeSelection.selected_resume.name,
        version: transientResumeSelection.selected_resume.version
      } : null,
      recommended_resume: transientResumeSelection.recommended_resume ? {
        resume_id: transientResumeSelection.recommended_resume.resume_id,
        name: transientResumeSelection.recommended_resume.name,
        version: transientResumeSelection.recommended_resume.version
      } : null
    }
  };
}

if (isMainModule(import.meta.url)) {
  try {
    const { jobId, resumeId } = parseArgs(process.argv);
    console.log(JSON.stringify(buildApplicationPackagePreview(jobId, { resumeId }), null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      status: 'blocked',
      code: err.code || 'ERROR',
      reason: err.reason || err.code || 'error',
      message: err.code === 'PROFILE_MISSING_OR_INVALID' ? 'profile_missing_or_invalid' : err.message,
      display_message: err.code === 'PROFILE_MISSING_OR_INVALID' ? 'Profile required before package preview' : err.message,
      failures: err.failures || [],
      details: err.details || {}
    }, null, 2));
    process.exit(err.code === 'PACKAGE_BLOCKED' ? 2 : 1);
  }
}
