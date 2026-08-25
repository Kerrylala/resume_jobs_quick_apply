#!/usr/bin/env node
// Idempotent Answer Memory migration: re-derives approved_for_real_applications
// for every stored answer using the trust rule
//   user_confirmed && sensitive_category === 'none' && risk_level !== 'high'.
// Dry-run by default; --apply writes after a timestamped backup. The report
// contains question IDs and flag transitions only — never answer values.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeAnswerMemory } from './lib/candidate_records.mjs';
import { readJsonFile, writeJsonAtomic } from './lib/json_repository.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export function migrateAnswerMemory(rawMemory) {
  const before = rawMemory && typeof rawMemory === 'object' && !Array.isArray(rawMemory) ? rawMemory : { answers: [] };
  const beforeAnswers = Array.isArray(before.answers) ? before.answers : [];
  const migrated = normalizeAnswerMemory(before);
  const changes = [];
  migrated.answers.forEach((answer, index) => {
    const previous = beforeAnswers[index]?.approved_for_real_applications === true;
    if (previous !== answer.approved_for_real_applications) {
      changes.push({
        question_id: answer.question_id,
        approved_for_real_applications: { from: previous, to: answer.approved_for_real_applications },
        reason: answer.approved_for_real_applications
          ? 'user_confirmed_safe_answer'
          : answer.user_confirmed !== true
            ? 'not_user_confirmed'
            : answer.sensitive_category !== 'none'
              ? 'sensitive_category'
              : 'high_risk'
      });
    }
  });
  return { memory: migrated, changes, total: migrated.answers.length };
}

function timestampForFile(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, '-');
}

export function runMigration({
  dataDir = path.resolve(process.env.RESUME_JOBS_DATA_DIR || path.join(PROJECT_ROOT, 'data')),
  archiveDir = path.resolve(process.env.RESUME_JOBS_ARCHIVE_DIR || path.join(PROJECT_ROOT, 'archive')),
  apply = false,
  now = new Date()
} = {}) {
  const filePath = path.join(dataDir, 'question_bank.json');
  if (!fs.existsSync(filePath)) {
    return { status: 'nothing_to_migrate', file: filePath, total: 0, changed: 0, changes: [], applied: false };
  }
  const raw = readJsonFile(filePath, { answers: [] });
  const { memory, changes, total } = migrateAnswerMemory(raw);
  const result = {
    status: changes.length === 0 ? 'already_migrated' : (apply ? 'applied' : 'dry_run'),
    file: filePath,
    total,
    changed: changes.length,
    changes,
    applied: false,
    backup: null
  };
  if (apply && changes.length > 0) {
    fs.mkdirSync(archiveDir, { recursive: true });
    const backupPath = path.join(archiveDir, `question_bank.json.${timestampForFile(now)}.bak`);
    fs.copyFileSync(filePath, backupPath);
    writeJsonAtomic(filePath, memory, { mode: 0o600 });
    result.applied = true;
    result.backup = backupPath;
  }
  return result;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const apply = process.argv.includes('--apply');
  const result = runMigration({ apply });
  console.log(JSON.stringify(result, null, 2));
  if (!apply && result.changed > 0) {
    console.error('Dry run only. Re-run with --apply to write the migration after a timestamped backup.');
  }
}
