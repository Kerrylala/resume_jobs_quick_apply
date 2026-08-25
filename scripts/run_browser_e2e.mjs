// Runs the product workflow E2E with its real-Chromium stage enabled.
//
// The offline suite (`npm test`) deliberately runs that stage against a
// deterministic stand-in so its result never depends on the locally installed
// browser version. This runner opts back in. It exists as a script rather than
// an inline `VAR=1 ...` npm script because npm scripts run through cmd.exe on
// Windows, where that syntax is not supported.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const child = spawn(process.execPath, [
  '--import', './tests/offline_test_guard.mjs',
  '--test', 'tests/product_workflow_e2e.test.mjs'
], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: { ...process.env, RESUME_JOBS_E2E_BROWSER: '1' }
});

child.on('close', code => process.exit(code ?? 1));
