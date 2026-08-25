const WORKPLACE_MODES = new Set(['any', 'onsite', 'hybrid', 'remote']);
const SENIORITY_LEVELS = new Set(['any', 'internship', 'entry', 'junior', 'mid', 'senior', 'lead', 'manager']);
const JOB_TYPES = new Set(['any', 'full_time', 'part_time', 'contract', 'internship', 'temporary']);

export class SearchPreferencesValidationError extends Error {
  constructor(issues) {
    super(issues.map(issue => `${issue.field}: ${issue.message}`).join('; '));
    this.name = 'SearchPreferencesValidationError';
    this.code = 'INVALID_SEARCH_PREFERENCES';
    this.issues = issues;
  }
}

function text(value) {
  return String(value ?? '').trim();
}

function unique(values) {
  return [...new Set(values)];
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return unique(value.map(item => text(item?.keyword ?? item)).filter(Boolean));
}

function preferenceItem(value, defaultWeight = 50) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      keyword: text(value.keyword),
      weight: Number.isFinite(Number(value.weight)) ? Number(value.weight) : defaultWeight,
      enabled: value.enabled !== false,
      aliases: stringList(value.aliases)
    };
  }
  return { keyword: text(value), weight: defaultWeight, enabled: true, aliases: [] };
}

function preferenceList(value, defaultWeight) {
  return (Array.isArray(value) ? value : [])
    .map(item => preferenceItem(item, defaultWeight))
    .filter(item => item.keyword);
}

function excludedItem(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return { keyword: text(value.keyword), reason: text(value.reason), enabled: value.enabled !== false };
  }
  return { keyword: text(value), reason: 'legacy keyword', enabled: true };
}

function excludedList(value) {
  return (Array.isArray(value) ? value : []).map(excludedItem).filter(item => item.keyword);
}

function enumList(value, allowed, fallback) {
  const values = stringList(value).map(item => item.toLowerCase());
  return values.length ? unique(values) : [...fallback];
}

function legacySeniorityList(value) {
  const aliases = new Map([
    ['intern', 'internship'],
    ['new grad', 'entry'],
    ['entry level', 'entry'],
    ['associate', 'entry']
  ]);
  return stringList(value).map(item => aliases.get(item.toLowerCase()) || item.toLowerCase());
}

function optionalNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : value;
}

function legacyProfile(source) {
  const workplaceModes = [];
  if (source.remote_ok) workplaceModes.push('remote');
  if (source.hybrid_ok) workplaceModes.push('hybrid');
  if (source.onsite_ok) workplaceModes.push('onsite');
  return {
    id: text(source.active_search_profile_id) || 'default',
    name: text(source.search_profile_name) || 'Default Search',
    enabled: source.search_enabled !== false,
    target_roles: preferenceList(source.target_roles, 100),
    preferred_locations: preferenceList(source.preferred_locations?.length ? source.preferred_locations : source.target_cities, 80),
    workplace_modes: workplaceModes.length ? workplaceModes : ['any'],
    seniority_levels: source.seniority_levels?.length
      ? enumList(source.seniority_levels, SENIORITY_LEVELS, ['any'])
      : (legacySeniorityList(source.seniority_allowed).length ? unique(legacySeniorityList(source.seniority_allowed)) : ['any']),
    required_skills: stringList(source.required_skills),
    preferred_skills: stringList(source.preferred_skills?.length ? source.preferred_skills : source.positive_keywords),
    excluded_keywords: excludedList(source.excluded_keywords?.length ? source.excluded_keywords : source.negative_keywords),
    excluded_companies: stringList(source.excluded_companies),
    posted_within_days: optionalNumber(source.posted_within_days, 30),
    job_types: enumList(source.job_types, JOB_TYPES, ['any']),
    minimum_salary: optionalNumber(source.minimum_salary ?? source.min_salary, null),
    maximum_search_results: optionalNumber(source.maximum_search_results, 50),
    maximum_jobs_to_open: optionalNumber(source.maximum_jobs_to_open, 5),
    show_unseen_only: source.show_unseen_only === true,
    include_previously_seen: source.show_unseen_only === true ? false : source.include_previously_seen !== false,
    do_not_repeat_rejected: source.do_not_repeat_rejected !== false,
    do_not_repeat_approved: source.do_not_repeat_approved !== false,
    do_not_repeat_applied: source.do_not_repeat_applied !== false,
    repeat_after_days: optionalNumber(source.repeat_after_days, 14),
    maximum_results_per_company: optionalNumber(source.maximum_results_per_company, 3),
    minimum_source_diversity: optionalNumber(source.minimum_source_diversity, 2)
  };
}

function normalizeProfile(input, fallback = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const showUnseenOnly = (source.show_unseen_only ?? fallback.show_unseen_only) === true;
  return {
    id: text(source.id || fallback.id),
    name: text(source.name || fallback.name),
    enabled: source.enabled !== false,
    target_roles: preferenceList(source.target_roles ?? fallback.target_roles, 100),
    preferred_locations: preferenceList(source.preferred_locations ?? fallback.preferred_locations, 80),
    workplace_modes: enumList(source.workplace_modes ?? fallback.workplace_modes, WORKPLACE_MODES, ['any']),
    seniority_levels: enumList(source.seniority_levels ?? fallback.seniority_levels, SENIORITY_LEVELS, ['any']),
    required_skills: stringList(source.required_skills ?? fallback.required_skills),
    preferred_skills: stringList(source.preferred_skills ?? fallback.preferred_skills),
    excluded_keywords: excludedList(source.excluded_keywords ?? fallback.excluded_keywords),
    excluded_companies: stringList(source.excluded_companies ?? fallback.excluded_companies),
    posted_within_days: optionalNumber(source.posted_within_days, fallback.posted_within_days ?? 30),
    job_types: enumList(source.job_types ?? fallback.job_types, JOB_TYPES, ['any']),
    minimum_salary: optionalNumber(source.minimum_salary, fallback.minimum_salary ?? null),
    maximum_search_results: optionalNumber(source.maximum_search_results, fallback.maximum_search_results ?? 50),
    maximum_jobs_to_open: optionalNumber(source.maximum_jobs_to_open, fallback.maximum_jobs_to_open ?? 5),
    show_unseen_only: showUnseenOnly,
    include_previously_seen: showUnseenOnly
      ? false
      : (source.include_previously_seen ?? fallback.include_previously_seen) !== false,
    do_not_repeat_rejected: (source.do_not_repeat_rejected ?? fallback.do_not_repeat_rejected) !== false,
    do_not_repeat_approved: (source.do_not_repeat_approved ?? fallback.do_not_repeat_approved) !== false,
    do_not_repeat_applied: (source.do_not_repeat_applied ?? fallback.do_not_repeat_applied) !== false,
    repeat_after_days: optionalNumber(source.repeat_after_days, fallback.repeat_after_days ?? 14),
    maximum_results_per_company: optionalNumber(source.maximum_results_per_company, fallback.maximum_results_per_company ?? 3),
    minimum_source_diversity: optionalNumber(source.minimum_source_diversity, fallback.minimum_source_diversity ?? 2)
  };
}

function validateEnumList(issues, field, values, allowed) {
  const invalid = values.filter(value => !allowed.has(value));
  if (invalid.length) {
    issues.push({ field, message: `unsupported value(s): ${invalid.join(', ')}`, allowed: [...allowed] });
  }
  if (values.includes('any') && values.length > 1) {
    issues.push({ field, message: '"any" cannot be combined with specific values' });
  }
}

function validateProfile(profile, index) {
  const prefix = `search_profiles[${index}]`;
  const issues = [];
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile.id)) {
    issues.push({ field: `${prefix}.id`, message: 'must be 1-64 letters, numbers, "_" or "-", starting with a letter or number' });
  }
  if (!profile.name) issues.push({ field: `${prefix}.name`, message: 'is required' });
  if (!profile.target_roles.some(item => item.enabled && item.keyword)) {
    issues.push({ field: `${prefix}.target_roles`, message: 'must contain at least one enabled target role' });
  }
  validateEnumList(issues, `${prefix}.workplace_modes`, profile.workplace_modes, WORKPLACE_MODES);
  validateEnumList(issues, `${prefix}.seniority_levels`, profile.seniority_levels, SENIORITY_LEVELS);
  validateEnumList(issues, `${prefix}.job_types`, profile.job_types, JOB_TYPES);
  for (const [field, value, min, max] of [
    ['posted_within_days', profile.posted_within_days, 1, 365],
    ['maximum_search_results', profile.maximum_search_results, 1, 500],
    ['maximum_jobs_to_open', profile.maximum_jobs_to_open, 1, 50],
    ['repeat_after_days', profile.repeat_after_days, 0, 365],
    ['maximum_results_per_company', profile.maximum_results_per_company, 1, 50],
    ['minimum_source_diversity', profile.minimum_source_diversity, 1, 10]
  ]) {
    if (!Number.isInteger(value) || value < min || value > max) {
      issues.push({ field: `${prefix}.${field}`, message: `must be an integer from ${min} to ${max}` });
    }
  }
  if (profile.minimum_salary !== null && (!Number.isFinite(profile.minimum_salary) || profile.minimum_salary < 0)) {
    issues.push({ field: `${prefix}.minimum_salary`, message: 'must be empty or a non-negative number' });
  }
  if (Number.isInteger(profile.maximum_jobs_to_open) && Number.isInteger(profile.maximum_search_results)
    && profile.maximum_jobs_to_open > profile.maximum_search_results) {
    issues.push({ field: `${prefix}.maximum_jobs_to_open`, message: 'cannot exceed maximum_search_results' });
  }
  return issues;
}

export function defaultSearchPreferences() {
  return {
    schema_version: '6.1',
    active_search_profile_id: 'default',
    search_profiles: [{
      id: 'default',
      name: 'Default Search',
      enabled: true,
      target_roles: [{ keyword: 'AI Product Manager', weight: 100, enabled: true, aliases: ['AI 产品经理', 'AI PM'] }],
      preferred_locations: [],
      workplace_modes: ['any'],
      seniority_levels: ['any'],
      required_skills: [],
      preferred_skills: [],
      excluded_keywords: [],
      excluded_companies: [],
      posted_within_days: 30,
      job_types: ['any'],
      minimum_salary: null,
      maximum_search_results: 50,
      maximum_jobs_to_open: 5,
      show_unseen_only: false,
      include_previously_seen: true,
      do_not_repeat_rejected: true,
      do_not_repeat_approved: true,
      do_not_repeat_applied: true,
      repeat_after_days: 14,
      maximum_results_per_company: 3,
      minimum_source_diversity: 2
    }],
    search_query_templates: ['{role} {location} careers', '{role} {location} jobs'],
    safety: {
      auto_approve: false, auto_submit: false, auto_upload_resume: false,
      resume_upload_policy: 'auto', resume_format_preference: 'auto',
      require_manual_review_before_application: true
    }
  };
}

export function normalizeSearchPreferences(input = {}, { strict = false } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const fallback = legacyProfile(Object.keys(source).length ? source : defaultSearchPreferences());
  const rawProfiles = Array.isArray(source.search_profiles) && source.search_profiles.length
    ? source.search_profiles
    : [fallback];
  const profiles = rawProfiles.map(profile => normalizeProfile(profile, fallback));
  const issues = profiles.flatMap(validateProfile);
  const ids = profiles.map(profile => profile.id);
  for (const id of unique(ids)) {
    if (id && ids.filter(value => value === id).length > 1) {
      issues.push({ field: 'search_profiles', message: `duplicate profile id: ${id}` });
    }
  }
  let activeId = text(source.active_search_profile_id) || profiles.find(profile => profile.enabled)?.id || profiles[0]?.id || '';
  let active = profiles.find(profile => profile.id === activeId);
  if (!active) {
    issues.push({ field: 'active_search_profile_id', message: `does not reference an existing profile: ${activeId}` });
    active = profiles.find(profile => profile.enabled) || profiles[0];
    activeId = active?.id || '';
  }
  if (active && !active.enabled) {
    issues.push({ field: 'active_search_profile_id', message: 'must reference an enabled profile' });
  }
  if (strict && issues.length) throw new SearchPreferencesValidationError(issues);

  const warnings = issues.map(issue => `${issue.field}: ${issue.message}`);
  const safety = { ...(source.safety || {}) };
  for (const key of ['auto_approve', 'auto_submit', 'auto_upload_resume']) {
    if (safety[key] === true) warnings.push(`safety.${key}=true is not allowed; forced to false`);
    safety[key] = false;
  }
  safety.require_manual_review_before_application = true;
  // Resume upload during a fill the user already authorized. This is separate
  // from the legacy auto_upload_resume flag above (which meant "upload without
  // the user in the loop" and stays forced off). Submit remains manual always.
  if (!['auto', 'never'].includes(text(safety.resume_upload_policy))) {
    if (safety.resume_upload_policy !== undefined) {
      warnings.push(`safety.resume_upload_policy must be "auto" or "never"; using "auto"`);
    }
    safety.resume_upload_policy = 'auto';
  }
  if (!['auto', 'pdf', 'docx'].includes(text(safety.resume_format_preference))) {
    if (safety.resume_format_preference !== undefined) {
      warnings.push(`safety.resume_format_preference must be "auto", "pdf" or "docx"; using "auto"`);
    }
    safety.resume_format_preference = 'auto';
  }
  // Per-category policy for sensitive questions:
  //   'ask'    — surfaced each application, never auto-filled (default)
  //   'reuse'  — a previously USER-CONFIRMED answer may auto-fill; the field
  //              still shows as sensitive and the user reviews before submit
  //   'manual' — the product never fills or even suggests; the user does it
  //              entirely on the page (default for EEO demographics)
  // CAPTCHA / login / MFA / final submit are hard-off regardless of policy.
  const SENSITIVE_CATEGORIES = ['work_authorization', 'sponsorship', 'eeo_demographics', 'salary', 'relocation', 'start_date', 'background_check', 'other_sensitive'];
  const policiesInput = safety.sensitive_policies && typeof safety.sensitive_policies === 'object' && !Array.isArray(safety.sensitive_policies)
    ? safety.sensitive_policies
    : {};
  const policies = {};
  for (const category of SENSITIVE_CATEGORIES) {
    const requested = text(policiesInput[category]);
    if (requested && !['ask', 'reuse', 'manual'].includes(requested)) {
      warnings.push(`safety.sensitive_policies.${category} must be "ask", "reuse" or "manual"; using the default`);
    }
    policies[category] = ['ask', 'reuse', 'manual'].includes(requested)
      ? requested
      : (category === 'eeo_demographics' ? 'manual' : 'ask');
  }
  safety.sensitive_policies = policies;

  const value = {
    ...source,
    schema_version: '6.1',
    active_search_profile_id: activeId,
    search_profiles: profiles,
    safety
  };
  if (active) {
    Object.assign(value, {
      search_profile_name: active.name,
      search_enabled: active.enabled,
      target_roles: active.target_roles,
      preferred_locations: active.preferred_locations,
      target_cities: active.preferred_locations.map(item => item.keyword),
      remote_ok: active.workplace_modes.includes('any') || active.workplace_modes.includes('remote'),
      hybrid_ok: active.workplace_modes.includes('any') || active.workplace_modes.includes('hybrid'),
      onsite_ok: active.workplace_modes.includes('any') || active.workplace_modes.includes('onsite'),
      seniority_allowed: active.seniority_levels,
      required_skills: active.required_skills,
      preferred_skills: active.preferred_skills,
      excluded_keywords: active.excluded_keywords,
      excluded_companies: active.excluded_companies,
      posted_within_days: active.posted_within_days,
      job_types: active.job_types,
      min_salary: active.minimum_salary,
      minimum_salary: active.minimum_salary,
      maximum_search_results: active.maximum_search_results,
      maximum_jobs_to_open: active.maximum_jobs_to_open,
      show_unseen_only: active.show_unseen_only,
      include_previously_seen: active.include_previously_seen,
      do_not_repeat_rejected: active.do_not_repeat_rejected,
      do_not_repeat_approved: active.do_not_repeat_approved,
      do_not_repeat_applied: active.do_not_repeat_applied,
      repeat_after_days: active.repeat_after_days,
      maximum_results_per_company: active.maximum_results_per_company,
      minimum_source_diversity: active.minimum_source_diversity
    });
  }
  return { value, warnings };
}

export function activeSearchProfile(preferences) {
  const { value } = normalizeSearchPreferences(preferences);
  return value.search_profiles.find(profile => profile.id === value.active_search_profile_id) || null;
}
