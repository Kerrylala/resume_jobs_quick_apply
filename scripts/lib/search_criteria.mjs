// Search Criteria / Search Plans — the big-filter data model behind the
// Global Job Search Engine. A user keeps MULTIPLE named plans ("上海AI产品",
// "Remote sales US"…); each holds the full criteria set a job board would
// offer. Stored in data/search_plans.json (own store — the legacy
// search_preferences stays untouched).
const text = value => String(value ?? '').normalize('NFKC').trim();

function stringList(value, { max = 50, maxLength = 120 } = {}) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,，、\n]/) : [];
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const cleaned = text(item).slice(0, maxLength);
    const key = cleaned.toLocaleLowerCase('en-US');
    if (!cleaned || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
    if (result.length >= max) break;
  }
  return result;
}

function boundedNumber(value, { min, max }) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.min(max, Math.max(min, number));
}

function enumValue(value, allowed, fallback) {
  const cleaned = text(value).toLowerCase();
  return allowed.includes(cleaned) ? cleaned : fallback;
}

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contract', 'internship', 'temporary', 'freelance'];
export const EDUCATION_LEVELS = ['any', 'high_school', 'associate', 'bachelor', 'master', 'phd'];
export const REMOTE_MODES = ['any', 'remote', 'hybrid', 'onsite'];
export const COMPANY_SIZES = ['any', 'startup', 'small', 'medium', 'large', 'enterprise'];
export const SALARY_PERIODS = ['year', 'month', 'day', 'hour'];

export function normalizeSearchCriteria(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const salaryMin = boundedNumber(source.salary_min, { min: 0, max: 100_000_000 });
  const salaryMax = boundedNumber(source.salary_max, { min: 0, max: 100_000_000 });
  const experienceMin = boundedNumber(source.experience_min, { min: 0, max: 50 });
  const experienceMax = boundedNumber(source.experience_max, { min: 0, max: 50 });
  return {
    keywords: stringList(source.keywords),
    target_roles: stringList(source.target_roles),
    locations: stringList(source.locations),
    remote: enumValue(source.remote, REMOTE_MODES, 'any'),
    experience_min: experienceMin,
    experience_max: experienceMax != null && experienceMin != null && experienceMax < experienceMin ? experienceMin : experienceMax,
    education: enumValue(source.education, EDUCATION_LEVELS, 'any'),
    salary_min: salaryMin,
    salary_max: salaryMax != null && salaryMin != null && salaryMax < salaryMin ? salaryMin : salaryMax,
    salary_currency: text(source.salary_currency).toUpperCase().slice(0, 6) || 'CNY',
    salary_period: enumValue(source.salary_period, SALARY_PERIODS, 'year'),
    employment_type: stringList(source.employment_type).map(item => enumValue(item, EMPLOYMENT_TYPES, ''))
      .filter(Boolean),
    industries: stringList(source.industries),
    company_size: enumValue(source.company_size, COMPANY_SIZES, 'any'),
    posted_within_days: boundedNumber(source.posted_within_days ?? source.posted_within, { min: 1, max: 365 }),
    skills: stringList(source.skills),
    entry_level: source.entry_level === true,
    sponsorship_required: source.sponsorship_required === true || source.sponsorship === true,
    excluded_keywords: stringList(source.excluded_keywords),
    blocked_companies: stringList(source.blocked_companies),
    minimum_match_score: boundedNumber(source.minimum_match_score, { min: 0, max: 100 }),
    // Optional explicit sources the user pins to this plan (careers/board URLs).
    company_boards: stringList(source.company_boards, { max: 20, maxLength: 300 }),
    // Rules listed here become SOFT preferences: a violation no longer removes
    // the job — it lowers its ranking and is explained. Everything else stays
    // a hard filter.
    soft_rules: stringList(source.soft_rules, { max: 20, maxLength: 40 })
      .filter(rule => SOFT_CAPABLE_RULES.includes(rule)),
  };
}

// Rules that may be demoted to soft preferences. Blocked companies and
// excluded keywords are ALWAYS hard — the user said never.
export const SOFT_CAPABLE_RULES = Object.freeze([
  'location_mismatch', 'not_remote', 'remote_only_job',
  'experience_above_max', 'experience_below_min', 'not_entry_level',
  'education_above_mine', 'salary_below_min', 'employment_type_mismatch',
  'industry_mismatch', 'posted_too_long_ago', 'no_sponsorship', 'no_keyword_match',
]);

export function normalizeSearchPlan(input = {}, { now = new Date().toISOString() } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const name = text(source.name).slice(0, 80) || 'My search';
  return {
    plan_id: text(source.plan_id) || `plan_${Math.abs(hash(`${name}${now}`)).toString(36)}`,
    name,
    criteria: normalizeSearchCriteria(source.criteria || source),
    created_at: text(source.created_at) || now,
    updated_at: now,
    last_run_at: text(source.last_run_at) || '',
    last_run_summary: source.last_run_summary && typeof source.last_run_summary === 'object'
      ? source.last_run_summary
      : null,
    // Profile binding: which Career Profile version/digest this plan was
    // generated from. Lets the UI mark a plan stale when the profile changes.
    profile_version: source.profile_version ?? null,
    profile_digest: text(source.profile_digest) || '',
    generated_at: text(source.generated_at) || text(source.created_at) || now,
    generated_from_profile: source.generated_from_profile === true,
  };
}

function hash(value) {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result | 0;
}

export function normalizeSearchPlanStore(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const plans = (Array.isArray(source.plans) ? source.plans : [])
    .map(plan => {
      try { return normalizeSearchPlan(plan, { now: plan?.updated_at || new Date().toISOString() }); }
      catch { return null; }
    })
    .filter(Boolean);
  const ids = new Set(plans.map(plan => plan.plan_id));
  return {
    schema_version: '1.0',
    plans,
    active_plan_id: ids.has(text(source.active_plan_id)) ? text(source.active_plan_id) : (plans[0]?.plan_id || ''),
  };
}

export function upsertSearchPlan(store, planInput, { now = new Date().toISOString() } = {}) {
  const normalizedStore = normalizeSearchPlanStore(store);
  const plan = normalizeSearchPlan(planInput, { now });
  const index = normalizedStore.plans.findIndex(item => item.plan_id === plan.plan_id);
  if (index >= 0) {
    plan.created_at = normalizedStore.plans[index].created_at;
    plan.last_run_at = planInput.last_run_at ?? normalizedStore.plans[index].last_run_at;
    plan.last_run_summary = planInput.last_run_summary ?? normalizedStore.plans[index].last_run_summary;
    normalizedStore.plans[index] = plan;
  } else {
    normalizedStore.plans.push(plan);
  }
  if (!normalizedStore.active_plan_id) normalizedStore.active_plan_id = plan.plan_id;
  return { store: normalizedStore, plan };
}

export function deleteSearchPlan(store, planId) {
  const normalizedStore = normalizeSearchPlanStore(store);
  const plans = normalizedStore.plans.filter(plan => plan.plan_id !== text(planId));
  return {
    schema_version: '1.0',
    plans,
    active_plan_id: normalizedStore.active_plan_id === text(planId)
      ? (plans[0]?.plan_id || '')
      : normalizedStore.active_plan_id,
  };
}
