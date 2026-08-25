import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { migrateAnswerMemory, runMigration } from '../scripts/migrate_answer_memory.mjs';
import { readJsonFile } from '../scripts/lib/json_repository.mjs';

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'answer-migration-'));
}

function writeBank(dataDir, answers) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'question_bank.json'), JSON.stringify({ version: '2.0', answers }, null, 2));
}

const SAFE_CONFIRMED = {
  original_question: 'What is your notice period?',
  answer: 'Synthetic thirty days',
  source: 'user_confirmed',
  user_confirmed: true,
  sensitive_category: 'none',
  risk_level: 'normal',
  approved_for_real_applications: false,
  last_confirmed_at: '2026-08-01T00:00:00.000Z'
};

test('safe confirmed answer is backfilled to approved', () => {
  const { memory, changes } = migrateAnswerMemory({ answers: [SAFE_CONFIRMED] });
  assert.equal(memory.answers[0].approved_for_real_applications, true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].reason, 'user_confirmed_safe_answer');
  assert.equal(Object.hasOwn(changes[0], 'answer'), false);
});

test('unconfirmed answer is never backfilled', () => {
  const { memory, changes } = migrateAnswerMemory({
    answers: [{
      original_question: 'Why this role?',
      answer: 'Synthetic model suggestion',
      source: 'model_suggested'
    }]
  });
  assert.equal(memory.answers[0].approved_for_real_applications, false);
  assert.equal(changes.length, 0);
});

test('sensitive answer is never backfilled even when confirmed', () => {
  const { memory, changes } = migrateAnswerMemory({
    answers: [{
      original_question: 'Do you require sponsorship?',
      answer: 'Synthetic sensitive answer',
      source: 'user_confirmed',
      user_confirmed: true,
      sensitive_category: 'work_authorization'
    }]
  });
  assert.equal(memory.answers[0].approved_for_real_applications, false);
  assert.equal(changes.length, 0);
});

test('high-risk answer loses a wrongly stored approval and the change is reported', () => {
  const { memory, changes } = migrateAnswerMemory({
    answers: [{
      original_question: 'Have you ever been convicted?',
      answer: 'Synthetic declaration',
      source: 'user_confirmed',
      user_confirmed: true,
      sensitive_category: 'none',
      risk_level: 'high',
      approved_for_real_applications: true
    }]
  });
  assert.equal(memory.answers[0].approved_for_real_applications, false);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].reason, 'high_risk');
});

test('duplicate normalized wording records migrate independently without merging', () => {
  const { memory, changes } = migrateAnswerMemory({
    answers: [
      { ...SAFE_CONFIRMED },
      {
        original_question: 'How long is your notice period?',
        answer: 'Synthetic paraphrase answer',
        source: 'user_confirmed',
        user_confirmed: true,
        sensitive_category: 'none'
      }
    ]
  });
  assert.equal(memory.answers.length, 2);
  assert.equal(changes.length, 2);
  assert.notEqual(memory.answers[0].question_id, memory.answers[1].question_id);
});

test('scoped answers keep their scope and migrate on the same rule', () => {
  const { memory } = migrateAnswerMemory({
    answers: [{
      original_question: 'Why this company?',
      answer: 'Synthetic scoped answer',
      source: 'user_confirmed',
      user_confirmed: true,
      scope: 'employer',
      scope_key: 'Example Employer'
    }]
  });
  assert.equal(memory.answers[0].scope, 'employer');
  assert.equal(memory.answers[0].scope_key, 'Example Employer');
  assert.equal(memory.answers[0].approved_for_real_applications, true);
});

test('migration run is dry-run by default, applies with backup, and reruns as a no-op', () => {
  const dataDir = tempDataDir();
  const archiveDir = path.join(dataDir, 'archive');
  writeBank(dataDir, [SAFE_CONFIRMED]);

  const dry = runMigration({ dataDir, archiveDir, apply: false });
  assert.equal(dry.status, 'dry_run');
  assert.equal(dry.changed, 1);
  assert.equal(dry.applied, false);
  const untouched = readJsonFile(path.join(dataDir, 'question_bank.json'));
  assert.equal(untouched.answers[0].approved_for_real_applications, false);

  const applied = runMigration({ dataDir, archiveDir, apply: true, now: new Date('2026-08-15T00:00:00.000Z') });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.applied, true);
  assert.ok(fs.existsSync(applied.backup));
  const migrated = readJsonFile(path.join(dataDir, 'question_bank.json'));
  assert.equal(migrated.answers[0].approved_for_real_applications, true);
  assert.equal(migrated.answers[0].last_confirmed_at, '2026-08-01T00:00:00.000Z');

  const rerun = runMigration({ dataDir, archiveDir, apply: true });
  assert.equal(rerun.status, 'already_migrated');
  assert.equal(rerun.changed, 0);
  assert.equal(rerun.applied, false);

  const missing = runMigration({ dataDir: path.join(dataDir, 'does-not-exist'), archiveDir, apply: true });
  assert.equal(missing.status, 'nothing_to_migrate');
});
