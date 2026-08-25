// Human-takeover contract for the assisted browser watcher: while the user
// signs in / completes verification, the system must detect that state from
// READ-ONLY page facts and keep every page-touching action off. These tests
// pin the detector; the live no-refresh behaviour is exercised end-to-end by
// scripts/test_discovery_user_takeover.mjs against a mock board.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CHALLENGE_ELEMENT_SELECTOR,
  classifyPageState,
  detectUserActionState,
  sameSite,
  WAITING_FOR_USER_MESSAGE,
} from '../scripts/lib/user_takeover.mjs';

test('login and verification pages are detected as waiting_for_user', () => {
  const cases = [
    { url: 'https://www.zhipin.com/web/user/?ka=header-login', bodyText: '' },
    { url: 'https://login.zhipin.com/', bodyText: '' },
    { url: 'https://www.zhipin.com/web/common/security-check.html?seed=x', bodyText: '' },
    { url: 'https://www.linkedin.com/authwall?trk=x', bodyText: '' },
    { url: 'https://passport.zhaopin.com/login', bodyText: '' },
    { url: 'https://www.zhipin.com/web/geek/job?query=ai', bodyText: '扫码登录 / 账号登录 请使用 BOSS直聘 APP 扫码' },
    { url: 'https://www.liepin.com/zhaopin/?key=ai', bodyText: '请输入短信验证码 手机号登录' },
    { url: 'https://we.51job.com/pc/search', bodyText: '安全验证 请完成验证后继续访问' },
    { url: 'https://example.com/jobs', bodyText: 'Just a moment... Checking your browser before accessing' },
    { url: 'https://sou.zhaopin.com/?kw=ai', bodyText: '拖动滑块完成拼图 人机验证' },
    { url: 'https://www.zhipin.com/web/geek/job?query=ai', bodyText: '', hasChallengeElement: true },
  ];
  for (const facts of cases) {
    const state = detectUserActionState(facts);
    assert.equal(state.waiting, true, `expected waiting for ${facts.url} / "${facts.bodyText.slice(0, 30)}"`);
    assert.ok(state.reason, 'a waiting state always names its reason');
  }
});

test('normal results pages are NOT treated as challenges', () => {
  const cases = [
    // Job slugs that contain fragments of challenge words must not trigger.
    { url: 'https://www.zhipin.com/web/geek/job?query=AI工程师&city=101020100', bodyText: 'AI工程师 25-40K 上海 3-5年 本科 招聘中' },
    { url: 'https://example.com/jobs/associate-software-engineer', bodyText: 'Associate Software Engineer — apply now' },
    { url: 'https://example.com/jobs/risk-analyst-verification-team', bodyText: 'Risk Analyst, verification systems team' },
    { url: 'https://www.linkedin.com/jobs/search/?keywords=engineer', bodyText: 'Software Engineer jobs. 1,024 results. Sign in for personalized results' },
    { url: '', bodyText: '' },
  ];
  for (const facts of cases) {
    const state = detectUserActionState(facts);
    assert.equal(state.waiting, false, `false positive on ${facts.url || '(blank page)'}`);
  }
});

test('the user-facing waiting message says the page will not refresh', () => {
  assert.match(WAITING_FOR_USER_MESSAGE, /不会刷新/);
  assert.match(WAITING_FOR_USER_MESSAGE, /登录|验证/);
});

test('the challenge element selector covers the widget families we key on', () => {
  for (const marker of ['geetest', 'captcha', 'login-dialog', 'password']) {
    assert.ok(CHALLENGE_ELEMENT_SELECTOR.includes(marker), `selector should cover ${marker}`);
  }
});

test('page verification is POSITIVE: about:blank or a foreign domain is never success', () => {
  const boss = { expectedUrl: 'https://www.zhipin.com/web/geek/job?query=ai', positivePattern: /zhipin\.com\/(web\/geek\/jobs?|job_detail)/ };
  // The exact 2026-08-23 failure: page ended on about:blank while the login
  // dialog was gone — that must be PAGE_LOST, not "challenge cleared".
  assert.equal(classifyPageState({ url: 'about:blank', ...boss }).state, 'page_lost');
  assert.equal(classifyPageState({ url: '', ...boss }).state, 'page_lost');
  assert.equal(classifyPageState({ url: 'chrome-error://chromewebdata/', ...boss }).state, 'page_lost');
  assert.equal(classifyPageState({ url: 'https://evil.example.com/jobs', ...boss }).state, 'page_lost');
  // The real search list and a real job detail are VERIFIED.
  assert.equal(classifyPageState({ url: 'https://www.zhipin.com/web/geek/job?query=AI工程师&city=101020100', ...boss }).state, 'verified');
  assert.equal(classifyPageState({ url: 'https://www.zhipin.com/job_detail/abc123.html', ...boss }).state, 'verified');
  // Same site but not a search/detail page: watch quietly, no advancing, no
  // recovery navigation — the user may be browsing on purpose.
  assert.equal(classifyPageState({ url: 'https://www.zhipin.com/gongsi/xyz.html', ...boss }).state, 'on_site');
  // A login page stays a challenge even though it matches the domain.
  assert.equal(classifyPageState({ url: 'https://www.zhipin.com/web/user/?ka=header-login', ...boss }).state, 'challenge');
  assert.equal(classifyPageState({ url: 'https://www.zhipin.com/web/geek/job?query=ai', bodyText: '扫码登录 请使用APP扫码', ...boss }).state, 'challenge');
  // Without a positive pattern (generic boards), same-site is verified.
  assert.equal(classifyPageState({ url: 'http://127.0.0.1:9000/results', expectedUrl: 'http://127.0.0.1:9000/board' }).state, 'verified');
});

test('sameSite compares registrable domains, not exact hosts', () => {
  assert.equal(sameSite('https://login.zhipin.com/x', 'https://www.zhipin.com/web/geek/job'), true);
  assert.equal(sameSite('https://sou.zhaopin.com/?kw=x', 'https://jobs.zhaopin.com/j/1'), true);
  assert.equal(sameSite('https://www.zhipin.com/', 'https://www.liepin.com/'), false);
  assert.equal(sameSite('about:blank', 'https://www.zhipin.com/'), false);
});

test('watcher source holds every takeover promise in code, not comments', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../browser_agent/discover_jobs.mjs', import.meta.url), 'utf8');
  // No reload; exactly two gotos: the initial open + the guarded PAGE_LOST
  // recovery back to this session's own last valid URL.
  assert.ok(!source.includes('.reload('), 'the watcher must never call page.reload()');
  assert.equal(source.match(/page\.goto\(/g)?.length ?? 0, 2, 'exactly two page.goto calls (initial open + page_lost recovery)');
  assert.match(source, /pageState\.state === 'page_lost' && Date\.now\(\) - lastRecoveryAt[\s\S]{0,200}?page\.goto\(lastValidUrl \|\| boardUrl/);
  // The countdown suspends while waiting for the user.
  assert.match(source, /if \(waitingForUser\) deadline = Date\.now\(\) \+ maxWaitMs/);
  // Page touches happen ONLY on a verified search page.
  assert.match(source, /pageState\.state === 'verified'\s*&&[\s\S]{0,120}advanceList/);
  // Next-page clicks additionally require already-read job links, so a broad
  // selector can never click controls on a login page.
  assert.match(source, /found\.size > 0/);
  // The fetch-only global search engine can never touch the assisted browser.
  const orchestrator = fs.readFileSync(new URL('../scripts/lib/search_orchestrator.mjs', import.meta.url), 'utf8');
  assert.ok(!/playwright|chromium|launchPersistentContext|page\.goto/.test(orchestrator),
    'the global search orchestrator must stay fetch-only — it may never drive or navigate the assisted browser session');
});
