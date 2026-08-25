import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { isMainModule, projectRootFromMetaUrl } from './lib/project_paths.mjs';

const root = projectRootFromMetaUrl(import.meta.url);
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.html', '.css', '.ps1', '.bat', '.cmd', '.yml', '.yaml', '.toml']);
const PRIVATE_RUNTIME = /^(?:\.openclaw|archive|applications|browser_profiles|browser_sessions|documents\/resumes|goal_mode|logs|output|tmp)(?:\/|$)|^reports\/(?!\.gitkeep$)|^data\/(?!README\.md$).+\.json$|\.local\.json$/i;
const PRIVATE_BINARY = /\.(?:pdf|docx|doc|rtf|lnk)$/i;
const GENERATED_SCREENSHOT = /^(?:reports|browser_sessions)\/.*\.(?:png|jpe?g|webp)$/i;
const COMPILED_CACHE = /(?:^|\/)(?:__pycache__\/.*\.pyc|.*\.pyc)$/i;
const PRIVATE_CONFIG = /(^|\/)(?:\.env(?:\..+)?|credentials?\.json|secrets?\.json|cookies?\.json)$/i;
const SECRET_PATTERNS = [
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*\b/gi,
  /(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\s${}<]{12,}["']/gi
];
// Standard system install paths (for example C:\Program Files or its WSL
// spelling) are portable browser-discovery candidates. User homes and
// project-specific workspaces are not.
const ABSOLUTE_LOCAL_PATH = /(?:[A-Z]:\\(?:Users|AI_Work)\\|\/mnt\/[a-z]\/(?:Users|AI_Work)\/|\/home\/[^/\s]+\/)/i;
const PRIVATE_URL_TOKEN = /https?:\/\/[^\s"')]+[?&](?:token|auth|signature|sig|key|code)=([^\s&"')]+)/ig;

function containsPossibleSecret(file, content) {
  return SECRET_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content))) {
      const lineStart = content.lastIndexOf('\n', match.index) + 1;
      const lineEnd = content.indexOf('\n', match.index);
      const line = content.slice(lineStart, lineEnd < 0 ? content.length : lineEnd);
      if (/^tests\//i.test(file) && /(?:synthetic|test|example|placeholder|dummy|redacted|existing-secret)/i.test(line)) continue;
      return true;
    }
    return false;
  });
}

function containsPrivateUrlToken(file, content) {
  PRIVATE_URL_TOKEN.lastIndex = 0;
  let match;
  while ((match = PRIVATE_URL_TOKEN.exec(content))) {
    const token = match[1] || '';
    const isDocumentedFixture = /^tests\//i.test(file)
      && /(?:\.example(?:\.test)?|localhost|127\.0\.0\.1)/i.test(match[0]);
    if (token.length >= 16 && !isDocumentedFixture) return true;
  }
  return false;
}

function gitLines(args) {
  return execFileSync('git', ['-c', 'core.quotepath=false', ...args, '-z'], {
    cwd: root,
    encoding: 'buffer',
    windowsHide: true
  }).toString('utf8').split('\0').filter(Boolean).map(value => value.replaceAll('\\', '/'));
}

function releaseFiles() {
  const candidates = new Set([
    ...gitLines(['ls-files', '--cached']),
    ...gitLines(['ls-files', '--others', '--exclude-standard'])
  ]);
  return [...candidates].filter(relative => fs.existsSync(path.join(root, relative)) && fs.statSync(path.join(root, relative)).isFile()).sort();
}

function add(findings, category, file) {
  if (!findings[category]) findings[category] = [];
  if (!findings[category].includes(file)) findings[category].push(file);
}

export function auditGithubRelease() {
  const files = releaseFiles();
  const findings = {};
  for (const file of files) {
    const normalized = file.replaceAll('\\', '/');
    if (PRIVATE_RUNTIME.test(normalized)) add(findings, 'tracked_or_release_runtime_data', normalized);
    if (PRIVATE_BINARY.test(normalized)) add(findings, 'resume_or_document_binary', normalized);
    if (GENERATED_SCREENSHOT.test(normalized)) add(findings, 'generated_runtime_screenshot', normalized);
    if (COMPILED_CACHE.test(normalized)) add(findings, 'compiled_runtime_cache', normalized);
    if (PRIVATE_CONFIG.test(normalized)) add(findings, 'private_configuration', normalized);
    const extension = path.extname(normalized).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const absolute = path.join(root, file);
    if (fs.statSync(absolute).size > 2 * 1024 * 1024) continue;
    const content = fs.readFileSync(absolute, 'utf8');
    if (containsPossibleSecret(normalized, content)) add(findings, 'possible_secret_literal', normalized);
    if (ABSOLUTE_LOCAL_PATH.test(content)) add(findings, 'absolute_local_path', normalized);
    if (containsPrivateUrlToken(normalized, content)) add(findings, 'url_with_private_token', normalized);
  }

  const server = fs.readFileSync(path.join(root, 'dashboard', 'server.mjs'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extensions', 'application_assistant', 'manifest.json'), 'utf8'));
  const permissions = [...(manifest.permissions || []), ...(manifest.host_permissions || [])];
  const safety = {
    dashboard_loopback_default: /const HOST = ['"]127\.0\.0\.1['"]/.test(server),
    shutdown_requires_private_runtime_token: /RESUME_JOBS_SHUTDOWN_TOKEN/.test(server),
    extension_has_native_messaging: permissions.includes('nativeMessaging'),
    extension_requests_all_urls: permissions.includes('<all_urls>'),
    final_submit_enabled_in_manifest: /submit|upload/i.test((manifest.permissions || []).join(' '))
  };
  const findingCount = Object.values(findings).reduce((sum, items) => sum + items.length, 0);
  return {
    status: findingCount === 0 && safety.dashboard_loopback_default && !safety.extension_has_native_messaging && !safety.extension_requests_all_urls
      ? 'ready'
      : 'blocked',
    release_file_count: files.length,
    finding_count: findingCount,
    findings,
    safety
  };
}

if (isMainModule(import.meta.url)) {
  const result = auditGithubRelease();
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'ready') process.exitCode = 1;
}
