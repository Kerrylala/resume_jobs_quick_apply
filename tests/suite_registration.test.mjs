// The offline suite is an explicit file list in package.json, not a glob. That
// makes it easy to add a test file and never notice it is not running — which
// already happened once while building Quick Apply: a whole contract test file
// sat unregistered and silently contributed nothing.
//
// A test suite that quietly skips tests is worse than no suite, because it
// still reports green.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TESTS_DIR, '..');

// Runs under a different command because it drives Windows launcher scripts
// rather than product logic (`npm run test:launcher`).
const INTENTIONALLY_SEPARATE = new Set(['tests/windows_launcher.test.mjs']);

test('every test file is actually part of the offline suite', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const offline = pkg.scripts['test:offline'] || '';
  const registered = new Set(offline.match(/tests\/[A-Za-z0-9_.-]+\.test\.mjs/g) || []);

  const present = fs.readdirSync(TESTS_DIR)
    .filter(name => name.endsWith('.test.mjs'))
    .map(name => `tests/${name}`);

  const unregistered = present.filter(file => !registered.has(file) && !INTENTIONALLY_SEPARATE.has(file));
  assert.deepEqual(
    unregistered, [],
    `These test files exist but never run in \`npm test\`:\n  ${unregistered.join('\n  ')}\n`
    + 'Add them to the test:offline script, or list them in INTENTIONALLY_SEPARATE with a reason.'
  );

  const missingFiles = [...registered].filter(file => !fs.existsSync(path.join(ROOT, file)));
  assert.deepEqual(
    missingFiles, [],
    `The offline suite lists files that do not exist:\n  ${missingFiles.join('\n  ')}`
  );
});

test('the separate-suite allowlist stays honest', () => {
  // A file may only be excluded while it genuinely exists and genuinely runs
  // somewhere else.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const allScripts = Object.values(pkg.scripts).join(' ');
  for (const file of INTENTIONALLY_SEPARATE) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} is allowlisted but does not exist`);
    assert.ok(
      allScripts.includes(file),
      `${file} is excluded from the offline suite but no package script runs it`
    );
  }
});
