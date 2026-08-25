// Match scoring for search results: the existing dimension evaluator
// (candidate_matching.mjs) fed from the ONLINE career profile, condensed into
// { match_score, why_fit, main_gaps } for every surviving job.
import { normalizeCareerProfile } from './career_brain.mjs';
import { evaluateCandidateJobDimensions } from './candidate_matching.mjs';
import {
  allProfileText, extractSkills, careerTermsForMatching, estimateYears, educationLevel, profileLocations,
} from './profile_signals.mjs';

const text = value => String(value ?? '').trim();

// Build the matching context by MINING the whole profile — real resumes bury
// their content in free-text fields (responsibilities, project descriptions)
// and leave role/company/skills empty, so reading only the structured fields
// (the old behaviour) dropped everything. Skills are mined from all text,
// career directions are derived from education + experience + goals, and both
// are bilingual-expanded so a Chinese profile matches English postings.
export function matchingContextFromCareerProfile(careerProfile = {}) {
  const profile = normalizeCareerProfile(careerProfile);
  const skills = extractSkills(profile);
  const careerTerms = careerTermsForMatching(profile);
  const years = estimateYears(profile);
  const eduLevel = educationLevel(profile);
  const experience = Array.isArray(profile.experience) ? profile.experience : [];
  // Entry-level. Structured employment (role/company present) is strong
  // evidence; years mined from free-text bullets are weak. A degree with NO
  // structured employment is a new grad unless the text-mined years clearly
  // say otherwise (>3 — protects experienced people whose parse failed).
  // Mirrors the search planner's signal so detection and ranking agree.
  const hasDegree = (profile.education || []).some(entry => String(entry?.degree || entry?.field_of_study || '').trim());
  const hasStructuredExperience = experience.some(item => String(item?.role || item?.title || item?.company || '').trim());
  const textYears = Number.isFinite(years) && years > 0 ? years : null;
  const entryLevel = hasDegree && !hasStructuredExperience
    ? (textYears == null || textYears <= 3)
    : (textYears != null && textYears <= 1);
  return {
    available: skills.length > 0 || careerTerms.length > 0 || experience.length > 0,
    profile_approved: careerProfile?.user_approved === true,
    skills,
    career_terms: careerTerms,
    experience_text: allProfileText(profile),
    years_experience: years,
    entry_level: entryLevel,
    // Include the derived level as a term so bilingual degrees (本科) are seen.
    education_terms: [
      ...(profile.education || []).map(entry => [entry.degree, entry.field_of_study, entry.institution].join(' ')).filter(Boolean),
      eduLevel,
    ].filter(Boolean),
    location_terms: profileLocations(profile),
    fact_count: skills.length + careerTerms.length + experience.length,
    confirmed_fact_count: skills.length + careerTerms.length,
    average_confidence: 0.9,
  };
}

export function scoreJobForSearch(job = {}, context = {}, { preferredLocations = [], minimumSalary = null } = {}) {
  const dimensions = evaluateCandidateJobDimensions(job, context, { preferredLocations, minimumSalary });
  const scored = Object.entries(dimensions)
    .filter(([, value]) => value && typeof value === 'object' && Number.isFinite(value.score));
  const meanScore = scored.length
    ? Math.round(scored.reduce((sum, [, value]) => sum + value.score, 0) / scored.length)
    : null;
  // A catastrophic level mismatch must not survive as "one vote among equals":
  // the seniority cap keeps a Director/EM posting under the recommendation
  // threshold for an entry-level candidate no matter how well the keywords
  // overlap.
  const matchScore = meanScore == null
    ? null
    : Math.min(meanScore, Number.isFinite(dimensions.seniority_cap) ? dimensions.seniority_cap : 100);

  const whyFit = [];
  const mainGaps = [];
  for (const [name, value] of Object.entries(dimensions)) {
    if (!value || typeof value !== 'object') continue;
    if (value.status === 'matched') {
      const evidence = (value.matched || []).slice(0, 4).join(', ');
      whyFit.push(evidence ? `${name}: ${evidence}` : name);
    } else if (['no_overlap', 'below_minimum', 'mismatch'].includes(value.status)) {
      const required = (value.required || []).slice(0, 3).join(', ') || value.required_years || value.reason || '';
      mainGaps.push(required ? `${name}: ${required}` : name);
    }
  }
  return {
    match_score: matchScore,
    why_fit: whyFit.slice(0, 5),
    main_gaps: mainGaps.slice(0, 5),
    dimensions,
  };
}
