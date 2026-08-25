// Source-level guards for the Quick Apply default UI.
//
// Three promises, pinned:
//   1. The UI speaks plain words — internal vocabulary (Package, Session,
//      Executor, state-machine constants, heartbeat…) never reaches the user.
//   2. No native alert/confirm/prompt dialogs (release UI rule).
//   3. The UI calls ONLY routes from the frozen API contract — no JSON files,
//      no runtime files, no internal endpoints.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK_DIR = path.join(ROOT, 'dashboard', 'quick');
const html = fs.readFileSync(path.join(QUICK_DIR, 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(QUICK_DIR, 'quick.js'), 'utf8');
const i18n = fs.readFileSync(path.join(QUICK_DIR, 'i18n.js'), 'utf8');

test('the default UI exists and is what / serves', () => {
  assert.ok(fs.existsSync(path.join(QUICK_DIR, 'index.html')));
  assert.ok(fs.existsSync(path.join(QUICK_DIR, 'quick.css')));
  const server = fs.readFileSync(path.join(ROOT, 'dashboard', 'server.mjs'), 'utf8');
  assert.match(server, /QUICK_UI_DIR/);
  assert.match(server, /'\/advanced'/);
});

test('user-facing text contains no internal vocabulary in either language', () => {
  // Everything the user can read lives in i18n.js and index.html.
  const forbidden = [
    /\bpackage\b/i, /\bsession\b/i, /\bexecutor\b/i, /heartbeat/i,
    /FILL_APPROVED/, /READY_FOR_MANUAL_SUBMIT/, /PACKAGE_READY/,
    /approve ai fill/i, /build package/i,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(i18n, pattern, `i18n must not contain ${pattern}`);
    assert.doesNotMatch(html, pattern, `index.html must not contain ${pattern}`);
  }
  // quick.js may reference internal FIELD NAMES (active_session_id …) to read
  // API responses, but must never render the words into user-visible strings:
  // every user string goes through t(), which resolves against i18n only.
  assert.doesNotMatch(js, /alert\(|window\.confirm\(|prompt\(/, 'no native dialogs');
  assert.doesNotMatch(js, /JSON\.stringify\([^)]*\)\s*\)\s*;?\s*\/\/\s*display/, 'no raw JSON display');
});

test('the UI calls only routes from the frozen API contract', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'developer', 'QUICK_APPLY_API_CONTRACT.md'), 'utf8');
  const frozen = [...doc.matchAll(/`(?:GET|POST|PUT|DELETE) (\/api\/[^\s`]+)`/g)]
    .map(match => match[1]
      .replaceAll(':id', '<id>')
      .replaceAll(':current_url', '<v>'));
  const frozenMatchers = frozen.map(route => new RegExp(
    `^${route.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('<id>', '[^/]+').replaceAll('<v>', '.*')}$`
  ));

  // Extract every /api/ path literal the UI requests.
  const called = [...js.matchAll(/api\((?:`|')(\/api\/[^'`?]+)/g)]
    .map(match => match[1].replaceAll(/\$\{[^}]+\}/g, 'X'));
  assert.ok(called.length >= 20, `expected the UI to use the API broadly, found ${called.length} calls`);
  const offContract = called.filter(route => !frozenMatchers.some(matcher => matcher.test(route)));
  assert.deepEqual(offContract, [], `UI calls outside the frozen contract:\n  ${offContract.join('\n  ')}`);
  // EventSource is the one non-fetch consumer.
  assert.match(js, /new EventSource\('\/api\/events'\)/);
});

test('the UI defaults to Chinese with an English toggle', () => {
  assert.match(html, /lang="zh-CN"/);
  assert.match(i18n, /language = localStorage\.getItem\('quick_apply_language'\) \|\| 'zh'/);
  assert.match(i18n, /const en = \{/);
});

test('the UI never reads local JSON or browser runtime files', () => {
  assert.doesNotMatch(js, /dashboard_state\.json|browser_sessions|ApplicationExecution\.json|retry-command/);
  assert.doesNotMatch(js, /require\(|from 'node:/);
});

test('destructive confirmation phrases match the server constants exactly', () => {
  // Both danger buttons send a fixed confirmation_text; a drifted literal
  // makes the button silently un-usable (the server 409s every click).
  const server = fs.readFileSync(path.join(ROOT, 'dashboard', 'server.mjs'), 'utf8');
  for (const constant of ['RESET_CONFIRMATION_TEXT', 'CLEAR_JOB_MATERIALS_CONFIRMATION_TEXT']) {
    const phrase = server.match(new RegExp(`const ${constant} = '([^']+)'`))?.[1];
    assert.ok(phrase, `${constant} must exist in server.mjs`);
    assert.ok(js.includes(`confirmation_text: '${phrase}'`),
      `quick.js must send the exact server phrase "${phrase}" for ${constant}`);
  }
});

test('AI provider form speaks the server field vocabulary', () => {
  // The save body must use the names normalizeAIProviderSettings reads —
  // provider_type/endpoint were silently dropped, so the choice never saved.
  assert.ok(js.includes("type: providerSelect.value"));
  assert.ok(js.includes("base_url: endpointInput.value.trim()"));
  assert.ok(!js.includes('provider_type: providerSelect.value'));
  // Select option values must be canonical server provider types.
  const providerLib = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'ai_provider.mjs'), 'utf8');
  for (const type of ['local_openai_compatible', 'openai', 'anthropic', 'openai_compatible']) {
    assert.ok(providerLib.includes(`'${type}'`), `${type} must be a server provider type`);
    assert.ok(js.includes(`'${type}'`), `quick.js must offer server type ${type}`);
  }
  assert.ok(!js.includes("'lmstudio'"), 'no fake provider type values in the UI');
});

test('conditional sections never print the word "null" into the page', () => {
  // The raw DOM append() renders a null child as the literal text "null".
  // A job with no search-match explanation printed "null" in its drawer.
  // Every call site that passes a conditional child into an EXISTING node
  // must go through mount(), which skips nullish children like el() does.
  assert.ok(/function mount\(parent, \.\.\.children\)/.test(js), 'mount() helper must exist');
  assert.ok(/if \(child == null\) continue;[\s\S]{0,200}parent\.append/.test(js),
    'mount() must skip nullish children');

  const risky = [];
  const pattern = /(\w+)\.append\(/g;
  let match;
  while ((match = pattern.exec(js)) !== null) {
    // Read the whole call by paren balance, then flag a bare `: null` that is
    // a DIRECT argument (depth 1) rather than one el() already filters.
    let depth = 0;
    let index = match.index + match[0].length - 1;
    let directArgs = '';
    for (; index < js.length; index += 1) {
      const character = js[index];
      if (character === '(') depth += 1;
      else if (character === ')') { depth -= 1; if (depth === 0) break; }
      if (depth === 1 && character !== '(') directArgs += character;
    }
    if (/:\s*null\s*(,|$)/m.test(directArgs)) {
      risky.push(js.slice(0, match.index).split('\n').length);
    }
  }
  assert.deepEqual(risky, [], `raw append() with a null argument at line(s): ${risky.join(', ')}`);
});
