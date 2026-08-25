import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activateCareerProfile,
  approveCareerProfile,
  archiveCareerProfile,
  careerProfileFromCandidateProfile,
  careerProfileToApplicationProfile,
  createCareerProfile,
  duplicateCareerProfile,
  importCareerProfile,
  normalizeCareerBrainStore,
  normalizeCareerProfile,
  publicCareerBrainSummary,
  saveCareerProfileVersion
} from '../scripts/lib/career_brain.mjs';

const NOW = '2026-08-09T00:00:00.000Z';

test('Career Profile normalization keeps structured career knowledge and drops raw resume text', () => {
  const profile = normalizeCareerProfile({
    id: 'career_one',
    name: 'Global AI roles',
    raw_resume_text: 'must not persist',
    identity: { full_name: 'Synthetic Candidate', email: 'synthetic@example.invalid' },
    education: [{ school: 'Example University', degree: 'BS', major: 'Computer Science' }],
    experience: [{ company: 'Example Co', role: 'Engineer', responsibilities: ['Built APIs'], achievements: ['Cut latency'], technologies: ['Node.js'] }],
    projects: [{ name: 'Career Agent', description: 'Local-first product', results: 'Shipped MVP' }],
    skills: { programming: ['JavaScript'], ai_tools: ['LM Studio'] },
    certifications: ['Synthetic Certificate'],
    languages: [{ name: 'English', proficiency: 'Professional' }],
    career_goals: ['AI Solutions Engineer']
  }, { now: NOW });

  assert.equal(profile.identity.full_name, 'Synthetic Candidate');
  assert.equal(profile.education[0].institution, 'Example University');
  assert.equal(profile.experience[0].role, 'Engineer');
  assert.deepEqual(profile.projects[0].results, ['Shipped MVP']);
  assert.deepEqual(profile.skills.ai_tools, ['LM Studio']);
  assert.equal(Object.hasOwn(profile, 'raw_resume_text'), false);
  assert.equal(profile.user_approved, false);
});

test('legacy Candidate Profile migrates to an unapproved Career Brain draft', () => {
  const profile = careerProfileFromCandidateProfile({
    full_name: 'Synthetic Candidate',
    email: 'synthetic@example.invalid',
    education: { school: 'Example University', degree: 'MS', major: 'Data Science' },
    work_background: {
      work_experience: [{ company: 'Example Co', title: 'Analyst', description: ['Analyzed data'] }],
      projects: [{ title: 'Forecasting', description: 'Synthetic project' }],
      skills: ['Python']
    },
    skills: { ai_skills: ['Prompt evaluation'], languages: ['Mandarin'] },
    job_preferences: { target_roles: ['AI Consultant'], target_countries: ['China'] },
    raw_resume_text: 'never copied'
  }, { resumeId: 'resume_1', name: 'Imported', now: NOW });

  assert.equal(profile.state, 'draft');
  assert.equal(profile.user_approved, false);
  assert.deepEqual(profile.source_resume_ids, ['resume_1']);
  assert.equal(profile.experience[0].role, 'Analyst');
  assert.deepEqual(profile.skills.programming, ['Python']);
  assert.deepEqual(profile.skills.ai_tools, ['Prompt evaluation']);
  assert.deepEqual(profile.career_goals, ['AI Consultant']);
  assert.equal(Object.hasOwn(profile, 'raw_resume_text'), false);
});

test('saving edits creates a new draft version and preserves the approved ancestor', () => {
  let { store, profile } = createCareerProfile({}, { name: 'Primary', now: NOW });
  ({ store, profile } = approveCareerProfile(store, { profileId: profile.id, confirmed: true, now: '2026-08-09T00:01:00.000Z' }));
  const approvedId = profile.id;
  const result = saveCareerProfileVersion(store, {
    profileId: approvedId,
    changes: { career_goals: ['AI Product Manager'] },
    now: '2026-08-09T00:02:00.000Z'
  });

  assert.notEqual(result.profile.id, approvedId);
  assert.equal(result.profile.version, 2);
  assert.equal(result.profile.parent_version_id, approvedId);
  assert.equal(result.profile.state, 'draft');
  assert.equal(result.store.profiles.find(item => item.id === approvedId).state, 'approved');
  assert.equal(result.store.active_profile_id, result.profile.id);
});

test('multiple profiles support duplicate, activate, import, archive, and safe summaries', () => {
  let { store, profile } = createCareerProfile({}, { name: 'China', now: NOW });
  const firstId = profile.id;
  let result = duplicateCareerProfile(store, { profileId: firstId, name: 'Global', now: '2026-08-09T00:01:00.000Z' });
  store = result.store;
  const secondId = result.profile.id;
  result = activateCareerProfile(store, { profileId: firstId });
  store = result.store;
  assert.equal(store.active_profile_id, firstId);

  result = importCareerProfile(store, { profile: { name: 'Imported', career_goals: ['Solutions Engineer'], state: 'approved', user_approved: true, approved_at: NOW }, now: '2026-08-09T00:02:00.000Z' });
  store = result.store;
  assert.equal(result.profile.state, 'draft');
  assert.equal(result.profile.user_approved, false);

  result = archiveCareerProfile(store, { profileId: secondId, confirmed: true, now: '2026-08-09T00:03:00.000Z' });
  store = result.store;
  assert.equal(result.profile.state, 'archived');
  assert.throws(() => archiveCareerProfile(store, { profileId: firstId }), error => error.code === 'CAREER_PROFILE_CONFIRMATION_REQUIRED');

  const summary = publicCareerBrainSummary(normalizeCareerBrainStore(store));
  assert.equal(summary.profiles.length, 3);
  assert.equal(summary.safety.raw_resume_text_stored, false);
});

test('only an approved Career Profile can feed the existing safe application profile path', () => {
  const legacy = {
    approved_for_real_applications: true,
    email: 'legacy@example.invalid',
    profile_meta: { candidate_fact_review: { snapshot_digest: 'sha256:fixture' } },
    allow_resume_attach: false,
    allow_final_submit: false
  };
  const draft = normalizeCareerProfile({
    id: 'career_safe',
    identity: {
      full_name: 'Synthetic Candidate',
      email: 'career@example.invalid',
      current_location: 'Shanghai, China',
      country: 'China',
      links: {
        linkedin: 'https://www.linkedin.com/in/synthetic-candidate',
        github: 'https://github.com/synthetic-candidate',
        portfolio: 'https://portfolio.example.invalid'
      }
    },
    education: [{ institution: 'Example University', degree: 'BS', field_of_study: 'Computer Science' }],
    experience: [{ company: 'Example', role: 'Engineer' }],
    skills: { programming: ['JavaScript'], ai_tools: ['LM Studio'] },
    career_goals: ['Solutions Engineer']
  }, { now: NOW });
  assert.equal(careerProfileToApplicationProfile(draft, legacy).email, 'legacy@example.invalid');

  const approved = normalizeCareerProfile({
    ...draft,
    state: 'approved',
    user_approved: true,
    approved_at: NOW
  }, { now: NOW });
  const application = careerProfileToApplicationProfile(approved, legacy);
  assert.equal(application.approved_for_real_applications, true);
  assert.match(application.profile_meta.candidate_fact_review.snapshot_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(application.full_name, 'Synthetic Candidate');
  assert.equal(application.email, 'career@example.invalid');
  assert.equal(application.city, 'Shanghai, China');
  assert.equal(application.linkedin, 'https://www.linkedin.com/in/synthetic-candidate');
  assert.equal(application.github, 'https://github.com/synthetic-candidate');
  assert.equal(application.portfolio, 'https://portfolio.example.invalid');
  assert.deepEqual(application.work_background.skills, ['JavaScript', 'LM Studio']);
  assert.equal(application.profile_meta.career_profile_reference.profile_id, 'career_safe');
  assert.equal(application.allow_resume_attach, false);
  assert.equal(application.allow_final_submit, false);
});

test('version numbers stay unique in a lineage after restoring an earlier version', () => {
  // Undo makes an earlier version active again. Editing from there must not
  // reuse a version number that already exists, or the two versions become
  // indistinguishable in history and a further undo cannot tell them apart.
  let store = createCareerProfile(normalizeCareerBrainStore({}), { name: 'Lineage' }).store;
  const original = store.profiles[0];

  const second = saveCareerProfileVersion(store, {
    profileId: original.id,
    changes: { identity: { full_name: 'Second' } }
  });
  store = second.store;
  assert.equal(second.profile.version, 2);

  // Go back to v1, then edit again.
  store = activateCareerProfile(store, { profileId: original.id }).store;
  const branched = saveCareerProfileVersion(store, {
    profileId: original.id,
    changes: { identity: { full_name: 'Branched' } }
  });
  store = branched.store;

  assert.equal(branched.profile.version, 3, 'a post-undo edit must take the next free version number');

  const versions = store.profiles
    .filter(profile => profile.family_id === original.family_id)
    .map(profile => profile.version);
  assert.deepEqual(
    [...versions].sort((a, b) => a - b),
    [...new Set(versions)].sort((a, b) => a - b),
    'a lineage must never contain two profiles with the same version number'
  );
});
