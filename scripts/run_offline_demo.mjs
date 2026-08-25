import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildOfflineDemoSummary,
  renderOfflineDemoHtml
} from './lib/offline_demo_report.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const noOpen = args.has('--no-open') || process.env.RESUME_JOBS_DEMO_NO_OPEN === '1';
const keepTemp = args.has('--keep-temp');
const browserExecutable = [
  process.env.CHROME_PATH,
  process.env.CHROMIUM_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium'
].filter(Boolean).find(candidate => fs.existsSync(candidate));

function fail(message, detail = '') {
  console.error(`\nOffline Demo failed / 离线演示失败\n${message}`);
  if (detail) console.error(detail);
  process.exitCode = 1;
}

function openReport(filePath) {
  if (process.platform === 'win32') {
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" "${filePath}"`], {
      windowsHide: true,
      stdio: 'ignore'
    });
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawnSync(command, [filePath], { stdio: 'ignore' });
}

function copyScreenshots(runRoot, outputDirectory, summary) {
  const sourceDirectory = path.join(runRoot, 'browser', 'job_apply_autofill_test_screenshots');
  const targetDirectory = path.join(outputDirectory, 'screenshots');
  fs.mkdirSync(targetDirectory, { recursive: true });
  const copied = [];
  for (const fileName of summary.screenshots) {
    const source = path.join(sourceDirectory, fileName);
    if (!fs.existsSync(source)) continue;
    fs.copyFileSync(source, path.join(targetDirectory, fileName));
    copied.push(fileName);
  }
  summary.screenshots = copied;
}

if (!browserExecutable) {
  fail(
    'Chrome or Microsoft Edge is required. / 需要安装 Chrome 或 Microsoft Edge。',
    'No browser was opened and no project data was changed.'
  );
} else {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-offline-demo-'));
  const timestamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
  const outputDirectory = path.join(PROJECT_ROOT, 'output', 'offline_demo', timestamp);

  console.log('Resume Jobs AI Agent — Offline Demo');
  console.log('Using synthetic data and localhost only. / 仅使用合成数据与 localhost。');
  console.log('Running the existing end-to-end workflow...\n');

  const testResult = spawnSync(process.execPath, [
    '--import',
    './tests/offline_test_guard.mjs',
    '--test',
    path.join(PROJECT_ROOT, 'tests', 'product_workflow_e2e.test.mjs')
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      CHROME_PATH: browserExecutable,
      RESUME_JOBS_E2E_ROOT: runRoot
    },
    encoding: 'utf8',
    timeout: 180000
  });

  if (testResult.status !== 0) {
    fail(
      'The verified workflow did not complete. / 已验证流程未完成。',
      `${testResult.stdout || ''}\n${testResult.stderr || ''}`.trim()
    );
  } else {
    try {
      const summary = buildOfflineDemoSummary(runRoot);
      fs.mkdirSync(outputDirectory, { recursive: true });
      copyScreenshots(runRoot, outputDirectory, summary);
      fs.writeFileSync(
        path.join(outputDirectory, 'report.json'),
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(outputDirectory, 'index.html'),
        renderOfflineDemoHtml(summary),
        'utf8'
      );

      console.log(`Demo result: ${summary.success ? 'PASS' : 'CHECK'}`);
      console.log(`Pipeline: ${summary.pipeline.passed_steps}/${summary.pipeline.total_steps}`);
      console.log(`Application Completion Rate: ${summary.completion.final_rate}%`);
      console.log(`Field Memory improvement: +${summary.completion.field_memory_improvement_points} points`);
      console.log(`Final state: ${summary.outcome}`);
      console.log('Final Submit clicked: false');
      console.log(`Report: ${path.join(outputDirectory, 'index.html')}`);

      if (!summary.success) {
        process.exitCode = 1;
      } else if (!noOpen) {
        openReport(path.join(outputDirectory, 'index.html'));
      }
    } catch (error) {
      fail(error?.message || String(error), error?.stack || '');
    }
  }

  if (!keepTemp) {
    fs.rmSync(runRoot, { recursive: true, force: true });
  } else {
    console.log(`Temporary evidence retained: ${runRoot}`);
  }
}
