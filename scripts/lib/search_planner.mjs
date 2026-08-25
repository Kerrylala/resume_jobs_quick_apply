// Search Planner — turns (Online Career Profile + Search Plan criteria) into
// concrete search queries for every provider kind. Fully deterministic; an AI
// provider may ADD queries later, but nothing here depends on one.
//
// Design goal: the planner must NEVER come back empty. Even a sparse profile
// (only a degree + field of study, which is all many real profiles carry) is
// expanded into role directions, then into dozens of bilingual queries across
// web / ATS-site / board / browser channels. "Search from my profile" works
// without the user typing a single keyword.
//
// Output shape:
//   {
//     roles: [...effective role terms...],
//     entry_level: bool,                                          // derived new-grad signal
//     text_queries:   [{ query, role, location, purpose }]        // SearXNG / web
//     site_queries:   [{ query, site, role, purpose }]            // site:ATS expansion
//     board_queries:  [{ keyword, role }]                         // filter terms for ATS boards
//     browser_queries:[{ keyword, city, role }]                   // BOSS / LinkedIn adapters
//   }
import { normalizeCareerProfile } from './career_brain.mjs';
import { normalizeSearchCriteria } from './search_criteria.mjs';
import { expandKeywordTerms } from './keyword_synonyms.mjs';
import { estimateYears } from './profile_signals.mjs';

const text = value => String(value ?? '').normalize('NFKC').trim();
const lower = value => text(value).toLocaleLowerCase('en-US');

function unique(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = text(item).toLocaleLowerCase('en-US');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Adjacent roles derived from verified profile skills — the "you did not know
// to search for this" part, without any AI.
function adjacentRoles(profile) {
  const skills = profile.skills || {};
  const has = key => (skills[key] || []).length > 0;
  const roles = [];
  if (has('programming')) roles.push('Software Engineer');
  if (has('programming') && has('ai_tools')) roles.push('AI Engineer');
  if (has('ai_tools') && has('business')) roles.push('AI Product Manager', 'AI Consultant');
  if (has('data')) roles.push('Data Analyst');
  if (has('data') && has('business')) roles.push('Product Analyst');
  if (has('business')) roles.push('Solutions Engineer');
  return roles;
}

// Field-of-study → role directions. Many real profiles carry ONLY a degree and
// a major; this is what turns "Math-CS & Economics, Bachelor" into concrete
// roles to search for. Deterministic keyword match against the study text
// (Chinese and English), each hit contributing role terms in priority order.
const FIELD_ROLE_MAP = [
  [/computer science|软件|计算机|software|informatics|信息技术/, ['Software Engineer', 'Backend Engineer', 'Full Stack Engineer']],
  [/machine learning|artificial intelligence|人工智能|machine|deep learning|神经/, ['Machine Learning Engineer', 'AI Engineer']],
  [/data science|data analytics|数据科学|大数据/, ['Data Scientist', 'Data Analyst', 'Data Engineer']],
  [/statistic|统计|数理统计/, ['Data Analyst', 'Data Scientist', 'Quantitative Analyst']],
  [/\bmath|mathematic|数学|应用数学/, ['Data Analyst', 'Quantitative Analyst', 'Software Engineer']],
  [/econ|经济|计量经济/, ['Business Analyst', 'Financial Analyst', 'Data Analyst']],
  [/finance|金融|财务/, ['Financial Analyst', 'Business Analyst', 'Investment Analyst']],
  [/business|管理|工商|mba|商科/, ['Business Analyst', 'Product Manager', 'Operations Analyst']],
  [/electric|electronic|电子|通信|communication engineering/, ['Hardware Engineer', 'Embedded Software Engineer']],
  [/mechanical|机械|自动化|automation/, ['Mechanical Engineer', 'Automation Engineer']],
  [/design|设计|人机交互|hci/, ['Product Designer', 'UX Designer']],
  [/marketing|市场营销|营销/, ['Marketing Specialist', 'Growth Analyst']],
  [/account|会计|审计/, ['Accountant', 'Financial Analyst']],
  [/film|cinema|media stud|broadcast|影视|电影|广播电视|传媒/, ['Video Editor', 'Production Assistant', 'Media Production Coordinator']],
  [/animation|动画|game design|游戏设计/, ['Animator', 'Game Designer']],
  [/journalism|新闻|communication stud|传播学/, ['Content Writer', 'Communications Specialist']],
  [/physics|物理/, ['Data Analyst', 'Research Assistant', 'Process Engineer']],
  [/biolog|biomed|life science|生物|生命科学/, ['Research Associate', 'Lab Technician', 'Clinical Research Coordinator']],
  [/chemis|chemical|化学|化工/, ['Chemist', 'Process Engineer', 'Quality Control Analyst']],
  [/environment|sustainab|环境|生态/, ['Environmental Engineer', 'Sustainability Analyst', 'EHS Specialist']],
  [/material|材料/, ['Materials Engineer', 'Process Engineer']],
  [/civil|土木|structural engineering/, ['Civil Engineer', 'Structural Engineer', 'Construction Project Coordinator']],
  [/architect|建筑/, ['Architectural Designer', 'BIM Coordinator']],
  [/aerospace|航空|航天/, ['Aerospace Engineer', 'Systems Engineer']],
  [/nursing|护理/, ['Registered Nurse', 'Clinical Nurse']],
  [/medicine|\bmedical\b|临床医学|公共卫生|public health/, ['Clinical Research Coordinator', 'Public Health Analyst', 'Medical Assistant']],
  [/pharma|药学|制药/, ['Pharmaceutical Research Associate', 'Regulatory Affairs Specialist']],
  [/psycholog|心理/, ['Research Assistant', 'UX Researcher', 'HR Specialist']],
  [/\blaw\b|legal|法学|法律/, ['Paralegal', 'Legal Assistant', 'Compliance Analyst']],
  [/education|teaching|pedagog|教育|师范/, ['Teacher', 'Instructional Designer', 'Education Program Coordinator']],
  [/linguistic|literature|translation|english stud|语言学|文学|翻译|英语专业/, ['Content Writer', 'Translator', 'Copywriter']],
  [/history|philosoph|sociolog|anthropolog|political science|international relations|历史|哲学|社会学|人类学|政治学|国际关系/, ['Research Assistant', 'Policy Analyst', 'Program Coordinator']],
  [/music|音乐/, ['Audio Engineer', 'Sound Designer', 'Music Producer']],
  // NOT bare "arts": every humanities degree is a "Bachelor of Arts" — only
  // explicit art-practice fields map to design roles.
  [/fine arts|studio art|visual arts|illustration|美术|艺术设计|插画/, ['Graphic Designer', 'Illustrator', 'Visual Designer']],
  [/supply chain|logistic|物流|供应链/, ['Supply Chain Analyst', 'Logistics Coordinator', 'Operations Coordinator']],
  [/hospitality|tourism|酒店管理|旅游/, ['Event Coordinator', 'Hospitality Operations Coordinator', 'Travel Consultant']],
  [/human resource|人力资源/, ['HR Specialist', 'Recruiter', 'HR Coordinator']],
  [/food science|nutrition|agricult|食品|营养|农业/, ['Food Scientist', 'Quality Assurance Specialist', 'Nutrition Assistant']],
  [/kinesiolog|sports? science|体育|运动科学/, ['Athletic Trainer', 'Fitness Coordinator', 'Sports Program Coordinator']],
];

function rolesFromEducation(profile) {
  const roles = [];
  for (const edu of profile.education || []) {
    const study = lower([edu.field_of_study, edu.degree, edu.major].filter(Boolean).join(' '));
    if (!study) continue;
    for (const [pattern, mapped] of FIELD_ROLE_MAP) {
      if (pattern.test(study)) roles.push(...mapped);
    }
  }
  return roles;
}

// Real experience/role titles when the profile carries them.
function rolesFromExperience(profile) {
  return (profile.experience || [])
    .map(item => text(item.role || item.title))
    .filter(Boolean);
}

// New-grad signal: date evidence first (derived years of experience), the
// structural degree-without-work shape only as fallback — a resume whose parse
// buried employers in free-text bullets must not turn an experienced person
// into a "new grad", and vice versa.
function derivesEntryLevel(profile, plan) {
  if (plan.entry_level) return true;
  const hasDegree = (profile.education || []).some(edu => text(edu.degree || edu.field_of_study));
  const hasExperience = (profile.experience || []).some(item => text(item.role || item.title || item.company));
  const years = estimateYears(profile);
  const textYears = Number.isFinite(years) && years > 0 ? years : null;
  // Degree + no structured employment = new grad, unless text-mined years
  // clearly disagree (>3 protects experienced people whose parse failed).
  if (hasDegree && !hasExperience) return textYears == null || textYears <= 3;
  return textYears != null && textYears <= 1;
}

const DEFAULT_ROLES = ['Software Engineer', 'Data Analyst', 'Business Analyst'];

const ATS_SITES = [
  'jobs.lever.co',
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.ashbyhq.com',
  'apply.workable.com',
  'jobs.smartrecruiters.com',
  'myworkdayjobs.com',
];

// Public index pages of login-walled boards — discovered here as leads, kept
// (marked limited_access) rather than dropped, per the "don't lose a finding
// just because we can't sign in" rule.
const PUBLIC_INDEX_SITES = [
  'linkedin.com/jobs',
  'zhipin.com',
  'liepin.com',
  '51job.com',
];

export function buildSearchQueries({ careerProfile = {}, criteria = {}, maxRoles = 8, maxTextQueries = 60 } = {}) {
  const profile = normalizeCareerProfile(careerProfile);
  const plan = normalizeSearchCriteria(criteria);

  // Role directions in priority order; the first non-empty tiers win, but a
  // sparse profile still falls through to education-derived and finally to a
  // sensible default so the planner is never empty.
  const derived = unique([
    ...plan.target_roles,
    ...plan.keywords,
    ...profile.career_goals,
    ...rolesFromExperience(profile),
    ...adjacentRoles(profile),
    ...rolesFromEducation(profile),
  ]);
  const roles = (derived.length ? derived : DEFAULT_ROLES).slice(0, maxRoles);
  const entryLevel = derivesEntryLevel(profile, plan);

  // Locations: plan locations, else the profile's own city/country, else world.
  const profileCities = unique([
    ...(profile.job_preferences?.cities || []),
    profile.identity?.city,
  ].filter(Boolean));
  const locations = plan.locations.length ? plan.locations : (profileCities.length ? profileCities : ['']);
  const remoteTerms = plan.remote === 'remote' ? ['remote'] : plan.remote === 'hybrid' ? ['hybrid'] : [];
  const levelTerms = entryLevel ? ['new grad', 'entry level'] : [];

  // Text queries: role × location, each in a plain and a job-suffixed form,
  // plus bilingual variants and (for new-grad profiles) entry-level combos.
  const textQueries = [];
  const pushText = (parts, role, location, purpose) => {
    const query = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (query) textQueries.push({ query, role, location, purpose });
  };
  for (const role of roles) {
    const isCjk = /[一-鿿]/.test(role);
    for (const location of locations) {
      pushText([role, location, ...remoteTerms, 'jobs'], role, location, 'web_search');
      // Bilingual: a CJK role also searched as 招聘; a latin role also as jobs
      // hiring so bing surfaces boards either way.
      if (isCjk || /[一-鿿]/.test(location)) {
        pushText([role, location, '招聘'], role, location, 'web_search_zh');
      }
      for (const level of levelTerms) {
        pushText([level, role, location, 'jobs'], role, location, 'web_search_level');
      }
    }
    for (const level of (entryLevel ? ['应届', '校招'] : [])) {
      if (isCjk) pushText([role, level, '招聘'], role, '', 'web_search_level_zh');
    }
  }

  // Site: queries expand the ATS pool (real public boards) and surface leads on
  // public index pages of login-walled boards (kept as limited_access).
  const siteQueries = [];
  const siteRoles = roles.slice(0, 4);
  for (const role of siteRoles) {
    for (const site of ATS_SITES) {
      siteQueries.push({ query: `site:${site} "${role}"`, site, role, purpose: 'ats_site_search' });
    }
  }
  for (const role of siteRoles.slice(0, 2)) {
    for (const site of PUBLIC_INDEX_SITES) {
      siteQueries.push({ query: `site:${site} ${role} ${locations[0] || ''}`.trim(), site, role, purpose: 'public_index_search' });
    }
  }

  // Board keywords drive the direct ATS-board filter, expanded across the
  // bilingual role families so a Chinese board term still matches English
  // postings and vice-versa.
  const boardKeywords = unique([...roles, ...expandKeywordTerms(roles)]).slice(0, 16);
  const boardQueries = boardKeywords.map(keyword => ({ keyword, role: keyword }));

  const browserQueries = [];
  for (const role of roles.slice(0, 4)) {
    for (const location of locations.slice(0, 3)) {
      browserQueries.push({ keyword: role, city: location, role });
    }
  }

  return {
    roles,
    entry_level: entryLevel,
    text_queries: unique(textQueries.map(item => JSON.stringify(item))).map(item => JSON.parse(item)).slice(0, maxTextQueries),
    site_queries: siteQueries.slice(0, 40),
    board_queries: boardQueries,
    browser_queries: browserQueries.slice(0, 8),
  };
}
