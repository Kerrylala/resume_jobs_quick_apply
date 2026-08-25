// Pins the persistent-browser-profile guarantee (acceptance criterion 6).
//
// The Local Browser Agent must run against one shared, persistent Chrome
// profile so cookies, logins and completed verifications survive between
// application sessions. A regression to a per-session or temporary profile
// would silently break "finish the verification yourself, then continue" —
// the user would be logged out every time.
//
// Scope note: these are source-level invariants, not a live browser run. They
// exist because the only script that launches the agent today
// (`scripts/test_browser_agent_local.mjs`) deliberately passes its own
// throwaway `--profile-dir` for test isolation, so no existing test exercises
// the product path. The live confirmation belongs to the Phase 4 work that
// adds continue-after-verification.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}

test('the server launches the agent with one shared persistent profile directory', () => {
  const server = read('dashboard/server.mjs');

  // The profile directory is a fixed name under BROWSER_PROFILES_DIR — not
  // derived from the session id, and not an os.tmpdir() path.
  assert.match(
    server,
    /const profileDir = path\.join\(BROWSER_PROFILES_DIR, 'resume-jobs-agent'\)/,
    'the agent profile must be the shared "resume-jobs-agent" directory'
  );

  const profileLine = server.split('\n').find(line => line.includes('const profileDir = path.join('));
  assert.ok(profileLine, 'expected a profileDir assignment in the server');
  assert.doesNotMatch(
    profileLine,
    /sessionId|session_id|tmpdir|mkdtemp/,
    'the agent profile must not be per-session or temporary'
  );

  // And it is actually handed to the agent process.
  assert.match(
    server,
    /'--profile-dir',\s*profileDir/,
    'the server must pass the shared profile directory to the agent'
  );
});

test('the agent opens a persistent, visible browser context', () => {
  const run = read('browser_agent/run.mjs');

  assert.match(
    run,
    /chromium\.launchPersistentContext\(profileDir/,
    'the agent must use launchPersistentContext so cookies and logins persist'
  );

  // Headless is only ever enabled by the explicit test flag; the product path
  // shows a real window the user can complete a verification in.
  assert.match(
    run,
    /headless:\s*hasFlag\('headless-test'\)/,
    'the agent window must be visible unless the headless test flag is set'
  );
});

test('the browser profile directory is treated as personal data on reset', () => {
  const server = read('dashboard/server.mjs');
  const resetBlock = server.slice(
    server.indexOf('function resetLocalData()'),
    server.indexOf('function sendJSON(')
  );
  assert.ok(resetBlock.length > 0, 'expected to find resetLocalData()');
  assert.match(
    resetBlock,
    /BROWSER_PROFILES_DIR/,
    '"delete all user data" must clear the browser profile: it holds logged-in sessions'
  );
});
