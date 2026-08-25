import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLearningCandidates,
  confirmFormFieldMapping,
  decideLearningCandidate,
  finalizeLearningCandidate,
  formFieldMemoryRules,
  normalizeFormFieldMemory,
  recordLearningCandidates
} from '../scripts/lib/learning_candidates.mjs';

const session = {
  session_id: 'session-learning-1',
  application_id: 'application-learning-1',
  job_id: 'job-learning-1',
  package_id: 'package-learning-1',
  target_url: 'https://jobs.lever.co/example/job-1/apply'
};

test('post-fill comparison creates review candidates and excludes prohibited values', () => {
  const baseline = [
    { field_ref: 'field-1', tag: 'input', type: 'text', name: 'location', label: 'Current location', value: '' },
    { field_ref: 'field-2', tag: 'input', type: 'text', name: 'authorization', label: 'Are you authorized to work?', value: '' },
    { field_ref: 'field-3', tag: 'input', type: 'text', name: 'ssn', label: 'Social Security Number', value: '' }
  ];
  const current = [
    { ...baseline[0], value: 'Synthetic City' },
    { ...baseline[1], value: 'Synthetic answer' },
    { ...baseline[2], value: '000-00-0000' }
  ];
  const candidates = buildLearningCandidates({ session, baselineSnapshot: baseline, currentSnapshot: current, now: '2026-08-11T00:00:00.000Z' });
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].suggested_destination, 'career_brain');
  assert.equal(candidates[0].canonical_path, 'identity.current_location');
  assert.equal(candidates[1].risk_level, 'high');
  assert.equal(candidates[1].suggested_scope, 'do_not_save');
  assert.doesNotMatch(JSON.stringify(candidates), /000-00-0000/);
});

test('learning candidates require explicit decisions and discard duplicate candidate values after save', () => {
  const [candidate] = buildLearningCandidates({
    session,
    baselineSnapshot: [{ tag: 'input', type: 'url', name: 'linkedin', label: 'LinkedIn', value: '' }],
    currentSnapshot: [{ tag: 'input', type: 'url', name: 'linkedin', label: 'LinkedIn', value: 'https://example.test/profile' }],
    now: '2026-08-11T00:00:00.000Z'
  });
  const recorded = recordLearningCandidates({}, [candidate], { now: '2026-08-11T00:00:00.000Z' });
  const decided = decideLearningCandidate(recorded, {
    candidateId: candidate.candidate_id,
    decision: 'save',
    scope: 'global',
    now: '2026-08-11T00:01:00.000Z'
  });
  assert.equal(decided.candidate.user_confirmed, true);
  assert.equal(decided.candidate.status, 'confirmed');
  const finalized = finalizeLearningCandidate(decided.store, candidate.candidate_id, { destination: 'career_brain' }, { now: '2026-08-11T00:02:00.000Z' });
  assert.equal(finalized.candidates[0].status, 'saved');
  assert.equal(finalized.candidates[0].value, '');
  assert.equal(finalized.candidates[0].value_retained_in_candidate_store, false);
});

test('confirmed Form Field Memory stores mappings but never candidate answers', () => {
  const [candidate] = buildLearningCandidates({
    session,
    baselineSnapshot: [{ tag: 'input', type: 'text', name: 'current_city', label: 'Current location', value: '' }],
    currentSnapshot: [{ tag: 'input', type: 'text', name: 'current_city', label: 'Current location', value: 'Synthetic City' }],
    now: '2026-08-11T00:00:00.000Z'
  });
  const memory = confirmFormFieldMapping({}, { ...candidate, selected_destination: 'career_brain' }, { now: '2026-08-11T00:01:00.000Z' });
  const serialized = JSON.stringify(memory);
  assert.doesNotMatch(serialized, /Synthetic City/);
  assert.equal(Object.hasOwn(memory.records[0], 'value'), false);
  assert.equal(Object.hasOwn(memory.records[0], 'answer'), false);
  assert.equal(normalizeFormFieldMemory(memory).records[0].user_confirmed, true);
  const rules = formFieldMemoryRules(memory, session.target_url);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].key, 'location');
  assert.ok(rules[0].aliases.includes('current_city'));
});
