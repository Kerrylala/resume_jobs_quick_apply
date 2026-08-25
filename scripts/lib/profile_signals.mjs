// Profile signal extraction — the single place that reads a Career Profile and
// pulls out the things matching and planning actually need: skills, role
// directions, years, education level, locations. Real resumes stuff content
// into free-text fields (responsibilities, project descriptions) and leave the
// structured role/company/skills empty; this module mines ALL of it so nothing
// real is dropped. Deterministic, no AI.
import { expandKeywordTerms } from './keyword_synonyms.mjs';

const text = value => String(value ?? '').normalize('NFKC').trim();
const lower = value => text(value).toLocaleLowerCase('en-US');

function uniq(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = lower(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Every text fragment a profile carries, structured OR free-text.
export function allProfileText(profile = {}) {
  const parts = [];
  for (const edu of profile.education || []) {
    parts.push(edu.degree, edu.field_of_study, edu.major, edu.institution, ...(edu.coursework || []), ...(edu.achievements || []));
  }
  for (const exp of profile.experience || []) {
    parts.push(exp.role, exp.title, exp.company, exp.location,
      ...(exp.responsibilities || []), ...(exp.achievements || []), ...(exp.technologies || []));
  }
  for (const proj of profile.projects || []) {
    parts.push(proj.name, proj.description, ...(proj.results || []), ...(proj.technologies || []), ...(proj.achievements || []));
  }
  parts.push(...Object.values(profile.skills || {}).flat());
  parts.push(...(profile.career_goals || []));
  return parts.map(text).filter(Boolean).join('\n');
}

// Tech-skill vocabulary. Each entry: the canonical skill + regex to find it in
// any-language text. Kept practical, not exhaustive — expands over time.
const SKILL_VOCAB = [
  ['Java', /\bjava\b/i], ['Python', /\bpython\b/i], ['JavaScript', /\bjavascript\b|\bjs\b/i],
  ['TypeScript', /\btypescript\b|\bts\b/i], ['Node.js', /\bnode\.?js\b/i], ['React', /\breact\b/i],
  ['C++', /\bc\+\+\b/i], ['C#', /\bc#\b/i], ['Go', /\bgolang\b/i], ['Rust', /\brust\b/i],
  ['SQL', /\bsql\b|mysql|postgres/i], ['Android', /\bandroid\b/i], ['iOS', /\bios\b|swift/i],
  ['Android Studio', /android studio/i], ['Playwright', /\bplaywright\b/i], ['Selenium', /\bselenium\b/i],
  ['Chrome Extension', /chrome extension|浏览器(插件|扩展)/i], ['Docker', /\bdocker\b/i],
  ['Kubernetes', /\bkubernetes\b|\bk8s\b/i], ['AWS', /\baws\b/i], ['GCP', /\bgcp\b|google cloud/i],
  ['Azure', /\bazure\b/i], ['PyTorch', /\bpytorch\b/i], ['TensorFlow', /\btensorflow\b/i],
  ['Machine Learning', /machine learning|机器学习|深度学习|deep learning/i],
  ['LLM', /\bllm\b|大模型|gpt|大语言模型/i], ['AI Tools', /\bai\b工具|ai tools|gamma|copilot/i],
  ['Data Analysis', /data analysis|数据分析/i], ['Excel', /\bexcel\b/i], ['Git', /\bgit\b|github/i],
  ['Linux', /\blinux\b/i], ['REST API', /rest api|restful/i], ['HTML', /\bhtml\b/i], ['CSS', /\bcss\b/i],
];

export function mineSkills(bodyText) {
  const body = String(bodyText || '');
  const found = [];
  for (const [skill, pattern] of SKILL_VOCAB) {
    if (pattern.test(body)) found.push(skill);
  }
  return found;
}

// Structured skills + skills mined from all free text.
export function extractSkills(profile = {}) {
  const structured = Object.values(profile.skills || {}).flat().map(text).filter(Boolean);
  return uniq([...structured, ...mineSkills(allProfileText(profile))]);
}

// Field-of-study → role directions (bilingual). Same taxonomy the planner uses.
const FIELD_ROLE_MAP = [
  [/computer science|软件|计算机|software|informatics|信息技术/, ['Software Engineer', 'Backend Engineer', 'Full Stack Engineer']],
  [/machine learning|artificial intelligence|人工智能|deep learning|神经网络/, ['Machine Learning Engineer', 'AI Engineer']],
  [/data science|data analytics|数据科学|大数据/, ['Data Scientist', 'Data Analyst', 'Data Engineer']],
  [/statistic|统计/, ['Data Analyst', 'Data Scientist', 'Quantitative Analyst']],
  [/\bmath|mathematic|数学/, ['Data Analyst', 'Quantitative Analyst', 'Software Engineer']],
  [/econ|经济/, ['Business Analyst', 'Financial Analyst', 'Data Analyst']],
  [/finance|金融|财务/, ['Financial Analyst', 'Business Analyst']],
  [/business|管理|工商|mba|商科/, ['Business Analyst', 'Product Manager', 'Operations Analyst']],
  [/electric|electronic|电子|通信/, ['Hardware Engineer', 'Embedded Software Engineer']],
  [/mechanical|机械|自动化/, ['Mechanical Engineer', 'Automation Engineer']],
  [/design|设计|人机交互|hci/, ['Product Designer', 'UX Designer']],
  [/marketing|市场营销|营销/, ['Marketing Specialist', 'Growth Analyst']],
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

// Role titles mentioned in experience free-text (Chinese or English).
const TITLE_HINTS = [
  [/软件工程(师|实习)|software engineer|software developer|开发工程师|研发工程师/i, 'Software Engineer'],
  [/前端|front[- ]?end/i, 'Frontend Engineer'],
  [/后端|back[- ]?end/i, 'Backend Engineer'],
  [/数据分析|data analyst/i, 'Data Analyst'],
  [/机器学习|machine learning|ml engineer|ai engineer|算法工程/i, 'AI Engineer'],
  [/产品经理|product manager/i, 'Product Manager'],
  [/市场|marketing|营销/i, 'Marketing Specialist'],
  [/销售|sales|account executive/i, 'Sales'],
  [/解决方案|solutions? (engineer|consultant)|售前/i, 'Solutions Engineer'],
];

function rolesFromFieldOfStudy(profile) {
  const roles = [];
  for (const edu of profile.education || []) {
    const study = lower([edu.field_of_study, edu.degree, edu.major].filter(Boolean).join(' '));
    for (const [pattern, mapped] of FIELD_ROLE_MAP) if (pattern.test(study)) roles.push(...mapped);
  }
  return roles;
}

function rolesFromText(profile) {
  const body = allProfileText(profile);
  const roles = [];
  for (const [pattern, role] of TITLE_HINTS) if (pattern.test(body)) roles.push(role);
  return roles;
}

// Derived role directions in priority order: explicit titles/goals → mined
// titles → field-of-study. Deduped, bounded.
export function deriveRoles(profile = {}, { limit = 10 } = {}) {
  const explicit = [
    ...(profile.career_goals || []),
    ...(profile.experience || []).map(e => text(e.role || e.title)).filter(Boolean),
  ];
  return uniq([...explicit, ...rolesFromText(profile), ...rolesFromFieldOfStudy(profile)]).slice(0, limit);
}

// Honest years estimate: parse "YYYY年MM月 - YYYY年MM月" / "YYYY - YYYY" ranges
// from all experience text, sum their spans (months), cap at a sane bound.
export function estimateYears(profile = {}) {
  const body = (profile.experience || [])
    .flatMap(e => [e.dates, e.start_date, e.end_date, ...(e.responsibilities || [])])
    .map(text).join('\n');
  let months = 0;
  const cn = /(20\d{2})\s*年\s*(\d{1,2})?\s*月?\s*[-–~至到]\s*(20\d{2}|至今|现在|present)\s*年?\s*(\d{1,2})?\s*月?/gi;
  for (const m of body.matchAll(cn)) {
    const y1 = Number(m[1]); const mo1 = Number(m[2] || 1);
    const y2 = /至今|现在|present/i.test(m[3]) ? 2026 : Number(m[3]);
    const mo2 = /至今|现在|present/i.test(m[3]) ? 8 : Number(m[4] || 12);
    if (Number.isFinite(y1) && Number.isFinite(y2) && y2 >= y1) months += Math.max(1, (y2 - y1) * 12 + (mo2 - mo1));
  }
  if (months === 0) return null;
  return Math.max(0.5, Math.round((months / 12) * 10) / 10);
}

// Education level, bilingual.
export function educationLevel(profile = {}) {
  const body = lower((profile.education || []).map(e => [e.degree, e.field_of_study].join(' ')).join(' '));
  if (/phd|doctora|博士/.test(body)) return 'doctorate';
  if (/master|硕士|研究生|mba/.test(body)) return 'masters';
  if (/bachelor|本科|学士|undergraduate/.test(body)) return 'bachelors';
  return '';
}

// Locations: identity + preferences + cities mentioned in experience text.
const CITY_HINTS = [
  ['上海', 'Shanghai'], ['北京', 'Beijing'], ['深圳', 'Shenzhen'], ['广州', 'Guangzhou'],
  ['杭州', 'Hangzhou'], ['圣地亚哥', 'San Diego'], ['旧金山', 'San Francisco'], ['纽约', 'New York'],
  ['西雅图', 'Seattle'], ['洛杉矶', 'Los Angeles'], ['波士顿', 'Boston'],
];
export function profileLocations(profile = {}) {
  const explicit = [
    profile.identity?.city, profile.identity?.country, profile.identity?.current_location,
    ...(profile.job_preferences?.cities || []), ...(profile.job_preferences?.countries || []),
  ].map(text).filter(Boolean);
  const body = allProfileText(profile);
  const mentioned = [];
  for (const [cn, en] of CITY_HINTS) if (body.includes(cn) || new RegExp(`\\b${en}\\b`, 'i').test(body)) mentioned.push(cn, en);
  return uniq([...explicit, ...mentioned]);
}

// Career terms for matching = derived roles, bilingual-expanded so a Chinese
// role matches an English posting and vice-versa.
export function careerTermsForMatching(profile = {}) {
  const roles = deriveRoles(profile);
  return uniq([...roles, ...expandKeywordTerms(roles)]);
}
