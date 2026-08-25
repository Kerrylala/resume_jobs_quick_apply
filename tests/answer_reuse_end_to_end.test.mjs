// Acceptance criterion 8: "the second application reuses answers you already
// confirmed."
//
// This is the regression that matters most, because it was broken in a way no
// existing test noticed. Answers saved through the UI were stored, marked
// reusable, and shown in Settings — but arrived at the executor with an empty
// canonical_key, and buildApprovedFieldMappings drops any answer without one.
// The answer was therefore never filled into any form, forever.
//
// The assertions below follow one answer all the way from "user typed it" to
// "the executor will type it", because every earlier stage already looked fine
// while the end of the chain was silently dropping it.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveAnswerCanonicalKey,
  normalizeAnswerMemory,
  normalizeAnswerRecord,
  upsertAnswerMemory
} from '../scripts/lib/candidate_records.mjs';
import { buildApprovedFieldMappings } from '../application_executor/execution_session.mjs';

function packageWith(answers) {
  return {
    status: 'PACKAGE_READY',
    application_profile: {
      approved_for_real_applications: true,
      full_name: 'Synthetic Candidate',
      email: 'candidate@example.test'
    },
    application_answers: answers
  };
}

// Mirrors how build_application_package_preview projects a stored answer into
// the package the executor consumes.
function asPackagedAnswer(record) {
  return {
    question_id: record.question_id,
    canonical_key: record.canonical_key,
    original_question: record.original_question,
    normalized_question: record.normalized_question,
    question_patterns: record.question_patterns || [],
    value: record.answer,
    source: record.source,
    confidence: record.confidence,
    user_confirmed: record.user_confirmed,
    sensitive_category: record.sensitive_category,
    risk_level: record.risk_level
  };
}

test('an answer typed by the user reaches the executor instead of being dropped', () => {
  // Exactly what the Settings form sends: no canonical_key.
  const saved = normalizeAnswerRecord({
    original_question: 'Why do you want to join our team?',
    answer: 'Synthetic motivation answer',
    source: 'user_entered',
    scope: 'global',
    sensitive_category: 'none',
    user_confirmed: true
  });

  assert.ok(saved.canonical_key, 'a saved answer must always carry a canonical key');
  assert.equal(saved.approved_for_real_applications, true);

  const mappings = buildApprovedFieldMappings(packageWith([asPackagedAnswer(saved)]));
  const reused = mappings.find(mapping => mapping.canonical_key === saved.canonical_key);

  assert.ok(reused, 'the confirmed answer must survive into the approved field mappings');
  assert.equal(reused.value, 'Synthetic motivation answer');
  assert.ok(
    reused.aliases.includes('Why do you want to join our team?'),
    'the original question must be carried as an alias so the page field can be matched'
  );
});

test('the canonical key is stable across saves so a second application matches the first', () => {
  const first = normalizeAnswerRecord({
    original_question: 'What is your notice period?',
    answer: 'Synthetic thirty days',
    source: 'user_entered',
    user_confirmed: true
  });
  // Same question, typed again with different spacing and case.
  const second = normalizeAnswerRecord({
    original_question: '  What Is Your Notice Period?  ',
    answer: 'Synthetic thirty days',
    source: 'user_entered',
    user_confirmed: true
  });

  assert.equal(
    first.canonical_key, second.canonical_key,
    'the same question must derive the same key, or reuse silently stops working'
  );
  assert.equal(first.question_id, second.question_id);
});

test('questions about known profile fields map onto the executor field key', () => {
  // These must not get a hash key: the executor already knows how to fill them,
  // and the post-fill learning loop routes them to the same names.
  const cases = [
    ['What is your email address?', 'email'],
    ['LinkedIn profile URL', 'linkedin_url'],
    ['联系电话', 'phone'],
    ['所在城市', 'location']
  ];
  for (const [question, expected] of cases) {
    const record = normalizeAnswerRecord({
      original_question: question, answer: 'Synthetic', user_confirmed: true
    });
    assert.equal(record.canonical_key, expected, `"${question}" should map to ${expected}`);
  }
});

test('a sensitive answer still gets a key but is never auto-filled', () => {
  const record = normalizeAnswerRecord({
    original_question: 'Do you require visa sponsorship?',
    answer: 'Synthetic sponsorship answer',
    source: 'user_entered',
    user_confirmed: true,
    sensitive_category: 'work_authorization',
    risk_level: 'high'
  });

  assert.ok(record.canonical_key, 'sensitive answers are still stored and listed');
  assert.equal(record.approved_for_real_applications, false);

  const mappings = buildApprovedFieldMappings(packageWith([asPackagedAnswer(record)]));
  assert.equal(
    mappings.some(mapping => mapping.canonical_key === record.canonical_key),
    false,
    'a sensitive answer must never reach a real form automatically (acceptance #13)'
  );
});

test('answer banks saved before canonical keys existed start working on read', () => {
  // Self-healing: no migration script has to run for an existing install.
  const legacy = normalizeAnswerMemory({
    version: '2.0',
    answers: [{
      original_question: 'Describe a challenge you overcame.',
      answer: 'Synthetic story',
      user_confirmed: true,
      approved_for_real_applications: true
    }]
  });

  assert.ok(
    legacy.answers[0].canonical_key,
    'an answer stored without a canonical key must gain one when read back'
  );
  const mappings = buildApprovedFieldMappings(packageWith([asPackagedAnswer(legacy.answers[0])]));
  assert.ok(
    mappings.some(mapping => mapping.canonical_key === legacy.answers[0].canonical_key),
    'a legacy answer must reach the executor once it is read back'
  );
});

test('an explicit canonical key from the learning loop is never overwritten', () => {
  const memory = upsertAnswerMemory({ version: '2.0', answers: [] }, {
    original_question: 'Where are you located?',
    answer: 'Synthetic City',
    source: 'user_confirmed',
    user_confirmed: true,
    canonical_key: 'location'
  });
  assert.equal(memory.answers[0].canonical_key, 'location');

  // And an edit that omits the key inherits it rather than re-deriving.
  const edited = upsertAnswerMemory(memory, {
    question_id: memory.answers[0].question_id,
    original_question: 'Where are you located?',
    answer: 'Synthetic City Two',
    user_confirmed: true
  });
  assert.equal(edited.answers[0].canonical_key, 'location');
  assert.equal(edited.answers[0].answer, 'Synthetic City Two');
});

test('deriveAnswerCanonicalKey returns nothing for an empty question', () => {
  assert.equal(deriveAnswerCanonicalKey('', ''), '');
});
