import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCandidateMatchingContext,
  evaluateCandidateJobDimensions
} from '../scripts/lib/candidate_matching.mjs';

function intelligence(facts) {
  return {
    profile_approved: false,
    resume_id: 'synthetic-resume',
    facts: facts.map(([fact_key, value, user_confirmed = false]) => ({
      fact_key,
      value,
      confidence: user_confirmed ? 1 : 0.8,
      user_confirmed
    }))
  };
}

test('candidate matching evaluates six explainable dimensions without inventing missing data', () => {
  const context = buildCandidateMatchingContext({
    resumeIntelligence: intelligence([
      ['skills', ['JavaScript', 'analytics', 'roadmapping']],
      ['years_experience', '5', true],
      ['degree', 'Master of Science', true],
      ['target_roles', ['Product Manager']],
      ['city', 'Shanghai', true]
    ])
  });
  const result = evaluateCandidateJobDimensions({
    title: 'Product Manager',
    description_text: 'Requires 3+ years of experience, analytics, roadmapping, and a bachelor degree.',
    skills: ['analytics', 'roadmapping'],
    location: 'Remote',
    salary_min: 120000
  }, context, { preferredLocations: ['Remote'], minimumSalary: 100000 });
  assert.equal(result.technical.status, 'matched');
  assert.equal(result.technical.score, 100);
  assert.equal(result.experience.status, 'matched');
  assert.equal(result.education.status, 'matched');
  assert.equal(result.location.status, 'matched');
  assert.equal(result.salary.status, 'matched');
  assert.equal(result.career_direction.status, 'matched');
  assert.equal(result.candidate_fit_score, 100);
  assert.equal(result.score_adjustment, 10);
});

test('unknown candidate fields stay unknown and explicit gaps lower only the bounded adjustment', () => {
  const context = buildCandidateMatchingContext({
    resumeIntelligence: intelligence([
      ['skills', ['copywriting']],
      ['years_experience', '1'],
      ['target_roles', ['Designer']]
    ])
  });
  const result = evaluateCandidateJobDimensions({
    title: 'Senior Software Engineer',
    description_text: 'Requires 5+ years of experience with JavaScript and a master degree.',
    skills: ['JavaScript'],
    location: 'New York'
  }, context);
  assert.equal(result.technical.status, 'no_overlap');
  assert.equal(result.experience.status, 'below_requirement');
  assert.equal(result.education.status, 'unknown');
  assert.equal(result.career_direction.status, 'no_match');
  assert.ok(result.score_adjustment >= -10);
  assert.equal(result.education.score, null);
});

test('seniority: a leadership title never scores as a recommendation for an entry-level candidate', () => {
  const entryContext = {
    available: true,
    skills: ['Python', 'Java'],
    career_terms: ['software engineer', 'backend'],
    years_experience: 0.5,
    entry_level: true,
    education_terms: ['bachelor'],
    location_terms: ['Shanghai']
  };
  const em = evaluateCandidateJobDimensions({
    title: 'Engineering Manager, Notifications',
    description_text: 'Lead a team of software engineers. Python services at scale.',
    location: 'Remote'
  }, entryContext, {});
  assert.equal(em.seniority.status, 'mismatch');
  assert.equal(em.seniority.score, 0);
  assert.equal(em.seniority_cap, 45);

  const senior = evaluateCandidateJobDimensions({
    title: 'Senior Software Engineer, Developer Experience',
    description_text: 'Python, Java. Build developer tooling.',
    location: 'Remote'
  }, entryContext, {});
  assert.equal(senior.seniority.status, 'mismatch');
  assert.equal(senior.seniority_cap, 55);

  // Entry/intern postings are a positive signal, not merely neutral.
  const intern = evaluateCandidateJobDimensions({
    title: 'Software Engineer Intern (校招)',
    description_text: 'Python. New grad program.',
    location: 'Shanghai'
  }, entryContext, {});
  assert.equal(intern.seniority.status, 'matched');
  assert.equal(intern.seniority.score, 100);
  assert.equal(intern.seniority_cap, 100);

  // Profession titles that merely contain "Manager" stay unlevelled — the
  // pinned Product Manager behavior above must not change.
  const pm = evaluateCandidateJobDimensions({
    title: 'Product Manager',
    description_text: 'Roadmapping and analytics.',
    location: 'Remote'
  }, entryContext, {});
  assert.equal(pm.seniority.status, 'unknown');
  assert.equal(pm.seniority_cap, 100);

  // A senior candidate applying at their level is untouched.
  const seniorContext = { ...entryContext, years_experience: 8, entry_level: false };
  const seniorForSenior = evaluateCandidateJobDimensions({
    title: 'Senior Software Engineer',
    description_text: 'Python, Java.',
    location: 'Remote'
  }, seniorContext, {});
  assert.equal(seniorForSenior.seniority.status, 'matched');
  assert.equal(seniorForSenior.seniority_cap, 100);
});
