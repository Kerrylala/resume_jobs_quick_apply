// Browser detection for the agent: env override → local Chrome for Testing →
// branded Chrome/Edge, and the honest prediction of whether a build can load
// the bundled extension (branded Chrome 137+ cannot).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  agentBrowserCandidates,
  detectChromeForTesting,
  executableSupportsLoadExtension
} from '../scripts/lib/agent_browser.mjs';

test('Chrome for Testing is detected from the local runtime directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
  assert.equal(detectChromeForTesting(root), '', 'no runtime installed → empty');
  const chromeDir = path.join(root, 'browser_runtime', 'chrome', 'win64-152.0.1.0', 'chrome-win64');
  fs.mkdirSync(chromeDir, { recursive: true });
  fs.writeFileSync(path.join(chromeDir, 'chrome.exe'), 'stub');
  const detected = detectChromeForTesting(root);
  assert.ok(detected.endsWith('chrome.exe'));
  assert.ok(detected.includes('browser_runtime'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('detection order: env override first, then the local runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'));
  const chromeDir = path.join(root, 'browser_runtime', 'chrome', 'win64-152.0.1.0', 'chrome-win64');
  fs.mkdirSync(chromeDir, { recursive: true });
  fs.writeFileSync(path.join(chromeDir, 'chrome.exe'), 'stub');
  const previous = process.env.RESUME_JOBS_CHROME_EXECUTABLE;
  try {
    process.env.RESUME_JOBS_CHROME_EXECUTABLE = 'C:/custom/chrome.exe';
    const candidates = agentBrowserCandidates(root);
    assert.equal(candidates[0], 'C:/custom/chrome.exe');
    assert.ok(candidates[1].includes('browser_runtime'));
  } finally {
    if (previous === undefined) delete process.env.RESUME_JOBS_CHROME_EXECUTABLE;
    else process.env.RESUME_JOBS_CHROME_EXECUTABLE = previous;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('only non-branded builds are predicted to load the extension', () => {
  assert.equal(executableSupportsLoadExtension('E:/proj/browser_runtime/chrome/win64-152/chrome-win64/chrome.exe'), true);
  assert.equal(executableSupportsLoadExtension('/usr/bin/chromium'), true);
  assert.equal(executableSupportsLoadExtension('C:/Program Files/Google/Chrome/Application/chrome.exe'), false);
  assert.equal(executableSupportsLoadExtension('C:/Program Files/Microsoft/Edge/Application/msedge.exe'), false);
  assert.equal(executableSupportsLoadExtension(''), false);
});
