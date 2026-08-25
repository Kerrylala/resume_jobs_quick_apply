import assert from 'node:assert/strict';
import test from 'node:test';

import {
  careerProfileToApplicationProfile,
  normalizeRelocationAnswer
} from '../scripts/lib/career_brain.mjs';

function approvedProfile(overrides = {}) {
  return {
    id: 'career-projection', family_id: 'career-projection', version: 1, name: 'Projection Test',
    state: 'approved', user_approved: true, approved_at: '2026-08-15T00:00:00.000Z',
    identity: {
      full_name: 'Synthetic Candidate',
      first_name: 'Synthetic',
      last_name: 'Candidate',
      email: 'candidate@example.test',
      phone: '+1 555 0100',
      city: 'Shanghai',
      country: 'China',
      links: { linkedin: 'https://linkedin.example.test/in/synthetic', github: 'https://github.example.test/synthetic' },
      ...overrides.identity
    },
    education: [], experience: overrides.experience || [], projects: [], skills: {}, certifications: [],
    languages: [], interview_stories: [], career_goals: ['Engineer'],
    job_preferences: {
      countries: ['China'], cities: ['Shanghai'], remote: '', salary: '',
      industries: [], blocked_industries: [],
      relocation_ok: 'yes', work_authorization: 'Citizen of China',
      sponsorship: 'Not required',
      earliest_start_date: '2026-09-01', notice_period: '30 days',
      ...overrides.job_preferences
    },
    field_provenance: {}
  };
}

test('the projection emits a usable location for the executor location key', () => {
  const projected = careerProfileToApplicationProfile(approvedProfile(), {});
  assert.equal(projected.location, 'Shanghai, China');
  assert.equal(projected.current_location, 'Shanghai, China');
  assert.equal(projected.city, 'Shanghai');
  assert.equal(projected.country, 'China');
});

test('work authorization, sponsorship, start date, and notice period are no longer dropped', () => {
  const projected = careerProfileToApplicationProfile(approvedProfile(), {});
  assert.equal(projected.work_authorization, 'Citizen of China');
  assert.equal(projected.sponsorship_required, 'Not required');
  assert.equal(projected.work_situation.work_authorization, 'Citizen of China');
  assert.equal(projected.work_situation.sponsorship, 'Not required');
  assert.equal(projected.work_situation.earliest_start_date, '2026-09-01');
  assert.equal(projected.work_situation.notice_period, '30 days');
  assert.equal(projected.job_preferences.work_authorization, 'Citizen of China');
  assert.equal(projected.job_preferences.earliest_start_date, '2026-09-01');
});

test('current company derives from the most recent open experience entry', () => {
  const projected = careerProfileToApplicationProfile(approvedProfile({
    experience: [
      { company: 'Old Employer', role: 'Engineer', end_date: '2024-01' },
      { company: 'Current Employer', role: 'Senior Engineer', end_date: '' }
    ]
  }), {});
  assert.equal(projected.work_situation.current_company, 'Current Employer');
  const explicit = careerProfileToApplicationProfile(approvedProfile({
    job_preferences: { current_company: 'Explicit Employer' },
    experience: [{ company: 'Current Employer', role: 'Engineer', end_date: '' }]
  }), {});
  assert.equal(explicit.work_situation.current_company, 'Explicit Employer');
});

test('relocation legacy forms normalize to a stable enum without inventing values', () => {
  assert.equal(normalizeRelocationAnswer(true), 'yes');
  assert.equal(normalizeRelocationAnswer(false), 'no');
  assert.equal(normalizeRelocationAnswer('true'), 'yes');
  assert.equal(normalizeRelocationAnswer('No, I prefer to stay'), 'no');
  assert.equal(normalizeRelocationAnswer('depends on the offer'), 'depends');
  assert.equal(normalizeRelocationAnswer('愿意'), 'yes');
  assert.equal(normalizeRelocationAnswer(''), '');
  assert.equal(normalizeRelocationAnswer('interesting phrasing'), '');
  const projected = careerProfileToApplicationProfile(approvedProfile({
    job_preferences: { relocation_ok: 'true' }
  }), {});
  assert.equal(projected.work_situation.relocation_ok, 'true');
  assert.equal(projected.work_situation.relocation_answer, 'yes');
});

test('a Chinese full name derives surname-first name parts deterministically', () => {
  // The user approved the profile carrying the full name and asked for the
  // split to be automatic: CJK names split family-name-first.
  const projected = careerProfileToApplicationProfile(approvedProfile({
    identity: { full_name: '王小明', first_name: '', last_name: '', chinese_name: '王小明', english_name: 'Ming Wang' }
  }), {});
  assert.equal(projected.full_name, '王小明');
  assert.equal(projected.first_name, '小明');
  assert.equal(projected.last_name, '王');
  const compound = careerProfileToApplicationProfile(approvedProfile({
    identity: { full_name: '欧阳娜娜', first_name: '', last_name: '' }
  }), {});
  assert.equal(compound.first_name, '娜娜');
  assert.equal(compound.last_name, '欧阳');
});

test('an English name with a confirmed split projects both parts and links stay aliased', () => {
  const projected = careerProfileToApplicationProfile(approvedProfile(), {});
  assert.equal(projected.first_name, 'Synthetic');
  assert.equal(projected.last_name, 'Candidate');
  assert.equal(projected.linkedin, 'https://linkedin.example.test/in/synthetic');
  assert.equal(projected.links.linkedin, 'https://linkedin.example.test/in/synthetic');
  assert.equal(projected.links.github, 'https://github.example.test/synthetic');
});

test('a missing city still yields a country-only location instead of an empty one', () => {
  const projected = careerProfileToApplicationProfile(approvedProfile({
    identity: { city: '', country: 'Singapore', current_location: '' }
  }), {});
  assert.equal(projected.location, 'Singapore');
});

test('an unapproved profile projects nothing and unknown values stay unknown', () => {
  const unapproved = careerProfileToApplicationProfile({ ...approvedProfile(), user_approved: false }, {});
  assert.equal(unapproved.location, undefined);
  const minimal = careerProfileToApplicationProfile(approvedProfile({
    job_preferences: {
      relocation_ok: '', work_authorization: '', sponsorship: '',
      earliest_start_date: '', notice_period: ''
    }
  }), {});
  assert.equal(minimal.work_situation.work_authorization, '');
  assert.equal(minimal.work_situation.earliest_start_date, '');
  assert.equal(minimal.work_situation.availability, '');
});
