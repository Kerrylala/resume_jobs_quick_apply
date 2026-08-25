// Locating the Browser Agent's Chromium.
//
// Branded Google Chrome 137+ removed --load-extension, so the agent can only
// ship its extension inside a "Chrome for Testing" runtime (installed locally
// with `npm run browser:install-agent-runtime` into browser_runtime/). The
// detection order is: explicit env override → local Chrome for Testing →
// installed branded Chrome/Edge (which still fill fine, just without the
// bundled extension — callers report that honestly).
import fs from 'node:fs';
import path from 'node:path';

export function detectChromeForTesting(projectRoot) {
  const base = path.join(projectRoot, 'browser_runtime', 'chrome');
  let versions = [];
  try { versions = fs.readdirSync(base); } catch { return ''; }
  for (const version of versions.sort().reverse()) {
    for (const relative of [
      ['chrome-win64', 'chrome.exe'],
      ['chrome-win32', 'chrome.exe'],
      ['chrome-linux64', 'chrome'],
      ['chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ]) {
      const candidate = path.join(base, version, ...relative);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

// Playwright's own Chromium build (npx playwright install chromium) also
// supports --load-extension and matches playwright-core's protocol.
export function detectPlaywrightChromium() {
  const bases = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '',
    process.env.HOME ? path.join(process.env.HOME, '.cache', 'ms-playwright') : '',
  ].filter(Boolean);
  for (const base of bases) {
    let entries = [];
    try { entries = fs.readdirSync(base); } catch { continue; }
    for (const entry of entries.filter(name => /^chromium-\d+$/.test(name)).sort().reverse()) {
      for (const relative of [
        ['chrome-win', 'chrome.exe'],
        ['chrome-linux', 'chrome'],
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
      ]) {
        const candidate = path.join(base, entry, ...relative);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return '';
}

export const BRANDED_BROWSER_CANDIDATES = Object.freeze([
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe',
]);

export function agentBrowserCandidates(projectRoot) {
  return [
    process.env.RESUME_JOBS_CHROME_EXECUTABLE,
    detectChromeForTesting(projectRoot),
    detectPlaywrightChromium(),
    ...BRANDED_BROWSER_CANDIDATES,
  ].filter(Boolean);
}

// Extension loading only works on non-branded builds (Chrome for Testing /
// plain Chromium). Callers use this to predict — and then verify — whether the
// bundled extension can load at all.
export function executableSupportsLoadExtension(executablePath) {
  const value = String(executablePath || '').toLowerCase();
  if (!value) return false;
  if (value.includes('browser_runtime') || value.includes('chrome-for-testing') || value.includes('for testing')) return true;
  if (value.includes('chromium')) return true;
  return false;
}
