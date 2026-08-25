import { normalizeCareerProfile } from './career_brain.mjs';

function text(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function unique(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = text(item).toLocaleLowerCase('en-US');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function preferenceTerms(items = []) {
  return (Array.isArray(items) ? items : [])
    .filter(item => typeof item === 'string' || item?.enabled !== false)
    .map(item => text(typeof item === 'string' ? item : item?.keyword))
    .filter(Boolean);
}

function adjacentRoleStrategies(profile) {
  const skills = profile.skills || {};
  const hasProgramming = (skills.programming || []).length > 0;
  const hasAI = (skills.ai_tools || []).length > 0;
  const hasData = (skills.data || []).length > 0;
  const hasBusiness = (skills.business || []).length > 0;
  const strategies = [];
  if (hasProgramming) strategies.push({ role: 'Software Engineer', category: 'technical', reason: 'verified programming skills' });
  if (hasProgramming && hasAI) strategies.push({ role: 'AI Engineer', category: 'technical', reason: 'programming plus AI tools' });
  if (hasAI && hasBusiness) strategies.push({ role: 'AI Product Manager', category: 'product', reason: 'AI tools plus business/product skills' });
  if (hasProgramming && hasBusiness) strategies.push({ role: 'Solutions Engineer', category: 'business', reason: 'programming plus customer/business skills' });
  if (hasAI && hasBusiness) strategies.push({ role: 'AI Consultant', category: 'business', reason: 'AI tools plus business problem-solving skills' });
  if (hasData && hasBusiness) strategies.push({ role: 'Product Analyst', category: 'product', reason: 'data plus business/product skills' });
  if (hasData) strategies.push({ role: 'Data Analyst', category: 'data', reason: 'verified data and analysis skills' });
  if (hasBusiness) strategies.push({ role: 'Technical Sales', category: 'business', reason: 'business skills with a technical career profile' });
  return strategies;
}

function roleCategory(role) {
  const value = text(role).toLowerCase();
  if (/product|program manager/.test(value)) return 'product';
  if (/solution|consult|sales|customer|business/.test(value)) return 'business';
  if (/data|analyst|analytics/.test(value)) return 'data';
  if (/engineer|developer|software|technical|machine learning|\bai\b/.test(value)) return 'technical';
  return 'other';
}

function regionType(value) {
  const location = text(value).toLowerCase();
  return /china|中国|shanghai|上海|beijing|北京|shenzhen|深圳|guangzhou|广州|hangzhou|杭州|nanjing|南京|chengdu|成都|wuhan|武汉|suzhou|苏州/.test(location) ? 'china' : 'global';
}

export function buildJobSearchPlan({ careerProfile = {}, searchPreferences = {}, maxRoles = 10, maxQueries = 20 } = {}) {
  const profile = normalizeCareerProfile(careerProfile);
  const directRoles = unique([
    ...preferenceTerms(searchPreferences.target_roles),
    ...profile.career_goals
  ]);
  const directLimit = Math.max(1, maxRoles - 4);
  const primary = directRoles.slice(0, directLimit);
  const adjacent = adjacentRoleStrategies(profile)
    .filter(strategy => !directRoles.some(role => role.toLowerCase() === strategy.role.toLowerCase()))
    .slice(0, Math.max(0, maxRoles - primary.length));
  const roles = [
    ...primary.map(role => ({ role, category: roleCategory(role), kind: 'direct', reason: 'User career goal or saved search target' })),
    ...adjacent.map(strategy => ({ ...strategy, category: strategy.category || roleCategory(strategy.role), kind: 'transferable' }))
  ].slice(0, maxRoles);
  const locations = unique([
    ...preferenceTerms(searchPreferences.preferred_locations || searchPreferences.locations),
    ...(profile.job_preferences?.cities || []),
    ...(profile.job_preferences?.countries || [])
  ]);
  const effectiveLocations = locations.length ? locations : ['Remote'];
  const keywords = unique([
    ...preferenceTerms(searchPreferences.required_skills),
    ...preferenceTerms(searchPreferences.preferred_skills),
    ...Object.values(profile.skills || {}).flatMap(values => Array.isArray(values) ? values : [])
  ]).slice(0, 24);
  const plannedAt = new Date().toISOString();
  const queries = [];
  for (const strategy of roles) {
    for (const location of effectiveLocations) {
      const region = regionType(location);
      const templates = region === 'china'
        ? [`${strategy.role} ${location} 官网 招聘`, `${strategy.role} ${location} 职位`]
        : [`${strategy.role} ${location} careers`, `${strategy.role} ${location} jobs`];
      for (const query of templates) {
        const preferredSources = region === 'china'
          ? ['company_career', 'public_job_pages', 'user_imported_urls']
          : ['ats', 'career_pages'];
        queries.push({
          query,
          source: preferredSources[0],
          time: plannedAt,
          reason: `${strategy.reason}; search in ${location}`,
          role: strategy.role,
          role_kind: strategy.kind,
          role_reason: strategy.reason,
          location,
          region,
          preferred_source_types: preferredSources
        });
      }
    }
  }
  const sourceRegions = new Set(effectiveLocations.map(regionType));
  const sources = [
    ...(sourceRegions.has('china') ? [
      { market: 'china', source: 'company_career', reason: 'First-party public company career pages.' },
      { market: 'china', source: 'public_job_pages', reason: 'Legally accessible public job pages; never bypass login or anti-bot controls.' },
      { market: 'china', source: 'user_imported_urls', reason: 'Public URLs explicitly selected by the user.' }
    ] : []),
    ...(sourceRegions.has('global') ? [
      { market: 'global', source: 'ats', reason: 'Public application pages hosted for employers.' },
      { market: 'global', source: 'career_pages', reason: 'First-party public company career pages.' }
    ] : [])
  ];
  const roleGroups = Object.fromEntries(['technical', 'product', 'business', 'data', 'other'].map(category => [category, roles.filter(item => item.category === category)]));
  return {
    schema_version: '1.0',
    generated_at: plannedAt,
    profile_id: profile.id,
    profile_approved: profile.user_approved === true,
    primary_roles: roles.filter(item => item.kind === 'direct'),
    target_roles: roles.filter(item => item.kind === 'direct'),
    adjacent_roles: roles.filter(item => item.kind === 'transferable'),
    role_groups: roleGroups,
    roles,
    locations: effectiveLocations,
    keywords,
    sources,
    queries: queries.slice(0, maxQueries),
    safety: {
      query_plan_only: true,
      public_sources_only: true,
      login_or_bypass_requested: false,
      user_approval_required_before_application: true
    }
  };
}
