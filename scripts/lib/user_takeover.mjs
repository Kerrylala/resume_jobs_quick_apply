// Detects "the user must drive this page" states — login walls, QR sign-in,
// SMS codes, CAPTCHA / risk checks, Cloudflare interstitials — from read-only
// page facts (URL + visible text + known challenge elements). Pure and
// deterministic so the no-refresh takeover contract can be unit tested.
//
// While one of these states is active the watcher must NOT scroll, click,
// navigate, reload or rebuild the page. It may only keep reading.

const URL_CHALLENGE_PATTERN = new RegExp([
  '/login', 'signin', 'sign-in', 'passport', 'weblogin', 'authwall',
  'captcha', 'verify', 'checkpoint', '/safe/', 'security-check', 'cf_chl',
  '/web/user', // BOSS 直聘 login area

].join('|'), 'i');

const TEXT_CHALLENGE_PATTERN = new RegExp([
  // Chinese login / verification walls
  '扫码登录', '账号登录', '密码登录', '手机号登录', '短信验证码', '请输入验证码',
  '安全验证', '人机验证', '请完成验证', '拖动滑块', '滑动验证', '点击进行验证',
  // English login / verification walls
  'sign in to continue', 'log in to continue', 'join now to see',
  'verify you are human', 'are you a robot', 'security check',
  'unusual activity', 'complete the challenge',
  // Cloudflare interstitial
  'just a moment', 'checking your browser', 'needs to review the security',
].join('|'), 'i');

// Selector for challenge widgets. Evaluated by the caller in the page; kept
// here so tests and the watcher share one definition.
export const CHALLENGE_ELEMENT_SELECTOR = [
  '.geetest_panel', '.geetest_holder', '.geetest_captcha',
  'iframe[src*="captcha" i]', 'iframe[src*="geetest" i]', 'iframe[src*="challenge" i]',
  '#captcha', '[class*="captcha" i]', '[class*="verify-wrap" i]',
  '.boss-login-dialog', '[class*="login-dialog" i]', '[class*="login-card" i]',
  'input[type="password"]',
].join(', ');

// { url, bodyText, hasChallengeElement } -> { waiting, reason }
// reason: 'url_login_or_challenge' | 'page_text_challenge' | 'challenge_element' | ''
export function detectUserActionState({ url = '', bodyText = '', hasChallengeElement = false } = {}) {
  const address = String(url || '');
  const sample = String(bodyText || '').slice(0, 6000);
  let testable = address;
  // Host + path + query — login walls live on subdomains (login.zhipin.com,
  // passport.zhaopin.com) as often as on paths.
  try { const parsed = new URL(address); testable = `/${parsed.host}${parsed.pathname}${parsed.search}`; } catch { /* keep raw */ }
  if (URL_CHALLENGE_PATTERN.test(testable)) return { waiting: true, reason: 'url_login_or_challenge' };
  if (TEXT_CHALLENGE_PATTERN.test(sample)) return { waiting: true, reason: 'page_text_challenge' };
  if (hasChallengeElement) return { waiting: true, reason: 'challenge_element' };
  return { waiting: false, reason: '' };
}

export const WAITING_FOR_USER_MESSAGE = '正在等待你完成登录/验证。页面不会刷新，也不会自动滚动。完成后停留在结果页即可，系统会自动继续。';

// Base ("registrable-ish") domain: last two labels. Good enough for the boards
// we drive (zhipin.com, 58.com, maimai.cn, microsoft.com, …).
function baseDomain(url) {
  try { return new URL(url).hostname.toLowerCase().split('.').slice(-2).join('.'); }
  catch { return ''; }
}
export function sameSite(a, b) {
  const left = baseDomain(a);
  return Boolean(left) && left === baseDomain(b);
}

// Where is the watcher's page, REALLY? Verification is POSITIVE-only:
// "no challenge markers" is never success — about:blank has no markers either.
//   challenge  — a login/verification the user must complete (same site or anywhere)
//   verified   — expected site AND (positive path marker when the board defines one)
//   on_site    — expected site, but not a page we recognize as search/detail:
//                read-only watching, no advancing, no recovery navigation
//   page_lost  — blank page, error page, or a different domain entirely
export function classifyPageState({ url = '', expectedUrl = '', bodyText = '', hasChallengeElement = false, positivePattern = null } = {}) {
  const challenge = detectUserActionState({ url, bodyText, hasChallengeElement });
  if (challenge.waiting) return { state: 'challenge', reason: challenge.reason };
  const address = String(url || '');
  if (!address || address === 'about:blank' || address.startsWith('chrome-error://') || address.startsWith('chrome://')) {
    return { state: 'page_lost', reason: 'blank_page' };
  }
  if (expectedUrl && !sameSite(address, expectedUrl)) {
    return { state: 'page_lost', reason: 'wrong_domain' };
  }
  if (positivePattern && !positivePattern.test(address)) {
    return { state: 'on_site', reason: 'no_positive_marker' };
  }
  return { state: 'verified', reason: positivePattern ? 'positive_marker' : 'same_site' };
}
