import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyResumeFactSuggestions,
  activateCandidateProfileVersion,
  buildResumeIntelligence,
  candidateFactSchema,
  confirmCandidateProfileSnapshot,
  createCandidateProfileVersion,
  deleteCandidateProfileVersion,
  listCandidateProfileVersions,
  mutateCandidateFact,
  persistResumeAnalysisDraft,
  prepareResumeSuggestionTargets,
  resolveCandidateFact
} from '../scripts/lib/resume_intelligence.mjs';

test('Candidate Profile editor supports sensitive values without authorizing automatic reuse', () => {
  const schema = candidateFactSchema();
  assert.equal(schema.find(item => item.fact_key === 'work_authorization')?.sensitive, true);
  const result = mutateCandidateFact({
    profile: { application_facts: {}, profile_meta: {} },
    selectedResume: { resume_id: 'resume-1', content_hash: 'sha256:resume' },
    factKey: 'work_authorization',
    action: 'add',
    value: 'Synthetic user-entered value',
    now: '2026-08-07T00:00:00.000Z'
  });
  assert.equal(result.profile.work_authorization, 'Synthetic user-entered value');
  assert.equal(resolveCandidateFact(result.resume_intelligence, 'work_authorization').status, 'user_confirmation_required');
  assert.equal(result.profile.approved_for_real_applications, false);
});

test('Candidate Profile versions save, restore, and delete named local snapshots', () => {
  const selectedResume = { resume_id: 'resume-1', content_hash: 'sha256:resume' };
  const first = createCandidateProfileVersion({
    profile: { full_name: 'Version One', approved_for_real_applications: true },
    selectedResume,
    name: 'Product roles',
    now: '2026-08-07T00:00:00.000Z'
  });
  const changed = { ...first.profile, full_name: 'Working Draft' };
  const second = createCandidateProfileVersion({
    profile: changed,
    selectedResume,
    name: 'Engineering roles',
    now: '2026-08-07T01:00:00.000Z'
  });
  assert.equal(listCandidateProfileVersions(second.profile).items.length, 2);
  const restored = activateCandidateProfileVersion({
    profile: second.profile,
    selectedResume,
    versionId: first.version.version_id,
    now: '2026-08-07T02:00:00.000Z'
  });
  assert.equal(restored.profile.full_name, 'Version One');
  assert.equal(restored.profile.approved_for_real_applications, false);
  assert.equal(restored.profile.allow_final_submit, false);
  const deleted = deleteCandidateProfileVersion({
    profile: restored.profile,
    versionId: second.version.version_id
  });
  assert.equal(deleted.versions.items.length, 1);
});

test('Resume Intelligence projects flat and nested existing profile facts with provenance', () => {
  const intelligence = buildResumeIntelligence({
    profile: {
      approved_for_real_applications: true,
      identity: {
        first_name: 'Synthetic',
        last_name: 'Candidate',
        email: 'candidate@local.invalid',
        phone: '000'
      },
      links: { linkedin: 'https://local.invalid/profile' },
      city: 'Fixture City',
      country: 'ZZ'
    },
    now: '2026-07-23T00:00:00.000Z'
  });
  assert.equal(resolveCandidateFact(intelligence, 'first_name').source_path, 'identity.first_name');
  assert.equal(resolveCandidateFact(intelligence, 'email').user_confirmed, true);
  assert.equal(intelligence.summary.core_fact_coverage_percent, 100);
  assert.equal(intelligence.storage_mode, 'derived_from_existing_sources');
});

test('explicit profile facts take precedence over resume metadata without reading resume content', () => {
  const intelligence = buildResumeIntelligence({
    profile: {
      approved_for_real_applications: true,
      summary: 'Confirmed profile summary'
    },
    selectedResume: {
      resume_id: 'resume-synthetic',
      version: 2,
      experience_summary: 'Resume metadata summary',
      skills: ['SQL', 'Product'],
      content_hash: 'sha256:synthetic',
      approved_at: '2026-07-23T00:00:00.000Z'
    }
  });
  assert.equal(resolveCandidateFact(intelligence, 'summary').value, 'Confirmed profile summary');
  assert.equal(resolveCandidateFact(intelligence, 'summary').source, 'candidate_profile');
  assert.deepEqual(resolveCandidateFact(intelligence, 'skills').value, ['SQL', 'Product']);
  assert.equal(resolveCandidateFact(intelligence, 'skills').source, 'resume_metadata');
  assert.equal(intelligence.resume_content_verified, true);
});

test('sensitive facts always carry an explicit per-application confirmation status', () => {
  const intelligence = buildResumeIntelligence({
    profile: {
      approved_for_real_applications: true,
      application_facts: { work_authorization: 'synthetic-confirmed-value' }
    }
  });
  const fact = resolveCandidateFact(intelligence, 'work_authorization');
  assert.equal(fact.user_confirmed, true);
  assert.equal(fact.sensitive, true);
  assert.equal(fact.status, 'user_confirmation_required');
});

test('existing structured resume facts remain structured and use the same profile source', () => {
  const intelligence = buildResumeIntelligence({
    profile: {
      approved_for_real_applications: true,
      work_background: {
        projects: [{ name: 'Synthetic project', result: 'Validated locally' }],
        certifications: ['Synthetic Certificate']
      },
      skills: {
        programming_languages: ['JavaScript'],
        languages: ['English']
      },
      application_facts: {
        requires_sponsorship_by_country: { ZZ: false }
      }
    }
  });
  assert.deepEqual(resolveCandidateFact(intelligence, 'projects').value, [
    { name: 'Synthetic project', result: 'Validated locally' }
  ]);
  assert.deepEqual(resolveCandidateFact(intelligence, 'programming_languages').value, ['JavaScript']);
  assert.deepEqual(resolveCandidateFact(intelligence, 'requires_sponsorship_by_country').value, { ZZ: false });
  assert.equal(resolveCandidateFact(intelligence, 'requires_sponsorship_by_country').status, 'user_confirmation_required');
});

test('Profile coverage measures the six review sections, not only contact fields', () => {
  const intelligence = buildResumeIntelligence({
    profile: {
      work_background: { skills: ['JavaScript'], projects: [{ name: 'Fixture project' }] },
      skills: { languages: ['English'] }
    }
  });
  assert.equal(intelligence.summary.core_fact_coverage_percent, 0);
  assert.deepEqual(intelligence.summary.populated_profile_sections, ['Projects', 'Skills', 'Languages']);
  assert.equal(intelligence.summary.profile_section_coverage_percent, 50);
});

test('automation flags and unknown profile objects never become candidate facts', () => {
  const intelligence = buildResumeIntelligence({
    profile: {
      approved_for_real_applications: true,
      allow_final_submit: true,
      arbitrary_private_blob: { secret: 'not-a-fact' }
    }
  });
  assert.equal(resolveCandidateFact(intelligence, 'allow_final_submit'), null);
  assert.equal(resolveCandidateFact(intelligence, 'arbitrary_private_blob'), null);
});

test('fact confirmation uses a reviewed snapshot and never unlocks risky actions', () => {
  const profile = {
    first_name: 'Synthetic',
    last_name: 'Candidate',
    email: 'candidate@local.invalid',
    allow_autofill_real_sites: false,
    allow_resume_attach: false,
    allow_final_submit: false,
    profile_meta: {
      approved_for_real_applications: false,
      review_required_before_real_applications: true,
      allow_autofill_real_sites: false,
      allow_resume_attach: false,
      allow_final_submit: false
    }
  };
  const before = buildResumeIntelligence({
    profile,
    now: '2026-07-23T00:00:00.000Z'
  });
  const result = confirmCandidateProfileSnapshot({
    profile,
    expectedSnapshotToken: before.snapshot_token,
    now: '2026-07-23T00:01:00.000Z'
  });
  assert.equal(result.profile.approved_for_real_applications, true);
  assert.equal(result.profile.profile_meta.last_reviewed_at, '2026-07-23T00:01:00.000Z');
  assert.equal(result.profile.allow_autofill_real_sites, false);
  assert.equal(result.profile.allow_resume_attach, false);
  assert.equal(result.profile.allow_final_submit, false);
  assert.equal(result.resume_intelligence.summary.confirmed_fact_count, before.summary.available_fact_count);
  assert.deepEqual(result.safety, {
    allow_autofill_real_sites_unchanged: true,
    allow_resume_attach_unchanged: true,
    allow_final_submit_unchanged: true
  });
  assert.equal(profile.approved_for_real_applications, undefined);
});

test('fact confirmation rejects a stale or missing snapshot token', () => {
  assert.throws(() => confirmCandidateProfileSnapshot({
    profile: { email: 'candidate@local.invalid' },
    expectedSnapshotToken: 'sha256:stale'
  }), error => error.code === 'STALE_FACT_SNAPSHOT');
});

test('Profile review is bound to the current Resume Version and fact snapshot', () => {
  const selectedResume = {
    resume_id: 'resume-v1',
    content_hash: 'sha256:resume-v1',
    language: 'en'
  };
  const legacy = buildResumeIntelligence({
    profile: {
      approved_for_real_applications: true,
      email: 'candidate@local.invalid'
    },
    selectedResume
  });
  assert.equal(legacy.profile_approved, true);
  assert.equal(legacy.current_review_approved, false);

  const confirmed = confirmCandidateProfileSnapshot({
    profile: { email: 'candidate@local.invalid' },
    selectedResume,
    expectedSnapshotToken: legacy.snapshot_token,
    now: '2026-07-24T00:00:00.000Z'
  });
  assert.equal(confirmed.resume_intelligence.current_review_approved, true);
  assert.equal(confirmed.resume_intelligence.review_bound_to_active_resume, true);

  const nextVersion = buildResumeIntelligence({
    profile: confirmed.profile,
    selectedResume: {
      ...selectedResume,
      resume_id: 'resume-v2',
      content_hash: 'sha256:resume-v2'
    }
  });
  assert.equal(nextVersion.current_review_approved, false);
});

test('Candidate Profile facts support add, edit, approve, reject, and delete without changing safety flags', () => {
  const selectedResume = {
    resume_id: 'resume-v1',
    content_hash: 'sha256:resume-v1',
    language: 'en'
  };
  const base = {
    email: 'candidate@local.invalid',
    allow_autofill_real_sites: false,
    allow_resume_attach: false,
    allow_final_submit: false
  };
  const added = mutateCandidateFact({
    profile: base,
    selectedResume,
    factKey: 'degree',
    action: 'add',
    value: 'Synthetic Degree'
  });
  assert.equal(resolveCandidateFact(added.resume_intelligence, 'degree').value, 'Synthetic Degree');
  assert.equal(added.resume_intelligence.current_review_approved, false);
  assert.equal(added.profile.allow_final_submit, false);

  const edited = mutateCandidateFact({
    profile: added.profile,
    selectedResume,
    factKey: 'degree',
    action: 'edit',
    value: 'Updated Synthetic Degree'
  });
  assert.equal(resolveCandidateFact(edited.resume_intelligence, 'degree').value, 'Updated Synthetic Degree');

  const approved = mutateCandidateFact({
    profile: edited.profile,
    selectedResume,
    factKey: 'degree',
    action: 'approve'
  });
  assert.equal(resolveCandidateFact(approved.resume_intelligence, 'degree').user_confirmed, true);

  const rejected = mutateCandidateFact({
    profile: approved.profile,
    selectedResume,
    factKey: 'degree',
    action: 'reject'
  });
  assert.equal(resolveCandidateFact(rejected.resume_intelligence, 'degree'), null);
  assert.ok(rejected.profile.profile_meta.suppressed_fact_keys.includes('degree'));
  assert.ok(rejected.profile.profile_meta.rejected_fact_keys.includes('degree'));
  assert.equal(
    rejected.profile.profile_meta.candidate_fact_rejections.degree.rejected_at.length > 0,
    true
  );

  const replacement = mutateCandidateFact({
    profile: rejected.profile,
    selectedResume,
    factKey: 'degree',
    action: 'add',
    value: 'Replacement Synthetic Degree'
  });
  assert.equal(replacement.profile.profile_meta.rejected_fact_keys.includes('degree'), false);

  const deleted = mutateCandidateFact({
    profile: replacement.profile,
    selectedResume,
    factKey: 'degree',
    action: 'delete'
  });
  assert.equal(resolveCandidateFact(deleted.resume_intelligence, 'degree'), null);
  assert.ok(deleted.profile.profile_meta.suppressed_fact_keys.includes('degree'));

  const editableSections = new Set(candidateFactSchema().map(item => item.section));
  for (const section of ['Education', 'Experience', 'Skills', 'Projects', 'Languages']) {
    assert.equal(editableSections.has(section), true);
  }
});

test('resume suggestions can target only existing non-sensitive profile fields', () => {
  const prepared = prepareResumeSuggestionTargets({
    email: '',
    linkedin: '',
    application_facts: { work_authorization: '' }
  }, [{
    suggestion_id: 'resume_suggestion_email',
    fact_key: 'email',
    value: 'candidate@local.invalid'
  }, {
    suggestion_id: 'resume_suggestion_linkedin',
    fact_key: 'linkedin',
    value: 'https://linkedin.com/in/synthetic'
  }, {
    suggestion_id: 'resume_suggestion_work_authorization',
    fact_key: 'work_authorization',
    value: 'Synthetic answer'
  }, {
    suggestion_id: 'resume_suggestion_school',
    fact_key: 'school',
    value: 'Synthetic University'
  }]);
  assert.equal(prepared.find(item => item.fact_key === 'email').target_path, 'email');
  assert.equal(prepared.find(item => item.fact_key === 'linkedin').can_apply_to_existing_profile, true);
  assert.equal(
    prepared.find(item => item.fact_key === 'work_authorization').apply_blocked_reason,
    'sensitive_fact_requires_manual_profile_edit'
  );
  assert.equal(
    prepared.find(item => item.fact_key === 'school').apply_blocked_reason,
    'existing_profile_field_missing'
  );
});

test('applying selected resume facts reuses existing fields and revokes profile approval', () => {
  const profile = {
    approved_for_real_applications: true,
    review_required_before_real_applications: true,
    allow_autofill_real_sites: true,
    allow_resume_attach: false,
    allow_final_submit: false,
    email: 'old@local.invalid',
    linkedin: '',
    profile_meta: {
      approved_for_real_applications: true,
      review_required_before_real_applications: true
    }
  };
  const result = applyResumeFactSuggestions({
    profile,
    suggestions: [{
      suggestion_id: 'resume_suggestion_email',
      fact_key: 'email',
      value: 'candidate@local.invalid',
      source: 'resume_document',
      confidence: 0.99
    }, {
      suggestion_id: 'resume_suggestion_linkedin',
      fact_key: 'linkedin',
      value: 'https://linkedin.com/in/synthetic',
      source: 'resume_document',
      confidence: 0.98
    }],
    selectedSuggestionIds: ['resume_suggestion_linkedin'],
    now: '2026-07-23T00:00:00.000Z'
  });
  assert.equal(result.profile.email, 'old@local.invalid');
  assert.equal(result.profile.linkedin, 'https://linkedin.com/in/synthetic');
  assert.equal(result.profile.approved_for_real_applications, false);
  assert.equal(result.profile.profile_meta.approved_for_real_applications, false);
  assert.equal(result.safety.profile_approval_revoked, true);
  assert.equal(result.safety.allow_autofill_real_sites_unchanged, true);
  assert.equal(result.safety.allow_resume_attach_unchanged, true);
  assert.equal(result.safety.allow_final_submit_unchanged, true);
  assert.equal(Object.hasOwn(result.profile.profile_meta, 'resume_suggestions_applied_at'), false);
});

test('resume suggestion apply rejects unknown, missing and sensitive targets', () => {
  assert.throws(
    () => applyResumeFactSuggestions({
      profile: { email: '' },
      suggestions: [],
      selectedSuggestionIds: []
    }),
    error => error.code === 'NO_RESUME_SUGGESTIONS_SELECTED'
  );
  assert.throws(
    () => applyResumeFactSuggestions({
      profile: { work_authorization: '' },
      suggestions: [{
        suggestion_id: 'resume_suggestion_work_authorization',
        fact_key: 'work_authorization',
        value: 'Synthetic answer'
      }],
      selectedSuggestionIds: ['resume_suggestion_work_authorization']
    }),
    error => error.code === 'RESUME_SUGGESTION_TARGET_BLOCKED'
  );
});

test('upload-time analysis persists only new review-required facts with provenance', () => {
  const profile = {
    full_name: 'Confirmed Candidate',
    email: '',
    work_background: { skills: [], work_experience: [], projects: [] },
    profile_meta: {},
    field_provenance: {
      full_name: { source: 'user_entered', confidence: 1, user_confirmed: true }
    },
    approved_for_real_applications: true,
    review_required_before_real_applications: false
  };
  const result = persistResumeAnalysisDraft({
    profile,
    resumeId: 'synthetic-v1',
    contentHash: 'sha256:synthetic',
    analysisSnapshotToken: 'sha256:analysis',
    now: '2026-08-06T00:00:00.000Z',
    suggestions: [{
      suggestion_id: 'resume_suggestion_full_name',
      fact_key: 'full_name',
      value: 'Resume Name',
      source: 'resume_document',
      confidence: 0.6,
      existing_fact_present: true
    }, {
      suggestion_id: 'resume_suggestion_email',
      fact_key: 'email',
      value: 'candidate@local.invalid',
      source: 'resume_document',
      confidence: 0.99,
      existing_fact_present: false
    }, {
      suggestion_id: 'resume_suggestion_skills',
      fact_key: 'skills',
      value: ['analytics'],
      source: 'resume_document',
      confidence: 0.8,
      existing_fact_present: false
    }]
  });
  assert.equal(result.profile.full_name, 'Confirmed Candidate');
  assert.equal(result.profile.email, 'candidate@local.invalid');
  assert.deepEqual(result.profile.work_background.skills, ['analytics']);
  assert.equal(result.profile.field_provenance.full_name.user_confirmed, true);
  assert.equal(result.profile.field_provenance.email.user_confirmed, false);
  assert.equal(result.profile.field_provenance.email.source, 'resume_document');
  assert.equal(result.profile.approved_for_real_applications, false);
  assert.deepEqual(result.profile.profile_meta.resume_analysis.applied_fact_keys, ['email', 'skills']);
  assert.deepEqual(result.profile.profile_meta.resume_analysis.conflict_fact_keys, ['full_name']);
  assert.equal(result.safety.existing_facts_overwritten, false);
});
