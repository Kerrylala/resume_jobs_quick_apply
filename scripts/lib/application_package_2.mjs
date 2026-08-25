import { normalizeCareerProfile } from './career_brain.mjs';

function text(value, max = 2000) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function list(value, max = 20) {
  return Array.isArray(value) ? value.map(item => text(item)).filter(Boolean).slice(0, max) : [];
}

function proseFragment(value, max = 240) {
  return text(value, max).replace(/\s+/g, ' ').replace(/[.;,:!?]+$/g, '');
}

function riskLevel({ sensitiveQuestions = [], unansweredQuestions = [], profileApproved = false } = {}) {
  if (sensitiveQuestions.length) return 'high';
  if (unansweredQuestions.length || !profileApproved) return 'medium';
  return 'low';
}

function interviewQuestions(job, hybridMatch) {
  const role = text(job?.title) || 'this role';
  const company = text(job?.company) || 'the company';
  const questions = [
    `Why are you interested in ${role} at ${company}?`,
    `Which verified experience best demonstrates your readiness for ${role}?`
  ];
  for (const missing of list(hybridMatch?.missing, 4)) questions.push(`How would you address the current gap in ${proseFragment(missing, 300)}?`);
  for (const weakness of list(hybridMatch?.weaknesses, 3)) questions.push(`What evidence can you share about ${proseFragment(weakness, 300)}?`);
  return [...new Set(questions)].slice(0, 8);
}

function coverLetterSection({ draft = {}, job = {}, profile = {}, hybridMatch = null } = {}) {
  const existing = text(draft?.content, 20_000);
  if (existing) {
    return {
      content: existing,
      status: text(draft?.status) || 'draft_ready',
      provenance: text(draft?.provenance) || 'user_or_model_draft',
      requires_review: draft?.requires_review !== false
    };
  }
  const role = text(job?.title);
  const company = text(job?.company);
  const evidence = list(hybridMatch?.strengths, 3).map(item => proseFragment(item)).filter(Boolean);
  if (profile.user_approved && role && company && evidence.length) {
    const growth = proseFragment(hybridMatch?.career_growth_value || hybridMatch?.career_reason, 500)
      .replace(/^(high|medium|low)(\s*\([^)]*\))?\s*[.:-]\s*/i, '');
    return {
      content: [
        `Dear ${company} Hiring Team,`,
        `I am interested in the ${role} opportunity. The strongest evidence from my reviewed career profile is: ${evidence.join('; ')}.`,
        growth
          ? `I am also interested in the role's growth path: ${growth}.`
          : 'I would welcome the opportunity to discuss how my verified experience can contribute to the team.',
        'Thank you for your consideration.'
      ].join('\n\n'),
      status: 'draft_ready',
      provenance: 'deterministic_verified_profile_and_match',
      requires_review: true
    };
  }
  return {
    content: '',
    status: text(draft?.status) || 'needs_user_input',
    provenance: text(draft?.provenance) || 'not_generated',
    requires_review: true
  };
}

export function buildApplicationPackage2Sections({
  job = {},
  careerProfile = {},
  selectedResume = null,
  plannedAnswers = [],
  unansweredQuestions = [],
  sensitiveQuestions = [],
  coverLetterDraft = {},
  hybridMatch = null,
  now = new Date().toISOString()
} = {}) {
  const profile = normalizeCareerProfile(careerProfile, { now });
  const stories = profile.interview_stories.map(story => ({
    id: story.id,
    title: story.title,
    situation: story.situation,
    task: story.task,
    action: story.action,
    result: story.result,
    skills: story.skills,
    user_confirmed: story.user_confirmed,
    requires_review: story.user_confirmed !== true
  }));
  const risk = riskLevel({
    sensitiveQuestions,
    unansweredQuestions,
    profileApproved: profile.user_approved
  });
  const missingSkills = [...new Set([
    ...list(hybridMatch?.skill_gaps),
    ...list(hybridMatch?.weaknesses),
    ...list(hybridMatch?.missing)
  ])].slice(0, 20);
  const coverLetter = coverLetterSection({
    draft: coverLetterDraft,
    job,
    profile,
    hybridMatch
  });
  return {
    package_version: '2.0',
    job_information: {
      job_id: text(job.job_id),
      company: text(job.company),
      role: text(job.title),
      location: text(job.location),
      country: text(job.country || job.country_or_region),
      remote: text(job.remote || job.remote_policy),
      salary: job.salary && typeof job.salary === 'object' ? job.salary : { text: text(job.salary) },
      url: text(job.url, 2000),
      source: text(job.source),
      source_type: text(job.source_type),
      match: hybridMatch || null
    },
    career_profile_reference: {
      profile_id: profile.id,
      family_id: profile.family_id,
      name: profile.name,
      version: profile.version,
      user_approved: profile.user_approved,
      approved_at: profile.approved_at
    },
    recommended_resume: selectedResume ? {
      resume_id: text(selectedResume.resume_id),
      name: text(selectedResume.name),
      version: Number(selectedResume.version || 1),
      content_hash: text(selectedResume.content_hash),
      user_approved: Boolean(selectedResume.approved_at)
    } : null,
    cover_letter: coverLetter,
    application_answers: plannedAnswers.map(answer => ({
      question_id: text(answer.question_id),
      canonical_key: text(answer.canonical_key),
      original_question: text(answer.original_question, 2000),
      normalized_question: text(answer.normalized_question, 2000),
      question_patterns: list(answer.question_patterns, 50),
      question_variants: list(answer.question_variants, 25),
      value: text(answer.value ?? answer.answer, 5000),
      source: text(answer.source),
      confidence: Number(answer.confidence || 0),
      user_confirmed: answer.user_confirmed === true,
      sensitive_category: text(answer.sensitive_category) || 'none',
      risk_level: text(answer.risk_level) || 'normal',
      scope: text(answer.scope) || 'global',
      scope_key: text(answer.scope_key, 1000),
      version: Number(answer.version || 1),
      last_used: answer.last_used || null
    })),
    interview_preparation: {
      recommended_stories: stories,
      star_stories: stories,
      possible_questions: interviewQuestions(job, hybridMatch),
      match_strengths: list(hybridMatch?.strengths),
      missing_skills: missingSkills,
      gaps_to_prepare: missingSkills,
      requires_user_review: true
    },
    star_stories: stories,
    missing_skills: missingSkills,
    risk: {
      level: risk,
      reasons: [
        ...(sensitiveQuestions.length ? ['sensitive_answers_require_confirmation'] : []),
        ...(unansweredQuestions.length ? ['unanswered_questions_remain'] : []),
        ...(!profile.user_approved ? ['career_profile_not_approved'] : [])
      ]
    },
    generated_at: now,
    safety: {
      review_required: true,
      resume_attachment_allowed: false,
      final_submit_allowed: false,
      candidate_facts_invented: false
    }
  };
}
