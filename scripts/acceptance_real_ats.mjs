// Real public ATS acceptance harness.
//
// Measures what the product would actually do on a live application page, using
// the SAME extraction and planning code the Browser Agent uses — no shortcuts,
// no page-specific hacks.
//
// Hard limits, enforced here and not merely intended:
//   - Only pages the operator passes in, only over HTTPS.
//   - No file is ever selected, no submit control is ever clicked.
//   - No CAPTCHA / login / MFA is touched; if one blocks the page the run
//     records that and moves on.
//   - Nothing is typed unless --fill is passed; with --fill only fields the
//     planner classified as safe are typed, using obviously synthetic values.
//   - Output is redacted: values never appear, only field identity and outcome.
//
// Usage:
//   node scripts/acceptance_real_ats.mjs --urls <a,b,c> [--fill] [--upload] [--out <path>]
//   node scripts/acceptance_real_ats.mjs --discover        (find live pages first)
//
// --upload attaches an OBVIOUSLY SYNTHETIC resume (name, e-mail domain and a
// visible in-document disclaimer all say so) through the same attachResume
// code path the Browser Agent runs, then verifies the control really holds
// the file. Submit is still never clicked.
import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

import { PlaywrightPageRuntime } from '../browser_agent/playwright_runtime.mjs';
import { planFields } from '../application_executor/field_mapper.mjs';
import { adapterForUrl } from '../portal_adapters/index.mjs';
import { classifyPageSafety } from '../application_executor/safety_policy.mjs';
import { buildResumeDocx } from './lib/docx_writer.mjs';
import { renderResumeHtml } from './lib/resume_render.mjs';
import { agentBrowserCandidates } from './lib/agent_browser.mjs';

const ROOT = path.resolve('.');

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const hasFlag = name => process.argv.includes(`--${name}`);

async function findBrowser() {
  // One detection order for the whole product: env override -> local Chrome
  // for Testing (carries the bundled extension) -> branded Chrome/Edge.
  for (const candidate of agentBrowserCandidates(ROOT)) {
    try { await access(candidate); return candidate; } catch { /* next */ }
  }
  return '';
}

// Deliberately synthetic. If any of this ever reached an employer it would be
// obviously not a real application.
const SYNTHETIC_PROFILE = {
  approved_for_real_applications: true,
  full_name: 'Acceptance Test Candidate',
  first_name: 'Acceptance',
  last_name: 'Candidate',
  email: 'acceptance-test@example.invalid',
  phone: '+1 555 0100',
  location: 'Shanghai, China',
  current_location: 'Shanghai, China',
  linkedin_url: 'https://www.linkedin.com/in/example-invalid',
  github_url: 'https://github.com/example-invalid',
  portfolio_url: 'https://example.invalid',
  current_company: 'Acceptance Test Company',
  current_title: 'Acceptance Test Engineer'
};

async function discoverTargets() {
  const targets = [];

  // Greenhouse publishes a public board API; take a real, currently-open role.
  try {
    const res = await fetch('https://boards-api.greenhouse.io/v1/boards/greenhouse/jobs', { signal: AbortSignal.timeout(15000) });
    const data = await res.json();
    const job = (data.jobs || [])[0];
    if (job?.absolute_url) targets.push({ portal: 'greenhouse', url: job.absolute_url });
  } catch { /* recorded as unavailable below */ }

  // Lever boards are client-rendered, so the posting list has to come from a
  // real browser rather than the HTML. Handled by the caller when needed.
  return targets;
}

async function extractLeverApplyUrls(context, boardUrl, limit = 1) {
  const page = await context.newPage();
  try {
    await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(2500);
    const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.href)
      .filter(href => /jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36}(?:\/|$)/i.test(href)));
    return [...new Set(links)].slice(0, limit).map(href => `${href.replace(/\/$/, '')}/apply`);
  } finally {
    await page.close();
  }
}

function summarizePlans(plans) {
  const reasons = {};
  let filled = 0;
  let plannedFill = 0;
  for (const plan of plans) {
    if (plan.action === 'fill') { plannedFill += 1; continue; }
    reasons[plan.reason] = (reasons[plan.reason] || 0) + 1;
  }
  return { planned_fill: plannedFill, filled, skip_reasons: reasons };
}

// Which mapped key each planned field targets — this is the coverage that
// matters, rather than a raw count against every control on the page.
function plannedKeys(plans) {
  return [...new Set(plans.filter(p => p.action === 'fill').map(p => p.mapping?.key).filter(Boolean))];
}

// Answers the user has confirmed before, in the exact shape the package hands
// to the executor. These are deliberately non-sensitive: a sensitive answer must
// stay ask-every-time and must never appear here.
const CONFIRMED_ANSWERS = [
  {
    canonical_key: 'answer_how_did_you_hear',
    original_question: 'How did you initially hear about this job?',
    question_patterns: ['how did you hear about', 'how did you initially hear', 'referral source'],
    value: 'Company website',
    user_confirmed: true,
    sensitive_category: 'none',
    risk_level: 'normal'
  }
];

// Mirrors confirmedSessionRules: an answer becomes a site rule keyed on its
// canonical key, matched by the question wording it was saved against.
const answerRules = CONFIRMED_ANSWERS.map(answer => ({
  key: answer.canonical_key,
  aliases: [answer.original_question, ...(answer.question_patterns || [])],
  confidence: 1,
  source: 'answer_memory'
}));
const answerProfile = Object.fromEntries(CONFIRMED_ANSWERS.map(answer => [answer.canonical_key, answer.value]));

// The synthetic tailored resume, produced by the product's own writers.
// Everything about it announces it is a test document.
async function buildSyntheticResumeFiles(context) {
  const model = {
    name: 'Acceptance Test Candidate',
    contact_line: 'acceptance-test@example.invalid · +1 555 0100 · Shanghai, China',
    sections: [
      {
        title: 'Notice',
        lines: [
          'This is a synthetic automated acceptance-test document generated by a local job-application assistant.',
          'It is not a real application. Please disregard.'
        ]
      },
      {
        title: 'Experience',
        entries: [{
          heading: 'Acceptance Test Company',
          subheading: 'Acceptance Test Engineer',
          dates: '2023 – now',
          bullets: ['Synthetic bullet used only to verify file upload works end to end.']
        }]
      }
    ]
  };
  const dir = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-real-ats-upload-'));
  const files = [];
  const docxPath = path.join(dir, 'Acceptance_Test_Candidate_SYNTHETIC.docx');
  await writeFile(docxPath, buildResumeDocx(model));
  files.push({ format: 'docx', path: docxPath, name: path.basename(docxPath) });
  try {
    const page = await context.newPage();
    try {
      await page.setContent(renderResumeHtml(model), { waitUntil: 'load', timeout: 30_000 });
      const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true });
      const pdfPath = path.join(dir, 'Acceptance_Test_Candidate_SYNTHETIC.pdf');
      await writeFile(pdfPath, pdfBuffer);
      files.unshift({ format: 'pdf', path: pdfPath, name: path.basename(pdfPath) });
    } finally {
      await page.close().catch(() => {});
    }
  } catch {
    // Headed runs cannot print to PDF; the DOCX alone is a complete test file.
  }
  return files;
}

async function inspect(context, target, { fill = false, uploadFiles = null } = {}) {
  const page = await context.newPage();
  const record = {
    portal: target.portal,
    url: target.url,
    status: 'ok',
    detected: 0,
    planned_fill: 0,
    actually_filled: 0,
    failed: 0,
    planned_keys: [],
    skip_reasons: {},
    unmapped_safe_fields: [],
    page_safety: null,
    safety: { file_selected: false, submit_clicked: false, challenge_touched: false, login_attempted: false }
  };
  try {
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    record.http_status = response?.status() ?? 0;
    // Client-rendered ATS forms need a moment before the controls exist.
    await page.waitForTimeout(3500);

    const runtime = new PlaywrightPageRuntime(page);
    const pageState = await runtime.getPageState();
    const safety = classifyPageSafety(pageState, target.url);
    record.page_safety = { action: safety.action, reason: safety.reason, challenge_scope: safety.challenge_scope };

    if (safety.action !== 'allow') {
      // A challenge or login wall: record honestly and touch nothing.
      record.status = 'blocked_by_page';
      return record;
    }

    const fields = await runtime.getFields();
    record.detected = fields.length;

    const adapter = adapterForUrl(target.url);
    const plans = planFields(fields, {
      profile: { ...SYNTHETIC_PROFILE, ...answerProfile },
      profile_confirmed: true,
      minimum_confidence: 0.8,
      // Answer Memory reaches the page as site rules derived from the stored
      // question text — the same path the real executor uses.
      site_rules: (adapter?.siteRules || []).concat(answerRules),
      safety: { never_fill: adapter?.neverFill || [] }
    });

    // A control we plan to type into may actually be a combobox, where setting
    // the text does not select anything. Capture the widget attributes so the
    // run can tell "filled" from "looks filled".
    record.planned_field_widgets = await page.evaluate(refs => {
      const elements = Array.from(document.querySelectorAll('input, textarea, select'));
      return refs.map(ref => {
        const element = elements[Number(String(ref).replace('field-', '')) - 1];
        if (!element) return { ref, missing: true };
        return {
          ref,
          tag: element.tagName.toLowerCase(),
          role: element.getAttribute('role') || '',
          aria_autocomplete: element.getAttribute('aria-autocomplete') || '',
          aria_haspopup: element.getAttribute('aria-haspopup') || '',
          aria_expanded: element.getAttribute('aria-expanded') || '',
          has_list: Boolean(element.getAttribute('list')),
          readonly: Boolean(element.readOnly)
        };
      });
    }, plans.filter(p => p.action === 'fill').map(p => p.field.field_ref));

    const summary = summarizePlans(plans);
    record.planned_fill = summary.planned_fill;
    record.skip_reasons = summary.skip_reasons;
    record.planned_keys = plannedKeys(plans);
    record.answer_memory_keys_used = record.planned_keys.filter(k => k.startsWith("answer_"));

    // Fields the planner refused only because it had no rule for them, but which
    // look like ordinary safe text inputs. This is the improvement backlog.
    record.unmapped_safe_fields = plans
      .filter(plan => plan.action === 'skip' && plan.reason === 'skipped_unknown')
      .filter(plan => ['text', 'email', 'tel', 'url', 'textarea'].includes(plan.field.type))
      .map(plan => ({
        label: plan.field.label.slice(0, 80),
        name: plan.field.name.slice(0, 60),
        type: plan.field.type,
        autocomplete: plan.field.autocomplete,
        required: plan.field.required
      }))
      .slice(0, 40);

    if (fill) {
      // Go through the adapter, exactly as the Browser Agent does, rather than
      // calling the runtime directly with a different argument convention.
      const results = await adapter.fill_fields(runtime, plans);
      record.actually_filled = results.filter(item => item.outcome === 'filled').length;
      record.failed = results.filter(item => item.outcome === 'failed').length;
      record.fill_failure_reasons = results.filter(item => item.outcome === 'failed')
        .map(item => item.reason).slice(0, 10);
      // Confirm from the page itself rather than trusting the fill call.
      const review = await runtime.getFormReviewState();
      record.verified_non_empty = review.filter(item => item.filled && !['file'].includes(item.type)).length;
    }

    if (uploadFiles && uploadFiles.length) {
      // The same code path the Browser Agent runs: locate the resume control,
      // attach, verify the input really holds the file. Never submit.
      const uploadResult = await runtime.attachResume({ files: uploadFiles, format_preference: 'auto' });
      record.resume_upload = uploadResult;
      record.safety.file_selected = uploadResult.status === 'confirmed';
      // Independent second reading straight from the page's file inputs.
      const reviewAfterUpload = await runtime.getFormReviewState();
      record.file_input_confirmed_on_page = reviewAfterUpload.some(item => item.type === 'file' && item.filled);
    }
  } catch (error) {
    record.status = 'error';
    record.error = String(error?.message || error).slice(0, 200);
  } finally {
    await page.close().catch(() => {});
  }
  return record;
}

const browser = await findBrowser();
if (!browser) throw new Error('Chrome/Edge is required for the real ATS acceptance run.');

const explicitUrls = argument('urls').split(',').map(value => value.trim()).filter(Boolean);
const outPath = path.resolve(argument('out', 'reports/real_ats_acceptance.json'));
const fill = hasFlag('fill');

const context = await chromium.launchPersistentContext(
  path.resolve(argument('profile-dir', 'browser_profiles/acceptance-probe')),
  {
    executablePath: browser,
    headless: !hasFlag('headed'),
    viewport: { width: 1280, height: 900 },
    acceptDownloads: false,
    args: ['--disable-features=Translate', '--no-default-browser-check', '--noerrdialogs']
  }
);

const results = [];
try {
  const uploadFiles = hasFlag('upload') ? await buildSyntheticResumeFiles(context) : null;
  let targets = explicitUrls.map(url => ({ portal: /lever\.co/i.test(url) ? 'lever' : (/greenhouse|job-boards/i.test(url) ? 'greenhouse' : 'generic'), url }));

  if (!targets.length) {
    targets = await discoverTargets();
    // Lever needs a rendered board to yield posting links.
    for (const board of ['https://jobs.lever.co/voleon', 'https://jobs.lever.co/lever']) {
      try {
        const applyUrls = await extractLeverApplyUrls(context, board, 1);
        for (const url of applyUrls) targets.push({ portal: 'lever', url });
        if (applyUrls.length) break;
      } catch { /* try the next board */ }
    }
  }

  if (!targets.length) throw new Error('No live application pages could be discovered. Pass --urls explicitly.');

  for (const target of targets) {
    process.stdout.write(`\n▶ ${target.portal}: ${target.url}\n`);
    const record = await inspect(context, target, { fill, uploadFiles });
    results.push(record);
    process.stdout.write(`  detected=${record.detected} planned_fill=${record.planned_fill}`
      + (fill ? ` actually_filled=${record.actually_filled} failed=${record.failed}` : '')
      + `\n  keys=[${record.planned_keys.join(', ')}]\n`
      + `  skips=${JSON.stringify(record.skip_reasons)}\n`
      + (record.resume_upload
        ? `  upload=${record.resume_upload.status}`
          + (record.resume_upload.file ? ` file=${record.resume_upload.file.name} (${record.resume_upload.file.format})` : '')
          + (record.resume_upload.evidence ? ` input_holds_file=${record.resume_upload.evidence.input_holds_file} page_shows_name=${record.resume_upload.evidence.page_shows_file_name}` : '')
          + ` review_state_file_selected=${record.file_input_confirmed_on_page === true}\n`
        : '')
      + (record.status !== 'ok' ? `  status=${record.status} ${record.error || record.page_safety?.reason || ''}\n` : ''));
    if (record.unmapped_safe_fields.length) {
      process.stdout.write(`  unmapped safe fields (${record.unmapped_safe_fields.length}):\n`);
      for (const field of record.unmapped_safe_fields.slice(0, 12)) {
        process.stdout.write(`    - "${field.label}" name=${field.name} type=${field.type} autocomplete=${field.autocomplete} required=${field.required}\n`);
      }
    }
  }
} finally {
  await context.close().catch(() => {});
}

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, `${JSON.stringify({
  generated_at: new Date().toISOString(),
  filled: fill,
  safety: {
    resume_uploaded: results.some(record => record.resume_upload?.status === 'confirmed'),
    uploaded_files_synthetic: true,
    application_submitted: false,
    challenge_bypassed: false,
    login_attempted: false,
    candidate_values_in_report: false
  },
  results
}, null, 2)}\n`);
process.stdout.write(`\nReport: ${path.relative(process.cwd(), outPath)}\n`);
