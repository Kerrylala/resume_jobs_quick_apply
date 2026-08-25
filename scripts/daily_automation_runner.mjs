import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { projectRootFromMetaUrl } from './lib/project_paths.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const logsDir = path.join(root, 'logs', 'daily_automation');
const reportsDir = path.join(root, 'reports');
const dataDir = path.join(root, 'data');

function pad(value) {
  return String(value).padStart(2, '0');
}
function todayStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function timestamp(date = new Date()) {
  return date.toISOString();
}
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function appendLog(line) {
  fs.appendFileSync(logFile, `${line}\n`, 'utf8');
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function tail(value, max = 2500) {
  const text = String(value || '').trim();
  return text.length <= max ? text : text.slice(-max);
}
function runStep(name, command, args, options = {}) {
  const startedAt = timestamp();
  appendLog(`[${startedAt}] START ${name}: ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs || 20 * 60 * 1000,
    env: { ...process.env, ...options.env }
  });
  const finishedAt = timestamp();
  const record = {
    name,
    command: [command, ...args].join(' '),
    started_at: startedAt,
    finished_at: finishedAt,
    exit_code: typeof result.status === 'number' ? result.status : 1,
    status: result.status === 0 ? 'ok' : 'failed',
    stdout_tail: tail(result.stdout),
    stderr_tail: tail(result.stderr)
  };
  appendLog(`[${finishedAt}] END ${name}: exit=${record.exit_code}`);
  if (record.stdout_tail) appendLog(`[${finishedAt}] STDOUT ${name}: ${record.stdout_tail}`);
  if (record.stderr_tail) appendLog(`[${finishedAt}] STDERR ${name}: ${record.stderr_tail}`);
  return record;
}
function safeParseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); }
      catch {
        // The caller treats null as an unreadable bounded command result.
      }
    }
  }
  return null;
}
function inspectSearxng() {
  const config = readJson(path.join(dataDir, 'job_sources.json'), {});
  const url = config?.search_backends?.searxng_search?.url || process.env.SEARXNG_URL || 'http://127.0.0.1:8888/search';
  const result = runStep('check_searxng', 'node', ['-e', `
    const baseUrl = ${JSON.stringify(url)};
    const target = new URL(baseUrl);
    if (!target.searchParams.has('q')) target.searchParams.set('q', 'resume_jobs_ping');
    if (!target.searchParams.has('format')) target.searchParams.set('format', 'json');
    fetch(target.href, { method: 'GET' })
      .then(async (res) => {
        const text = await res.text();
        const payload = { ok: res.ok, status: res.status, url: target.href, text_tail: text.slice(0, 300) };
        console.log(JSON.stringify(payload, null, 2));
        process.exit(res.ok ? 0 : 1);
      })
      .catch((error) => {
        console.log(JSON.stringify({ ok: false, url: target.href, error: error.message }, null, 2));
        process.exit(1);
      });
  `], { timeoutMs: 30 * 1000 });
  const parsed = safeParseJson(result.stdout_tail) || safeParseJson(result.stderr_tail) || {};
  return {
    ...result,
    url,
    service_ok: parsed.ok === true,
    service_status: parsed.status ?? null,
    text_tail: parsed.text_tail || '',
    error: parsed.error || ''
  };
}
function summarizeDaily(state) {
  const lastStatus = state.steps.find((step) => step.name === 'status_after') || null;
  const before = state.summary_before || {};
  const after = state.summary_after || {};
  return {
    pwd_used: root,
    date: state.date,
    status: state.status,
    step_count: state.steps.length,
    blocked_step: state.blocked_step || null,
    blocked_reason: state.blocked_reason || null,
    searxng: {
      ok: Boolean(state.searxng && state.searxng.service_ok),
      url: state.searxng?.url || ''
    },
    counts_before: {
      job_leads: before.job_leads_count ?? null,
      jobs_shortlist: before.jobs_shortlist_count ?? null,
      pending: before.pending_count ?? null,
      approved: before.approved_count ?? null,
      rejected: before.rejected_count ?? null,
      manual_review: before.manual_review_count ?? null
    },
    counts_after: {
      job_leads: after.job_leads_count ?? null,
      jobs_shortlist: after.jobs_shortlist_count ?? null,
      pending: after.pending_count ?? null,
      approved: after.approved_count ?? null,
      rejected: after.rejected_count ?? null,
      manual_review: after.manual_review_count ?? null
    },
    deltas: {
      new_job_leads: (after.job_leads_count ?? 0) - (before.job_leads_count ?? 0),
      new_shortlist: (after.jobs_shortlist_count ?? 0) - (before.jobs_shortlist_count ?? 0),
      pending_change: (after.pending_count ?? 0) - (before.pending_count ?? 0)
    },
    latest_report_paths: state.latest_report_paths || [],
    safety: {
      browser_opened: false,
      chrome_opened: false,
      application_form_opened: false,
      apply_submit_clicked: false,
      resume_uploaded: false,
      login_attempted: false,
      captcha_otp_handled: false,
      automatic_approve: false,
      scrapling_used: false,
      final_submit_allowed: false
    }
  };
}
function writeDailyReport(state) {
  const jsonPath = path.join(reportsDir, `daily_automation_${state.date}.json`);
  const mdPath = path.join(reportsDir, `daily_automation_${state.date}.md`);
  const json = summarizeDaily(state);
  writeJson(jsonPath, json);

  const lines = [
    `# Daily Automation Report ${state.date}`,
    '',
    `- pwd used: \`${root}\``,
    `- status: ${json.status}`,
    `- blocked step: ${json.blocked_step || 'none'}`,
    `- blocked reason: ${json.blocked_reason || 'none'}`,
    `- SearXNG ok: ${json.searxng.ok ? 'yes' : 'no'}`,
    `- SearXNG url: ${json.searxng.url || 'n/a'}`,
    '',
    '## Counts before',
    `- job leads: ${json.counts_before.job_leads ?? 'n/a'}`,
    `- shortlist: ${json.counts_before.jobs_shortlist ?? 'n/a'}`,
    `- pending: ${json.counts_before.pending ?? 'n/a'}`,
    `- approved: ${json.counts_before.approved ?? 'n/a'}`,
    `- rejected: ${json.counts_before.rejected ?? 'n/a'}`,
    `- manual review: ${json.counts_before.manual_review ?? 'n/a'}`,
    '',
    '## Counts after',
    `- job leads: ${json.counts_after.job_leads ?? 'n/a'}`,
    `- shortlist: ${json.counts_after.jobs_shortlist ?? 'n/a'}`,
    `- pending: ${json.counts_after.pending ?? 'n/a'}`,
    `- approved: ${json.counts_after.approved ?? 'n/a'}`,
    `- rejected: ${json.counts_after.rejected ?? 'n/a'}`,
    `- manual review: ${json.counts_after.manual_review ?? 'n/a'}`,
    '',
    '## Deltas',
    `- new job leads: ${json.deltas.new_job_leads}`,
    `- new shortlist: ${json.deltas.new_shortlist}`,
    `- pending change: ${json.deltas.pending_change}`,
    '',
    '## Steps',
    ...state.steps.map((step) => [
      `### ${step.name}`,
      `- started_at: ${step.started_at}`,
      `- finished_at: ${step.finished_at}`,
      `- exit_code: ${step.exit_code}`,
      step.stdout_tail ? `- stdout_tail: ${step.stdout_tail}` : '- stdout_tail: none',
      step.stderr_tail ? `- stderr_tail: ${step.stderr_tail}` : '- stderr_tail: none',
      ''
    ]).flat(),
    '## Safety',
    '- browser_opened: false',
    '- chrome_opened: false',
    '- application_form_opened: false',
    '- apply_submit_clicked: false',
    '- resume_uploaded: false',
    '- login_attempted: false',
    '- captcha_otp_handled: false',
    '- automatic_approve: false',
    '- scrapling_used: false',
    '- final_submit_allowed: false',
    '',
    '## Next step',
    state.blocked_step ? 'Resolve the blocker, then rerun the runner.' : 'Review the Dashboard and manually inspect new/changed jobs.'
  ];
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, mdPath };
}

const date = todayStamp();
ensureDir(logsDir);
ensureDir(reportsDir);
const logFile = path.join(logsDir, `${date}.log`);
const state = {
  date,
  started_at: timestamp(),
  status: 'running',
  steps: [],
  blocked_step: null,
  blocked_reason: null,
  latest_report_paths: []
};

appendLog(`=== daily automation runner start ${state.started_at} ===`);

const beforeStatus = runStep('status_before', 'node', ['scripts/resume_jobs_cli.mjs', 'status']);
state.steps.push(beforeStatus);
state.summary_before = safeParseJson(beforeStatus.stdout_tail) || {};

const validate = runStep('validate', 'node', ['scripts/resume_jobs_cli.mjs', 'validate']);
state.steps.push(validate);
if (validate.exit_code !== 0) {
  state.status = 'blocked';
  state.blocked_step = validate.name;
  state.blocked_reason = 'resume_jobs_cli validate failed';
} else {
  state.searxng = inspectSearxng();
  state.steps.push(state.searxng);
  if (!state.searxng.service_ok) {
    state.status = 'blocked';
    state.blocked_step = state.searxng.name;
    state.blocked_reason = `SearXNG unavailable at ${state.searxng.url}`;
  }
}

if (state.status === 'running') {
  const daily = runStep('daily', 'node', ['scripts/resume_jobs_cli.mjs', 'daily'], { timeoutMs: 60 * 60 * 1000 });
  state.steps.push(daily);
  if (daily.exit_code !== 0) {
    state.status = 'blocked';
    state.blocked_step = daily.name;
    state.blocked_reason = 'resume_jobs_cli daily failed';
  }
}

if (state.status === 'running') {
  const expand = runStep('expand_details', 'node', ['scripts/resume_jobs_cli.mjs', 'expand-details']);
  state.steps.push(expand);
  if (expand.exit_code !== 0) {
    state.status = 'blocked';
    state.blocked_step = expand.name;
    state.blocked_reason = 'expand-details failed';
  }
}

if (state.status === 'running') {
  const enrich = runStep('enrich_details', 'node', ['scripts/resume_jobs_cli.mjs', 'enrich-details']);
  state.steps.push(enrich);
  if (enrich.exit_code !== 0) {
    state.status = 'blocked';
    state.blocked_step = enrich.name;
    state.blocked_reason = 'enrich-details failed';
  }
}

const afterStatus = runStep('status_after', 'node', ['scripts/resume_jobs_cli.mjs', 'status']);
state.steps.push(afterStatus);
state.summary_after = safeParseJson(afterStatus.stdout_tail) || {};

state.latest_report_paths = fs.readdirSync(reportsDir)
  .filter((name) => /^daily_automation_\d{4}-\d{2}-\d{2}\.(json|md)$/.test(name))
  .sort()
  .slice(-4)
  .map((name) => path.join('reports', name));

if (state.status === 'running') state.status = 'completed';
state.finished_at = timestamp();

const outputs = writeDailyReport(state);
writeJson(path.join(reportsDir, `daily_automation_${date}.json`), summarizeDaily(state));

appendLog(`=== daily automation runner finished ${state.finished_at} status=${state.status} ===`);
console.log(JSON.stringify({
  pwd_used: root,
  status: state.status,
  blocked_step: state.blocked_step,
  blocked_reason: state.blocked_reason,
  report_json: outputs.jsonPath,
  report_md: outputs.mdPath,
  log_file: logFile,
  steps: state.steps.map((step) => ({
    name: step.name,
    started_at: step.started_at,
    finished_at: step.finished_at,
    exit_code: step.exit_code
  })),
  safety: {
    browser_opened: false,
    chrome_opened: false,
    application_form_opened: false,
    apply_submit_clicked: false,
    resume_uploaded: false,
    login_attempted: false,
    captcha_otp_handled: false,
    automatic_approve: false,
    scrapling_used: false,
    final_submit_allowed: false
  }
}, null, 2));

process.exit(state.status === 'completed' ? 0 : 1);
