import fs from 'fs';
import path from 'path';
import { createApprovalSafety } from './lib/approval_safety.mjs';
import { isMainModule, projectRootFromMetaUrl } from './lib/project_paths.mjs';
import { normalizeSearchPreferences } from './lib/search_preferences.mjs';
import { searchConfigurationFingerprint } from './lib/workflow_state.mjs';
import { normalizeResumeProfiles as normalizeResumeProfileRecords } from './lib/candidate_records.mjs';
import { buildResumeIntelligence } from './lib/resume_intelligence.mjs';
import {
  buildCandidateMatchingContext,
  evaluateCandidateJobDimensions
} from './lib/candidate_matching.mjs';
import { writeJsonAtomic } from './lib/json_repository.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const dataDir = path.resolve(process.env.RESUME_JOBS_DATA_DIR || path.join(root, 'data'));

const AGGREGATOR_DOMAINS = [
  'linkedin.com/jobs',
  'indeed.',
  'glassdoor.',
  'jobstreet.',
  'jobsdb.',
  'efinancialcareers.',
  'zhipin.com',
  'liepin.com',
  'boss直聘',
  '猎聘'
];
const ATS_PROVIDERS = new Set(['greenhouse', 'lever', 'ashby']);
const TRUSTED_PROVIDERS = new Set(['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'bamboohr', 'teamtailor', 'generic_company_careers', 'china_job_board']);
const BAD_LOCATION_RE = /\b(san francisco|sf bay area|bay area|nyc|new york)\b/i;
const SEARCH_TITLE_RE = /\b(greenhouse jobs|search jobs|jobs in|jobs at|job search|open jobs|all jobs|employment|with salaries)\b/i;
const GENERIC_COMPANY_RE = /^(jobs?|careers?|career|recruitment|recruiter|talent|hiring|laowaicareer|ycombinator|sg|www)$/i;
const LISTING_URL_RE = /\/(jobs\/role|role\/product-manager|search|jobs\?|jobs\.html|q-[^/?#]*-jobs|jobs\/role\/|jobs\/product-management\/search)\b|[?&](q|keyword|search)=/i;
const KNOWN_DIRECTORY_RE = /(accaglobal\.com\/job\/|laowaicareer\.com\/jobs|ycombinator\.com\/jobs\/role)/i;
const SINGLE_POSTING_URL_RE = /(greenhouse\.io\/[^/]+\/jobs\/\d+|boards\.greenhouse\.io\/[^/]+\/jobs\/\d+|lever\.co\/[^/]+\/[^/?#]+|jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{16,}|ashbyhq\.com\/[^/]+\/[^/?#]+\/[^/?#]+|jobs\.apple\.com\/[^/]+\/details\/\d+(?:-\d+)*\/[^/?#]+|gh_jid=|[?&](jobid|job_id|currentjobid|jk)=|\/job\/\d+|\/jobs\/\d+|\/jobs\/[0-9a-f-]{16,})/i;
const CAREERS_HOME_RE = /\bcareers at\b/i;
const PRODUCT_ANALYST_RE = /\b(product analyst|business analyst|data analyst)\b/i;
const NON_TARGET_ROLE_TITLE_RE = /\b(manager|engineer|developer|sales|recruiter|legal|security|compliance|finance|marketing|operations|consultant|director|head|lead)\b/i;
const UUID_LIKE_TITLE_RE = /^[0-9a-f]{8}[ -][0-9a-f]{4}[ -][0-9a-f]{4}[ -][0-9a-f]{4}[ -][0-9a-f]{12}$|^[0-9a-f]{32}$|^\d{5,}$/i;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function writeJson(file, value) {
  writeJsonAtomic(file, value);
}
function norm(value) { return String(value || '').toLowerCase(); }
function comparablePhrase(value) {
  return norm(value).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}
function clampScore(value) { return Math.max(0, Math.min(100, Math.round(value))); }
function uniqueBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeWeightedItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.enabled === true && String(item.keyword || '').trim())
    .map((item) => {
      const keyword = String(item.keyword).trim();
      const aliases = (Array.isArray(item.aliases) ? item.aliases : [])
        .map((alias) => String(alias || '').trim())
        .filter(Boolean);
      const terms = uniqueBy([keyword, ...aliases], (term) => norm(term));
      return {
        keyword,
        weight: Number.isFinite(Number(item.weight)) ? Number(item.weight) : 50,
        enabled: true,
        aliases,
        terms
      };
    });
}

function normalizeExcludedItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && item.enabled === true && String(item.keyword || '').trim())
    .map((item) => {
      const keyword = String(item.keyword).trim();
      return {
        keyword,
        reason: String(item.reason || 'excluded keyword'),
        enabled: true,
        terms: [keyword]
      };
    });
}

export function loadCandidateScoringContext() {
  const resumes = normalizeResumeProfileRecords(readJson(path.join(dataDir, 'resume_profiles.json'), { items: [] })).value;
  const activeResume = resumes.items.find(item =>
    item.resume_id === resumes.active_resume_id || item.id === resumes.active_resume_profile_id
  ) || null;
  const explicitProfilePath = String(process.env.RESUME_JOBS_PROFILE_PATH || '').trim();
  const resumeProfilePath = activeResume?.profile_file_path
    ? path.resolve(root, activeResume.profile_file_path)
    : '';
  const customDataDirectory = Boolean(String(process.env.RESUME_JOBS_DATA_DIR || '').trim());
  const fallbackCandidates = customDataDirectory
    ? []
    : [path.join(root, 'profile.local.json'), path.join(root, 'extensions/application_assistant/profile.local.json')];
  const profilePath = [explicitProfilePath ? path.resolve(explicitProfilePath) : '', resumeProfilePath, ...fallbackCandidates]
    .find(candidate => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) || '';
  const profile = profilePath ? readJson(profilePath, {}) : {};
  const resumeIntelligence = buildResumeIntelligence({ profile, selectedResume: activeResume });
  return buildCandidateMatchingContext({ resumeIntelligence });
}

export function loadScoringConfig() {
  const rawPrefs = readJson(path.join(dataDir, 'search_preferences.json'), {});
  const prefs = normalizeSearchPreferences(rawPrefs).value;
  return {
    raw: prefs,
    search_configuration_fingerprint: searchConfigurationFingerprint(prefs),
    scoring_config_version: String(prefs.schema_version || 'unknown'),
    target_roles: normalizeWeightedItems(prefs.target_roles),
    preferred_locations: normalizeWeightedItems(prefs.preferred_locations),
    preferred_companies: normalizeWeightedItems(prefs.preferred_companies),
    excluded_keywords: normalizeExcludedItems(prefs.excluded_keywords),
    excluded_companies: (prefs.excluded_companies || []).map(norm).filter(Boolean),
    required_skills: (prefs.required_skills || []).map(norm).filter(Boolean),
    preferred_skills: (prefs.preferred_skills || []).map(norm).filter(Boolean),
    workplace_modes: prefs.search_profiles?.find(profile => profile.id === prefs.active_search_profile_id)?.workplace_modes || ['any'],
    seniority_levels: prefs.seniority_allowed || ['any'],
    posted_within_days: Number(prefs.posted_within_days || 30),
    job_types: prefs.job_types || ['any'],
    minimum_salary: prefs.minimum_salary,
    maximum_jobs_to_open: Number(prefs.maximum_jobs_to_open || 5),
    work_authorization: prefs.work_authorization || null,
    safety: prefs.safety || {},
    scoring_weights: prefs.scoring_weights || {},
    thresholds: prefs.thresholds || {},
    candidate_context: loadCandidateScoringContext()
  };
}

function matchTerms(text, terms) {
  const haystack = norm(text);
  return (terms || []).filter(term => haystack.includes(norm(term)));
}

function inferSeniority(job) {
  const text = norm(`${job.seniority || job.likely_seniority || ''} ${job.title || ''}`);
  if (/\b(intern|internship)\b/.test(text)) return 'internship';
  if (/\b(entry|new grad|graduate|associate)\b/.test(text)) return 'entry';
  if (/\bjunior\b/.test(text)) return 'junior';
  if (/\b(mid|intermediate)\b/.test(text)) return 'mid';
  if (/\bsenior\b/.test(text)) return 'senior';
  if (/\blead\b/.test(text)) return 'lead';
  if (/\bmanager\b/.test(text)) return 'manager';
  return '';
}

function hardFilterJob(job, config, context) {
  const reasons = [];
  const uncertainty = [];
  const locationConfigured = config.preferred_locations.length > 0;
  if (locationConfigured && !context.preferredLocationMatch && !/\bremote\b/i.test(context.location)) reasons.push('location_not_allowed');
  const remotePolicy = norm(job.remote_policy || job.workplace_mode || (/\bremote\b/i.test(context.location) ? 'remote' : ''));
  if (!config.workplace_modes.includes('any')) {
    if (!remotePolicy) uncertainty.push('remote_policy_unknown');
    else if (!config.workplace_modes.some(mode => remotePolicy.includes(mode))) reasons.push('remote_policy_not_allowed');
  }
  const seniority = inferSeniority(job);
  if (!config.seniority_levels.includes('any')) {
    if (!seniority) uncertainty.push('seniority_unknown');
    else if (!config.seniority_levels.includes(seniority)) reasons.push('seniority_not_allowed');
  }
  if (context.excludedKeywordMatch) reasons.push('excluded_keyword_match');
  if (config.excluded_companies.some(company => norm(context.company).includes(company))) reasons.push('excluded_company_match');
  const postedAt = Date.parse(job.posted_at || job.published_at || '');
  if (Number.isFinite(postedAt)) {
    const ageDays = Math.floor((Date.now() - postedAt) / 86400000);
    if (ageDays > config.posted_within_days) reasons.push('posting_too_old');
  } else {
    uncertainty.push('posted_date_unknown');
  }
  const jobType = norm(job.job_type || job.employment_type);
  if (!config.job_types.includes('any')) {
    if (!jobType) uncertainty.push('job_type_unknown');
    else if (!config.job_types.some(type => jobType.includes(type))) reasons.push('job_type_not_allowed');
  }
  if (job.work_authorization_required && !config.work_authorization) uncertainty.push('work_authorization_not_user_confirmed');
  return { passed: reasons.length === 0, reasons: uniqueBy(reasons, value => value), uncertainty: uniqueBy(uncertainty, value => value), inferred_seniority: seniority };
}

function matchConfiguredItems(text, items) {
  const haystack = norm(text);
  const comparableHaystack = comparablePhrase(text);
  if (!haystack) return [];
  const matches = [];
  for (const item of items || []) {
    const matched_terms = (item.terms || [item.keyword]).filter((term) => {
      const rawTerm = norm(term);
      const comparableTerm = comparablePhrase(term);
      return haystack.includes(rawTerm) || Boolean(comparableTerm && comparableHaystack.includes(comparableTerm));
    });
    if (matched_terms.length) {
      matches.push({
        keyword: item.keyword,
        aliases: item.aliases || [],
        matched_terms,
        weight: item.weight,
        ...(item.reason ? { reason: item.reason } : {})
      });
    }
  }
  return matches;
}

function infoQualityScore(job) {
  const iq = job.info_quality || {};
  const score = Number(iq.score ?? 0);
  if (Number.isFinite(score) && score > 0) return score;
  let inferred = 0;
  if (job.title && !UUID_LIKE_TITLE_RE.test(String(job.title).trim())) inferred += 25;
  if (job.company) inferred += 15;
  if (job.location || job.country_or_region) inferred += 15;
  if (String(job.description_text || '').trim().length >= 120) inferred += 30;
  if (job.apply_url || job.url || job.job_url) inferred += 15;
  return Math.max(0, Math.min(100, inferred));
}

export function classifyPageType(job) {
  const url = norm(job.url || job.job_url);
  const title = norm(job.title);
  const provider = norm(job.provider || job.ats);
  const text = `${title} ${url} ${provider}`;

  if (job.page_type && ['job_detail', 'aggregator_search', 'company_careers_home', 'ats_company_board', 'unknown'].includes(job.page_type)) {
    return job.page_type;
  }

  if (AGGREGATOR_DOMAINS.some((needle) => text.includes(needle.toLowerCase()))) {
    if (/\/jobs\/view\//i.test(url) || /currentjobid=|jk=|jobid=|gh_jid=|lever\.co\/[^/]+\/[^/?#]+|jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{16,}|ashbyhq\.com\/[^/]+\/[^/?#]+\/[^/?#]+/i.test(url)) {
      return 'job_detail';
    }
    return 'aggregator_search';
  }

  if (ATS_PROVIDERS.has(provider)) {
    if (/gh_jid=|greenhouse\.io\/[^/]+\/jobs\/\d+|lever\.co\/[^/]+\/[^/?#]+|jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{16,}|ashbyhq\.com\/[^/]+\/[^/?#]+\/[^/?#]+/i.test(url)) {
      return 'job_detail';
    }
    return 'ats_company_board';
  }

  if (/\/careers?\/?$|\/jobs?\/?$|\/open-positions\/?$|\/join-us\/?$/i.test(url) || CAREERS_HOME_RE.test(title)) {
    return 'company_careers_home';
  }

  if (/jobs\.apple\.com\/[^/]+\/details\/\d+(?:-\d+)*\/[^/?#]+/i.test(url) && title && !SEARCH_TITLE_RE.test(title)) {
    return 'job_detail';
  }

  if (/\/jobs\/[^/?#]+|\/careers\/[^/?#]+|\/positions\/[^/?#]+|\/job\//i.test(url) && title && !SEARCH_TITLE_RE.test(title)) {
    return 'job_detail';
  }

  if (SEARCH_TITLE_RE.test(title)) return 'aggregator_search';
  return 'unknown';
}

function assessPostingEvidence(job, context) {
  const title = String(context.title || '');
  const company = String(context.company || '').trim();
  const url = String(context.url || '');
  const description = String(context.description || '');
  const pageType = context.pageType;
  const provider = context.provider;
  const qualityScore = context.qualityScore;

  const jobBoardReasons = [];
  const directReasons = [];
  const companyLower = norm(company);

  if (!company || GENERIC_COMPANY_RE.test(companyLower)) jobBoardReasons.push(`generic_or_directory_company:${company || 'missing'}`);
  if (LISTING_URL_RE.test(url)) jobBoardReasons.push('listing_or_search_url');
  if (KNOWN_DIRECTORY_RE.test(url)) jobBoardReasons.push('known_job_board_or_role_directory_domain');
  if (SEARCH_TITLE_RE.test(title)) jobBoardReasons.push('listing_or_search_title');
  if (/jobs? at/i.test(title)) jobBoardReasons.push('jobs_at_directory_title');
  if (/jobs? in/i.test(title)) jobBoardReasons.push('jobs_in_directory_title');
  if (/(job search|open jobs|all jobs|with salaries|employment)/i.test(title)) jobBoardReasons.push('job_collection_title');
  if (/ycombinator\.com\/jobs\/role/i.test(url)) jobBoardReasons.push('ycombinator_role_directory');
  if (/laowaicareer\.com\/jobs/i.test(url) && GENERIC_COMPANY_RE.test(companyLower)) jobBoardReasons.push('laowaicareer_without_extracted_employer');
  if (/accaglobal\.com\/job\//i.test(url) && GENERIC_COMPANY_RE.test(companyLower)) jobBoardReasons.push('accaglobal_without_extracted_employer');

  const singlePostingUrl = SINGLE_POSTING_URL_RE.test(url);
  const concreteCompany = Boolean(company) && !GENERIC_COMPANY_RE.test(companyLower);
  const singleTitle = Boolean(title.trim()) && !SEARCH_TITLE_RE.test(title) && !/jobs? (at|in)/i.test(title) && !/(job search|open jobs|all jobs|with salaries|employment)/i.test(title);
  const enoughContent = Boolean(description.trim()) || qualityScore >= 80;
  const verifiedAts = ATS_PROVIDERS.has(provider) && singlePostingUrl;

  if (pageType === 'job_detail') directReasons.push('page_type_job_detail');
  if (concreteCompany) directReasons.push('concrete_employer_company');
  if (singleTitle) directReasons.push('single_job_title');
  if (enoughContent) directReasons.push(description.trim() ? 'has_description_text' : 'info_quality_at_least_80');
  if (singlePostingUrl) directReasons.push('single_posting_url');
  if (verifiedAts) directReasons.push('verified_ats_single_posting');

  const jobBoardOrDirectoryEvidence = jobBoardReasons.length > 0;
  const directPostingEvidence = pageType === 'job_detail'
    && concreteCompany
    && singleTitle
    && enoughContent
    && !jobBoardOrDirectoryEvidence
    && (singlePostingUrl || verifiedAts || ['greenhouse', 'lever', 'ashby'].includes(provider));

  return {
    direct_posting_evidence: directPostingEvidence,
    direct_posting_reasons: uniqueBy(directPostingEvidence ? directReasons : directReasons.filter((reason) => reason !== 'page_type_job_detail'), (reason) => reason),
    job_board_or_directory_evidence: jobBoardOrDirectoryEvidence,
    job_board_or_directory_reasons: uniqueBy(jobBoardReasons, (reason) => reason)
  };
}

export function classifyJobSafety(job) {
  const cfg = loadScoringConfig();
  const scored = scoreJob(job, cfg);
  return {
    page_type: scored.page_type,
    approval_safety: scored.approval_safety,
    approval_warning: scored.approval_warning,
    recommended_decision: scored.recommended_decision,
    quality_flags: scored.quality_flags
  };
}

export function scoreJob(job, config = loadScoringConfig()) {
  config = {
    required_skills: [],
    preferred_skills: [],
    excluded_companies: [],
    workplace_modes: ['any'],
    seniority_levels: ['any'],
    posted_within_days: 30,
    job_types: ['any'],
    minimum_salary: null,
    maximum_jobs_to_open: 5,
    candidate_context: {},
    ...config
  };
  const pageType = classifyPageType(job);
  const title = String(job.title || '');
  const company = String(job.company || '');
  const location = String(job.location || job.country_or_region || '');
  // notes are internal provenance markers, never job content; evidence gates
  // must treat a content-free page as having no description.
  const description = String(job.description_text || job.description || job.snippet || job.search_snippet || '');
  const url = String(job.url || job.job_url || job.apply_url || '');
  const snippet = String(job.snippet || job.search_snippet || '');
  const provider = norm(job.provider || job.ats);

  const titleText = title;
  const roleBodyText = `${description} ${snippet}`;
  const weakRoleText = `${url} ${company}`;
  const locationPrimaryText = location;
  const locationSecondaryText = `${title} ${snippet} ${url}`;
  const companyText = `${company} ${title} ${url}`;

  const matchedTargetRolesTitle = matchConfiguredItems(titleText, config.target_roles);
  const matchedTargetRolesBody = matchConfiguredItems(roleBodyText, config.target_roles);
  const matchedTargetRolesWeak = matchConfiguredItems(weakRoleText, config.target_roles);
  const matchedTargetRoles = uniqueBy(
    [...matchedTargetRolesTitle, ...matchedTargetRolesBody, ...matchedTargetRolesWeak],
    (item) => item.keyword
  );
  const strongTargetRoleMatch = matchedTargetRolesTitle.length > 0;
  const mediumTargetRoleMatch = matchedTargetRolesBody.length > 0;
  const weakTargetRoleMatch = matchedTargetRolesWeak.length > 0;
  const targetRoleMatch = matchedTargetRoles.length > 0;

  const matchedPreferredLocationsPrimary = matchConfiguredItems(locationPrimaryText, config.preferred_locations);
  const matchedPreferredLocationsSecondary = matchConfiguredItems(locationSecondaryText, config.preferred_locations);
  const matchedPreferredLocations = uniqueBy(
    [...matchedPreferredLocationsPrimary, ...matchedPreferredLocationsSecondary],
    (item) => item.keyword
  );
  const preferredLocationMatch = matchedPreferredLocations.length > 0;

  const matchedPreferredCompanies = matchConfiguredItems(companyText, config.preferred_companies);
  const preferredCompanyMatch = matchedPreferredCompanies.length > 0;

  const matchedExcludedKeywordsTitle = matchConfiguredItems(title, config.excluded_keywords);
  const matchedExcludedKeywordsAll = matchConfiguredItems(`${title} ${description} ${snippet}`, config.excluded_keywords);
  const matchedExcludedKeywords = uniqueBy(
    [...matchedExcludedKeywordsTitle, ...matchedExcludedKeywordsAll],
    (item) => item.keyword
  );
  const excludedKeywordMatch = matchedExcludedKeywords.length > 0;
  const matchedRequiredSkills = matchTerms(`${title} ${description}`, config.required_skills);
  const matchedPreferredSkills = matchTerms(`${title} ${description}`, config.preferred_skills);
  const candidateDimensions = evaluateCandidateJobDimensions(job, config.candidate_context || {}, {
    preferredLocations: config.preferred_locations.map(item => item.keyword),
    minimumSalary: config.minimum_salary
  });

  const qualityScore = infoQualityScore(job);
  const missingDescription = !description.trim();
  const submitAllowed = job.submit_allowed === true;
  const uploadResumeAllowed = job.upload_resume_allowed === true;
  const finalSubmitAllowed = job.final_submit_allowed === true;
  const nonDetail = pageType !== 'job_detail';
  const searchOrBoardTitle = SEARCH_TITLE_RE.test(title) || (CAREERS_HOME_RE.test(title) && !targetRoleMatch);
  const uuidLikeTitle = UUID_LIKE_TITLE_RE.test(title.trim());
  const locationConflict = BAD_LOCATION_RE.test(`${title} ${location} ${company} ${url}`) && !preferredLocationMatch;
  const weakerProductAnalyst = PRODUCT_ANALYST_RE.test(title) && !strongTargetRoleMatch;
  const titleRoleMismatch = !strongTargetRoleMatch && (matchedExcludedKeywordsTitle.length > 0 || (!targetRoleMatch && NON_TARGET_ROLE_TITLE_RE.test(title)));
  const postingEvidence = assessPostingEvidence(job, { title, company, url, description, pageType, provider, qualityScore });
  const { direct_posting_evidence: directPostingEvidence, direct_posting_reasons: directPostingReasons, job_board_or_directory_evidence: jobBoardOrDirectoryEvidence, job_board_or_directory_reasons: jobBoardOrDirectoryReasons } = postingEvidence;
  const hardFilter = hardFilterJob(job, config, { title, company, location, preferredLocationMatch, excludedKeywordMatch });

  let score = Number(config.scoring_weights.base ?? 50);
  const scoreComponents = [];
  const add = (name, points, evidence = {}) => {
    const value = Number(points) || 0;
    score += value;
    scoreComponents.push({ name, points: value, ...evidence });
  };

  if (strongTargetRoleMatch) add('target_role_title_match', Number(config.scoring_weights.strong_role_match ?? 25), { matches: matchedTargetRolesTitle });
  if (!strongTargetRoleMatch && mediumTargetRoleMatch) add('target_role_description_match', Number(config.scoring_weights.medium_role_match ?? 15), { matches: matchedTargetRolesBody });
  if (!strongTargetRoleMatch && !mediumTargetRoleMatch && weakTargetRoleMatch) add('target_role_url_or_company_match', Number(config.scoring_weights.weak_role_match ?? 5), { matches: matchedTargetRolesWeak });

  if (matchedPreferredLocationsPrimary.length) add('preferred_location_primary_match', Number(config.scoring_weights.preferred_location ?? 10), { matches: matchedPreferredLocationsPrimary });
  if (!matchedPreferredLocationsPrimary.length && matchedPreferredLocationsSecondary.length) add('preferred_location_secondary_match', 4, { matches: matchedPreferredLocationsSecondary });

  if (preferredCompanyMatch) add('preferred_company_match', Number(config.scoring_weights.preferred_company ?? 15), { matches: matchedPreferredCompanies });
  if (TRUSTED_PROVIDERS.has(provider)) add('trusted_provider', 6, { provider });
  if (Number(job.confidence || 0) >= 0.8) add('high_provider_confidence', 5, { confidence: Number(job.confidence) });
  else if (Number(job.confidence || 0) < 0.45) add('low_provider_confidence', -5, { confidence: Number(job.confidence || 0) });

  if (excludedKeywordMatch) add('excluded_keyword_penalty', -25, { matches: matchedExcludedKeywords });
  if (locationConflict) add('location_conflict_penalty', -25, { location });
  if (searchOrBoardTitle) add('search_or_board_title_penalty', -18, { title });
  if (jobBoardOrDirectoryEvidence) add('job_board_or_directory_penalty', -18, { reasons: jobBoardOrDirectoryReasons });
  if (!directPostingEvidence) add('weak_direct_posting_evidence_penalty', -8, { reasons: directPostingReasons });
  if (uuidLikeTitle) add('uuid_like_title_penalty', -25, { title });
  if (qualityScore < 70) add('info_quality_below_70_penalty', -15, { info_quality: qualityScore });
  if (missingDescription) add('missing_description_penalty', -10);
  if (weakerProductAnalyst) add('weak_product_analyst_penalty', -8);
  if (config.required_skills.length) add('required_skills_match', Math.round(15 * matchedRequiredSkills.length / config.required_skills.length), { matches: matchedRequiredSkills });
  if (config.preferred_skills.length) add('preferred_skills_match', Math.round(8 * matchedPreferredSkills.length / config.preferred_skills.length), { matches: matchedPreferredSkills });
  if (candidateDimensions.score_adjustment) {
    add('candidate_profile_fit_adjustment', candidateDimensions.score_adjustment, {
      candidate_fit_score: candidateDimensions.candidate_fit_score,
      resume_id: candidateDimensions.candidate_context.resume_id
    });
  }
  if (!hardFilter.passed) add('hard_filter_penalty', -50, { reasons: hardFilter.reasons });

  const gateReasons = [];
  if (!targetRoleMatch) gateReasons.push('target_role_not_matched');
  if (titleRoleMismatch) gateReasons.push('title_role_mismatch');
  if (excludedKeywordMatch) gateReasons.push('excluded_keyword_match');
  if (nonDetail) gateReasons.push(`page_type_${pageType}_not_approvable`);
  if (qualityScore < 80 && !(description.trim() && directPostingEvidence)) gateReasons.push('info_quality_below_80_or_missing_direct_description');
  if (missingDescription && !directPostingEvidence) gateReasons.push('missing_description');
  if (!strongTargetRoleMatch && !(strongTargetRoleMatch && directPostingEvidence)) gateReasons.push('target_role_not_matched_in_title');
  if (!directPostingEvidence) gateReasons.push('weak_direct_posting_evidence');
  if (jobBoardOrDirectoryEvidence) gateReasons.push('job_board_or_directory');
  if (submitAllowed) gateReasons.push('submit_allowed_not_false');
  if (uploadResumeAllowed) gateReasons.push('upload_resume_allowed_not_false');
  if (finalSubmitAllowed) gateReasons.push('final_submit_allowed_not_false');
  if (config.safety.auto_approve === true || config.safety.auto_submit === true || config.safety.auto_upload_resume === true) gateReasons.push('settings_safety_disables_auto_approval');
  gateReasons.push(...hardFilter.reasons);

  let cap = 100;
  if (pageType !== 'job_detail') cap = Math.min(cap, { aggregator_search: 70, company_careers_home: 70, ats_company_board: 75, unknown: 65 }[pageType] ?? 65);
  if (jobBoardOrDirectoryEvidence || !directPostingEvidence) cap = Math.min(cap, 79);
  if (!targetRoleMatch) cap = Math.min(cap, 70);
  if (titleRoleMismatch || (excludedKeywordMatch && !strongTargetRoleMatch)) cap = Math.min(cap, 60);
  if (qualityScore < 80 && !(description.trim() && directPostingEvidence)) cap = Math.min(cap, 79);
  if (missingDescription && !directPostingEvidence) cap = Math.min(cap, 78);
  if (!hardFilter.passed) cap = Math.min(cap, 49);
  if (Number.isFinite(candidateDimensions.seniority_cap) && candidateDimensions.seniority_cap < 100) {
    cap = Math.min(cap, candidateDimensions.seniority_cap);
    gateReasons.push('job_level_above_candidate_level');
  }
  if (score > cap) scoreComponents.push({ name: 'score_cap', points: cap - score, cap, reasons: gateReasons });
  score = clampScore(Math.min(score, cap));

  const approvalGatePass = pageType === 'job_detail'
    && targetRoleMatch
    && strongTargetRoleMatch
    && directPostingEvidence
    && !jobBoardOrDirectoryEvidence
    && !excludedKeywordMatch
    && !titleRoleMismatch
    && (qualityScore >= 80 || (description.trim() && directPostingEvidence))
    && !submitAllowed
    && !uploadResumeAllowed
    && !finalSubmitAllowed
    && hardFilter.passed
    && config.safety.auto_approve !== true
    && config.safety.auto_submit !== true
    && config.safety.auto_upload_resume !== true;

  let recommendedDecision = 'manual_review';
  if (approvalGatePass && score >= Number(config.thresholds.shortlist_candidate ?? 80)) {
    recommendedDecision = 'approve';
  } else if (targetRoleMatch && jobBoardOrDirectoryEvidence) {
    recommendedDecision = 'manual_review';
  } else if (!targetRoleMatch && (excludedKeywordMatch || score < Number(config.thresholds.keep_in_queue ?? 50))) {
    recommendedDecision = 'reject';
  } else if (titleRoleMismatch || locationConflict || uuidLikeTitle || searchOrBoardTitle) {
    recommendedDecision = score >= 55 ? 'manual_review' : 'reject';
  } else if (targetRoleMatch || preferredLocationMatch || preferredCompanyMatch || score >= Number(config.thresholds.manual_review_candidate ?? 65)) {
    recommendedDecision = 'manual_review';
  } else {
    recommendedDecision = 'reject';
  }

  const approvalStatus = recommendedDecision === 'approve' ? 'safe_to_approve'
    : recommendedDecision === 'reject' ? 'reject_candidate'
      : pageType === 'job_detail' ? 'needs_review' : 'review_only';
  const approvalSafety = createApprovalSafety(
    approvalStatus,
    recommendedDecision === 'approve',
    uniqueBy(gateReasons.filter(Boolean), (reason) => reason)
  );
  const approvalWarning = approvalSafety.reasons.join(' ') || 'none';
  const qualityFlags = {
    non_detail_page: nonDetail,
    location_conflict: locationConflict,
    search_or_board_title: searchOrBoardTitle,
    product_analyst_lower_priority: weakerProductAnalyst,
    uuid_like_title: uuidLikeTitle,
    info_quality_below_approval_threshold: qualityScore < 80 && !(description.trim() && directPostingEvidence),
    missing_description: missingDescription,
    direct_posting_evidence: directPostingEvidence,
    job_board_or_directory_evidence: jobBoardOrDirectoryEvidence,
    title_role_mismatch: titleRoleMismatch,
    excluded_keyword_match: excludedKeywordMatch,
    target_role_not_matched: !targetRoleMatch
  };
  const reasons = uniqueBy([
    ...scoreComponents.map((component) => component.name),
    ...gateReasons,
    recommendedDecision === 'approve' ? 'approval_gates_passed' : null
  ].filter(Boolean), (reason) => reason);
  const recommendedAction = recommendedDecision === 'approve'
    ? 'manual_application_prep_candidate'
    : recommendedDecision === 'manual_review'
      ? 'manual_review'
      : 'keep_discovered_or_reject';
  const salary = Number(job.salary_min ?? job.min_salary);
  const salaryMatch = config.minimum_salary == null
    ? { status: 'not_configured', score: 0 }
    : Number.isFinite(salary)
      ? { status: salary >= Number(config.minimum_salary) ? 'matched' : 'below_minimum', score: salary >= Number(config.minimum_salary) ? 5 : 0 }
      : { status: 'unknown', score: 0 };
  const matchedRequirements = [
    ...(targetRoleMatch ? ['target_role'] : []),
    ...matchedRequiredSkills.map(skill => `required_skill:${skill}`),
    ...(preferredLocationMatch ? ['location'] : []),
    ...(hardFilter.inferred_seniority ? [`seniority:${hardFilter.inferred_seniority}`] : [])
  ];
  const missingRequirements = config.required_skills.filter(skill => !matchedRequiredSkills.includes(skill)).map(skill => `required_skill:${skill}`);
  const uncertainty = uniqueBy([
    ...hardFilter.uncertainty,
    ...(config.required_skills.length && !description.trim() ? ['skills_cannot_be_verified_without_description'] : []),
    ...(salaryMatch.status === 'unknown' ? ['salary_unknown'] : [])
  ], value => value);
  const scoreBreakdown = {
    title_match: { matched: targetRoleMatch, score: scoreComponents.filter(item => item.name.startsWith('target_role_')).reduce((sum, item) => sum + item.points, 0) },
    required_skills_match: { matched: matchedRequiredSkills, total_required: config.required_skills.length },
    preferred_skills_match: { matched: matchedPreferredSkills, total_preferred: config.preferred_skills.length },
    seniority_match: { inferred: hardFilter.inferred_seniority, allowed: config.seniority_levels, passed: !hardFilter.reasons.includes('seniority_not_allowed') },
    technical_match: candidateDimensions.technical,
    experience_match: candidateDimensions.experience,
    education_match: candidateDimensions.education,
    location_match: {
      matched: preferredLocationMatch || candidateDimensions.location.status === 'matched',
      hard_filter_passed: !hardFilter.reasons.includes('location_not_allowed'),
      candidate_dimension: candidateDimensions.location
    },
    remote_match: { allowed: config.workplace_modes, passed: !hardFilter.reasons.includes('remote_policy_not_allowed') },
    salary_match: { ...salaryMatch, candidate_dimension: candidateDimensions.salary },
    career_direction_match: candidateDimensions.career_direction,
    candidate_fit_score: candidateDimensions.candidate_fit_score,
    candidate_context: candidateDimensions.candidate_context,
    recency: { posted_at: job.posted_at || job.published_at || null, passed: !hardFilter.reasons.includes('posting_too_old') },
    penalties: scoreComponents.filter(item => item.points < 0),
    final_score: score,
    matched_requirements: matchedRequirements,
    missing_requirements: missingRequirements,
    uncertainty,
    explanation: reasons.join('; ')
  };

  return {
    scoring_config_version: config.scoring_config_version,
    target_role_match: targetRoleMatch,
    matched_target_roles: matchedTargetRoles,
    preferred_location_match: preferredLocationMatch,
    matched_preferred_locations: matchedPreferredLocations,
    preferred_company_match: preferredCompanyMatch,
    matched_preferred_companies: matchedPreferredCompanies,
    excluded_keyword_match: excludedKeywordMatch,
    matched_excluded_keywords: matchedExcludedKeywords,
    title_role_mismatch: titleRoleMismatch,
    direct_posting_evidence: directPostingEvidence,
    direct_posting_reasons: directPostingReasons,
    job_board_or_directory_evidence: jobBoardOrDirectoryEvidence,
    job_board_or_directory_reasons: jobBoardOrDirectoryReasons,
    score_components: scoreComponents,
    score_breakdown: scoreBreakdown,
    candidate_matching: candidateDimensions,
    hard_filter: hardFilter,
    score,
    reasons,
    recommended_action: recommendedAction,
    page_type: pageType,
    approval_safety: approvalSafety,
    approval_warning: approvalWarning,
    recommended_decision: recommendedDecision,
    quality_flags: qualityFlags,
    info_quality_score: qualityScore
  };
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

export function scoreJobs() {
  const config = loadScoringConfig();
  const leads = readJson(path.join(dataDir, 'job_leads.json'), []);
  const jobs = (Array.isArray(leads) ? leads : []).map((job) => {
    const scored = scoreJob(job, config);
    return {
      ...job,
      search_configuration_fingerprint: config.search_configuration_fingerprint,
      scored_at: new Date().toISOString(),
      scoring_config_version: scored.scoring_config_version,
      target_role_match: scored.target_role_match,
      matched_target_roles: scored.matched_target_roles,
      preferred_location_match: scored.preferred_location_match,
      matched_preferred_locations: scored.matched_preferred_locations,
      preferred_company_match: scored.preferred_company_match,
      matched_preferred_companies: scored.matched_preferred_companies,
      excluded_keyword_match: scored.excluded_keyword_match,
      matched_excluded_keywords: scored.matched_excluded_keywords,
      title_role_mismatch: scored.title_role_mismatch,
      direct_posting_evidence: scored.direct_posting_evidence,
      direct_posting_reasons: scored.direct_posting_reasons,
      job_board_or_directory_evidence: scored.job_board_or_directory_evidence,
      job_board_or_directory_reasons: scored.job_board_or_directory_reasons,
      score_components: scored.score_components,
      score_breakdown: scored.score_breakdown,
      candidate_matching: scored.candidate_matching,
      hard_filter: scored.hard_filter,
      page_type: scored.page_type,
      approval_safety: scored.approval_safety,
      approval_warning: scored.approval_warning,
      recommended_decision: scored.recommended_decision,
      quality_flags: scored.quality_flags,
      info_quality_score: scored.info_quality_score,
      match_score: scored.score,
      match_reasons: scored.reasons,
      shortlist_status: scored.recommended_action,
      application_mode: 'REVIEW_ONLY',
      requires_user_review_before_application: true,
      can_apply_automatically: false,
      submit_allowed: false,
      upload_resume_allowed: false,
      final_submit_allowed: false
    };
  }).sort((a, b) => (b.match_score || 0) - (a.match_score || 0));
  // Rejected jobs stay stored and scored in job_leads, but never re-enter the
  // Good Matches shortlist until the user explicitly restores them.
  const reviews = readJson(path.join(dataDir, 'job_reviews.json'), []);
  const rejectedIds = new Set((Array.isArray(reviews) ? reviews : [])
    .filter((review) => String(review?.decision || '') === 'rejected')
    .map((review) => String(review.job_id)));
  const shortlisted = jobs
    .filter((job) => !rejectedIds.has(String(job.job_id)))
    .filter((job) => job.match_score >= 55 || job.recommended_decision !== 'reject')
    .slice(0, 100);
  writeJson(path.join(dataDir, 'jobs_shortlist.json'), shortlisted);
  return {
    config_loaded_from: 'data/search_preferences.json',
    scoring_config_version: config.scoring_config_version,
    enabled_target_roles_count: config.target_roles.length,
    enabled_preferred_locations_count: config.preferred_locations.length,
    enabled_excluded_keywords_count: config.excluded_keywords.length,
    enabled_preferred_companies_count: config.preferred_companies.length,
    shortlisted_jobs_count: shortlisted.length,
    total_scored: jobs.length,
    page_type_breakdown: countBy(shortlisted, 'page_type'),
    recommended_decision_breakdown: countBy(shortlisted, 'recommended_decision'),
    top_10: shortlisted.slice(0, 10)
  };
}

if (isMainModule(import.meta.url)) console.log(JSON.stringify(scoreJobs(), null, 2));
