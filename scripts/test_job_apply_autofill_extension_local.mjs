#!/usr/bin/env node
// Localhost installed-extension test (thin-bridge architecture).
//
// The old harness evaluated the content script into pages through a chrome-API
// shim — it never proved the extension actually worked when installed. This
// wrapper runs the REAL installed-mode acceptance in localhost-only mode: the
// extension is loaded into a Chrome for Testing persistent profile and does
// its own detection, planning, filling, verification and reporting.
//
// Usage: node scripts/test_job_apply_autofill_extension_local.mjs [--output-dir <dir>]
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRootFromMetaUrl } from './lib/project_paths.mjs';

const PROJECT_ROOT = projectRootFromMetaUrl(import.meta.url);
const outputArgIndex = process.argv.indexOf('--output-dir');
const OUTPUT_DIR = outputArgIndex >= 0 && process.argv[outputArgIndex + 1]
  ? path.resolve(process.argv[outputArgIndex + 1])
  : path.join(PROJECT_ROOT, 'reports');
const RESULT_JSON = path.join(OUTPUT_DIR, 'job_apply_autofill_local_test_result_001.json');

const run = spawnSync(process.execPath, [
  path.join(PROJECT_ROOT, 'scripts', 'acceptance_extension_installed.mjs'),
  '--local-only',
  '--result-json', RESULT_JSON,
], { cwd: PROJECT_ROOT, stdio: 'inherit', timeout: 300_000 });

process.exit(run.status === 0 ? 0 : 1);
