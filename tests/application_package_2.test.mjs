import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApplicationPackage2Sections } from '../scripts/lib/application_package_2.mjs';

test('Application Package 2.0 combines job, Career Brain, resume, answers, and interview preparation', () => {
  const value = buildApplicationPackage2Sections({
    job: { job_id: 'job_1', title: 'AI Consultant', company: 'Example', country: 'China', source: 'fixture' },
    careerProfile: {
      id: 'career_1', name: 'Consulting profile', state: 'approved', user_approved: true,
      approved_at: '2026-08-09T00:00:00.000Z',
      interview_stories: [{ title: 'Automation delivery', situation: 'Manual workflow', task: 'Improve it', action: 'Built tools', result: 'Saved time', user_confirmed: true }]
    },
    selectedResume: { resume_id: 'resume_1', name: 'AI Resume', version: 2, approved_at: '2026-08-09' },
    plannedAnswers: [{ question_id: 'work_auth', value: 'Confirmed', source: 'user_confirmed', confidence: 1, user_confirmed: true }],
    hybridMatch: { strengths: ['AI delivery'], weaknesses: ['Sector depth'], missing: ['Certification'] }
  });
  assert.equal(value.package_version, '2.0');
  assert.equal(value.recommended_resume.resume_id, 'resume_1');
  assert.equal(value.interview_preparation.recommended_stories.length, 1);
  assert.equal(value.star_stories.length, 1);
  assert.deepEqual(value.missing_skills, ['Sector depth', 'Certification']);
  assert.deepEqual(value.interview_preparation.missing_skills, value.missing_skills);
  assert.ok(value.interview_preparation.possible_questions.some(question => /Certification/.test(question)));
  assert.ok(value.interview_preparation.possible_questions.every(question => !/\.\?$/.test(question)));
  assert.equal(value.cover_letter.status, 'draft_ready');
  assert.match(value.cover_letter.content, /AI Consultant/);
  assert.match(value.cover_letter.content, /strongest evidence from my reviewed career profile/i);
  assert.equal(value.cover_letter.requires_review, true);
  assert.equal(value.risk.level, 'low');
  assert.equal(value.safety.final_submit_allowed, false);
});

test('unapproved Career Brain and sensitive questions raise package risk without enabling submit', () => {
  const value = buildApplicationPackage2Sections({
    job: { title: 'Engineer' },
    careerProfile: {},
    sensitiveQuestions: [{ question_id: 'salary' }]
  });
  assert.equal(value.risk.level, 'high');
  assert.ok(value.risk.reasons.includes('career_profile_not_approved'));
  assert.equal(value.safety.resume_attachment_allowed, false);
});
