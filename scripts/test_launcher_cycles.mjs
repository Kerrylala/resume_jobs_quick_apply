import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runLauncherTests() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', 'tests/windows_launcher.test.mjs'], {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore']
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Launcher regression exited with code ${code}.`)));
  });
}

function dashboardProcessCount() {
  if (process.platform !== 'win32') return 0;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-Command',
    "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'dashboard[/\\\\]server\\.mjs' } | Measure-Object).Count"
  ], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  if (result.status !== 0) throw new Error('Could not inspect Dashboard process count.');
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}

function launcherTempCount() {
  return fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('resume-jobs-launcher-')).length;
}

const initialDashboards = dashboardProcessCount();
const initialTemporaryDirectories = launcherTempCount();
for (let cycle = 1; cycle <= 10; cycle += 1) {
  try { await runLauncherTests(); }
  catch (error) { throw new Error(`Launcher cycle ${cycle} failed: ${error.message}`); }
}
await new Promise(resolve => setTimeout(resolve, 1000));
const finalDashboards = dashboardProcessCount();
const finalTemporaryDirectories = launcherTempCount();
assert.equal(finalDashboards, initialDashboards);
assert.equal(finalTemporaryDirectories, initialTemporaryDirectories);

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  launcher_start_stop_cycles: 10,
  launcher_contract_checks: 10,
  missing_node_message_checks: 10,
  port_conflict_message_checks: 10,
  extra_dashboard_processes: finalDashboards - initialDashboards,
  extra_launcher_temp_directories: finalTemporaryDirectories - initialTemporaryDirectories
}, null, 2)}\n`);
