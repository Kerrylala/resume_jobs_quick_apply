// Real-browser regression for the human-takeover contract of the assisted
// discovery watcher (browser_agent/discover_jobs.mjs):
//
//   1. While a login/verification page is shown, the watcher must not reload,
//      navigate, scroll-jump into or click the page — the mock board counts
//      page loads and tracks a value the "user" is typing.
//   2. The challenge is held for 130s with --max-wait-ms 60000: the run only
//      survives if the countdown really suspends while waiting for the user.
//   3. A mutating CAPTCHA box must not break the hold.
//   4. When the page leaves the challenge state (client-side swap to a results
//      list, no navigation), reading resumes automatically and jobs come in.
//
// Usage: node scripts/test_discovery_user_takeover.mjs [--challenge-ms 130000]
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argIndex = process.argv.indexOf('--challenge-ms');
const CHALLENGE_MS = argIndex >= 0 ? Number(process.argv[argIndex + 1]) : 130_000;

let boardLoads = 0;
let typedValueAtSwap = '';
const jobLinks = Array.from({ length: 6 }, (_, i) =>
  `<li><a href="/job/${i + 1}">Senior Platform Engineer ${i + 1}</a> — MockCo — Shanghai — 30-50K</li>`).join('');

const page = `<!doctype html><meta charset="utf-8"><title>Mock board</title>
<div id="stage">
  <h2>账号登录</h2>
  <p>扫码登录 或 请输入验证码</p>
  <div id="captcha" class="captcha-box">captcha-0</div>
  <input id="code" type="text" placeholder="验证码">
</div>
<script>
  let n = 0;
  // The CAPTCHA keeps changing — the watcher must keep waiting, not reload.
  const captchaTimer = setInterval(() => {
    document.getElementById('captcha').textContent = 'captcha-' + (++n);
  }, 3000);
  // The "user" keeps typing — a reload would wipe this value.
  const typing = setInterval(() => {
    const box = document.getElementById('code');
    if (box) box.value += 'x';
  }, 5000);
  setTimeout(() => {
    clearInterval(captchaTimer); clearInterval(typing);
    const typed = document.getElementById('code').value;
    // Report what survived, then do what real verify flows (e.g. BOSS) do:
    // continue in a NEW tab and blank the original. The watcher must follow
    // the real tab — about:blank must never be treated as success.
    fetch('/typed?value=' + encodeURIComponent(typed)).finally(() => {
      window.open('/results', '_blank');
      setTimeout(() => { location.href = 'about:blank'; }, 1500);
    });
  }, ${CHALLENGE_MS});
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/board') {
    boardLoads += 1;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(page);
  }
  if (url.pathname === '/typed') {
    typedValueAtSwap = url.searchParams.get('value') || '';
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === '/results') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Results</title><h2>搜索结果</h2><ul>${jobLinks}</ul>`);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><title>Job detail</title><h1>Senior Platform Engineer</h1>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const work = await mkdtemp(path.join(os.tmpdir(), 'rj-takeover-'));
const outFile = path.join(work, 'out.json');
const readOut = () => { try { return JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { return null; } };

const child = spawn(process.execPath, [
  path.join(ROOT, 'browser_agent', 'discover_jobs.mjs'),
  '--url', `http://127.0.0.1:${port}/board`,
  '--out', outFile,
  '--profile-dir', path.join(work, 'profile'),
  '--mode', 'search', '--board', 'generic', '--keyword', 'engineer',
  '--headless-test',
  '--max-wait-ms', '60000',          // < challenge time: only clock suspension survives this
  '--advance-interval-ms', '15000',  // eager advancing AFTER the challenge clears
  '--max-jobs', '5',
], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let childLog = '';
child.stdout.on('data', chunk => { childLog += chunk; });
child.stderr.on('data', chunk => { childLog += chunk; });
const exited = new Promise(resolve => child.once('close', code => resolve(code)));

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

// Sample the takeover state twice while the "user" is on the login page.
const sampleAt = async (ms, label) => {
  await new Promise(resolve => setTimeout(resolve, ms));
  const out = readOut();
  check(out?.status === 'running', `${label}: watcher still running`);
  check(out?.user_action?.waiting_for_user === true, `${label}: reports waiting_for_user`);
  check(/不会刷新/.test(out?.user_action?.message || ''), `${label}: message says the page will not refresh`);
  check(boardLoads === 1, `${label}: page loaded exactly once (loads=${boardLoads})`);
};
await sampleAt(45_000, 't≈45s');
await sampleAt(75_000, 't≈120s'); // beyond the 60s max-wait: countdown must be suspended

const exitCode = await exited;
const out = readOut();
check(exitCode === 0, `watcher exited cleanly (code=${exitCode})`);
check(out?.status === 'completed', `final status completed (got ${out?.status})`);
check((out?.jobs?.length || 0) >= 5, `jobs read after the challenge cleared (got ${out?.jobs?.length || 0})`);
check(out?.user_action?.waiting_for_user === false, 'waiting flag cleared at the end');
check(boardLoads === 1, `no reload across the whole run (loads=${boardLoads})`);
// The BOSS failure shape: content continued in a NEW tab, original went
// about:blank. The watcher must have re-bound to the real tab and finished on
// a POSITIVELY verified page — never counting about:blank as success.
check((out?.diagnostics?.tab_rebinds || 0) >= 1, `watcher followed the real tab (rebinds=${out?.diagnostics?.tab_rebinds})`);
check(out?.diagnostics?.page_state === 'verified', `final page positively verified (got ${out?.diagnostics?.page_state})`);
check((out?.diagnostics?.current_url || '').includes('/results'), `final page is the real results tab (got ${out?.diagnostics?.current_url})`);
const expectedTyped = Math.floor((CHALLENGE_MS - 1) / 5000);
check(typedValueAtSwap.length >= expectedTyped - 1, `typed input survived untouched (${typedValueAtSwap.length} chars, expected ≈${expectedTyped})`);
check((out?.jobs || []).every(job => job.title.includes('Engineer')), 'collected records are real job links, not navigation');

server.close();
await rm(work, { recursive: true, force: true }).catch(() => {});
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  if (childLog.trim()) console.error(childLog.slice(0, 2000));
  process.exit(1);
}
console.log('\nAll takeover regression checks passed.');
