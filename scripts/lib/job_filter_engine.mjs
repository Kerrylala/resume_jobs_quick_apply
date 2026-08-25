// Filter Engine — providers FIND jobs, this decides which survive the plan's
// criteria. Every rejection records why_filtered; unknown attributes never
// filter (we refuse only on evidence, we don't guess).
import { normalizeSearchCriteria } from './search_criteria.mjs';
import { expandKeywordTerms } from './keyword_synonyms.mjs';
import { classifyJobSeniority } from './candidate_matching.mjs';

const text = value => String(value ?? '').normalize('NFKC').trim();
const lower = value => text(value).toLocaleLowerCase('en-US');

function jobText(job) {
  return lower([job.title, job.description_text, job.description, job.location, job.company,
    ...(Array.isArray(job.requirements) ? job.requirements : [])].filter(Boolean).join(' \n '));
}

// "3-5年" "5+ years" "at least 3 years" "经验不限"
export function extractExperienceYears(value) {
  const body = lower(value);
  if (!body) return null;
  if (/经验不限|无经验要求|no experience required/.test(body)) return { min: 0, max: null };
  let match = body.match(/(\d{1,2})\s*[-–~到至]\s*(\d{1,2})\s*年/) || body.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})\+?\s*years?/);
  if (match) return { min: Number(match[1]), max: Number(match[2]) };
  match = body.match(/(\d{1,2})\s*年以上|(\d{1,2})\+\s*years?|at least (\d{1,2})\s*years?|minimum (?:of )?(\d{1,2})\s*years?/);
  if (match) { const years = Number(match[1] ?? match[2] ?? match[3] ?? match[4]); return { min: years, max: null }; }
  match = body.match(/(\d{1,2})\s*years?\s+(?:of\s+)?experience|(\d{1,2})\s*年经验/);
  if (match) { const years = Number(match[1] ?? match[2]); return { min: years, max: null }; }
  return null;
}

const EDUCATION_RANK = { high_school: 1, associate: 2, bachelor: 3, master: 4, phd: 5 };
export function extractEducationLevel(value) {
  const body = lower(value);
  if (!body) return null;
  if (/phd|doctorate|博士/.test(body)) return 'phd';
  if (/master|硕士|研究生/.test(body)) return 'master';
  if (/bachelor|本科|学士|degree in|大学本科/.test(body)) return 'bachelor';
  if (/associate|大专|专科/.test(body)) return 'associate';
  if (/high school|高中|学历不限/.test(body)) return 'high_school';
  return null;
}

// "25-40K·15薪" "¥20k-35k/月" "$120,000 - $150,000" "120k USD"
export function extractSalary(value) {
  const body = text(value);
  if (!body) return null;
  let match = body.match(/(\d{1,4})\s*[kK千]?\s*[-–~到至]\s*(\d{1,4})\s*[kK千]/);
  if (match) {
    // "30-50K·13薪" is a Chinese MONTHLY convention; "120k-150k" in western
    // postings is annual. Explicit markers win, locale decides the default.
    const cjk = /[一-鿿]/.test(body);
    const period = /月|per month|\/\s*month|monthly/i.test(body) ? 'month'
      : /年薪|per year|\/\s*year|annum|annual/i.test(body) ? 'year'
      : (cjk ? 'month' : 'year');
    return { min: Number(match[1]) * 1000, max: Number(match[2]) * 1000, period, currency: /\$|usd/i.test(body) ? 'USD' : cjk ? 'CNY' : 'USD' };
  }
  match = body.match(/[¥$€£]\s*([\d,]{4,9})\s*[-–~]\s*[¥$€£]?\s*([\d,]{4,9})/);
  if (match) {
    const min = Number(match[1].replaceAll(',', ''));
    const max = Number(match[2].replaceAll(',', ''));
    return { min, max, period: /month|月/i.test(body) ? 'month' : 'year', currency: /\$/.test(body) ? 'USD' : /€/.test(body) ? 'EUR' : /£/.test(body) ? 'GBP' : 'CNY' };
  }
  return null;
}

function toAnnual(amount, period) {
  if (amount == null) return null;
  if (period === 'month') return amount * 12;
  if (period === 'day') return amount * 250;
  if (period === 'hour') return amount * 2000;
  return amount;
}

const REMOTE_PATTERN = /\bremote\b|远程|在家办公|work from home|wfh/i;
const HYBRID_PATTERN = /\bhybrid\b|混合办公/i;

// One job against the plan. Returns { ok, why_filtered: [...] }.
export function evaluateJobAgainstCriteria(job = {}, criteriaInput = {}) {
  const criteria = normalizeSearchCriteria(criteriaInput);
  const body = jobText(job);
  const why = [];

  // Blocked companies — hard.
  const company = lower(job.company);
  if (company && criteria.blocked_companies.some(blocked => company.includes(lower(blocked)))) {
    why.push({ rule: 'blocked_company', detail: job.company });
  }
  // Excluded keywords — hard.
  for (const excluded of criteria.excluded_keywords) {
    if (body.includes(lower(excluded))) { why.push({ rule: 'excluded_keyword', detail: excluded }); break; }
  }
  // Required keywords: at least ONE keyword/role family must appear. Terms
  // expand across bilingual role families ("销售" also matches "Account
  // Executive") — expansion only loosens this rule, never tightens it.
  const positiveTerms = [...criteria.keywords, ...criteria.target_roles];
  if (positiveTerms.length) {
    const hit = expandKeywordTerms(positiveTerms).some(term => body.includes(term));
    if (!hit) why.push({ rule: 'no_keyword_match', detail: positiveTerms.slice(0, 5).join(' / ') });
  }
  // Location: pass when any plan location appears, or the job is remote-friendly
  // while the plan allows remote. Jobs with NO location evidence pass (unknown).
  if (criteria.locations.length) {
    const jobLocation = lower([job.location, job.country].filter(Boolean).join(' '));
    const anywhere = REMOTE_PATTERN.test(body) && ['any', 'remote'].includes(criteria.remote);
    if (jobLocation && !anywhere && !criteria.locations.some(location => {
      const term = lower(location);
      return jobLocation.includes(term) || body.includes(term);
    })) {
      why.push({ rule: 'location_mismatch', detail: job.location });
    }
  }
  // Remote mode.
  if (criteria.remote === 'remote' && lower(job.location) && !REMOTE_PATTERN.test(body)) {
    why.push({ rule: 'not_remote', detail: job.location });
  }
  if (criteria.remote === 'onsite' && REMOTE_PATTERN.test(body) && !HYBRID_PATTERN.test(body)) {
    why.push({ rule: 'remote_only_job', detail: 'remote' });
  }
  // Experience window (evidence-based only).
  const required = extractExperienceYears(body);
  if (required && criteria.experience_max != null && required.min > criteria.experience_max) {
    why.push({ rule: 'experience_above_max', detail: `requires ${required.min}+ years` });
  }
  if (required && criteria.experience_min != null && required.max != null && required.max < criteria.experience_min) {
    why.push({ rule: 'experience_below_min', detail: `caps at ${required.max} years` });
  }
  if (criteria.entry_level && required && required.min >= 3) {
    why.push({ rule: 'not_entry_level', detail: `requires ${required.min}+ years` });
  }
  // Title-level evidence: a Senior/Staff/Manager/Director TITLE is a stated
  // requirement even when the body never spells out a years phrase.
  if (criteria.entry_level && !why.some(item => item.rule === 'not_entry_level')) {
    const titleRank = classifyJobSeniority(job);
    if (titleRank != null && titleRank >= 3) {
      why.push({ rule: 'not_entry_level', detail: `title level: ${String(job.title || '').slice(0, 60)}` });
    }
  }
  // Education ceiling.
  if (criteria.education !== 'any') {
    const needed = extractEducationLevel(body);
    if (needed && EDUCATION_RANK[needed] > EDUCATION_RANK[criteria.education]) {
      why.push({ rule: 'education_above_mine', detail: needed });
    }
  }
  // Salary: filter only when the job states a salary that tops out below the floor.
  if (criteria.salary_min != null) {
    const salary = extractSalary(job.salary?.text || job.salary || body);
    if (salary && salary.max != null) {
      const annualMax = toAnnual(salary.max, salary.period);
      const floor = toAnnual(criteria.salary_min, criteria.salary_period);
      if (annualMax != null && floor != null && salary.currency === criteria.salary_currency && annualMax < floor) {
        why.push({ rule: 'salary_below_min', detail: `${salary.currency} ${salary.max}/${salary.period}` });
      }
    }
  }
  // Employment type (evidence-based).
  if (criteria.employment_type.length) {
    const mentions = {
      internship: /intern(ship)?|实习/i.test(body),
      part_time: /part[- ]?time|兼职/i.test(body),
      contract: /contract(or)?|合同工|外包/i.test(body),
      temporary: /temporary|临时/i.test(body),
      freelance: /freelance|自由职业/i.test(body),
    };
    const isSomethingElse = Object.entries(mentions).some(([type, present]) => present && !criteria.employment_type.includes(type));
    const wantsOnly = criteria.employment_type.every(type => type === 'full_time');
    if (wantsOnly && isSomethingElse) {
      const found = Object.entries(mentions).find(([, present]) => present)?.[0];
      why.push({ rule: 'employment_type_mismatch', detail: found });
    }
  }
  // Industries: only filters when the plan names industries and none appears.
  if (criteria.industries.length) {
    const hit = criteria.industries.some(industry => body.includes(lower(industry)));
    if (!hit) why.push({ rule: 'industry_mismatch', detail: criteria.industries.slice(0, 3).join(' / ') });
  }
  // Posted-within window (only when the job carries a date).
  if (criteria.posted_within_days != null) {
    const posted = Date.parse(job.posted_date || job.posted_at || job.first_seen || '');
    if (Number.isFinite(posted)) {
      const ageDays = (Date.now() - posted) / 86_400_000;
      if (ageDays > criteria.posted_within_days) {
        why.push({ rule: 'posted_too_long_ago', detail: `${Math.round(ageDays)}d` });
      }
    }
  }
  // Sponsorship: filter only when the description explicitly refuses it.
  if (criteria.sponsorship_required && /no (visa )?sponsorship|sponsorship (is )?not (available|provided)|不提供签证/i.test(body)) {
    why.push({ rule: 'no_sponsorship', detail: 'description states no sponsorship' });
  }

  return { ok: why.length === 0, why_filtered: why };
}

// Hard filters remove; soft preferences (criteria.soft_rules) keep the job
// but attach penalties that lower its ranking — always with the reason.
export function filterJobs(jobs = [], criteriaInput = {}) {
  const criteria = normalizeSearchCriteria(criteriaInput);
  const softRules = new Set(criteria.soft_rules || []);
  const accepted = [];
  const filtered = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const verdict = evaluateJobAgainstCriteria(job, criteria);
    const hard = verdict.why_filtered.filter(why => !softRules.has(why.rule));
    const soft = verdict.why_filtered.filter(why => softRules.has(why.rule));
    if (hard.length) filtered.push({ job, why_filtered: hard, soft_notes: soft });
    else if (soft.length) accepted.push({ ...job, soft_penalties: soft });
    else accepted.push(job);
  }
  return { accepted, filtered, total: (jobs || []).length };
}
