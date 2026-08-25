import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { projectRootFromMetaUrl } from './lib/project_paths.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const dataDir = path.join(root, 'data');
const reportsDir = path.join(root, 'reports');

const COMMANDS = [
  'status',
  'validate',
  'daily',
  'discovery',
  'discovery-fixture',
  'score',
  'approval-queue',
  'expand-details',
  'enrich-details',
  'model-health',
  'dashboard',
  'debug-last',
  'build-package'
];

function rel(file) { return path.relative(root, file) || '.'; }
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function exists(file) { return fs.existsSync(path.join(root, file)); }
function countBy(items, field) {
  return items.reduce((acc, item) => {
    const key = item?.[field] || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}
function latestFiles(dir, predicate = () => true, limit = 8) {
  try {
    return fs.readdirSync(dir)
      .map((name) => path.join(dir, name))
      .filter((file) => fs.statSync(file).isFile() && predicate(file))
      .map((file) => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, limit)
      .map((entry) => rel(entry.file));
  } catch { return []; }
}
function runNode(args, { label = args.join(' '), allowFailure = false } = {}) {
  const result = spawnSync('node', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const summary = {
    label,
    command: `node ${args.join(' ')}`,
    status: result.status === 0 ? 'ok' : 'failed',
    exit_code: result.status,
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr)
  };
  if (!allowFailure && result.status !== 0) {
    const error = new Error(`${summary.command} failed`);
    error.summary = summary;
    throw error;
  }
  return summary;
}
function tail(value, max = 3000) {
  const text = String(value || '').trim();
  return text.length <= max ? text : text.slice(-max);
}
function parseArgs(argv = process.argv.slice(2)) {
  const [command = 'help', ...rest] = argv;
  const args = { command, rest, jobId: '' };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--job-id') args.jobId = rest[++i] || '';
    else if (rest[i].startsWith('--job-id=')) args.jobId = rest[i].slice('--job-id='.length);
  }
  return args;
}
function safety() {
  return {
    browser_opened: false,
    chrome_opened: false,
    application_form_opened: false,
    apply_submit_clicked: false,
    resume_uploaded: false,
    login_attempted: false,
    captcha_otp_handled: false,
    scrapling_used: false,
    automatic_approve: false,
    final_submit_allowed: false
  };
}
function summarizeStatus() {
  const leads = readJson(path.join(dataDir, 'job_leads.json'), []);
  const shortlist = readJson(path.join(dataDir, 'jobs_shortlist.json'), []);
  const reviews = readJson(path.join(dataDir, 'job_reviews.json'), []);
  const dashboardState = readJson(path.join(dataDir, 'dashboard_state.json'), {});
  const providerHealth = readJson(path.join(dataDir, 'provider_health.json'), {});
  const reviewCounts = countBy(reviews, 'decision');
  const shortlistDecisionCounts = countBy(shortlist, 'recommended_decision');
  const detailLeads = leads.filter((job) => job?.page_type === 'job_detail');
  return {
    pwd_used: root,
    status: 'ok',
    counts: {
      job_leads: leads.length,
      jobs_shortlist: shortlist.length,
      job_reviews: reviews.length,
      detail_leads: detailLeads.length,
      pending_reviews: shortlist.length - (reviewCounts.approved || 0) - (reviewCounts.rejected || 0) - (reviewCounts.manual_review || 0),
      approved_reviews: reviewCounts.approved || 0,
      rejected_reviews: reviewCounts.rejected || 0,
      manual_review_reviews: reviewCounts.manual_review || 0
    },
    shortlist_recommended_decision_breakdown: shortlistDecisionCounts,
    provider_health_keys: Object.keys(providerHealth).sort(),
    running_job: dashboardState.running_job || dashboardState.last_run?.status === 'running' ? dashboardState.last_run : null,
    latest_reports: latestFiles(reportsDir, (file) => /\.(json|md)$/i.test(file), 10),
    safety: safety(),
    next_step: 'Open Dashboard or run validate before daily/score/package work.'
  };
}
function validate() {
  const jsonFiles = [
    'data/job_leads.json',
    'data/jobs_shortlist.json',
    'data/job_reviews.json',
    'data/dashboard_state.json',
    'data/provider_health.json'
  ];
  const jsFiles = [
    'scripts/discover_jobs.mjs',
    'scripts/score_jobs.mjs',
    'scripts/build_approval_queue.mjs',
    'scripts/expand_job_detail_urls.mjs',
    'scripts/enrich_job_details.mjs',
    'scripts/build_application_package_preview.mjs',
    'scripts/resume_jobs_cli.mjs',
    'dashboard/server.mjs'
  ];
  const jsonResults = jsonFiles.map((file) => {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) {
      return { file, status: 'not_created_yet' };
    }
    JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { file, status: 'ok' };
  });
  const jsResults = jsFiles.filter(exists).map((file) => runNode(['--check', file], { label: `check ${file}` }));
  return {
    pwd_used: root,
    status: 'ok',
    json_results: jsonResults,
    js_results: jsResults.map(({ label, status }) => ({ label, status })),
    safety: safety(),
    next_step: 'If validation is ok, use status, dashboard, daily, or build-package.'
  };
}
function runSequence(steps) {
  const results = [];
  for (const step of steps) results.push(runNode(step.args, { label: step.label }));
  return {
    pwd_used: root,
    status: 'ok',
    steps: results,
    safety: safety(),
    next_step: 'Review Dashboard and approval queue before any package work.'
  };
}
function dashboard() {
  return {
    pwd_used: root,
    status: 'ok',
    command: 'node dashboard/server.mjs',
    url: 'http://127.0.0.1:8767',
    note: 'This command only prints the launch command; start it in a terminal when you want the Dashboard server to keep running.',
    suggested_next_action: 'Run `node dashboard/server.mjs`, then open http://127.0.0.1:8767 manually.',
    safety: safety()
  };
}
function debugLast() {
  const providerHealth = readJson(path.join(dataDir, 'provider_health.json'), {});
  const recentReports = latestFiles(reportsDir, (file) => /\.(json|md)$/i.test(file), 12);
  const reportSummaries = [];
  for (const report of recentReports.filter((file) => file.endsWith('.json')).slice(0, 5)) {
    try {
      const parsed = readJson(path.join(root, report), {});
      reportSummaries.push({
        report,
        generated_at: parsed.generated_at || parsed.created_at || parsed.run_at || '',
        status: parsed.status || parsed.ok || 'n/a',
        failed_count: parsed.failed_count ?? parsed.failures_count ?? parsed.errors_count ?? 0,
        error: parsed.error || parsed.reason || ''
      });
    } catch (error) {
      reportSummaries.push({ report, status: 'parse_failed', error: error.message });
    }
  }
  return {
    pwd_used: root,
    status: 'ok',
    recent_reports: recentReports,
    report_summaries: reportSummaries,
    provider_health_last_keys: Object.keys(providerHealth).sort(),
    provider_health_generated_at: providerHealth.generated_at || '',
    safety: safety(),
    next_step: reportSummaries.some((item) => Number(item.failed_count || 0) > 0 || item.status === 'parse_failed')
      ? 'Inspect the failed report and rerun validate before changing data.'
      : 'No obvious recent report failure; run status or dashboard next.'
  };
}
function buildPackage(jobId) {
  if (!jobId) {
    return {
      pwd_used: root,
      status: 'blocked',
      reason: 'missing_job_id',
      usage: 'node scripts/resume_jobs_cli.mjs build-package --job-id <id>',
      safety: safety()
    };
  }
  const result = runNode(['scripts/build_application_package_preview.mjs', '--job-id', jobId], { label: 'build package', allowFailure: true });
  let parsed = null;
  let outputParseWarning = '';
  try { parsed = JSON.parse(result.stdout_tail || result.stderr_tail || '{}'); }
  catch { outputParseWarning = 'The package builder returned an unreadable result.'; }
  return {
    pwd_used: root,
    status: result.status,
    command: result.command,
    output_parse_warning: outputParseWarning,
    result: parsed || result,
    safety: safety(),
    next_step: result.status === 'ok' ? 'Review package files manually; do not submit automatically.' : 'Resolve blocked reason, usually approval/profile safety gate.'
  };
}
function help() {
  return {
    pwd_used: root,
    status: 'ok',
    commands: COMMANDS,
    examples: [
      'node scripts/resume_jobs_cli.mjs status',
      'node scripts/resume_jobs_cli.mjs validate',
      'node scripts/resume_jobs_cli.mjs daily',
      'node scripts/resume_jobs_cli.mjs dashboard',
      'node scripts/resume_jobs_cli.mjs discovery-fixture',
      'node scripts/resume_jobs_cli.mjs model-health',
      'node scripts/resume_jobs_cli.mjs build-package --job-id <id>'
    ],
    safety: safety()
  };
}
function main() {
  const args = parseArgs();
  let output;
  if (args.command === 'status') output = summarizeStatus();
  else if (args.command === 'validate') output = validate();
  else if (args.command === 'daily') output = runSequence([
    { label: 'safe small discovery', args: ['scripts/discover_jobs.mjs', '--max-queries', '5', '--max-results-per-query', '5', '--timeout-ms', '12000'] },
    { label: 'score jobs', args: ['scripts/score_jobs.mjs'] },
    { label: 'build approval queue', args: ['scripts/build_approval_queue.mjs'] }
  ]);
  else if (args.command === 'discovery') output = runSequence([{ label: 'safe small discovery', args: ['scripts/discover_jobs.mjs', '--max-queries', '5', '--max-results-per-query', '5', '--timeout-ms', '12000'] }]);
  else if (args.command === 'discovery-fixture') output = runSequence([{ label: 'offline fixture discovery', args: ['scripts/discover_jobs.mjs', '--fixture', '--dry-run', '--max-queries', '1', '--max-results-per-query', '10'] }]);
  else if (args.command === 'score') output = runSequence([{ label: 'score jobs', args: ['scripts/score_jobs.mjs'] }]);
  else if (args.command === 'approval-queue') output = runSequence([{ label: 'build approval queue', args: ['scripts/build_approval_queue.mjs'] }]);
  else if (args.command === 'expand-details') output = runSequence([{ label: 'expand details', args: ['scripts/expand_job_detail_urls.mjs', '--max-parents', '10', '--max-links-per-parent', '20'] }]);
  else if (args.command === 'enrich-details') output = runSequence([{ label: 'enrich details', args: ['scripts/enrich_job_details.mjs', '--max-jobs', '20', '--delay-ms', '1500'] }]);
  else if (args.command === 'model-health') output = runSequence([{ label: 'local model health', args: ['scripts/check_local_model.mjs'] }]);
  else if (args.command === 'dashboard') output = dashboard();
  else if (args.command === 'debug-last') output = debugLast();
  else if (args.command === 'build-package') output = buildPackage(args.jobId);
  else output = help();
  console.log(JSON.stringify(output, null, 2));
  if (output.status === 'failed' || output.status === 'blocked') process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({
    pwd_used: root,
    status: 'failed',
    message: error.message,
    summary: error.summary || null,
    safety: safety()
  }, null, 2));
  process.exit(1);
}
