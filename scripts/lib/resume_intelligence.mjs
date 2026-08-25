import crypto from 'node:crypto';

const FACT_DEFINITIONS = Object.freeze([
  { key: 'full_name', category: 'identity', paths: ['full_name', 'identity.full_name'] },
  { key: 'first_name', category: 'identity', paths: ['first_name', 'identity.first_name'], core: true },
  { key: 'last_name', category: 'identity', paths: ['last_name', 'identity.last_name'], core: true },
  { key: 'preferred_name', category: 'identity', paths: ['preferred_name', 'identity.preferred_name'] },
  { key: 'chinese_name', category: 'identity', paths: ['identity.chinese_name'] },
  { key: 'english_name', category: 'identity', paths: ['identity.english_name'] },
  { key: 'email', category: 'contact', paths: ['email', 'identity.email'], core: true },
  { key: 'alternate_email', category: 'contact', paths: ['identity.alternate_email'] },
  { key: 'phone', category: 'contact', paths: ['phone', 'identity.phone'], core: true },
  { key: 'current_location', category: 'location', paths: ['identity.current_location'] },
  { key: 'city', category: 'location', paths: ['city', 'identity.city'], core: true },
  { key: 'state_or_province', category: 'location', paths: ['state_or_province', 'identity.state_or_province'], sensitive: true },
  { key: 'country', category: 'location', paths: ['country', 'identity.country'], core: true },
  { key: 'address_line_1', category: 'location', paths: ['address_line_1', 'identity.address_line_1'], sensitive: true },
  { key: 'address_line_2', category: 'location', paths: ['address_line_2', 'identity.address_line_2'], sensitive: true },
  { key: 'postal_code', category: 'location', paths: ['postal_code', 'identity.postal_code'], sensitive: true },
  { key: 'linkedin', category: 'links', paths: ['linkedin', 'links.linkedin'], core: true },
  { key: 'github', category: 'links', paths: ['github', 'links.github'] },
  { key: 'portfolio', category: 'links', paths: ['portfolio', 'links.portfolio', 'links.personal_website'] },
  { key: 'personal_website', category: 'links', paths: ['personal_website', 'links.personal_website', 'links.portfolio'] },
  { key: 'google_scholar', category: 'links', paths: ['links.google_scholar'] },
  { key: 'other_links', category: 'links', paths: ['links.other_links'] },
  { key: 'school', category: 'education', paths: ['school', 'education.school'] },
  { key: 'degree', category: 'education', paths: ['degree', 'education.degree'] },
  { key: 'major', category: 'education', paths: ['major', 'education.major'] },
  { key: 'discipline', category: 'education', paths: ['discipline', 'education.discipline'] },
  { key: 'second_major', category: 'education', paths: ['education.second_major'] },
  { key: 'minor', category: 'education', paths: ['education.minor'] },
  { key: 'gpa', category: 'education', paths: ['education.gpa'] },
  { key: 'relevant_coursework', category: 'education', paths: ['education.relevant_coursework'] },
  { key: 'graduation_month', category: 'education', paths: ['graduation_month', 'education.graduation_month'] },
  { key: 'graduation_year', category: 'education', paths: ['graduation_year', 'education.graduation_year'] },
  { key: 'years_experience', category: 'experience', paths: ['years_experience', 'work_background.years_experience'] },
  { key: 'summary', category: 'experience', paths: ['summary', 'work_background.summary'] },
  { key: 'internships', category: 'experience', paths: ['work_background.internships'] },
  { key: 'work_experience', category: 'experience', paths: ['work_background.work_experience'] },
  { key: 'projects', category: 'experience', paths: ['work_background.projects'] },
  { key: 'leadership', category: 'experience', paths: ['work_background.leadership'] },
  { key: 'volunteer_experience', category: 'experience', paths: ['work_background.volunteer_experience'] },
  { key: 'certifications', category: 'experience', paths: ['work_background.certifications'] },
  { key: 'awards', category: 'experience', paths: ['work_background.awards'] },
  { key: 'skills', category: 'skills', paths: ['work_background.skills'] },
  { key: 'programming_languages', category: 'skills', paths: ['skills.programming_languages'] },
  { key: 'product_skills', category: 'skills', paths: ['skills.product_skills'] },
  { key: 'data_skills', category: 'skills', paths: ['skills.data_skills'] },
  { key: 'ai_skills', category: 'skills', paths: ['skills.ai_skills'] },
  { key: 'tools', category: 'skills', paths: ['skills.tools'] },
  { key: 'languages', category: 'skills', paths: ['skills.languages'] },
  { key: 'domain_keywords', category: 'skills', paths: ['skills.domain_keywords'] },
  { key: 'resume_language', category: 'skills', paths: ['profile_meta.resume_language'] },
  { key: 'language_preference', category: 'preferences', paths: ['profile_meta.language_preference'] },
  { key: 'desired_role', category: 'preferences', paths: ['desired_role', 'job_preferences.desired_role'] },
  { key: 'target_roles', category: 'preferences', paths: ['target_roles', 'job_preferences.target_roles'] },
  { key: 'target_countries', category: 'preferences', paths: ['job_preferences.target_countries'] },
  { key: 'target_cities', category: 'preferences', paths: ['job_preferences.target_cities'] },
  { key: 'preferred_industries', category: 'preferences', paths: ['job_preferences.preferred_industries'] },
  { key: 'blocked_industries', category: 'preferences', paths: ['job_preferences.blocked_industries'] },
  { key: 'remote_ok', category: 'preferences', paths: ['job_preferences.remote_ok'] },
  { key: 'relocation_ok', category: 'preferences', paths: ['job_preferences.relocation_ok'] },
  { key: 'notice_period', category: 'preferences', paths: ['notice_period', 'job_preferences.notice_period'] },
  { key: 'earliest_start_date', category: 'preferences', paths: ['earliest_start_date', 'job_preferences.earliest_start_date'], sensitive: true },
  { key: 'salary_expectation', category: 'preferences', paths: ['salary_expectation', 'job_preferences.salary_expectation'], sensitive: true },
  { key: 'work_authorization', category: 'application_facts', paths: ['work_authorization', 'application_facts.work_authorization'], sensitive: true },
  { key: 'sponsorship', category: 'application_facts', paths: ['sponsorship', 'application_facts.sponsorship'], sensitive: true },
  { key: 'sponsorship_required', category: 'application_facts', paths: ['sponsorship_required', 'application_facts.sponsorship_required'], sensitive: true },
  { key: 'visa_status', category: 'application_facts', paths: ['visa_status', 'application_facts.visa_status'], sensitive: true },
  { key: 'authorized_countries', category: 'application_facts', paths: ['application_facts.authorized_countries'], sensitive: true },
  { key: 'requires_sponsorship_by_country', category: 'application_facts', paths: ['application_facts.requires_sponsorship_by_country'], sensitive: true },
  { key: 'employment_gap_answer', category: 'application_facts', paths: ['application_facts.employment_gap_answer'], sensitive: true },
  { key: 'reference_policy', category: 'application_facts', paths: ['application_facts.reference_policy'], sensitive: true },
  { key: 'background_check_policy', category: 'application_facts', paths: ['application_facts.background_check_policy'], sensitive: true },
  { key: 'pronouns', category: 'eeo_optional', paths: ['pronouns', 'eeo_optional.pronouns'], sensitive: true },
  { key: 'gender', category: 'eeo_optional', paths: ['gender', 'eeo_optional.gender'], sensitive: true },
  { key: 'race_ethnicity', category: 'eeo_optional', paths: ['race_ethnicity', 'eeo_optional.race_ethnicity'], sensitive: true },
  { key: 'veteran_status', category: 'eeo_optional', paths: ['veteran_status', 'eeo_optional.veteran_status'], sensitive: true },
  { key: 'disability_status', category: 'eeo_optional', paths: ['disability_status', 'eeo_optional.disability_status'], sensitive: true },
  { key: 'lgbtq_status', category: 'eeo_optional', paths: ['lgbtq_status', 'eeo_optional.lgbtq_status'], sensitive: true }
]);

function hasValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(item => String(item ?? '').trim());
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return String(value).trim() !== '';
}

function getPath(object, dottedPath) {
  let value = object;
  for (const part of String(dottedPath || '').split('.').filter(Boolean)) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function existingWritablePath(profile, paths) {
  for (const dottedPath of paths) {
    const parts = String(dottedPath || '').split('.').filter(Boolean);
    if (!parts.length) continue;
    let owner = profile;
    for (const part of parts.slice(0, -1)) {
      if (!owner || typeof owner !== 'object' || Array.isArray(owner) || !Object.hasOwn(owner, part)) {
        owner = null;
        break;
      }
      owner = owner[part];
    }
    const leaf = parts.at(-1);
    if (owner && typeof owner === 'object' && !Array.isArray(owner) && Object.hasOwn(owner, leaf)) {
      return dottedPath;
    }
  }
  return '';
}

function setPathCopy(object, dottedPath, value) {
  const parts = dottedPath.split('.');
  const output = { ...object };
  let sourceOwner = object;
  let targetOwner = output;
  for (const part of parts.slice(0, -1)) {
    targetOwner[part] = { ...sourceOwner[part] };
    sourceOwner = sourceOwner[part];
    targetOwner = targetOwner[part];
  }
  targetOwner[parts.at(-1)] = value;
  return output;
}

function setPathCreatingCopy(object, dottedPath, value) {
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  if (!parts.length) return object;
  const output = { ...(object || {}) };
  let sourceOwner = object && typeof object === 'object' && !Array.isArray(object) ? object : {};
  let targetOwner = output;
  for (const part of parts.slice(0, -1)) {
    const sourceChild = sourceOwner?.[part];
    targetOwner[part] = sourceChild && typeof sourceChild === 'object' && !Array.isArray(sourceChild)
      ? { ...sourceChild }
      : {};
    sourceOwner = sourceChild && typeof sourceChild === 'object' && !Array.isArray(sourceChild)
      ? sourceChild
      : {};
    targetOwner = targetOwner[part];
  }
  targetOwner[parts.at(-1)] = value;
  return output;
}

function deletePathCopy(object, dottedPath) {
  const parts = String(dottedPath || '').split('.').filter(Boolean);
  if (!parts.length || !object || typeof object !== 'object' || Array.isArray(object)) return object;
  const output = { ...object };
  let sourceOwner = object;
  let targetOwner = output;
  for (const part of parts.slice(0, -1)) {
    const sourceChild = sourceOwner?.[part];
    if (!sourceChild || typeof sourceChild !== 'object' || Array.isArray(sourceChild)) return output;
    targetOwner[part] = { ...sourceChild };
    sourceOwner = sourceChild;
    targetOwner = targetOwner[part];
  }
  delete targetOwner[parts.at(-1)];
  return output;
}

function text(value) {
  return String(value ?? '').trim();
}

function reviewRecord(profile) {
  const value = profile?.profile_meta?.candidate_fact_review || profile?.candidate_fact_review;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function selectedResumeIdentity(selectedResume) {
  return {
    resume_id: text(selectedResume?.resume_id || selectedResume?.id),
    resume_content_hash: text(selectedResume?.content_hash)
  };
}

function profileFactSection(definition) {
  const key = `${definition.category || ''} ${definition.key || ''}`.toLowerCase();
  if (/education|degree|school|university/.test(key)) return 'Education';
  if (/project|portfolio/.test(key)) return 'Projects';
  if (/language/.test(key)) return 'Languages';
  if (/certificate|certification|license/.test(key)) return 'Certifications';
  if (/skill|technology|tool/.test(key)) return 'Skills';
  if (/experience|employment|company|job_title/.test(key)) return 'Experience';
  if (/identity|contact|location|name|email|phone|city|country/.test(key)) return 'Basics';
  return 'Additional';
}

function preferredWritablePath(profile, definition, currentFact = null) {
  const currentPath = text(currentFact?.source_path);
  if (currentPath && definition.paths.includes(currentPath)) return currentPath;
  return existingWritablePath(profile, definition.paths) || definition.paths[0] || '';
}

function revokeProfileReview(profile) {
  let next = {
    ...profile,
    approved_for_real_applications: false,
    review_required_before_real_applications: true
  };
  if (profile?.profile_meta && typeof profile.profile_meta === 'object' && !Array.isArray(profile.profile_meta)) {
    const { candidate_fact_review, ...profileMeta } = profile.profile_meta;
    next.profile_meta = {
      ...profileMeta,
      approved_for_real_applications: false,
      review_required_before_real_applications: true
    };
  }
  const { candidate_fact_review, ...root } = next;
  return root;
}

function firstValue(object, paths) {
  for (const path of paths) {
    const value = getPath(object, path);
    if (hasValue(value)) return { value, path };
  }
  return null;
}

function clamp(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function fieldMetadata(profile, key) {
  return profile?.field_provenance?.[key]
    || profile?.profile_meta?.field_provenance?.[key]
    || profile?.field_usage?.[key]
    || {};
}

function resumeMetadataValue(selectedResume, key) {
  const map = {
    skills: selectedResume?.skills,
    summary: selectedResume?.experience_summary,
    desired_role: selectedResume?.target_role,
    target_roles: selectedResume?.target_roles,
    resume_language: selectedResume?.language
  };
  return map[key];
}

function snapshotToken(facts) {
  const stableFacts = (Array.isArray(facts) ? facts : []).map(fact => ({
    fact_key: fact.fact_key,
    value: fact.value,
    source: fact.source,
    source_path: fact.source_path,
    sensitive: fact.sensitive
  }));
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(stableFacts)).digest('hex')}`;
}

export function buildResumeIntelligence({
  profile = {},
  selectedResume = null,
  now = new Date().toISOString()
} = {}) {
  const legacyProfileApproved = profile?.approved_for_real_applications === true
    || profile?.profile_meta?.approved_for_real_applications === true;
  const resumeApproved = Boolean(selectedResume?.approved_at);
  const resumeVerified = Boolean(selectedResume?.content_hash);
  const suppressedFactKeys = new Set(
    Array.isArray(profile?.profile_meta?.suppressed_fact_keys)
      ? profile.profile_meta.suppressed_fact_keys.map(text).filter(Boolean)
      : []
  );
  const draftFacts = [];

  for (const definition of FACT_DEFINITIONS) {
    if (suppressedFactKeys.has(definition.key)) continue;
    const profileValue = firstValue(profile, definition.paths);
    const metadata = fieldMetadata(profile, definition.key);
    const fallbackValue = resumeMetadataValue(selectedResume, definition.key);
    const fromProfile = Boolean(profileValue);
    const value = fromProfile ? profileValue.value : fallbackValue;
    if (!hasValue(value)) continue;
    draftFacts.push({
      fact_id: `candidate_fact_${definition.key}`,
      fact_key: definition.key,
      category: definition.category,
      value,
      source: String(metadata.source || (fromProfile ? 'candidate_profile' : 'resume_metadata')),
      source_path: fromProfile ? profileValue.path : `resume_profiles.${definition.key}`,
      confidence: clamp(metadata.confidence ?? (fromProfile ? 0.75 : (resumeApproved && resumeVerified ? 0.95 : 0.6))),
      user_confirmed: metadata.user_confirmed === true || (!fromProfile && resumeApproved),
      last_used: metadata.last_used || null,
      sensitive: definition.sensitive === true,
      status: 'confirmation_required'
    });
  }

  const currentSnapshotToken = snapshotToken(draftFacts);
  const storedReview = reviewRecord(profile);
  const resumeIdentity = selectedResumeIdentity(selectedResume);
  const currentReviewApproved = Boolean(
    storedReview
    && text(storedReview.snapshot_digest || storedReview.snapshot_token) === currentSnapshotToken
    && text(storedReview.document_id || storedReview.resume_id) === resumeIdentity.resume_id
    && text(storedReview.document_content_digest || storedReview.resume_content_hash) === resumeIdentity.resume_content_hash
  );
  const profileApproved = currentReviewApproved || legacyProfileApproved;
  const facts = draftFacts.map(fact => {
    const userConfirmed = fact.user_confirmed || profileApproved;
    return {
      ...fact,
      confidence: profileApproved && fact.source !== 'resume_metadata' ? 1 : fact.confidence,
      user_confirmed: userConfirmed,
      status: fact.sensitive
        ? 'user_confirmation_required'
        : (userConfirmed ? 'available' : 'confirmation_required')
    };
  });

  const coreDefinitions = FACT_DEFINITIONS.filter(definition => definition.core);
  const factKeys = new Set(facts.map(fact => fact.fact_key));
  const missingCoreFactKeys = coreDefinitions
    .map(definition => definition.key)
    .filter(key => !factKeys.has(key));
  const confirmedFacts = facts.filter(fact => fact.user_confirmed);
  const sensitiveFacts = facts.filter(fact => fact.sensitive);
  const productProfileSections = ['Basics', 'Education', 'Experience', 'Projects', 'Skills', 'Languages'];
  const populatedProfileSections = productProfileSections.filter(section => facts.some(fact => {
    const definition = FACT_DEFINITIONS.find(item => item.key === fact.fact_key);
    return definition && profileFactSection(definition) === section;
  }));

  return {
    schema_version: '1.0',
    generated_at: now,
    storage_mode: 'derived_from_existing_sources',
    profile_approved: profileApproved,
    current_review_approved: currentReviewApproved,
    review_bound_to_active_resume: currentReviewApproved && Boolean(selectedResume),
    resume_id: selectedResume?.resume_id || selectedResume?.id || '',
    resume_version: Number(selectedResume?.version || 0) || null,
    resume_content_verified: resumeVerified,
    resume_user_approved: resumeApproved,
    snapshot_token: currentSnapshotToken,
    summary: {
      available_fact_count: facts.length,
      confirmed_fact_count: confirmedFacts.length,
      sensitive_fact_count: sensitiveFacts.length,
      core_fact_count: coreDefinitions.length,
      core_fact_coverage_percent: Math.round(((coreDefinitions.length - missingCoreFactKeys.length) / coreDefinitions.length) * 100),
      missing_core_fact_keys: missingCoreFactKeys,
      profile_section_count: productProfileSections.length,
      populated_profile_sections: populatedProfileSections,
      profile_section_coverage_percent: Math.round((populatedProfileSections.length / productProfileSections.length) * 100)
    },
    facts
  };
}

export function resolveCandidateFact(intelligence, key) {
  return (Array.isArray(intelligence?.facts) ? intelligence.facts : [])
    .find(fact => fact?.fact_key === key) || null;
}

export function candidateFactSchema() {
  return FACT_DEFINITIONS
    .filter(definition => definition.paths.length > 0)
    .map(definition => ({
      fact_key: definition.key,
      category: definition.category,
      section: profileFactSection(definition),
      editable: true,
      sensitive: definition.sensitive === true,
      value_kind: ['projects', 'work_experience', 'internships', 'leadership', 'volunteer_experience'].includes(definition.key)
        ? 'structured'
        : ['skills', 'programming_languages', 'product_skills', 'data_skills', 'ai_skills', 'tools', 'languages', 'certifications', 'awards', 'relevant_coursework', 'target_roles'].includes(definition.key)
          ? 'list'
          : 'text'
    }));
}

export function mutateCandidateFact({
  profile = {},
  selectedResume = null,
  factKey = '',
  action = 'edit',
  value,
  now = new Date().toISOString()
} = {}) {
  const definition = FACT_DEFINITIONS.find(item => item.key === text(factKey));
  if (!definition || !definition.paths.length) {
    const error = new Error('This Candidate Profile field is not editable through the product Profile editor.');
    error.code = 'CANDIDATE_FACT_NOT_EDITABLE';
    throw error;
  }
  if (!['add', 'edit', 'delete', 'approve', 'reject'].includes(action)) {
    const error = new Error('Unsupported Candidate Profile fact action.');
    error.code = 'INVALID_CANDIDATE_FACT_ACTION';
    throw error;
  }

  const intelligence = buildResumeIntelligence({ profile, selectedResume, now });
  const currentFact = resolveCandidateFact(intelligence, definition.key);
  if (action !== 'add' && !currentFact) {
    const error = new Error('Candidate Profile fact was not found.');
    error.code = 'CANDIDATE_FACT_NOT_FOUND';
    throw error;
  }
  if (action === 'add' && currentFact) {
    const error = new Error('Candidate Profile fact already exists. Edit the existing fact instead.');
    error.code = 'CANDIDATE_FACT_ALREADY_EXISTS';
    throw error;
  }
  if (['add', 'edit'].includes(action) && !hasValue(value)) {
    const error = new Error('Candidate Profile fact value cannot be empty.');
    error.code = 'CANDIDATE_FACT_VALUE_REQUIRED';
    throw error;
  }

  const existingProvenance = profile?.field_provenance && typeof profile.field_provenance === 'object'
    ? profile.field_provenance
    : {};
  const preservedProvenance = { ...existingProvenance };
  for (const fact of intelligence.facts) {
    if (!fact.user_confirmed || fact.fact_key === definition.key) continue;
    preservedProvenance[fact.fact_key] = {
      ...(preservedProvenance[fact.fact_key] || {}),
      source: preservedProvenance[fact.fact_key]?.source || fact.source,
      confidence: preservedProvenance[fact.fact_key]?.confidence ?? fact.confidence,
      user_confirmed: true
    };
  }

  let next = { ...profile, field_provenance: preservedProvenance };
  const writablePath = preferredWritablePath(profile, definition, currentFact);
  const suppressed = new Set(
    Array.isArray(profile?.profile_meta?.suppressed_fact_keys)
      ? profile.profile_meta.suppressed_fact_keys.map(text).filter(Boolean)
      : []
  );
  const rejected = new Set(
    Array.isArray(profile?.profile_meta?.rejected_fact_keys)
      ? profile.profile_meta.rejected_fact_keys.map(text).filter(Boolean)
      : []
  );
  const rejectionHistory = {
    ...(profile?.profile_meta?.candidate_fact_rejections
      && typeof profile.profile_meta.candidate_fact_rejections === 'object'
      && !Array.isArray(profile.profile_meta.candidate_fact_rejections)
      ? profile.profile_meta.candidate_fact_rejections
      : {})
  };

  if (action === 'delete' || action === 'reject') {
    next = deletePathCopy(next, writablePath);
    suppressed.add(definition.key);
    delete next.field_provenance[definition.key];
    if (action === 'reject') {
      rejected.add(definition.key);
      rejectionHistory[definition.key] = { rejected_at: now };
    } else {
      rejected.delete(definition.key);
      delete rejectionHistory[definition.key];
    }
  } else if (action === 'add' || action === 'edit') {
    next = setPathCreatingCopy(next, writablePath, value);
    suppressed.delete(definition.key);
    rejected.delete(definition.key);
    delete rejectionHistory[definition.key];
    next.field_provenance[definition.key] = {
      ...(next.field_provenance[definition.key] || {}),
      source: 'user_entered',
      confidence: 1,
      user_confirmed: false,
      updated_at: now
    };
  } else {
    next.field_provenance[definition.key] = {
      ...(next.field_provenance[definition.key] || {}),
      source: next.field_provenance[definition.key]?.source || currentFact.source,
      confidence: 1,
      user_confirmed: true,
      updated_at: now
    };
  }

  next.profile_meta = {
    ...(next.profile_meta && typeof next.profile_meta === 'object' && !Array.isArray(next.profile_meta)
      ? next.profile_meta
      : {}),
    suppressed_fact_keys: [...suppressed].sort(),
    rejected_fact_keys: [...rejected].sort(),
    candidate_fact_rejections: rejectionHistory
  };
  if (action !== 'approve') next = revokeProfileReview(next);

  return {
    profile: next,
    action,
    fact_key: definition.key,
    updated_at: now,
    resume_intelligence: buildResumeIntelligence({ profile: next, selectedResume, now }),
    safety: {
      local_profile_only: true,
      real_site_opened: false,
      resume_uploaded: false,
      final_submit_clicked: false,
      profile_review_required: action !== 'approve'
    }
  };
}

function normalizedProfileVersions(profile = {}) {
  const source = profile?.profile_versions;
  const items = Array.isArray(source?.items)
    ? source.items.filter(item => item && typeof item === 'object' && text(item.version_id) && item.snapshot && typeof item.snapshot === 'object')
    : [];
  return {
    schema_version: '1.0',
    active_version_id: items.some(item => item.version_id === text(source?.active_version_id))
      ? text(source.active_version_id)
      : '',
    items: items.slice(-25)
  };
}

function candidateProfileSnapshot(profile = {}) {
  const snapshot = structuredClone(profile && typeof profile === 'object' ? profile : {});
  delete snapshot.profile_versions;
  return snapshot;
}

export function listCandidateProfileVersions(profile = {}) {
  const versions = normalizedProfileVersions(profile);
  return {
    schema_version: versions.schema_version,
    active_version_id: versions.active_version_id,
    items: versions.items.map(item => ({
      version_id: item.version_id,
      name: text(item.name) || 'Untitled Profile',
      created_at: text(item.created_at),
      updated_at: text(item.updated_at || item.created_at),
      resume_id: text(item.resume_id),
      active: item.version_id === versions.active_version_id
    }))
  };
}

export function createCandidateProfileVersion({
  profile = {},
  selectedResume = null,
  name = '',
  now = new Date().toISOString()
} = {}) {
  const versionName = text(name);
  if (!versionName || versionName.length > 80) {
    const error = new Error('Profile version name must be between 1 and 80 characters.');
    error.code = 'CANDIDATE_PROFILE_VERSION_NAME_INVALID';
    throw error;
  }
  const versions = normalizedProfileVersions(profile);
  const versionId = `profile_version_${crypto.randomUUID()}`;
  const item = {
    version_id: versionId,
    name: versionName,
    created_at: now,
    updated_at: now,
    resume_id: text(selectedResume?.resume_id || selectedResume?.id),
    snapshot: candidateProfileSnapshot(profile)
  };
  const next = {
    ...profile,
    profile_versions: {
      schema_version: '1.0',
      active_version_id: versionId,
      items: [...versions.items, item].slice(-25)
    }
  };
  return {
    profile: next,
    version: listCandidateProfileVersions(next).items.find(entry => entry.version_id === versionId),
    versions: listCandidateProfileVersions(next)
  };
}

export function activateCandidateProfileVersion({
  profile = {},
  selectedResume = null,
  versionId = '',
  now = new Date().toISOString()
} = {}) {
  const versions = normalizedProfileVersions(profile);
  const selected = versions.items.find(item => item.version_id === text(versionId));
  if (!selected) {
    const error = new Error('Candidate Profile version was not found.');
    error.code = 'CANDIDATE_PROFILE_VERSION_NOT_FOUND';
    throw error;
  }
  const restored = revokeProfileReview({
    ...structuredClone(selected.snapshot),
    allow_resume_attach: false,
    allow_final_submit: false,
    profile_versions: {
      ...versions,
      active_version_id: selected.version_id
    }
  });
  restored.profile_meta = {
    ...(restored.profile_meta && typeof restored.profile_meta === 'object' && !Array.isArray(restored.profile_meta)
      ? restored.profile_meta
      : {}),
    active_profile_version_id: selected.version_id,
    active_profile_version_loaded_at: now,
    active_profile_version_resume_id: text(selectedResume?.resume_id || selectedResume?.id)
  };
  return {
    profile: restored,
    version: listCandidateProfileVersions(restored).items.find(entry => entry.version_id === selected.version_id),
    versions: listCandidateProfileVersions(restored),
    resume_intelligence: buildResumeIntelligence({ profile: restored, selectedResume, now })
  };
}

export function deleteCandidateProfileVersion({ profile = {}, versionId = '' } = {}) {
  const versions = normalizedProfileVersions(profile);
  const selected = versions.items.find(item => item.version_id === text(versionId));
  if (!selected) {
    const error = new Error('Candidate Profile version was not found.');
    error.code = 'CANDIDATE_PROFILE_VERSION_NOT_FOUND';
    throw error;
  }
  const items = versions.items.filter(item => item.version_id !== selected.version_id);
  const activeVersionId = versions.active_version_id === selected.version_id ? '' : versions.active_version_id;
  const next = {
    ...profile,
    profile_versions: {
      ...versions,
      active_version_id: activeVersionId,
      items
    }
  };
  return {
    profile: next,
    deleted_version_id: selected.version_id,
    versions: listCandidateProfileVersions(next)
  };
}

export function prepareResumeSuggestionTargets(profile = {}, suggestions = []) {
  const definitions = new Map(FACT_DEFINITIONS.map(definition => [definition.key, definition]));
  return (Array.isArray(suggestions) ? suggestions : []).map(item => {
    const definition = definitions.get(item?.fact_key);
    const targetPath = definition && definition.sensitive !== true
      ? existingWritablePath(profile, definition.paths)
      : '';
    return {
      ...item,
      can_apply_to_existing_profile: Boolean(targetPath),
      target_path: targetPath,
      apply_blocked_reason: !definition
        ? 'unsupported_fact_key'
        : definition.sensitive === true
          ? 'sensitive_fact_requires_manual_profile_edit'
          : targetPath
            ? ''
            : 'existing_profile_field_missing'
    };
  });
}

export function applyResumeFactSuggestions({
  profile = {},
  suggestions = [],
  selectedSuggestionIds = [],
  now = new Date().toISOString()
} = {}) {
  const selectedIds = new Set(
    (Array.isArray(selectedSuggestionIds) ? selectedSuggestionIds : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  );
  if (!selectedIds.size) {
    const error = new Error('Select at least one resume fact suggestion.');
    error.code = 'NO_RESUME_SUGGESTIONS_SELECTED';
    throw error;
  }
  const prepared = prepareResumeSuggestionTargets(profile, suggestions);
  const selected = prepared.filter(item => selectedIds.has(item.suggestion_id));
  if (selected.length !== selectedIds.size) {
    const error = new Error('One or more selected resume suggestions are stale or unavailable.');
    error.code = 'STALE_RESUME_SUGGESTIONS';
    throw error;
  }
  const blocked = selected.filter(item => !item.can_apply_to_existing_profile);
  if (blocked.length) {
    const error = new Error('One or more selected suggestions cannot be written to the existing Candidate Profile.');
    error.code = 'RESUME_SUGGESTION_TARGET_BLOCKED';
    error.details = blocked.map(item => ({
      suggestion_id: item.suggestion_id,
      fact_key: item.fact_key,
      reason: item.apply_blocked_reason
    }));
    throw error;
  }

  let next = profile;
  const fieldProvenance = {
    ...(profile?.field_provenance && typeof profile.field_provenance === 'object' && !Array.isArray(profile.field_provenance)
      ? profile.field_provenance
      : {})
  };
  const applied = [];
  for (const item of selected) {
    next = setPathCopy(next, item.target_path, item.value);
    fieldProvenance[item.fact_key] = {
      ...(fieldProvenance[item.fact_key] || {}),
      source: item.source || 'resume_document',
      confidence: clamp(item.confidence),
      user_confirmed: false,
      updated_at: now,
      last_used: fieldProvenance[item.fact_key]?.last_used || null
    };
    applied.push({
      suggestion_id: item.suggestion_id,
      fact_key: item.fact_key,
      target_path: item.target_path,
      confidence: item.confidence,
      source: item.source
    });
  }
  next = {
    ...next,
    field_provenance: fieldProvenance,
    approved_for_real_applications: false,
    review_required_before_real_applications: true
  };
  if (profile?.profile_meta && typeof profile.profile_meta === 'object' && !Array.isArray(profile.profile_meta)) {
    next.profile_meta = {
      ...next.profile_meta,
      approved_for_real_applications: false,
      review_required_before_real_applications: true
    };
  }
  return {
    profile: next,
    applied,
    applied_at: now,
    safety: {
      profile_approval_revoked: next.approved_for_real_applications === false,
      review_required: next.review_required_before_real_applications === true,
      allow_autofill_real_sites_unchanged: next.allow_autofill_real_sites === profile.allow_autofill_real_sites,
      allow_resume_attach_unchanged: next.allow_resume_attach === profile.allow_resume_attach,
      allow_final_submit_unchanged: next.allow_final_submit === profile.allow_final_submit
    }
  };
}

export function persistResumeAnalysisDraft({
  profile = {},
  suggestions = [],
  resumeId = '',
  contentHash = '',
  analysisSnapshotToken = '',
  now = new Date().toISOString()
} = {}) {
  const prepared = prepareResumeSuggestionTargets(profile, suggestions);
  const automatic = prepared.filter(item =>
    item.can_apply_to_existing_profile
    && item.existing_fact_present !== true
    && item.sensitive !== true
  );
  let next = profile;
  let applied = [];
  if (automatic.length) {
    const result = applyResumeFactSuggestions({
      profile,
      suggestions: automatic,
      selectedSuggestionIds: automatic.map(item => item.suggestion_id),
      now
    });
    next = result.profile;
    applied = result.applied;
  }
  next = {
    ...next,
    profile_meta: {
      ...(next?.profile_meta && typeof next.profile_meta === 'object' && !Array.isArray(next.profile_meta)
        ? next.profile_meta
        : {}),
      resume_analysis: {
        resume_id: text(resumeId),
        resume_content_hash: text(contentHash),
        analysis_snapshot_token: text(analysisSnapshotToken),
        generated_at: now,
        applied_fact_keys: applied.map(item => item.fact_key),
        conflict_fact_keys: prepared.filter(item => item.existing_fact_present === true).map(item => item.fact_key),
        blocked_fact_keys: prepared.filter(item => !item.can_apply_to_existing_profile).map(item => item.fact_key),
        review_required: true,
        raw_text_saved: false
      }
    }
  };
  return {
    profile: next,
    applied,
    prepared_suggestions: prepared,
    generated_at: now,
    safety: {
      raw_text_saved: false,
      facts_user_confirmed: false,
      existing_facts_overwritten: false,
      profile_review_required: true,
      external_request_performed: false,
      model_called: false
    }
  };
}

export function confirmCandidateProfileSnapshot({
  profile = {},
  selectedResume = null,
  expectedSnapshotToken = '',
  now = new Date().toISOString()
} = {}) {
  const current = buildResumeIntelligence({ profile, selectedResume, now });
  if (!current.facts.length) {
    const error = new Error('Candidate profile has no reviewable facts.');
    error.code = 'NO_REVIEWABLE_FACTS';
    throw error;
  }
  if (!expectedSnapshotToken || expectedSnapshotToken !== current.snapshot_token) {
    const error = new Error('Candidate facts changed after review. Reload and review the current facts before confirming.');
    error.code = 'STALE_FACT_SNAPSHOT';
    throw error;
  }
  const confirmedProfile = {
    ...profile,
    approved_for_real_applications: true,
    review_required_before_real_applications: true
  };
  const identity = selectedResumeIdentity(selectedResume);
  confirmedProfile.profile_meta = {
    ...(profile?.profile_meta && typeof profile.profile_meta === 'object' && !Array.isArray(profile.profile_meta)
      ? profile.profile_meta
      : {}),
    approved_for_real_applications: true,
    review_required_before_real_applications: true,
    last_reviewed_at: now,
    candidate_fact_review: {
      snapshot_digest: current.snapshot_token,
      document_id: identity.resume_id,
      document_content_digest: identity.resume_content_hash,
      reviewed_at: now
    }
  };
  return {
    profile: confirmedProfile,
    resume_intelligence: buildResumeIntelligence({
      profile: confirmedProfile,
      selectedResume,
      now
    }),
    confirmed_at: now,
    safety: {
      allow_autofill_real_sites_unchanged: confirmedProfile.allow_autofill_real_sites === profile.allow_autofill_real_sites,
      allow_resume_attach_unchanged: confirmedProfile.allow_resume_attach === profile.allow_resume_attach,
      allow_final_submit_unchanged: confirmedProfile.allow_final_submit === profile.allow_final_submit
    }
  };
}

export { FACT_DEFINITIONS };
