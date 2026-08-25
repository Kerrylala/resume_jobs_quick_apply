// Assisted job-board reading.
//
// Opens ONE job-board page (LinkedIn jobs, BOSS 直聘, …) in the persistent
// browser profile and then only WATCHES: the user drives the page — signs in,
// completes any verification, scrolls, searches. Every couple of seconds the
// visible job links are read and written to the results file. Nothing is
// clicked, typed, bypassed or submitted by this process.
//
//   node browser_agent/discover_jobs.mjs --url <board> --out <results.json>
//     [--profile-dir <dir>] [--max-jobs 40] [--max-wait-ms 300000] [--headless-test]
//     [--mode search --board boss|linkedin|generic --keyword <k> --city <c>]
//
// Search mode: the page's OWN search box may be filled with the keyword (a
// normal site feature, never a login field), the list is scrolled and paged.
// Sign-in, CAPTCHA and every verification remain the user's — the watcher
// only reads what the signed-in page chooses to show.
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

import { agentBrowserCandidates } from '../scripts/lib/agent_browser.mjs';
import { classifyJobInput, isNavigationTitle } from '../scripts/lib/job_input_classifier.mjs';
import { CHALLENGE_ELEMENT_SELECTOR, classifyPageState, sameSite, WAITING_FOR_USER_MESSAGE } from '../scripts/lib/user_takeover.mjs';

function argument(name, fallback = '') {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const hasFlag = name => process.argv.includes(`--${name}`);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Board adapters: how to open a keyword search and how the list paginates.
// These construct NORMAL public search URLs — the same ones a user types.
// positivePattern: URL shape of the board's REAL search/detail pages — the
// only pages that count as VERIFIED. "No challenge markers" is never success.
export const SEARCH_ADAPTERS = Object.freeze({
  boss: {
    searchUrl: (keyword) => `https://www.zhipin.com/web/geek/job?query=${encodeURIComponent(keyword)}`,
    nextSelector: '.options-pages a.next, .ui-icon-arrow-right, a[ka="page-next"]',
    positivePattern: /zhipin\.com\/(web\/geek\/jobs?|job_detail)/,
    scroll: true,
  },
  linkedin: {
    searchUrl: (keyword, city) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keyword)}${city ? `&location=${encodeURIComponent(city)}` : ''}`,
    nextSelector: 'button.infinite-scroller__show-more-button, button[aria-label*="more jobs" i]',
    positivePattern: /linkedin\.com\/jobs\//,
    scroll: true,
  },
  liepin: {
    searchUrl: (keyword) => `https://www.liepin.com/zhaopin/?key=${encodeURIComponent(keyword)}`,
    nextSelector: '.list-pagination-box .ant-pagination-next, a[rel="next"]',
    positivePattern: /liepin\.com\/(zhaopin|job|a\/\d)/,
    scroll: true,
  },
  '51job': {
    searchUrl: (keyword) => `https://we.51job.com/pc/search?keyword=${encodeURIComponent(keyword)}`,
    nextSelector: '.btn-next, a[rel="next"]',
    positivePattern: /51job\.com\/(pc\/search|job)/,
    scroll: true,
  },
  zhaopin: {
    searchUrl: (keyword) => `https://sou.zhaopin.com/?kw=${encodeURIComponent(keyword)}`,
    nextSelector: '.soupager .btn-next, a[rel="next"]',
    positivePattern: /(sou|jobs)\.zhaopin\.com\//,
    scroll: true,
  },
  lagou: {
    searchUrl: (keyword) => `https://www.lagou.com/wn/jobs?kd=${encodeURIComponent(keyword)}`,
    nextSelector: '.lg-pagination-next, a[rel="next"]',
    positivePattern: /lagou\.com\/(wn\/)?jobs/,
    scroll: true,
  },
  generic: { searchUrl: null, nextSelector: 'a[rel="next"], .next a, button[class*="more" i]', positivePattern: null, scroll: true },
});

const mode = argument('mode', 'watch');
const boardKind = argument('board', 'generic');
const keyword = argument('keyword', '');
const city = argument('city', '');
const adapter = SEARCH_ADAPTERS[boardKind] || SEARCH_ADAPTERS.generic;
let boardUrl = argument('url');
if (!boardUrl && mode === 'search' && adapter.searchUrl && keyword) {
  boardUrl = adapter.searchUrl(keyword, city);
}
if (!boardUrl) throw new Error('--url is required (or --mode search with --board and --keyword).');
const outPath = path.resolve(argument('out', path.join(PROJECT_ROOT, 'reports', 'assisted_discovery.json')));
const profileDir = path.resolve(argument('profile-dir', path.join(PROJECT_ROOT, 'browser_profiles', 'resume-jobs-agent')));
const maxJobs = Math.max(1, Math.min(200, Number(argument('max-jobs', '40'))));
// Timeout counts only while the page does NOT need the user: whenever a
// login/verification state is detected the countdown suspends, so the watcher
// waits as long as the window stays open. Default 10 minutes of quiet time.
const maxWaitMs = Math.max(10_000, Math.min(240 * 60_000, Number(argument('max-wait-ms', '600000'))));
// How often the watcher may touch the page (scroll / next). Reading stays on
// the 2s tick, but page interaction defaults to every 3 minutes so the user
// can drive the page without the list jumping under them. During a detected
// login/verification state the page is never touched at all.
const advanceIntervalMs = Math.max(10_000, Number(argument('advance-interval-ms', '180000')));

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, filePath);
}

const fs = await import('node:fs');
const executablePath = agentBrowserCandidates(PROJECT_ROOT).find(candidate => fs.existsSync(candidate));
if (!executablePath) throw new Error('Chrome or Microsoft Edge was not found. Set RESUME_JOBS_CHROME_EXECUTABLE.');

// Reads visible job links. Site-specific shapes for the boards that matter,
// plus a generic anchor sweep; final gating happens back in Node.
function collectJobLinksInPage() {
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  const results = [];
  const push = (href, title, company, location, salary) => {
    if (!href || !title) return;
    results.push({
      url: href,
      title: clean(title).slice(0, 160),
      company: clean(company).slice(0, 120),
      location: clean(location).slice(0, 120),
      salary: clean(salary).slice(0, 60),
    });
  };
  for (const anchor of document.querySelectorAll('a[href*="/jobs/view/"]')) {
    const card = anchor.closest('li, [data-job-id], .job-card-container, .base-card') || anchor;
    push(
      anchor.href,
      clean(anchor.getAttribute('aria-label') || anchor.textContent),
      card.querySelector('.base-search-card__subtitle, .job-card-container__primary-description, [class*="company" i]')?.textContent,
      card.querySelector('.job-search-card__location, [class*="location" i]')?.textContent,
      card.querySelector('[class*="salary" i]')?.textContent
    );
  }
  for (const anchor of document.querySelectorAll('a[href*="job_detail"]')) {
    const card = anchor.closest('li, .job-card-wrapper, .job-card-box') || anchor;
    push(
      anchor.href,
      clean(card.querySelector('.job-name, [class*="job-name" i], [class*="job-title" i]')?.textContent || anchor.textContent),
      card.querySelector('.company-name, [class*="company-name" i], [class*="boss-name" i]')?.textContent,
      card.querySelector('.job-area, [class*="job-area" i], [class*="city" i]')?.textContent,
      card.querySelector('.salary, [class*="salary" i]')?.textContent
    );
  }
  if (!results.length) {
    for (const anchor of document.querySelectorAll('a[href]')) {
      const title = clean(anchor.textContent);
      if (title.length < 3 || title.length > 140) continue;
      push(anchor.href, title, '', '', '');
      if (results.length >= 400) break;
    }
  }
  return results.slice(0, 500);
}

const startedAt = new Date().toISOString();
const found = new Map();
let status = 'running';
let note = 'Waiting for you to drive the page. Sign in or search as needed — jobs are read automatically.';
let waitingForUser = false;
let waitingReason = '';
// Read-only diagnostics: what the last read tick saw and why candidates were
// rejected — the difference between "no jobs on page" and "page changed shape".
let diagnostics = { current_url: '', anchors_seen: 0, rejected_not_job_url: 0, rejected_nav_title: 0 };
// "I am done, continue now" signal: the dashboard writes this file when the
// user says they finished signing in; the watcher rescans immediately.
const continueSignalPath = `${outPath}.continue`;

const context = await chromium.launchPersistentContext(profileDir, {
  executablePath,
  headless: hasFlag('headless-test'),
  viewport: null,
  acceptDownloads: false,
  args: ['--disable-features=Translate', '--no-default-browser-check', '--noerrdialogs'],
});
let page = context.pages()[0] || await context.newPage();

async function persist() {
  await writeJsonAtomic(outPath, {
    schema_version: '1.0',
    status,
    note,
    board_url: boardUrl,
    started_at: startedAt,
    updated_at: new Date().toISOString(),
    jobs: [...found.values()],
    user_action: {
      waiting_for_user: waitingForUser,
      reason: waitingReason,
      message: waitingForUser ? WAITING_FOR_USER_MESSAGE : '',
    },
    diagnostics,
    safety: {
      user_drives_the_page: true, login_attempted: false, challenge_bypassed: false,
      fields_filled: 0, application_submitted: false
    },
  });
}

// Read-only probe: URL + visible text + visible challenge widgets. Never
// navigates, clicks or reloads. Verification is POSITIVE: only the expected
// site (plus the board's real search/detail URL shape, when defined) counts as
// verified — about:blank or a wrong domain is PAGE_LOST, never success.
async function probePageState() {
  let url = '';
  try { url = page.url(); } catch { /* page mid-teardown */ }
  try {
    const facts = await page.evaluate((selector) => ({
      url: location.href,
      bodyText: (document.body?.innerText || '').slice(0, 6000),
      hasChallengeElement: [...document.querySelectorAll(selector)].some(el => el.offsetParent !== null),
    }), CHALLENGE_ELEMENT_SELECTOR);
    return classifyPageState({ ...facts, expectedUrl: boardUrl, positivePattern: adapter.positivePattern || null });
  } catch {
    return classifyPageState({ url, expectedUrl: boardUrl, positivePattern: adapter.positivePattern || null });
  }
}

// Fill the page's OWN search box (input[type=search] / search-ish
// placeholders) with the keyword. Strictly a normal site feature: password,
// login and verification inputs are structurally excluded.
async function fillSiteSearch(keywordValue) {
  if (!keywordValue) return false;
  try {
    return await page.evaluate((wanted) => {
      const candidates = [...document.querySelectorAll('input')].filter(input => {
        const type = String(input.getAttribute('type') || 'text').toLowerCase();
        if (!['text', 'search'].includes(type)) return false;
        const hint = [input.name, input.id, input.placeholder, input.getAttribute('aria-label')].join(' ').toLowerCase();
        return /search|query|keyword|搜索|职位|岗位/.test(hint);
      });
      const box = candidates[0];
      if (!box) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(box, wanted); else box.value = wanted;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      box.form?.requestSubmit?.();
      return true;
    }, keywordValue);
  } catch { return false; }
}

async function advanceList(advanceCount) {
  // Scroll to the bottom; every fourth advance: try the site's own
  // next/see-more control — but only once real job links were already read,
  // so a broad selector can never click anything on a login/challenge page.
  try {
    if (adapter.scroll) await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    if (advanceCount % 4 === 3 && adapter.nextSelector && found.size > 0) {
      const next = page.locator(adapter.nextSelector).first();
      if (await next.isVisible().catch(() => false)) await next.click({ timeout: 2000 }).catch(() => { /* list may have re-rendered */ });
    }
  } catch { /* advancing is best-effort; the user can scroll too */ }
}

try {
  await persist();
  await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(error => {
    // NOT silent: a failed open leaves the page blank, which the state
    // machine reports as page_lost and the recovery path retries.
    diagnostics.goto_error = String(error?.message || error).slice(0, 160);
  });
  if (mode === 'search' && boardKind === 'generic' && keyword) {
    await page.waitForTimeout(1500);
    const loadState = await probePageState();
    if (loadState.state !== 'challenge') await fillSiteSearch(keyword);
  }
  let deadline = Date.now() + maxWaitMs;
  let lastAdvanceAt = Date.now();
  let advanceCount = 0;
  let lastValidUrl = '';
  let lastRecoveryAt = 0;
  let tabRebinds = 0;
  const pageScore = candidate => {
    let url = '';
    try { url = candidate.url(); } catch { return -1; }
    return (sameSite(url, boardUrl) ? 2 : 0) + (url && url !== 'about:blank' ? 1 : 0);
  };
  while (Date.now() < deadline && found.size < maxJobs) {
    // 1. This session owns ONE search — but sites move it: verify flows open a
    //    new tab and blank the old one. Follow the best page in OUR context
    //    (never another context, never closing anything).
    const openPages = context.pages().filter(candidate => !candidate.isClosed());
    if (!openPages.length) { status = 'window_closed'; note = 'The browser window was closed.'; break; }
    const best = openPages.reduce((a, b) => (pageScore(b) > pageScore(a) ? b : a), openPages[0]);
    if (best !== page && (page.isClosed() || pageScore(best) > pageScore(page))) {
      page = best;
      tabRebinds += 1;
    }
    // 2. POSITIVE page verification: challenge / verified / on_site / page_lost.
    const pageState = await probePageState();
    waitingForUser = pageState.state === 'challenge';
    waitingReason = waitingForUser ? pageState.reason : '';
    if (waitingForUser) deadline = Date.now() + maxWaitMs; // clock stops for the user
    if (['verified', 'on_site'].includes(pageState.state)) {
      try { lastValidUrl = page.url(); } catch { /* keep previous */ }
    }
    // 3. "I'm done, continue" from the dashboard.
    let continueSignal = false;
    try {
      if (fs.existsSync(continueSignalPath)) { fs.unlinkSync(continueSignalPath); continueSignal = true; }
    } catch { /* signal file already consumed */ }
    if (continueSignal) {
      waitingForUser = false;
      waitingReason = '';
      lastRecoveryAt = 0; // a lost page may recover right now
    }
    // 4. Read the visible job links — read-only, every tick, in every state.
    let links = [];
    try { links = await page.evaluate(collectJobLinksInPage); }
    catch { /* page mid-navigation; read again next tick */ }
    diagnostics = {
      ...diagnostics,
      current_url: (() => { try { return page.url().slice(0, 200); } catch { return ''; } })(),
      page_state: pageState.state,
      page_state_reason: pageState.reason,
      last_valid_url: lastValidUrl.slice(0, 200),
      tab_count: openPages.length,
      tab_rebinds: tabRebinds,
      anchors_seen: links.length,
      rejected_not_job_url: 0,
      rejected_nav_title: 0,
    };
    for (const link of links) {
      const kind = classifyJobInput(link.url);
      if (kind.kind !== 'single_job_url') { diagnostics.rejected_not_job_url += 1; continue; }
      if (isNavigationTitle(link.title)) { diagnostics.rejected_nav_title += 1; continue; }
      const key = kind.url.split('?')[0];
      if (!found.has(key)) {
        found.set(key, {
          title: link.title, company: link.company, apply_url: kind.url,
          location: link.location || '', salary: link.salary || '',
          provider_hint: kind.provider_hint, read_at: new Date().toISOString(),
        });
      }
    }
    note = waitingForUser
      ? WAITING_FOR_USER_MESSAGE
      : pageState.state === 'page_lost'
        ? '搜索页面丢失（空白页或跳去了其他网站），正在恢复原来的搜索页。你的登录不受影响。'
        : (found.size > 0
          ? `${found.size} job link(s) read from your session so far.`
          : 'Waiting for you to drive the page. Sign in or search as needed — jobs are read automatically.');
    await persist();
    // 5. PAGE_LOST recovery: same context (cookies/profile intact), back to the
    //    last page that was really ours — at most every 30 seconds.
    if (pageState.state === 'page_lost' && Date.now() - lastRecoveryAt >= 30_000) {
      lastRecoveryAt = Date.now();
      await page.goto(lastValidUrl || boardUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(error => {
        diagnostics.goto_error = String(error?.message || error).slice(0, 160);
      });
    }
    // 6. Touch the page ONLY on a verified search page, never during a
    //    challenge, at most once per advance interval (or on the signal).
    if (mode === 'search' && pageState.state === 'verified'
      && (continueSignal || Date.now() - lastAdvanceAt >= advanceIntervalMs)) {
      await advanceList(advanceCount);
      advanceCount += 1;
      lastAdvanceAt = Date.now();
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (status === 'running') status = 'completed';
  waitingForUser = false;
  waitingReason = '';
  if (status === 'completed' && found.size === 0) {
    note = 'No job links became visible. The page may still need a sign-in or a search.';
  }
} catch (error) {
  status = 'failed';
  note = String(error?.message || error).slice(0, 300);
} finally {
  await persist();
  await context.close().catch(() => { /* window already gone */ });
}
