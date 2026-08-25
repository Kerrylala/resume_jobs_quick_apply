import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { directoryFromMetaUrl, projectRootFromMetaUrl } from '../../scripts/lib/project_paths.mjs';

const root = projectRootFromMetaUrl(import.meta.url, 2);
const providerDir = directoryFromMetaUrl(import.meta.url);
const pythonPath = path.join(root, '.venv_scrapling', 'bin', 'python');
const fetchScript = path.join(providerDir, 'scrapling_fetch.py');

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function parseJson(text) {
  try { return JSON.parse(String(text || '').trim()); }
  catch { return null; }
}

export function scraplingEnvStatus() {
  if (!fs.existsSync(pythonPath)) {
    return { ok: false, status: 'scrapling_env_missing', python: pythonPath };
  }
  const result = spawnSync(pythonPath, ['-c', 'import scrapling; print("scrapling installed")'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000
  });
  if (result.status !== 0) {
    return {
      ok: false,
      status: 'scrapling_not_installed',
      python: pythonPath,
      stderr: String(result.stderr || '').trim().slice(0, 1000)
    };
  }
  return { ok: true, status: 'ok', python: pythonPath };
}

export async function extractPublicMetadata(url, { timeoutMs = 20000 } = {}) {
  const safeUrl = normalizeUrl(url);
  if (!safeUrl) return { ok: false, status: 'invalid_url' };

  const env = scraplingEnvStatus();
  if (!env.ok) return { ...env, url: safeUrl };

  const result = spawnSync(pythonPath, [fetchScript, safeUrl], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    env: { ...process.env, PYTHONNOUSERSITE: '1' }
  });
  const parsed = parseJson(result.stdout) || parseJson(result.stderr);
  if (parsed) return { ...parsed, exit_code: result.status };
  return {
    ok: false,
    status: result.error?.code === 'ETIMEDOUT' ? 'timeout' : 'scrapling_fetch_failed',
    exit_code: result.status,
    stdout_tail: String(result.stdout || '').trim().slice(-1000),
    stderr_tail: String(result.stderr || '').trim().slice(-1000)
  };
}

export default { extractPublicMetadata, scraplingEnvStatus };

if (import.meta.url === `file://${process.argv[1]}`) {
  extractPublicMetadata(process.argv[2] || '').then((result) => {
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  }).catch((error) => {
    console.error(JSON.stringify({ ok: false, status: 'failed', error: error.message }, null, 2));
    process.exit(1);
  });
}
