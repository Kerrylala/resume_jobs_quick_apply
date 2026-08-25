// Bilingual keyword families — a plan keyword written in one language must not
// hard-filter out the same role advertised in the other ("销售" vs "Account
// Executive"). Expansion only LOOSENS the required-keyword rule: it adds match
// possibilities, it never removes any. Deterministic, no AI.
const text = value => String(value ?? '').normalize('NFKC').trim();
const lower = value => text(value).toLocaleLowerCase('en-US');

// Each family is one job-role concept across languages/titles. Members double
// as triggers: a plan term activates a family when it contains (or is
// contained by) a member. Members stay >= 3 latin chars or CJK to avoid
// accidental substring hits in job text.
export const KEYWORD_FAMILIES = Object.freeze([
  ['销售', 'sales', 'account executive', 'account manager', 'sales representative',
    'sales development', 'business development', 'sales engineer', 'sales manager',
    '客户经理', '商务拓展', '大客户'],
  ['软件工程师', 'software engineer', 'software developer', 'software development',
    '研发工程师', '开发工程师', 'programmer', 'full stack', 'fullstack', '全栈'],
  ['ai工程师', 'ai engineer', 'machine learning', 'ml engineer', 'applied ai',
    'applied scientist', 'deep learning', '算法工程师', '机器学习', '人工智能', '大模型', 'llm engineer'],
  ['解决方案', 'solutions engineer', 'solution engineer', 'solutions consultant',
    'solution consultant', 'solutions architect', 'presales', 'pre-sales', '售前'],
  ['数据分析', 'data analyst', 'data analytics', '数据分析师'],
  ['数据工程师', 'data engineer', 'data engineering'],
  ['产品经理', 'product manager', 'product management'],
  ['前端', 'front end', 'frontend', 'front-end', 'web developer'],
  ['后端', 'back end', 'backend', 'back-end', 'server-side'],
  ['测试工程师', 'qa engineer', 'test engineer', 'quality assurance', 'sdet', '质量保障'],
  ['运维', 'devops', 'site reliability', 'sre', '运维工程师'],
  ['实习', 'intern', 'internship', '实习生'],
  ['应届', 'new grad', 'entry level', 'entry-level', 'graduate program', 'campus hire',
    '校招', '应届生', 'early career'],
  ['客户成功', 'customer success'],
  ['咨询顾问', 'consultant', 'consulting', '咨询'],
].map(family => Object.freeze(family.map(lower))));

function familyMatchesTerm(family, term) {
  return family.some(member =>
    member === term
    || (term.length >= 2 && member.includes(term))
    || (member.length >= 2 && term.includes(member)));
}

// Plan terms -> the terms plus every member of each family a term activates.
// Unknown terms pass through unchanged (they still match literally).
export function expandKeywordTerms(terms = []) {
  const expanded = new Set();
  for (const raw of Array.isArray(terms) ? terms : []) {
    const term = lower(raw);
    if (!term) continue;
    expanded.add(term);
    for (const family of KEYWORD_FAMILIES) {
      if (familyMatchesTerm(family, term)) for (const member of family) expanded.add(member);
    }
  }
  return [...expanded];
}
