// Requirement: API keys, local model endpoints and personal material stay on
// this machine and never enter Git.
//
// The repository has no .git yet, so this cannot be checked by asking Git. It
// checks the two things that actually decide the outcome: that .gitignore
// covers every path the server writes candidate data to, and that no product
// source file carries a credential or a personal absolute path.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function gitignoreRules() {
  return fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));
}

// Every location the product writes user material to.
const CANDIDATE_DATA_PATHS = [
  'data/career_profiles.local.json',
  'data/candidate_profile.local.json',
  'data/question_bank.json',
  'data/resume_profiles.json',
  'data/form_field_memory.local.json',
  'data/learning_candidates.local.json',
  'data/ai_provider.local.json',
  'data/job_leads.json',
  'data/dashboard_state.json',
  // Nested stores. `data/*.json` does not match these, which is exactly the
  // kind of gap that silently commits a resume.
  'data/resume_drafts/index.json',
  'documents/resumes/synthetic.pdf',
  'documents/resume_drafts/job_x/draft.docx',
  'documents/cover_letters/job_x/letter.json',
  'applications/job_x/application_profile.json',
  'browser_profiles/resume-jobs-agent/Cookies',
  'browser_sessions/session-x/status.json',
  'archive/career_profiles.local.json.2026-01-01.bak',
  'profile.local.json'
];

// Minimal gitignore matcher: enough for the rule shapes this file uses.
function isIgnored(rules, filePath) {
  return rules.some(rule => {
    if (rule.startsWith('!')) return false;
    if (rule.endsWith('/')) {
      const prefix = rule.slice(0, -1);
      // `data/*/` ignores any subdirectory of data/.
      if (prefix.endsWith('/*')) {
        const parent = prefix.slice(0, -2);
        const rest = filePath.startsWith(`${parent}/`) ? filePath.slice(parent.length + 1) : '';
        return rest.includes('/');
      }
      return filePath === prefix || filePath.startsWith(`${prefix}/`);
    }
    if (rule.includes('*')) {
      const pattern = new RegExp(`^${rule.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
      return pattern.test(filePath);
    }
    return filePath === rule || filePath.startsWith(`${rule}/`);
  });
}

test('every path the product writes candidate data to is gitignored', () => {
  const rules = gitignoreRules();
  const leaking = CANDIDATE_DATA_PATHS.filter(filePath => !isIgnored(rules, filePath));
  assert.deepEqual(
    leaking, [],
    `These candidate-data paths are not covered by .gitignore and would be committed:\n  ${leaking.join('\n  ')}`
  );
});

test('product source carries no credentials or personal absolute paths', () => {
  const sourceDirs = [
    'scripts', 'dashboard', 'application_executor', 'browser_agent',
    'providers', 'portal_adapters', 'tools'
  ];
  // The release auditor legitimately contains the leak-detector pattern itself.
  const ALLOWED = new Set([path.join('scripts', 'audit_github_release.mjs')]);

  const patterns = [
    [/sk-[A-Za-z0-9]{20,}/, 'an OpenAI-style API key'],
    [/AIza[A-Za-z0-9_-]{30,}/, 'a Google API key'],
    [/sk-ant-[A-Za-z0-9_-]{20,}/, 'an Anthropic API key'],
    [/Bearer\s+[A-Za-z0-9._-]{24,}/, 'a hardcoded bearer token'],
    [/[A-Z]:\\+(?:AI_Work|Users)\\+/i, 'a personal absolute Windows path']
  ];

  const offenders = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(path.join(ROOT, directory), { withFileTypes: true })) {
      const relative = path.join(directory, entry.name);
      if (entry.isDirectory()) { walk(relative); continue; }
      if (!/\.(mjs|js|json)$/.test(entry.name)) continue;
      if (ALLOWED.has(relative)) continue;
      const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
      for (const [pattern, label] of patterns) {
        if (pattern.test(source)) offenders.push(`${relative}: ${label}`);
      }
    }
  };
  for (const directory of sourceDirs) walk(directory);

  assert.deepEqual(offenders, [], `Product source must stay publishable:\n  ${offenders.join('\n  ')}`);
});

test('the settings API never returns a stored credential', () => {
  // publicAIProviderConfig is the only shape handed back to a client.
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'ai_provider.mjs'), 'utf8');
  const publicConfig = source.slice(
    source.indexOf('export function publicAIProviderConfig'),
    source.indexOf('export function normalizeAIProviderSettings')
  );
  assert.ok(publicConfig.length > 0, 'expected to find publicAIProviderConfig');
  assert.match(
    publicConfig, /credential_configured:\s*Boolean\(/,
    'the public config must report only whether a credential exists'
  );
  assert.equal(
    /\bapiKey\b\s*[,}]/.test(publicConfig.replace(/credential_configured:\s*Boolean\(apiKey\)/, '')),
    false,
    'the public config must never carry the key itself'
  );
});

test('local model endpoints are restricted to loopback', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'ai_provider.mjs'), 'utf8');
  assert.match(
    source,
    /Local AI provider endpoint must use localhost or a loopback address/,
    'a "local" provider must not be pointed at a remote host'
  );
  assert.match(
    source,
    /Remote AI provider endpoints must use HTTPS/,
    'a remote endpoint must not be plain HTTP'
  );
});
