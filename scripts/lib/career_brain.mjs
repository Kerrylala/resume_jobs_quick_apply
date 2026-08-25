import crypto from 'node:crypto';

const PROFILE_STATES = new Set(['draft', 'approved', 'archived']);
const REMOTE_MODES = new Set(['', 'any', 'onsite', 'hybrid', 'remote']);
const SKILL_GROUPS = ['programming', 'ai_tools', 'frameworks', 'cloud', 'data', 'business'];
const MAX_TEXT = 20_000;

function text(value, max = MAX_TEXT) {
  return String(value ?? '').normalize('NFKC').trim().slice(0, max);
}

function list(value, maxItems = 200) {
  const values = Array.isArray(value) ? value : (value === null || value === undefined || value === '' ? [] : [value]);
  const seen = new Set();
  const output = [];
  for (const item of values) {
    const normalized = text(item, 1000);
    const key = normalized.toLocaleLowerCase('en-US');
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    output.push(normalized);
    if (output.length >= maxItems) break;
  }
  return output;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stableId(prefix, seed = '') {
  const digest = crypto.createHash('sha256').update(text(seed) || crypto.randomUUID()).digest('hex').slice(0, 16);
  return `${prefix}_${digest}`;
}

function normalizeIdentity(input = {}) {
  const source = object(input);
  return {
    full_name: text(source.full_name),
    first_name: text(source.first_name),
    last_name: text(source.last_name),
    preferred_name: text(source.preferred_name),
    chinese_name: text(source.chinese_name),
    english_name: text(source.english_name),
    email: text(source.email, 320),
    phone: text(source.phone, 100),
    current_location: text(source.current_location || [source.city, source.state_or_province, source.country].filter(Boolean).join(', '), 500),
    city: text(source.city, 200),
    state_or_province: text(source.state_or_province, 200),
    country: text(source.country, 200),
    links: {
      linkedin: text(source.links?.linkedin || source.linkedin, 1000),
      github: text(source.links?.github || source.github, 1000),
      portfolio: text(source.links?.portfolio || source.portfolio || source.personal_website, 1000),
      other: list(source.links?.other || source.other_links, 30)
    }
  };
}

function normalizeEducationItem(input = {}) {
  const source = object(input);
  return {
    id: text(source.id, 100) || stableId('education', JSON.stringify(source)),
    institution: text(source.institution || source.school || source.university, 500),
    degree: text(source.degree, 300),
    field_of_study: text(source.field_of_study || source.major || source.discipline, 500),
    start_date: text(source.start_date, 100),
    end_date: text(source.end_date || source.graduation_date || source.graduation_year, 100),
    location: text(source.location, 300),
    achievements: list(source.achievements || source.honors, 50),
    coursework: list(source.coursework || source.relevant_coursework, 100)
  };
}

function normalizeExperienceItem(input = {}) {
  const source = typeof input === 'string' ? { description: input } : object(input);
  return {
    id: text(source.id, 100) || stableId('experience', JSON.stringify(source)),
    company: text(source.company || source.employer, 500),
    role: text(source.role || source.title || source.job_title, 500),
    start_date: text(source.start_date, 100),
    end_date: text(source.end_date, 100),
    dates: text(source.dates || source.duration, 200),
    location: text(source.location, 300),
    responsibilities: list(source.responsibilities || source.description, 100),
    achievements: list(source.achievements, 100),
    technologies: list(source.technologies || source.skills || source.tools, 100)
  };
}

function normalizeProjectItem(input = {}) {
  const source = typeof input === 'string' ? { description: input } : object(input);
  return {
    id: text(source.id, 100) || stableId('project', JSON.stringify(source)),
    name: text(source.name || source.title, 500),
    description: text(source.description),
    technologies: list(source.technologies || source.skills || source.tools, 100),
    results: list(source.results || source.achievements || source.outcomes, 100),
    url: text(source.url, 1000),
    dates: text(source.dates || source.duration, 200)
  };
}

function normalizeCertification(input = {}) {
  const source = typeof input === 'string' ? { name: input } : object(input);
  return {
    id: text(source.id, 100) || stableId('certification', JSON.stringify(source)),
    name: text(source.name || source.title, 500),
    issuer: text(source.issuer || source.organization, 500),
    issued_date: text(source.issued_date || source.date, 100),
    expiration_date: text(source.expiration_date, 100),
    credential_id: text(source.credential_id, 300),
    url: text(source.url, 1000)
  };
}

function normalizeLanguage(input = {}) {
  const source = typeof input === 'string' ? { name: input } : object(input);
  return {
    id: text(source.id, 100) || stableId('language', JSON.stringify(source)),
    name: text(source.name || source.language, 300),
    proficiency: text(source.proficiency || source.level, 200)
  };
}

function normalizeStory(input = {}) {
  const source = object(input);
  return {
    id: text(source.id, 100) || stableId('story', JSON.stringify(source)),
    title: text(source.title, 500),
    situation: text(source.situation),
    task: text(source.task),
    action: text(source.action),
    result: text(source.result),
    skills: list(source.skills, 50),
    user_confirmed: source.user_confirmed === true
  };
}

function structuredList(value, normalizer) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(item => normalizer(item)).filter(item => Object.entries(item).some(([key, field]) => key !== 'id' && (Array.isArray(field) ? field.length : field)));
}

function normalizeSkills(input = {}) {
  const source = Array.isArray(input) ? { programming: input } : object(input);
  const output = {};
  for (const group of SKILL_GROUPS) output[group] = list(source[group], 200);
  return output;
}

function normalizePreferences(input = {}) {
  const source = object(input);
  const remote = text(source.remote || source.remote_mode || source.remote_ok, 100).toLowerCase();
  return {
    countries: list(source.countries || source.target_countries, 100),
    cities: list(source.cities || source.target_cities, 100),
    remote: REMOTE_MODES.has(remote) ? remote : '',
    salary: text(source.salary || source.salary_expectation, 300),
    industries: list(source.industries || source.preferred_industries, 100),
    blocked_industries: list(source.blocked_industries, 100),
    relocation_ok: text(source.relocation_ok, 100),
    work_authorization: text(source.work_authorization, 500),
    sponsorship: text(source.sponsorship || source.sponsorship_required, 500),
    earliest_start_date: text(source.earliest_start_date || source.start_date, 200),
    notice_period: text(source.notice_period, 200),
    current_company: text(source.current_company, 500)
  };
}

// Legacy relocation values arrive as booleans, "true"/"false" strings, or free
// text. The projection exposes a stable enum next to the raw text; unknown
// wording stays '' rather than being guessed.
export function normalizeRelocationAnswer(value) {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  const normalized = text(value, 100).toLowerCase();
  if (!normalized) return '';
  if (/^(true|yes|y|willing|open|ok|okay|sure|可以|愿意)/.test(normalized)) return 'yes';
  if (/^(false|no|n|not |unwilling|不能|不愿意|不考虑)/.test(normalized)) return 'no';
  if (/(depend|maybe|discuss|case|negotiable|视情况|看情况|待定)/.test(normalized)) return 'depends';
  return '';
}

function currentExperienceEntry(profile) {
  return (profile.experience || []).find(item => {
    const end = text(item.end_date || '').toLowerCase();
    const dates = text(item.dates || '').toLowerCase();
    return end === '' || end === 'present' || end === 'current' || end === '至今'
      || /present|current|至今/.test(dates);
  }) || (profile.experience || [])[0] || null;
}

function deriveCurrentCompany(profile) {
  const explicit = text(profile.job_preferences?.current_company, 500);
  if (explicit) return explicit;
  return text(currentExperienceEntry(profile)?.company, 500);
}

function deriveCurrentRole(profile) {
  const explicit = text(profile.job_preferences?.current_title, 500);
  if (explicit) return explicit;
  return text(currentExperienceEntry(profile)?.role, 500);
}

// The family name comes FIRST in an unspaced CJK full name; common
// two-character surnames are checked before the single-character default.
const CJK_DOUBLE_SURNAMES = ['欧阳', '司马', '上官', '诸葛', '夏侯', '皇甫', '尉迟', '公孙', '令狐', '慕容', '司徒', '端木', '东方', '独孤', '南宫', '西门', '轩辕'];

// Deterministic first/last derivation from an approved full name. The user
// approved the profile that carries the full name, and asked for the split to
// be automatic — CJK names split surname-first, spaced names split on the
// last token (Western order).
export function deriveNameParts(fullName = '') {
  const full = text(fullName, 300);
  if (!full) return { first_name: '', last_name: '' };
  if (/^[㐀-鿿]{2,4}$/.test(full)) {
    const surnameLength = CJK_DOUBLE_SURNAMES.some(surname => full.startsWith(surname)) ? 2 : 1;
    return { first_name: full.slice(surnameLength), last_name: full.slice(0, surnameLength) };
  }
  const pieces = full.split(/\s+/).filter(Boolean);
  if (pieces.length < 2) return { first_name: full, last_name: '' };
  return { first_name: pieces.slice(0, -1).join(' '), last_name: pieces[pieces.length - 1] };
}

// Rough total experience in whole years, from the earliest start date to the
// latest end date (or now for a current position). Absent/unparseable dates
// simply produce '' — never a guess.
function deriveYearsExperience(profile) {
  const explicit = text(profile.job_preferences?.years_experience, 50);
  if (explicit) return explicit;
  const parseYear = value => {
    const match = String(value || '').match(/(19|20)\d{2}/);
    return match ? Number(match[0]) : null;
  };
  let earliest = null;
  let latest = null;
  for (const item of profile.experience || []) {
    const start = parseYear(item.start_date) ?? parseYear(item.dates);
    const endText = text(item.end_date || '').toLowerCase();
    const isCurrent = endText === '' || /present|current|至今/.test(endText + ' ' + text(item.dates).toLowerCase());
    const end = isCurrent ? new Date().getFullYear() : parseYear(item.end_date) ?? parseYear(item.dates);
    if (start !== null && (earliest === null || start < earliest)) earliest = start;
    if (end !== null && (latest === null || end > latest)) latest = end;
  }
  if (earliest === null || latest === null || latest < earliest) return '';
  return String(latest - earliest);
}

function normalizeProvenance(value = {}) {
  const output = {};
  for (const [key, record] of Object.entries(object(value))) {
    const source = object(record);
    output[text(key, 300)] = {
      source: text(source.source, 200),
      confidence: Math.max(0, Math.min(1, Number(source.confidence) || 0)),
      user_confirmed: source.user_confirmed === true,
      updated_at: text(source.updated_at, 100),
      last_used: text(source.last_used, 100) || null
    };
  }
  return output;
}

export function emptyCareerProfile({ id = '', name = 'Primary Career Profile', now = new Date().toISOString() } = {}) {
  const profileId = text(id, 100) || stableId('career', `${name}:${now}`);
  return {
    schema_version: '1.0',
    id: profileId,
    family_id: profileId,
    name: text(name, 200) || 'Primary Career Profile',
    version: 1,
    state: 'draft',
    user_approved: false,
    created_at: now,
    updated_at: now,
    approved_at: null,
    source_resume_ids: [],
    identity: normalizeIdentity(),
    education: [],
    experience: [],
    projects: [],
    skills: normalizeSkills(),
    certifications: [],
    languages: [],
    interview_stories: [],
    job_preferences: normalizePreferences(),
    career_goals: [],
    field_provenance: {}
  };
}

export function normalizeCareerProfile(input = {}, { now = new Date().toISOString() } = {}) {
  const source = object(input);
  const fallback = emptyCareerProfile({ id: source.id, name: source.name, now });
  const state = PROFILE_STATES.has(text(source.state).toLowerCase()) ? text(source.state).toLowerCase() : 'draft';
  const approved = state === 'approved' && source.user_approved === true && Boolean(text(source.approved_at));
  return {
    schema_version: '1.0',
    id: text(source.id, 100) || fallback.id,
    family_id: text(source.family_id, 100) || text(source.id, 100) || fallback.family_id,
    name: text(source.name, 200) || fallback.name,
    version: Math.max(1, Number.parseInt(source.version || 1, 10) || 1),
    state: approved ? 'approved' : (state === 'archived' ? 'archived' : 'draft'),
    user_approved: approved,
    created_at: text(source.created_at, 100) || now,
    updated_at: text(source.updated_at, 100) || now,
    approved_at: approved ? text(source.approved_at, 100) : null,
    parent_version_id: text(source.parent_version_id, 100) || null,
    source_resume_ids: list(source.source_resume_ids, 100),
    identity: normalizeIdentity(source.identity),
    education: structuredList(source.education, normalizeEducationItem),
    experience: structuredList(source.experience, normalizeExperienceItem),
    projects: structuredList(source.projects, normalizeProjectItem),
    skills: normalizeSkills(source.skills),
    certifications: structuredList(source.certifications, normalizeCertification),
    languages: structuredList(source.languages, normalizeLanguage),
    interview_stories: structuredList(source.interview_stories, normalizeStory),
    job_preferences: normalizePreferences(source.job_preferences),
    career_goals: list(source.career_goals, 100),
    field_provenance: normalizeProvenance(source.field_provenance)
  };
}

export function normalizeCareerBrainStore(input = {}) {
  const source = object(input);
  const profiles = (Array.isArray(source.profiles) ? source.profiles : []).map(profile => normalizeCareerProfile(profile));
  const unique = [];
  const ids = new Set();
  for (const profile of profiles) {
    if (ids.has(profile.id)) continue;
    ids.add(profile.id);
    unique.push(profile);
  }
  const active = text(source.active_profile_id, 100);
  return {
    schema_version: '1.0',
    active_profile_id: unique.some(profile => profile.id === active && profile.state !== 'archived') ? active : '',
    profiles: unique
  };
}

function legacySkills(profile) {
  const root = object(profile);
  const skills = object(root.skills);
  const work = object(root.work_background);
  // First NON-EMPTY list wins: `||` short-circuits on empty arrays (truthy in
  // JS), which silently discarded the skills the parser DID find in
  // work_background.skills whenever the preferred group existed but was empty.
  const firstNonEmpty = (...candidates) => candidates.map(list).find(items => items.length) || [];
  // Spoken languages never belong in a skills group — they have their own
  // profile field and their own resume line.
  const withoutLanguages = items => items.filter(item =>
    !/\b(?:native|professional|fluent|conversational|bilingual|proficiency)\b|母语|流利|中文|英文|英语|mandarin|cantonese/iu.test(String(item)));
  return {
    programming: withoutLanguages(firstNonEmpty(skills.programming, skills.programming_languages, work.skills)),
    ai_tools: firstNonEmpty(skills.ai_tools, skills.ai_skills),
    frameworks: list(skills.frameworks),
    cloud: list(skills.cloud),
    data: firstNonEmpty(skills.data, skills.data_skills),
    business: firstNonEmpty(skills.business, skills.product_skills, skills.domain_keywords)
  };
}

export function careerProfileFromCandidateProfile(profile = {}, {
  resumeId = '',
  name = 'Imported Career Profile',
  now = new Date().toISOString()
} = {}) {
  const source = object(profile);
  const work = object(source.work_background);
  const preferences = object(source.job_preferences);
  const identity = { ...object(source.identity) };
  for (const key of ['full_name', 'first_name', 'last_name', 'preferred_name', 'email', 'phone', 'city', 'state_or_province', 'country', 'linkedin', 'github', 'portfolio']) {
    if (!identity[key] && source[key] !== undefined) identity[key] = source[key];
  }
  const educationSource = source.education;
  const graduationDate = [source.graduation_month, source.graduation_year]
    .map(value => text(value, 20)).filter(Boolean).join(' ');
  const education = Array.isArray(educationSource)
    ? educationSource
    : (object(educationSource).school || source.school || source.degree || source.major
        ? [{
            ...object(educationSource),
            school: object(educationSource).school || source.school,
            degree: object(educationSource).degree || source.degree,
            major: object(educationSource).major || source.major,
            end_date: object(educationSource).end_date || graduationDate
          }]
        : []);
  const languages = Array.isArray(source.languages) ? source.languages : (object(source.skills).languages || []);
  return normalizeCareerProfile({
    id: stableId('career', `${resumeId}:${name}:${now}`),
    name,
    state: 'draft',
    user_approved: false,
    created_at: now,
    updated_at: now,
    source_resume_ids: resumeId ? [resumeId] : [],
    identity,
    education,
    experience: source.experience || work.work_experience || [],
    projects: source.projects || work.projects || [],
    skills: legacySkills(source),
    certifications: source.certifications || work.certifications || [],
    languages,
    interview_stories: source.interview_stories || [],
    job_preferences: {
      ...preferences,
      work_authorization: object(source.application_facts).work_authorization,
      sponsorship: object(source.application_facts).sponsorship
    },
    career_goals: source.career_goals || preferences.target_roles || (source.desired_role ? [source.desired_role] : []),
    field_provenance: source.field_provenance || {}
  }, { now });
}

function nextVersionId(profile, now) {
  return stableId('career', `${profile.family_id}:${profile.version + 1}:${now}:${crypto.randomUUID()}`);
}

export function createCareerProfile(store, { name = 'Career Profile', now = new Date().toISOString() } = {}) {
  const normalized = normalizeCareerBrainStore(store);
  const profile = emptyCareerProfile({ name, now });
  return {
    store: { ...normalized, active_profile_id: profile.id, profiles: [...normalized.profiles, profile] },
    profile
  };
}

export function saveCareerProfileVersion(store, { profileId, changes = {}, now = new Date().toISOString() } = {}) {
  const normalized = normalizeCareerBrainStore(store);
  const current = normalized.profiles.find(profile => profile.id === text(profileId));
  if (!current) {
    const error = new Error('Career Profile was not found.');
    error.code = 'CAREER_PROFILE_NOT_FOUND';
    throw error;
  }
  // Version numbers must be unique within a lineage. Deriving the next one from
  // the *current* profile is not enough: after restoring an earlier version
  // (undo), editing it would reuse a number that already exists, leaving two
  // versions indistinguishable and making further undo ambiguous.
  const highestVersion = normalized.profiles
    .filter(profile => profile.family_id === current.family_id)
    .reduce((highest, profile) => Math.max(highest, profile.version), 0);
  const profile = normalizeCareerProfile({
    ...current,
    ...object(changes),
    id: nextVersionId(current, now),
    family_id: current.family_id,
    name: text(changes.name, 200) || current.name,
    version: highestVersion + 1,
    parent_version_id: current.id,
    state: 'draft',
    user_approved: false,
    approved_at: null,
    created_at: now,
    updated_at: now
  }, { now });
  return {
    store: { ...normalized, active_profile_id: profile.id, profiles: [...normalized.profiles, profile] },
    profile
  };
}

export function duplicateCareerProfile(store, { profileId, name = '', now = new Date().toISOString() } = {}) {
  const normalized = normalizeCareerBrainStore(store);
  const current = normalized.profiles.find(profile => profile.id === text(profileId));
  if (!current) {
    const error = new Error('Career Profile was not found.');
    error.code = 'CAREER_PROFILE_NOT_FOUND';
    throw error;
  }
  const id = stableId('career', `${current.id}:${now}:${crypto.randomUUID()}`);
  const profile = normalizeCareerProfile({
    ...current,
    id,
    family_id: id,
    name: text(name, 200) || `${current.name} Copy`,
    version: 1,
    parent_version_id: null,
    state: 'draft',
    user_approved: false,
    approved_at: null,
    created_at: now,
    updated_at: now
  }, { now });
  return {
    store: { ...normalized, active_profile_id: profile.id, profiles: [...normalized.profiles, profile] },
    profile
  };
}

export function approveCareerProfile(store, { profileId, confirmed = false, now = new Date().toISOString() } = {}) {
  if (confirmed !== true) {
    const error = new Error('Explicit user confirmation is required to approve a Career Profile.');
    error.code = 'CAREER_PROFILE_CONFIRMATION_REQUIRED';
    throw error;
  }
  const normalized = normalizeCareerBrainStore(store);
  let approved = null;
  const profiles = normalized.profiles.map(profile => {
    if (profile.id !== text(profileId)) return profile;
    approved = normalizeCareerProfile({ ...profile, state: 'approved', user_approved: true, approved_at: now, updated_at: now }, { now });
    return approved;
  });
  if (!approved) {
    const error = new Error('Career Profile was not found.');
    error.code = 'CAREER_PROFILE_NOT_FOUND';
    throw error;
  }
  return { store: { ...normalized, active_profile_id: approved.id, profiles }, profile: approved };
}

export function activateCareerProfile(store, { profileId } = {}) {
  const normalized = normalizeCareerBrainStore(store);
  const profile = normalized.profiles.find(item => item.id === text(profileId) && item.state !== 'archived');
  if (!profile) {
    const error = new Error('Career Profile was not found or is archived.');
    error.code = 'CAREER_PROFILE_NOT_FOUND';
    throw error;
  }
  return { store: { ...normalized, active_profile_id: profile.id }, profile };
}

export function archiveCareerProfile(store, { profileId, confirmed = false, now = new Date().toISOString() } = {}) {
  if (confirmed !== true) {
    const error = new Error('Explicit user confirmation is required to archive a Career Profile.');
    error.code = 'CAREER_PROFILE_CONFIRMATION_REQUIRED';
    throw error;
  }
  const normalized = normalizeCareerBrainStore(store);
  let archived = null;
  const profiles = normalized.profiles.map(profile => {
    if (profile.id !== text(profileId)) return profile;
    archived = normalizeCareerProfile({ ...profile, state: 'archived', user_approved: false, approved_at: null, updated_at: now }, { now });
    return archived;
  });
  if (!archived) {
    const error = new Error('Career Profile was not found.');
    error.code = 'CAREER_PROFILE_NOT_FOUND';
    throw error;
  }
  return {
    store: { ...normalized, active_profile_id: normalized.active_profile_id === archived.id ? '' : normalized.active_profile_id, profiles },
    profile: archived
  };
}

export function importCareerProfile(store, { profile, name = '', now = new Date().toISOString() } = {}) {
  const normalized = normalizeCareerBrainStore(store);
  const source = normalizeCareerProfile(profile, { now });
  const id = stableId('career', `${source.id}:${now}:${crypto.randomUUID()}`);
  const imported = normalizeCareerProfile({
    ...source,
    id,
    family_id: id,
    name: text(name, 200) || source.name,
    version: 1,
    parent_version_id: null,
    state: 'draft',
    user_approved: false,
    approved_at: null,
    created_at: now,
    updated_at: now
  }, { now });
  return {
    store: { ...normalized, active_profile_id: imported.id, profiles: [...normalized.profiles, imported] },
    profile: imported
  };
}

export function publicCareerBrainSummary(store) {
  const normalized = normalizeCareerBrainStore(store);
  const active = normalized.profiles.find(profile => profile.id === normalized.active_profile_id) || null;
  return {
    schema_version: normalized.schema_version,
    active_profile_id: normalized.active_profile_id,
    profiles: normalized.profiles.map(profile => ({
      id: profile.id,
      family_id: profile.family_id,
      name: profile.name,
      version: profile.version,
      state: profile.state,
      user_approved: profile.user_approved,
      updated_at: profile.updated_at,
      source_resume_count: profile.source_resume_ids.length
    })),
    active_profile: active,
    safety: { raw_resume_text_stored: false, user_approval_required: true }
  };
}

export function careerProfileToApplicationProfile(careerProfile = {}, legacyProfile = {}) {
  const profile = normalizeCareerProfile(careerProfile);
  const fallback = object(legacyProfile);
  if (profile.user_approved !== true) return { ...fallback };
  const reviewDigest = `sha256:${crypto.createHash('sha256')
    .update(JSON.stringify(profile))
    .digest('hex')}`;
  const identity = profile.identity || {};
  const education = profile.education[0] || {};
  const skills = [...new Set(SKILL_GROUPS.flatMap(group => profile.skills[group] || []))];
  return {
    ...fallback,
    approved_for_real_applications: true,
    review_required_before_real_applications: false,
    full_name: identity.full_name || fallback.full_name || '',
    // first/last derive deterministically from the approved full name when the
    // profile does not carry them explicitly. The whole profile — full name
    // included — was approved by the user, so the split is treated as a real
    // fact and fills real forms (CJK: surname first; spaced: last token).
    first_name: identity.first_name || fallback.first_name
      || deriveNameParts(identity.full_name || fallback.full_name).first_name || '',
    last_name: identity.last_name || fallback.last_name
      || deriveNameParts(identity.full_name || fallback.full_name).last_name || '',
    preferred_name: identity.preferred_name || fallback.preferred_name || '',
    chinese_name: identity.chinese_name || fallback.chinese_name || '',
    english_name: identity.english_name || fallback.english_name || '',
    email: identity.email || fallback.email || '',
    phone: identity.phone || fallback.phone || '',
    // `location`/`current_location` are what the executor field key resolves
    // from; without them no location mapping ever reaches a fill plan.
    location: identity.current_location || fallback.location || fallback.current_location || '',
    current_location: identity.current_location || fallback.current_location || '',
    city: identity.city || identity.current_location || fallback.city || '',
    state_or_province: identity.state_or_province || fallback.state_or_province || '',
    country: identity.country || fallback.country || '',
    linkedin: identity.links?.linkedin || fallback.linkedin || '',
    github: identity.links?.github || fallback.github || '',
    portfolio: identity.links?.portfolio || fallback.portfolio || '',
    links: {
      ...object(fallback.links),
      linkedin: identity.links?.linkedin || fallback.links?.linkedin || fallback.linkedin || '',
      github: identity.links?.github || fallback.links?.github || fallback.github || '',
      portfolio: identity.links?.portfolio || fallback.links?.portfolio || fallback.portfolio || '',
      other: identity.links?.other || []
    },
    work_authorization: profile.job_preferences.work_authorization || fallback.work_authorization || '',
    sponsorship_required: profile.job_preferences.sponsorship || fallback.sponsorship_required || '',
    work_situation: {
      ...object(fallback.work_situation),
      current_company: deriveCurrentCompany(profile) || fallback.work_situation?.current_company || '',
      current_title: deriveCurrentRole(profile) || fallback.work_situation?.current_title || '',
      work_authorization: profile.job_preferences.work_authorization || fallback.work_situation?.work_authorization || '',
      sponsorship: profile.job_preferences.sponsorship || fallback.work_situation?.sponsorship || '',
      relocation_ok: profile.job_preferences.relocation_ok || fallback.work_situation?.relocation_ok || '',
      relocation_answer: normalizeRelocationAnswer(profile.job_preferences.relocation_ok || fallback.work_situation?.relocation_ok || ''),
      salary_expectation: profile.job_preferences.salary || fallback.work_situation?.salary_expectation || '',
      earliest_start_date: profile.job_preferences.earliest_start_date || fallback.work_situation?.earliest_start_date || '',
      notice_period: profile.job_preferences.notice_period || fallback.work_situation?.notice_period || '',
      availability: fallback.work_situation?.availability || ''
    },
    school: education.institution || fallback.school || '',
    degree: education.degree || fallback.degree || '',
    major: education.field_of_study || fallback.major || '',
    graduation_date: education.end_date || fallback.graduation_date || fallback.graduation_year || '',
    years_experience: deriveYearsExperience(profile) || fallback.years_experience || '',
    work_background: {
      ...object(fallback.work_background),
      work_experience: profile.experience,
      projects: profile.projects,
      skills,
      certifications: profile.certifications,
      // The flat school/degree/major keys above describe the most recent entry
      // only, because that is what portal forms ask for. Tailored-resume
      // generation needs the whole history, so carry it through rather than
      // dropping every entry after the first.
      education_history: profile.education
    },
    skills: {
      ...object(fallback.skills),
      programming_languages: profile.skills.programming,
      ai_skills: profile.skills.ai_tools,
      tools: [...profile.skills.frameworks, ...profile.skills.cloud],
      data_skills: profile.skills.data,
      product_skills: profile.skills.business,
      languages: profile.languages.map(language => language.proficiency ? `${language.name} — ${language.proficiency}` : language.name)
    },
    job_preferences: {
      ...object(fallback.job_preferences),
      target_roles: profile.career_goals,
      target_countries: profile.job_preferences.countries,
      target_cities: profile.job_preferences.cities,
      preferred_industries: profile.job_preferences.industries,
      // Kept so job matching can rule a posting out; the user entered it and
      // silently dropping it would make the exclusion look ignored.
      blocked_industries: profile.job_preferences.blocked_industries,
      salary_expectation: profile.job_preferences.salary,
      remote_ok: profile.job_preferences.remote,
      relocation_ok: profile.job_preferences.relocation_ok,
      work_authorization: profile.job_preferences.work_authorization,
      sponsorship: profile.job_preferences.sponsorship,
      earliest_start_date: profile.job_preferences.earliest_start_date,
      notice_period: profile.job_preferences.notice_period,
      current_company: deriveCurrentCompany(profile)
    },
    profile_meta: {
      ...object(fallback.profile_meta),
      career_profile_reference: {
        profile_id: profile.id,
        family_id: profile.family_id,
        version: profile.version,
        approved_at: profile.approved_at
      },
      candidate_fact_review: {
        ...object(fallback.profile_meta?.candidate_fact_review),
        source: 'career_brain_user_approval',
        snapshot_digest: reviewDigest,
        confirmed_at: profile.approved_at
      },
      career_brain_values_applied: true
    },
    allow_autofill_real_sites: false,
    allow_resume_attach: false,
    allow_final_submit: false
  };
}

export const CAREER_BRAIN_SCHEMA = Object.freeze({
  version: '1.0',
  skill_groups: [...SKILL_GROUPS],
  profile_states: [...PROFILE_STATES],
  remote_modes: [...REMOTE_MODES]
});
