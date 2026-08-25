import fs from 'fs';
import path from 'path';
import { classifyJobSafety } from './score_jobs.mjs';
import { evaluateApprovalEligibility, normalizeApprovalSafety } from './lib/approval_safety.mjs';
import { projectRootFromMetaUrl } from './lib/project_paths.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const defaultDataDir = path.resolve(process.env.RESUME_JOBS_DATA_DIR || path.join(root, 'data'));
const defaultReportsDir = path.resolve(process.env.RESUME_JOBS_REPORTS_DIR || path.join(root, 'reports'));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'unknown';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}
export function approvalQueueDecision(job) {
  const safety = job.recommended_decision && job.page_type && job.approval_safety
    ? job
    : classifyJobSafety(job);
  const { safe_to_approve: safeToApprove } = evaluateApprovalEligibility(safety);
  if (safety.recommended_decision === 'reject') return 'reject_candidate';
  if (safety.page_type !== 'job_detail') return 'manual_review_only_not_confirmed_job_detail';
  if ((job.match_score || 0) >= 85 && safety.recommended_decision === 'approve' && safeToApprove) return 'approve_for_manual_application_prep';
  if ((job.match_score || 0) >= 65) return 'manual_review';
  return 'reject_or_keep_discovered';
}

export function buildApprovalQueue({ dataDir = defaultDataDir, reportsDir = defaultReportsDir } = {}) {
  const rawJobs = readJson(path.join(dataDir, 'jobs_shortlist.json'), []);
  const jobs = (Array.isArray(rawJobs) ? rawJobs : []).map((job) => {
    const safety = classifyJobSafety(job);
    return {
      ...job,
      ...safety,
      approval_safety: normalizeApprovalSafety(safety.approval_safety)
    };
  });
  const lines = [
    '# Approval Queue',
    '',
    'Safety: public metadata only. No login, no CAPTCHA/OTP handling, no apply click, no submit/upload.',
    'Approval guardrail: only page_type=job_detail can be approved for manual application prep. Search/aggregator/careers-board pages must stay manual_review or reject.',
    ''
  ];

  for (const [i, job] of jobs.slice(0, 50).entries()) {
    lines.push(`## ${i + 1}. ${job.title || 'Untitled'} — ${job.company || 'Unknown company'}`);
    lines.push(`- Recommendation: ${approvalQueueDecision(job)}`);
    lines.push(`- Recommended Decision: ${job.recommended_decision || 'manual_review'}`);
    lines.push(`- Approval Safety: ${job.approval_safety.status}`);
    lines.push(`- Page Type: ${job.page_type || 'unknown'}`);
    lines.push(`- Safety Warning: ${job.approval_warning || 'none'}`);
    lines.push(`- Score: ${job.match_score || 0}`);
    lines.push(`- Provider: ${job.provider || 'unknown'} / ATS: ${job.ats || ''}`);
    lines.push(`- Location: ${job.location || job.country_or_region || ''}`);
    lines.push(`- URL: ${job.url || job.job_url || ''}`);
    lines.push(`- Reasons: ${(job.match_reasons || []).join(', ') || 'none'}`);
    lines.push('');
  }

  fs.mkdirSync(reportsDir, { recursive: true });
  const reportFile = path.join(reportsDir, 'approval_queue_latest.md');
  fs.writeFileSync(reportFile, `${lines.join('\n')}\n`);
  return {
    approval_queue_count: jobs.length,
    path: path.relative(root, reportFile).replaceAll('\\', '/'),
    source_of_truth: 'data/jobs_shortlist.json plus data/job_reviews.json overlays',
    product_queue_file_created: false,
    page_type_breakdown: countBy(jobs, 'page_type'),
    recommended_decision_breakdown: countBy(jobs, 'recommended_decision'),
    approve_candidates: jobs.filter((job) => approvalQueueDecision(job) === 'approve_for_manual_application_prep').slice(0, 5),
    manual_review_candidates: jobs.filter((job) => approvalQueueDecision(job).includes('manual_review')).slice(0, 5),
    reject_candidates: jobs.filter((job) => approvalQueueDecision(job).includes('reject')).slice(0, 5)
  };
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(buildApprovalQueue(), null, 2));
