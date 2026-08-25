// Input classification and the job quality gate.
//
// The defect this file pins: a BOSS 直聘 list page imported through the
// single-URL path turned its "查看更多职位" navigation anchors into job
// records with no company, no description and a 0 score. Board pages are now
// refused before fetching, and no navigation title can ever pass the gate.
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyJobInput, isNavigationTitle, jobQualityGate } from '../scripts/lib/job_input_classifier.mjs';
import { ingestPublicJobUrl, JobUrlIngestionError } from '../scripts/lib/job_url_ingestion.mjs';
import { repairJobInventory } from '../scripts/fix_invalid_job_records.mjs';
import { normalizeJobRecord } from '../scripts/lib/job_records.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('inputs classify into the four kinds', () => {
  const cases = [
    // search queries
    ['销售', 'search_query'],
    ['AI Engineer', 'search_query'],
    ['Product Manager 上海', 'search_query'],
    // single job URLs
    ['https://jobs.lever.co/alloy/6f359313-0233-47c9-a030-ef57b3bc3a68/apply', 'single_job_url'],
    ['https://job-boards.greenhouse.io/greenhouse/jobs/8021661?gh_jid=8021661', 'single_job_url'],
    ['https://jobs.ashbyhq.com/linear/6d3f9c4e-1234-5678-9abc-def012345678', 'single_job_url'],
    ['https://www.linkedin.com/jobs/view/3948129471', 'single_job_url'],
    ['https://www.zhipin.com/job_detail/abcdef123.html', 'single_job_url'],
    ['https://careers.example.com/jobs/42', 'single_job_url'],
    // company careers URLs
    ['https://jobs.lever.co/alloy', 'company_careers_url'],
    ['https://boards.greenhouse.io/stripe', 'company_careers_url'],
    ['https://jobs.ashbyhq.com/linear', 'company_careers_url'],
    ['https://apply.workable.com/netguru', 'company_careers_url'],
    ['https://example.com/careers', 'company_careers_url'],
    ['https://example.com/careers/engineering', 'company_careers_url'],
    // job board pages — never single jobs
    ['https://www.linkedin.com/jobs/', 'job_board_url'],
    ['https://www.linkedin.com/jobs/search/?keywords=sales', 'job_board_url'],
    ['https://www.zhipin.com/web/geek/job?query=%E9%94%80%E5%94%AE', 'job_board_url'],
    ['https://www.zhipin.com/shanghai/', 'job_board_url'],
    ['https://www.lagou.com/', 'job_board_url'],
    ['https://www.liepin.com/zhaopin/?key=AI', 'job_board_url'],
  ];
  for (const [input, expected] of cases) {
    const result = classifyJobInput(input);
    assert.equal(result.kind, expected, `${input} → expected ${expected}, got ${result.kind} (${result.reason})`);
  }
});

test('JS/login-walled boards are flagged browser_required', () => {
  for (const input of [
    'https://www.linkedin.com/jobs/',
    'https://www.linkedin.com/jobs/view/3948129471',
    'https://www.zhipin.com/web/geek/job?query=sales',
    'https://www.zhipin.com/job_detail/abcdef123.html',
  ]) {
    assert.equal(classifyJobInput(input).browser_required, true, input);
  }
  assert.equal(classifyJobInput('https://jobs.lever.co/alloy/6f359313-0233-47c9-a030-ef57b3bc3a68').browser_required, false);
});

test('navigation titles never pass the gate', () => {
  for (const title of [
    '查看更多职位', '更多职位', '更多工作机会', '职位列表', '全部职位', '搜索职位',
    'Jobs', 'Careers', 'View all jobs', 'See more', 'Apply now', 'Load more jobs',
    'Open positions', '登录', '下一页',
  ]) {
    assert.equal(isNavigationTitle(title), true, `"${title}" must be recognized as navigation`);
    assert.equal(jobQualityGate({ title, company: 'X', description_text: 'y'.repeat(60), apply_url: 'https://example.com/jobs/1' }).ok,
      false, `"${title}" must fail the quality gate`);
  }
  // Real titles pass.
  for (const title of ['Senior Sales Manager', '销售经理（华东区）', 'AI Engineer', 'Data Scientist II']) {
    assert.equal(isNavigationTitle(title), false, title);
  }
});

test('the gate requires structure: title + (company or description) + non-board URL', () => {
  assert.equal(jobQualityGate({ title: 'Engineer', company: '', description_text: '', apply_url: 'https://x.com/jobs/1' }).ok, false);
  assert.equal(jobQualityGate({ title: 'Engineer', company: 'Acme', description_text: '', apply_url: 'https://x.com/jobs/1' }).ok, true);
  assert.equal(jobQualityGate({ title: 'Engineer', company: 'Acme', description_text: 'd', apply_url: 'https://www.linkedin.com/jobs/' }).ok, false, 'a board list URL is not a job URL');
});

test('a BOSS-style list page imports ZERO job records and says browser_required', async () => {
  // The shape that used to produce fake records: navigation anchors with
  // job-ish hrefs and "查看更多职位" text. The board URL is refused before any
  // fetch happens — no anchor on it can ever become a job again.
  await assert.rejects(
    ingestPublicJobUrl('https://www.zhipin.com/web/geek/job?query=sales', {
      confirmedPublicFetch: true, lookup: publicLookup,
      fetchImpl: async () => { throw new Error('fetch must never run for a board list page'); }
    }),
    error => error instanceof JobUrlIngestionError
      && error.code === 'BROWSER_REQUIRED'
      && error.classification?.kind === 'job_board_url'
  );
});

test('the LinkedIn jobs home page is a board, never a failed single-job fetch', async () => {
  await assert.rejects(
    ingestPublicJobUrl('https://www.linkedin.com/jobs/', {
      confirmedPublicFetch: true, lookup: publicLookup,
      fetchImpl: async () => { throw new Error('fetch must never run for the LinkedIn jobs home page'); }
    }),
    error => error.code === 'BROWSER_REQUIRED' && error.classification?.kind === 'job_board_url'
  );
});

test('a login-walled single posting says browser_required, not raw fetch failed', async () => {
  await assert.rejects(
    ingestPublicJobUrl('https://www.linkedin.com/jobs/view/3948129471', {
      confirmedPublicFetch: true, lookup: publicLookup,
      fetchImpl: async () => new Response('', { status: 999 })
    }),
    error => error.code === 'BROWSER_REQUIRED'
  );
});

test('the inventory repair pass marks non-jobs without deleting, and the mark sticks', () => {
  const garbage = {
    job_id: 'job_bad', title: '查看更多职位', company: '', description_text: '',
    url: 'https://www.zhipin.com/web/geek/job?query=x', canonical_url: 'https://www.zhipin.com/web/geek/job?query=x'
  };
  const real = {
    job_id: 'job_ok', title: 'Senior Sales Manager', company: 'Acme',
    description_text: 'Own the East China region sales pipeline end to end.',
    url: 'https://acme.example.com/careers/senior-sales-manager-1042',
    canonical_url: 'https://acme.example.com/careers/senior-sales-manager-1042'
  };
  const first = repairJobInventory([garbage, real]);
  assert.equal(first.marked, 1);
  assert.equal(first.total, 2);
  assert.equal(first.jobs[0].invalid_non_job, true);
  assert.deepEqual(first.jobs[0].invalid_reasons, ['navigation_title', 'no_company_and_no_description', 'url_is_board_list_page']);
  assert.equal(first.jobs[1].invalid_non_job, undefined, 'real jobs stay untouched');
  // Idempotent: a second pass marks nothing new.
  const second = repairJobInventory(first.jobs);
  assert.equal(second.marked, 0);
  assert.equal(second.already_marked, 1);
  // The mark survives re-normalization (merges must not resurrect garbage).
  const renormalized = normalizeJobRecord(first.jobs[0], { now: '2026-08-22T00:00:00.000Z' });
  assert.equal(renormalized.invalid_non_job, true);
  assert.ok(renormalized.invalid_reasons.includes('navigation_title'));
});

test('a careers page discovery drops navigation anchors and keeps real postings', async () => {
  const html = `<!doctype html><html><head><title>Jobs at Acme</title></head><body>
    <a href="/careers/senior-sales-manager-shanghai-1042">Senior Sales Manager</a>
    <a href="/careers/backend-engineer-platform-2044">Backend Engineer, Platform</a>
    <a href="/careers/all">查看更多职位</a>
    <a href="/careers/list">View all jobs</a>
  </body></html>`;
  const result = await ingestPublicJobUrl('https://acme.example.com/careers', {
    confirmedPublicFetch: true, lookup: publicLookup,
    fetchImpl: async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  });
  const titles = result.jobs.map(job => job.title);
  assert.deepEqual(titles.sort(), ['Backend Engineer, Platform', 'Senior Sales Manager']);
  for (const job of result.jobs) {
    assert.ok(job.discovery?.discovered_by, 'every discovered job carries provenance');
  }
});
