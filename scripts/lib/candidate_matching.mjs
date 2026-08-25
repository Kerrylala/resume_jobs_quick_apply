function text(value) {
  return String(value ?? '').trim();
}

function normalized(value) {
  return text(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}+#.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function strings(value) {
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return text(value) ? [text(value)] : [];
}

function unique(values) {
  const seen = new Set();
  return values.filter(value => {
    const key = normalized(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function factMap(intelligence) {
  return new Map(
    (Array.isArray(intelligence?.facts) ? intelligence.facts : [])
      .filter(fact => fact?.fact_key)
      .map(fact => [fact.fact_key, fact])
  );
}

function factValues(facts, keys) {
  return unique(keys.flatMap(key => strings(facts.get(key)?.value)));
}

function numericYears(value) {
  const number = Number.parseFloat(firstNumber(strings(value).join(' ')));
  return Number.isFinite(number) ? number : null;
}

function firstNumber(value) {
  return String(value || '').match(/\d+(?:\.\d+)?/)?.[0] || '';
}

export function buildCandidateMatchingContext({ resumeIntelligence = null } = {}) {
  const facts = factMap(resumeIntelligence);
  const skillKeys = [
    'skills',
    'programming_languages',
    'product_skills',
    'data_skills',
    'ai_skills',
    'tools',
    'domain_keywords',
    'certifications'
  ];
  const careerKeys = ['desired_role', 'target_roles'];
  const experienceKeys = ['summary', 'work_experience', 'internships', 'projects', 'leadership'];
  const educationKeys = ['degree', 'major', 'discipline', 'school', 'relevant_coursework'];
  const locationKeys = ['current_location', 'city', 'state_or_province', 'country'];
  const sourceFacts = [...facts.values()];
  return {
    available: sourceFacts.length > 0,
    profile_approved: resumeIntelligence?.profile_approved === true,
    resume_id: text(resumeIntelligence?.resume_id),
    skills: factValues(facts, skillKeys),
    career_terms: factValues(facts, careerKeys),
    experience_text: factValues(facts, experienceKeys).join(' '),
    years_experience: numericYears(facts.get('years_experience')?.value),
    education_terms: factValues(facts, educationKeys),
    location_terms: factValues(facts, locationKeys),
    fact_count: sourceFacts.length,
    confirmed_fact_count: sourceFacts.filter(fact => fact.user_confirmed === true).length,
    average_confidence: sourceFacts.length
      ? Number((sourceFacts.reduce((sum, fact) => sum + Number(fact.confidence || 0), 0) / sourceFacts.length).toFixed(2))
      : 0
  };
}

function dimension(status, score, evidence = {}) {
  return { status, score: score == null ? null : Math.max(0, Math.min(100, Math.round(score))), ...evidence };
}

function matchesInText(terms, value) {
  const haystack = normalized(value);
  return terms.filter(term => {
    const needle = normalized(term);
    return needle && haystack.includes(needle);
  });
}

function requiredExperience(value) {
  const source = String(value || '');
  const candidates = [
    // "8+ years of engineering experience" — up to three qualifier words may
    // sit between "years" and "experience"; the old exact form missed them.
    ...[...source.matchAll(/(?:at least|minimum|min\.?|requires?|with)?\s*(\d+(?:\.\d+)?)\+?\s+years?\s+(?:of\s+)?(?:[a-zA-Z-]+\s+){0,3}?experience/gi)]
      .map(match => Number(match[1])),
    // "3年以上相关工作经验"
    ...[...source.matchAll(/(\d+(?:\.\d+)?)\s*年(?:以上)?[^，。；,;]{0,8}?经验/g)]
      .map(match => Number(match[1]))
  ].filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : null;
}

// Job seniority from the TITLE only — descriptions mention "work with senior
// engineers" incidentally, so they must never classify. Ranks: 0 entry/intern,
// 1 junior, 3 senior, 4 staff/principal/lead, 5 engineering management,
// 6 director+. Unlevelled titles return null (neutral: scoring is unchanged).
// Precision first: profession titles that merely CONTAIN a level word
// (Product/Project/Account Manager, 产品经理) are NOT people-management
// seniority and stay unlevelled unless another pattern (Senior …) matches.
const JOB_SENIORITY_PATTERNS = [
  [/\b(?:intern|internship)\b|实习/i, 0],
  [/\bnew ?grad(?:uate)?\b|\bentry[- ]?level\b|\bgraduate (?:engineer|program|scheme)\b|\bcampus\b|\bearly career\b|应届|校招|培训生/i, 0],
  [/\bjunior\b|\bjr\.?\b|初级/i, 1],
  [/\bsenior\b|\bsr\.?\b|高级|资深/i, 3],
  [/\bstaff (?:software |data |platform |product |security |machine learning )?engineer\b|\bprincipal\b|\bdistinguished\b|\barchitect\b|专家/i, 4],
  [/\btech(?:nical)? lead\b|\bteam lead\b|\blead (?:software |data |backend |frontend |full[- ]?stack |platform |machine learning )?(?:engineer|developer|scientist)\b|技术负责人/i, 4],
  [/\bengineering manager\b|\b(?:software|development|platform|infrastructure) manager\b|\bmanager,/i, 5],
  [/(?:研发|技术|工程|开发)经理|技术主管/, 5],
  [/\bdirector\b|\bhead of\b|\bvp\b|\bvice president\b|\bchief\b|\bcto\b|总监|副总裁|首席/i, 6]
];

export function classifyJobSeniority(job = {}) {
  const explicit = normalized(job.seniority || job.likely_seniority || job.experience_level || '');
  const title = String(job.title || '');
  const haystacks = [title, explicit].filter(Boolean);
  let rank = null;
  for (const haystack of haystacks) {
    for (const [pattern, level] of JOB_SENIORITY_PATTERNS) {
      if (pattern.test(haystack)) rank = rank == null ? level : Math.max(rank, level);
    }
  }
  return rank;
}

function candidateLevelRank(context = {}) {
  if (context.entry_level === true) return 0;
  const years = Number(context.years_experience);
  if (!Number.isFinite(years) || context.years_experience == null) return null;
  if (years <= 1.5) return 0;
  if (years < 3) return 1;
  if (years < 6) return 2;
  return 3;
}

function educationRequirement(value) {
  const source = normalized(value);
  const raw = String(value ?? '');
  if (/\b(phd|ph d|doctorate|doctoral)\b/.test(source) || /博士/.test(raw)) return 'doctorate';
  if (/\b(master|masters|msc|m sc|mba)\b/.test(source) || /硕士|研究生/.test(raw)) return 'masters';
  if (/\b(bachelor|bachelors|bsc|b sc|undergraduate degree)\b/.test(source) || /本科|学士/.test(raw)) return 'bachelors';
  return '';
}

function candidateEducationLevel(terms) {
  // The context already carries a derived level token ('bachelors'…); honor it
  // directly, else parse the raw education terms (bilingual).
  const joined = terms.join(' ');
  if (/\bdoctorate\b/i.test(joined)) return 'doctorate';
  if (/\bmasters\b/i.test(joined)) return 'masters';
  if (/\bbachelors\b/i.test(joined)) return 'bachelors';
  return educationRequirement(joined);
}

const EDUCATION_RANK = Object.freeze({ bachelors: 1, masters: 2, doctorate: 3 });

export function evaluateCandidateJobDimensions(job = {}, context = {}, {
  preferredLocations = [],
  minimumSalary = null
} = {}) {
  const jobText = [job.title, job.description_text, job.description, job.snippet, ...(job.skills || [])].filter(Boolean).join(' ');
  const explicitSkills = unique([...(Array.isArray(job.required_skills) ? job.required_skills : []), ...(Array.isArray(job.skills) ? job.skills : [])]);
  const matchedSkills = matchesInText(context.skills || [], jobText);
  const matchedExplicitSkills = explicitSkills.filter(requirement =>
    (context.skills || []).some(skill => {
      const left = normalized(skill);
      const right = normalized(requirement);
      return left && right && (left.includes(right) || right.includes(left));
    })
  );
  const technical = !(context.skills || []).length
    ? dimension('unknown', null, { reason: 'candidate_skills_missing', matched: [] })
    : explicitSkills.length
      ? dimension(
          matchedExplicitSkills.length ? 'matched' : 'no_overlap',
          100 * matchedExplicitSkills.length / explicitSkills.length,
          { matched: matchedExplicitSkills, required: explicitSkills }
        )
      : dimension(
          matchedSkills.length ? 'matched' : 'no_overlap',
          matchedSkills.length ? Math.min(100, 50 + matchedSkills.length * 10) : 0,
          { matched: matchedSkills, candidate_skills_considered: context.skills.length }
        );

  const requiredYears = requiredExperience(jobText);
  const experience = context.years_experience == null
    ? dimension('unknown', null, { reason: 'candidate_years_experience_missing', required_years: requiredYears })
    : requiredYears == null
      ? dimension('evidence_available', null, { candidate_years: context.years_experience, required_years: null })
      : dimension(
          context.years_experience >= requiredYears ? 'matched' : 'below_requirement',
          context.years_experience >= requiredYears ? 100 : 100 * context.years_experience / requiredYears,
          { candidate_years: context.years_experience, required_years: requiredYears }
        );

  const requiredEducation = educationRequirement(jobText);
  const candidateEducation = candidateEducationLevel(context.education_terms || []);
  const education = !requiredEducation
    ? dimension('not_required', null, { candidate_level: candidateEducation || null })
    : !candidateEducation
      ? dimension('unknown', null, { reason: 'candidate_education_missing', required_level: requiredEducation })
      : dimension(
          EDUCATION_RANK[candidateEducation] >= EDUCATION_RANK[requiredEducation] ? 'matched' : 'below_requirement',
          EDUCATION_RANK[candidateEducation] >= EDUCATION_RANK[requiredEducation] ? 100 : 40,
          { candidate_level: candidateEducation, required_level: requiredEducation }
        );

  const jobLocation = text(job.location || job.country_or_region);
  const remote = /\bremote\b/i.test(jobLocation) || /\bremote\b/i.test(text(job.remote_policy || job.workplace_mode));
  const candidateLocationMatches = matchesInText(context.location_terms || [], jobLocation);
  const preferredLocationMatches = matchesInText(preferredLocations, jobLocation);
  const location = remote
    ? dimension('matched', 100, { reason: 'remote_job', matched: ['remote'] })
    : !(context.location_terms || []).length && !preferredLocations.length
      ? dimension('unknown', null, { reason: 'candidate_and_search_locations_missing', matched: [] })
      : dimension(
          candidateLocationMatches.length || preferredLocationMatches.length ? 'matched' : 'no_match',
          candidateLocationMatches.length || preferredLocationMatches.length ? 100 : 0,
          { matched: unique([...candidateLocationMatches, ...preferredLocationMatches]) }
        );

  const salaryValue = Number(job.salary_min ?? job.min_salary);
  const salary = minimumSalary == null
    ? dimension('not_configured', null)
    : Number.isFinite(salaryValue)
      ? dimension(salaryValue >= Number(minimumSalary) ? 'matched' : 'below_minimum', salaryValue >= Number(minimumSalary) ? 100 : 0, {
          job_minimum: salaryValue,
          candidate_minimum: Number(minimumSalary)
        })
      : dimension('unknown', null, { reason: 'job_salary_missing', candidate_minimum: Number(minimumSalary) });

  const careerMatches = matchesInText(context.career_terms || [], `${job.title || ''} ${job.description_text || job.description || ''}`);
  const career = !(context.career_terms || []).length
    ? dimension('unknown', null, { reason: 'candidate_career_direction_missing', matched: [] })
    : dimension(careerMatches.length ? 'matched' : 'no_match', careerMatches.length ? 100 : 0, {
        matched: careerMatches,
        candidate_terms: context.career_terms
      });

  // Seniority: a topical-overlap score must never recommend an Engineering
  // Manager posting to a new grad. Unknown on either side stays neutral
  // (unlevelled titles keep today's scores exactly); a big gap zeroes the
  // dimension AND caps the final score below the recommendation threshold.
  const jobLevel = classifyJobSeniority(job);
  const candidateLevel = candidateLevelRank(context);
  const levelGap = jobLevel == null || candidateLevel == null ? null : jobLevel - candidateLevel;
  const seniority = levelGap == null
    ? dimension('unknown', null, {
        reason: jobLevel == null ? 'job_level_not_stated' : 'candidate_level_unknown',
        job_level_rank: jobLevel, candidate_level_rank: candidateLevel
      })
    : levelGap <= 1
      ? dimension('matched', levelGap <= 0 ? 100 : 80, { job_level_rank: jobLevel, candidate_level_rank: candidateLevel })
      : levelGap === 2
        ? dimension('above_level', 40, { job_level_rank: jobLevel, candidate_level_rank: candidateLevel })
        : dimension('mismatch', 0, {
            reason: 'job_level_far_above_candidate',
            job_level_rank: jobLevel, candidate_level_rank: candidateLevel
          });
  const seniorityCap = levelGap == null ? 100 : levelGap >= 5 ? 45 : levelGap >= 3 ? 55 : levelGap === 2 ? 65 : 100;

  const dimensions = { technical, experience, education, location, salary, career_direction: career, seniority };
  const weighted = [
    ['technical', 30],
    ['experience', 20],
    ['education', 10],
    ['location', 15],
    ['salary', 10],
    ['career_direction', 15],
    ['seniority', 20]
  ].filter(([key]) => Number.isFinite(dimensions[key].score));
  const totalWeight = weighted.reduce((sum, [, weight]) => sum + weight, 0);
  const candidateFitScore = totalWeight
    ? Math.round(weighted.reduce((sum, [key, weight]) => sum + dimensions[key].score * weight, 0) / totalWeight)
    : null;
  const adjustment = Math.max(-10, Math.min(10,
    (technical.status === 'matched' ? 5 : technical.status === 'no_overlap' ? -3 : 0)
    + (experience.status === 'matched' ? 3 : experience.status === 'below_requirement' ? -4 : 0)
    + (education.status === 'matched' ? 1 : education.status === 'below_requirement' ? -2 : 0)
    + (career.status === 'matched' ? 4 : career.status === 'no_match' ? -4 : 0)
    + (seniority.status === 'mismatch' ? -6 : seniority.status === 'above_level' ? -3 : 0)
  ));
  return {
    ...dimensions,
    candidate_fit_score: candidateFitScore,
    score_adjustment: adjustment,
    seniority_cap: seniorityCap,
    candidate_context: {
      available: context.available === true,
      profile_approved: context.profile_approved === true,
      resume_id: context.resume_id || '',
      fact_count: Number(context.fact_count || 0),
      confirmed_fact_count: Number(context.confirmed_fact_count || 0),
      average_confidence: Number(context.average_confidence || 0)
    }
  };
}
