import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  directoryFromMetaUrl,
  isMainModule,
  projectRootFromMetaUrl
} from '../scripts/lib/project_paths.mjs';

const PROJECT_ROOT = path.resolve(directoryFromMetaUrl(import.meta.url), '..');

test('project root resolves from a script URL on the current platform', () => {
  const scriptUrl = pathToFileURL(path.join(PROJECT_ROOT, 'scripts', 'resume_jobs_cli.mjs'));
  assert.equal(projectRootFromMetaUrl(scriptUrl), PROJECT_ROOT);
});

test('file URLs are decoded before path operations', () => {
  const encodedDirectory = path.join(PROJECT_ROOT, 'tmp path');
  const scriptUrl = pathToFileURL(path.join(encodedDirectory, 'script.mjs'));
  assert.equal(directoryFromMetaUrl(scriptUrl), encodedDirectory);
});

test('invalid traversal levels fail explicitly', () => {
  assert.throws(
    () => projectRootFromMetaUrl(import.meta.url, -1),
    /non-negative integer/
  );
});

test('main-module detection uses platform file URL semantics', () => {
  const script = path.join(PROJECT_ROOT, 'scripts', 'resume_jobs_cli.mjs');
  assert.equal(isMainModule(pathToFileURL(script).href, script), true);
  assert.equal(isMainModule(import.meta.url, script), false);
});
