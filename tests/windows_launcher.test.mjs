import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = path.join(projectRoot, 'scripts', 'start_dashboard_windows.ps1');
const powershellPath = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      windowsHide: true,
      ...options
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitForOutput(child, expected, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(expected)) {
        clearTimeout(timeout);
        resolve(output);
      }
    });
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', code => {
      if (!output.includes(expected)) {
        clearTimeout(timeout);
        reject(new Error(`Child exited (${code}) before reporting ${expected}: ${output}`));
      }
    });
  });
}

test('Windows launcher reuses the canonical npm app entry and has bilingual errors', async () => {
  const [launcher, packageJson, batchWrapper, portableWrapper, developerWrapper, server] = await Promise.all([
    readFile(launcherPath, 'utf8'),
    readFile(path.join(projectRoot, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(projectRoot, 'scripts', 'start_dashboard_windows.bat'), 'utf8'),
    readFile(path.join(projectRoot, 'dist', 'ResumeJobs Launcher.cmd'), 'utf8'),
    readFile(path.join(projectRoot, 'tools', 'launchers', 'ResumeJobs Developer.cmd'), 'utf8'),
    readFile(path.join(projectRoot, 'dashboard', 'server.mjs'), 'utf8')
  ]);

  assert.equal(packageJson.scripts.app, 'node dashboard/server.mjs');
  assert.equal(packageJson.scripts.start, packageJson.scripts.app);
  assert.match(launcher, /npm run app|@?'run', 'app'/);
  assert.match(launcher, /缺少 Node\.js/);
  assert.match(launcher, /Node\.js is required/);
  assert.doesNotMatch(launcher, /wsl\.exe|\/mnt\/e\//i);
  assert.doesNotMatch(batchWrapper, /(?<!\r)\n/, 'the .bat wrapper must use Windows CRLF lines');
  assert.doesNotMatch(portableWrapper, /(?<!\r)\n/, 'the portable .cmd wrapper must use Windows CRLF lines');
  assert.doesNotMatch(developerWrapper, /(?<!\r)\n/, 'the developer .cmd wrapper must use Windows CRLF lines');
  assert.match(developerWrapper, /-DeveloperMode/);
  assert.match(launcher, /X-Resume-Jobs-Shutdown-Token/);
  assert.match(server, /RESUME_JOBS_SHUTDOWN_TOKEN/);
  assert.match(server, /\/api\/runtime\/shutdown/);
});

test('launcher reports missing Node.js without a PowerShell stack', { skip: process.platform !== 'win32' }, async () => {
  const system32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const result = await run(
    powershellPath,
    ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, '-CheckOnly', '-NoBrowser'],
    { env: { ...process.env, PATH: system32 } }
  );

  assert.equal(result.code, 1);
  assert.match(result.stdout, /Node\.js is required/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /at <ScriptBlock>|CategoryInfo|FullyQualifiedErrorId/);
});

test('launcher detects an unrelated process on the requested port', { skip: process.platform !== 'win32' }, async () => {
  const port = await getFreePort();
  const dummy = spawn(
    process.execPath,
    ['-e', `require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end('{}')}).listen(${port},'127.0.0.1',()=>console.log('ready'))`],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
  );

  try {
    await waitForOutput(dummy, 'ready');
    const result = await run(
      powershellPath,
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcherPath, '-CheckOnly', '-NoBrowser', '-Port', String(port)]
    );
    assert.equal(result.code, 1);
    assert.match(result.stdout, new RegExp(`Port ${port} is already used by another program`));
  } finally {
    dummy.kill();
  }
});

test('launcher starts the Dashboard from isolated data and stops only its process tree', { skip: process.platform !== 'win32' }, async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), 'resume-jobs-launcher-'));
  const port = await getFreePort();
  const dataDir = path.join(sandbox, 'data');
  const reportsDir = path.join(sandbox, 'reports');
  const applicationsDir = path.join(sandbox, 'applications');
  const archiveDir = path.join(sandbox, 'archive');
  await Promise.all([dataDir, reportsDir, applicationsDir, archiveDir].map(directory => mkdir(directory)));

  try {
    const result = await run(
      powershellPath,
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        launcherPath,
        '-SmokeTest',
        '-NoBrowser',
        '-Port',
        String(port)
      ],
      {
        env: {
          ...process.env,
          RESUME_JOBS_DATA_DIR: dataDir,
          RESUME_JOBS_REPORTS_DIR: reportsDir,
          RESUME_JOBS_APPLICATIONS_DIR: applicationsDir,
          RESUME_JOBS_ARCHIVE_DIR: archiveDir
        }
      }
    );

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Resume Jobs started successfully/);
    assert.match(result.stdout, /Launcher smoke test passed/);

    await new Promise(resolve => setTimeout(resolve, 500));
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/api/summary`, { signal: AbortSignal.timeout(1000) })
    );
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
