// Global Job Search Engine units: criteria model, deterministic planner,
// filter engine (with why_filtered), and the orchestrator's failure isolation.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSearchCriteria, normalizeSearchPlanStore, upsertSearchPlan, deleteSearchPlan,
} from '../scripts/lib/search_criteria.mjs';
import { buildSearchQueries } from '../scripts/lib/search_planner.mjs';
import test_planner_default from 'node:test';

test_planner_default('field-of-study role mapping covers non-tech majors and never defaults them to Software Engineer', () => {
  const planFor = field => buildSearchQueries({
    careerProfile: {
      identity: {}, career_goals: [], skills: {},
      experience: [], projects: [],
      // "Bachelor of Arts" as the degree form is the trap: bare "arts" must
      // never map a humanities student to design roles.
      education: [{ institution: 'Synthetic University', degree: 'Bachelor of Arts', field_of_study: field }]
    },
    criteria: {}
  });
  const cases = [
    ['Film Studies', 'Video Editor'],
    ['Nursing', 'Registered Nurse'],
    ['Biology', 'Research Associate'],
    ['Psychology', 'Research Assistant'],
    ['Supply Chain Management', 'Supply Chain Analyst'],
    ['Music Performance', 'Audio Engineer'],
    ['Hospitality Management', 'Event Coordinator']
  ];
  for (const [field, expectedRole] of cases) {
    const plan = planFor(field);
    assert.ok(plan.roles.includes(expectedRole), `${field} must map to ${expectedRole}: got ${plan.roles.slice(0, 6)}`);
    assert.ok(!plan.roles.includes('Software Engineer'), `${field} must not fall back to Software Engineer`);
  }
  // "Bachelor of Arts" alone is a degree form, not an art major — it must
  // not map humanities students to design roles.
  const history = planFor('History');
  assert.ok(!history.roles.includes('Graphic Designer'), `History (BA) must not map to design: ${history.roles.slice(0, 6)}`);
});
import {
  evaluateJobAgainstCriteria, filterJobs, extractExperienceYears, extractSalary, extractEducationLevel,
} from '../scripts/lib/job_filter_engine.mjs';
import { runGlobalSearch } from '../scripts/lib/search_orchestrator.mjs';
import { matchingContextFromCareerProfile, scoreJobForSearch } from '../scripts/lib/search_matching.mjs';

const PROFILE = {
  id: 'p1', family_id: 'p1', version: 1, user_approved: true,
  identity: { full_name: 'T', email: 't@example.invalid', city: 'Shanghai', country: 'China' },
  education: [{ institution: 'U', degree: 'MSc', field_of_study: 'Statistics' }],
  experience: [{ company: 'Lab', role: 'ML Engineer', achievements: ['Built a platform in Python'], technologies: ['Python', 'SQL'] }],
  skills: { programming: ['Python', 'SQL'], ai_tools: ['PyTorch'], business: ['Sales enablement'] },
  career_goals: ['AI Engineer', '销售经理'],
  projects: [], certifications: [], languages: [], interview_stories: [], job_preferences: {}, field_provenance: {},
};

test('criteria normalize into a complete, bounded model and plans persist', () => {
  const criteria = normalizeSearchCriteria({
    keywords: '销售, AI', target_roles: ['Sales Manager'], locations: ['上海', 'Remote'],
    remote: 'hybrid', experience_min: 2, experience_max: 1, education: 'bachelor',
    salary_min: 300000, salary_max: 100000, salary_currency: 'cny', salary_period: 'year',
    employment_type: ['full_time', 'nonsense'], industries: ['SaaS'], company_size: 'large',
    posted_within: 30, skills: ['CRM'], entry_level: false, sponsorship: true,
    excluded_keywords: ['外包'], blocked_companies: ['BadCo'], minimum_match_score: 60,
    company_boards: ['https://jobs.lever.co/alloy'],
  });
  assert.deepEqual(criteria.keywords, ['销售', 'AI']);
  assert.equal(criteria.experience_max, 2, 'max below min clamps up');
  assert.equal(criteria.salary_max, 300000, 'salary max below min clamps up');
  assert.equal(criteria.salary_currency, 'CNY');
  assert.deepEqual(criteria.employment_type, ['full_time'], 'unknown types drop');
  assert.equal(criteria.posted_within_days, 30);
  assert.equal(criteria.sponsorship_required, true);

  let store = normalizeSearchPlanStore({});
  ({ store } = upsertSearchPlan(store, { name: '上海销售', criteria }, { now: '2026-08-22T00:00:00.000Z' }));
  ({ store } = upsertSearchPlan(store, { name: 'Remote AI', criteria: { keywords: ['AI Engineer'] } }, { now: '2026-08-22T00:00:01.000Z' }));
  assert.equal(store.plans.length, 2, 'multiple named plans persist');
  const removed = deleteSearchPlan(store, store.plans[0].plan_id);
  assert.equal(removed.plans.length, 1);
  assert.equal(removed.active_plan_id, removed.plans[0].plan_id);
});

test('the planner is deterministic and blends profile + criteria into real queries', () => {
  const first = buildSearchQueries({ careerProfile: PROFILE, criteria: { target_roles: ['销售经理'], locations: ['上海'] } });
  const second = buildSearchQueries({ careerProfile: PROFILE, criteria: { target_roles: ['销售经理'], locations: ['上海'] } });
  assert.deepEqual(first, second, 'no AI, no randomness — identical output');
  assert.ok(first.roles.includes('销售经理'), 'plan roles lead');
  assert.ok(first.roles.includes('AI Engineer'), 'profile goals join');
  assert.ok(first.roles.some(role => role === 'Software Engineer' || role === 'Data Analyst' || role === 'AI Product Manager'),
    'adjacent roles derived from verified skills');
  assert.ok(first.text_queries.some(item => item.query.includes('销售经理') && item.query.includes('招聘')), 'Chinese query variant exists');
  assert.ok(first.site_queries.some(item => item.query.startsWith('site:jobs.lever.co')), 'ATS site queries exist');
  assert.ok(first.browser_queries.length >= 1, 'browser-provider queries exist');
});

test('extractors read real-world experience / salary / education wording', () => {
  assert.deepEqual(extractExperienceYears('3-5年经验，本科'), { min: 3, max: 5 });
  assert.deepEqual(extractExperienceYears('at least 7 years of experience'), { min: 7, max: null });
  assert.deepEqual(extractExperienceYears('经验不限'), { min: 0, max: null });
  assert.equal(extractSalary('25-40K·15薪 上海').min, 25000);
  assert.equal(extractSalary('$120,000 - $150,000 per year').currency, 'USD');
  assert.equal(extractEducationLevel('本科及以上'), 'bachelor');
  assert.equal(extractEducationLevel('PhD preferred'), 'phd');
});

test('the filter engine records why_filtered for every rejection', () => {
  const criteria = {
    keywords: ['sales'], locations: ['Shanghai'], remote: 'any',
    experience_max: 5, education: 'bachelor', salary_min: 200000, salary_currency: 'CNY', salary_period: 'year',
    excluded_keywords: ['gambling'], blocked_companies: ['BadCo'], posted_within: 30,
  };
  const jobs = [
    { title: 'Sales Manager', company: 'GoodCo', location: 'Shanghai', description_text: 'Sales role, 3-5年经验, 本科, 30-50K·13薪' },
    { title: 'Sales Director', company: 'BadCo', location: 'Shanghai', description_text: 'sales leadership' },
    { title: 'Sales Ops', company: 'X', location: 'Beijing', description_text: 'sales operations role' },
    { title: 'Casino Sales', company: 'Y', location: 'Shanghai', description_text: 'sales for gambling products' },
    { title: 'Principal Sales', company: 'Z', location: 'Shanghai', description_text: 'sales, requires 10+ years experience' },
    { title: 'Sales PhD', company: 'W', location: 'Shanghai', description_text: 'sales research, PhD required' },
    { title: 'Backend Engineer', company: 'V', location: 'Shanghai', description_text: 'Go microservices' },
  ];
  const { accepted, filtered } = filterJobs(jobs, criteria);
  assert.deepEqual(accepted.map(job => job.title), ['Sales Manager']);
  const reasons = Object.fromEntries(filtered.map(item => [item.job.title, item.why_filtered.map(why => why.rule)]));
  assert.deepEqual(reasons['Sales Director'], ['blocked_company']);
  assert.deepEqual(reasons['Sales Ops'], ['location_mismatch']);
  assert.deepEqual(reasons['Casino Sales'], ['excluded_keyword']);
  assert.deepEqual(reasons['Principal Sales'], ['experience_above_max']);
  assert.deepEqual(reasons['Sales PhD'], ['education_above_mine']);
  assert.deepEqual(reasons['Backend Engineer'], ['no_keyword_match']);
});

test('bilingual role families stop cross-language keyword kills', () => {
  // The real 2026-08-23 defect: a 销售 plan hard-filtered "Account Executive"
  // and "Sales Development Representative" as no_keyword_match.
  const salesJobs = [
    { title: 'Enterprise Account Executive', company: 'Stripe', description_text: 'own a book of enterprise accounts' },
    { title: 'Sales Development Representative', company: 'Alloy', description_text: 'outbound pipeline generation' },
    { title: '销售经理', company: '乐有家', description_text: '负责区域销售' },
    { title: 'FP&A Analyst', company: 'X', description_text: 'financial planning and analysis' },
  ];
  const zhPlan = filterJobs(salesJobs, { keywords: ['销售'] });
  assert.deepEqual(zhPlan.accepted.map(job => job.title),
    ['Enterprise Account Executive', 'Sales Development Representative', '销售经理'],
    '中文"销售"必须匹配英文销售类职位');
  assert.deepEqual(zhPlan.filtered.map(item => item.job.title), ['FP&A Analyst']);
  // And the reverse direction: an English plan keeps the Chinese posting.
  const enPlan = filterJobs(salesJobs, { keywords: ['sales'] });
  assert.ok(enPlan.accepted.some(job => job.title === '销售经理'), 'English "sales" must match 销售 postings');
  // AI family crosses languages too.
  const aiPlan = filterJobs([
    { title: 'Machine Learning Engineer', company: 'A', description_text: 'training pipelines' },
    { title: '大模型算法工程师', company: 'B', description_text: 'LLM 训练' },
    { title: 'Accountant', company: 'C', description_text: 'ledgers' },
  ], { target_roles: ['AI工程师'] });
  assert.deepEqual(aiPlan.accepted.map(job => job.title), ['Machine Learning Engineer', '大模型算法工程师']);
  // Expansion NEVER applies to negative rules: excluded keywords stay literal.
  const excluded = filterJobs(
    [{ title: 'Account Executive', company: 'A', description_text: 'enterprise sales' }],
    { keywords: ['销售'], excluded_keywords: ['销售'] });
  assert.equal(excluded.filtered.length, 0, 'excluded_keywords must not be synonym-expanded');
});

test('unknown attributes never filter — evidence only', () => {
  const verdict = evaluateJobAgainstCriteria(
    { title: 'Sales Lead', company: 'A', location: '', description_text: 'sales lead role' },
    { keywords: ['sales'], locations: ['Shanghai'], experience_max: 3, salary_min: 100000, education: 'bachelor', posted_within: 7 }
  );
  assert.equal(verdict.ok, true, `no location/experience/salary/date evidence → passes; got ${JSON.stringify(verdict.why_filtered)}`);
});

test('one failing provider never sinks the whole search', async () => {
  const failingFetch = async () => { throw new Error('network down'); };
  const outcome = await runGlobalSearch({
    criteria: { target_roles: ['Engineer'], company_boards: ['https://jobs.lever.co/doesnotexist'] },
    careerProfile: PROFILE,
    includeSeedBoards: false,
    searxng: { enabled: false },
    fetchImpl: failingFetch,
  });
  const ats = outcome.providers.find(provider => provider.id === 'company_ats');
  assert.ok(ats, 'the ATS provider always reports');
  assert.notEqual(ats.status, 'ok');
  const web = outcome.providers.find(provider => provider.id === 'searxng_web');
  assert.equal(web.status, 'unavailable', 'a disabled SearXNG degrades honestly');
  assert.ok(outcome.providers.some(provider => provider.id === 'browser_boss' && provider.status === 'user_action_required'));
  assert.deepEqual(outcome.jobs, [], 'no provider fabricated jobs');
});

test('soft preferences demote with reasons instead of removing', async () => {
  const { filterJobs: filter } = await import('../scripts/lib/job_filter_engine.mjs');
  const jobs = [
    { title: 'Sales Manager', company: 'A', location: 'Beijing', description_text: 'sales role in Beijing' },
    { title: 'Sales Lead', company: 'BadCo', location: 'Shanghai', description_text: 'sales role' },
  ];
  const { accepted, filtered } = filter(jobs, {
    keywords: ['sales'], locations: ['Shanghai'], blocked_companies: ['BadCo'],
    soft_rules: ['location_mismatch'],
  });
  // Location mismatch is soft → kept with a penalty; blocked company stays hard.
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].title, 'Sales Manager');
  assert.deepEqual(accepted[0].soft_penalties.map(item => item.rule), ['location_mismatch']);
  assert.equal(filtered.length, 1);
  assert.deepEqual(filtered[0].why_filtered.map(item => item.rule), ['blocked_company']);
  // Blocked companies can never be demoted to soft.
  const { normalizeSearchCriteria: normalize } = await import('../scripts/lib/search_criteria.mjs');
  assert.deepEqual(normalize({ soft_rules: ['blocked_company', 'excluded_keyword', 'location_mismatch'] }).soft_rules, ['location_mismatch']);
});

test('the provider registry exposes an honest capability roster', async () => {
  const registry = await import('../providers/discovery/registry.mjs');
  const roster = registry.capabilityReport();
  assert.ok(roster.length >= 20, `expected a broad roster, got ${roster.length}`);
  const capabilities = new Set(roster.map(item => item.capability));
  for (const level of ['REAL_WORKING', 'BROWSER_LOGIN_REQUIRED', 'BLOCKED_EXTERNAL', 'NOT_IMPLEMENTED']) {
    assert.ok(capabilities.has(level), `roster must use ${level}`);
  }
  for (const adapter of registry.fetchableAdapters()) {
    assert.equal(typeof adapter.search, 'function', `${adapter.id} must implement search()`);
    assert.ok(['china', 'global'].includes(adapter.region));
  }
  for (const adapter of registry.browserAdapters()) {
    assert.equal(typeof adapter.browser?.search_url, 'function', `${adapter.id} must build a search URL`);
    assert.equal(adapter.capability, 'BROWSER_LOGIN_REQUIRED');
  }
  // The China majors and overseas majors are all accounted for — honestly.
  const ids = new Set(roster.map(item => item.id));
  for (const id of ['browser_boss', 'browser_liepin', 'browser_51job', 'browser_zhaopin', 'browser_lagou',
    'browser_linkedin', 'indeed', 'glassdoor', 'tencent_careers', 'nowcoder', 'shixiseng', 'amazon_jobs', 'wellfound']) {
    assert.ok(ids.has(id), `roster must include ${id}`);
  }
});

test('soft_notes survive re-normalization so the demotion stays explained', async () => {
  const { normalizeJobRecord: normalize } = await import('../scripts/lib/job_records.mjs');
  const record = normalize({
    title: 'Engineer', company: 'A', url: 'https://a.example.com/jobs/1',
    search_match: { match_score: 62, why_fit: ['skills'], main_gaps: [], soft_notes: ['location_mismatch: Beijing'], plan_id: 'p', scored_at: '2026-08-22T00:00:00.000Z' },
  }, { now: '2026-08-22T00:00:00.000Z' });
  assert.deepEqual(record.search_match.soft_notes, ['location_mismatch: Beijing']);
});

test('shortlist and ignore-forever flags survive re-normalization', async () => {
  const { normalizeJobRecord: normalize } = await import('../scripts/lib/job_records.mjs');
  const record = normalize({
    title: 'Engineer', company: 'A', url: 'https://a.example.com/jobs/1',
    shortlisted: true, ignored_forever: true,
  }, { now: '2026-08-22T00:00:00.000Z' });
  assert.equal(record.shortlisted, true);
  assert.equal(record.ignored_forever, true);
  const renormalized = normalize(record, { now: '2026-08-23T00:00:00.000Z' });
  assert.equal(renormalized.ignored_forever, true, 'the permanent ignore can never be lost in a merge');
});

test('matching condenses dimensions into score / why fit / main gaps', () => {
  const context = matchingContextFromCareerProfile(PROFILE);
  assert.ok(context.skills.includes('Python'));
  const scored = scoreJobForSearch({
    title: 'AI Engineer', company: 'Acme', location: 'Shanghai, China',
    description_text: 'Build ML systems in Python and SQL. 3 years of experience required. Bachelor degree.',
  }, context, { preferredLocations: ['Shanghai'] });
  assert.ok(Number.isFinite(scored.match_score), 'a numeric score exists');
  assert.ok(scored.why_fit.length >= 1, 'why fit is populated');
  assert.ok(Array.isArray(scored.main_gaps));
});

test('search scoring caps leadership postings below the recommendation threshold for a new grad', () => {
  const context = matchingContextFromCareerProfile({
    identity: { full_name: 'Synthetic Grad' },
    education: [{ institution: 'Synthetic University', degree: 'BSc', field_of_study: 'Computer Science' }],
    experience: [{ role: '', company: '', responsibilities: ['built a course project'] }],
    skills: { programming_languages: ['Python', 'Java'] }
  });
  assert.equal(context.entry_level, true);
  const em = scoreJobForSearch({
    title: 'Engineering Manager, Notifications',
    description_text: 'Lead a team of software engineers building Python services.',
    location: 'Remote'
  }, context, {});
  assert.ok(em.match_score < 60, `EM posting must stay out of 推荐, got ${em.match_score}`);
  assert.ok(em.main_gaps.some(gap => gap.includes('seniority')), 'the gap must name seniority');
  const entry = scoreJobForSearch({
    title: 'Software Engineer, New Grad',
    description_text: 'Python services. Entry level program.',
    location: 'Remote'
  }, context, {});
  assert.ok(entry.match_score > em.match_score, 'an entry posting must outrank the EM posting');
});
