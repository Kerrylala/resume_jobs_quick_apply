#!/usr/bin/env node
// Inventory repair: mark records that were never jobs.
//
// Earlier imports could turn navigation anchors ("查看更多职位", "View all
// jobs", board list pages) into job records. This pass runs the job quality
// gate over the stored inventory and marks failures `invalid_non_job` with the
// gate's reasons. Nothing is deleted — marked records simply stop surfacing in
// the default views, and the mark survives re-normalization.
//
// Usage: node scripts/fix_invalid_job_records.mjs [--dry-run] [--data-dir <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { jobQualityGate } from './lib/job_input_classifier.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDirIndex = process.argv.indexOf('--data-dir');
const DATA_DIR = dataDirIndex >= 0 && process.argv[dataDirIndex + 1]
  ? path.resolve(process.argv[dataDirIndex + 1])
  : path.resolve(process.env.RESUME_JOBS_DATA_DIR || path.join(ROOT, 'data'));
const DRY_RUN = process.argv.includes('--dry-run');

export function repairJobInventory(jobs) {
  const records = Array.isArray(jobs) ? jobs : [];
  let marked = 0;
  let alreadyMarked = 0;
  const details = [];
  const repaired = records.map(job => {
    if (!job || typeof job !== 'object') return job;
    if (job.invalid_non_job === true) { alreadyMarked += 1; return job; }
    const gate = jobQualityGate(job);
    if (gate.ok) return job;
    marked += 1;
    details.push({ job_id: job.job_id || '', title: String(job.title || '').slice(0, 60), reasons: gate.reasons });
    return { ...job, invalid_non_job: true, invalid_reasons: gate.reasons };
  });
  return { jobs: repaired, marked, already_marked: alreadyMarked, total: records.length, details };
}

function repairFile(fileName) {
  const filePath = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(filePath)) return { file: fileName, skipped: true };
  let value;
  try { value = JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return { file: fileName, skipped: true, reason: 'unreadable' }; }
  if (!Array.isArray(value)) return { file: fileName, skipped: true, reason: 'not_a_job_array' };
  const result = repairJobInventory(value);
  if (!DRY_RUN && result.marked > 0) {
    fs.copyFileSync(filePath, `${filePath}.${Date.now()}.bak`);
    fs.writeFileSync(filePath, `${JSON.stringify(result.jobs, null, 2)}\n`);
  }
  return { file: fileName, ...result, jobs: undefined };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const reports = ['job_leads.json', 'jobs_shortlist.json'].map(repairFile);
  for (const report of reports) {
    if (report.skipped) {
      console.log(`${report.file}: skipped (${report.reason || 'missing'})`);
      continue;
    }
    console.log(`${report.file}: ${report.total} records, ${report.marked} newly marked invalid_non_job, ${report.already_marked} already marked${DRY_RUN ? ' (dry run — nothing written)' : ''}`);
    for (const item of report.details.slice(0, 20)) {
      console.log(`  - ${item.job_id || '(no id)'} "${item.title}" → ${item.reasons.join(', ')}`);
    }
    if (report.details.length > 20) console.log(`  … and ${report.details.length - 20} more`);
  }
}
