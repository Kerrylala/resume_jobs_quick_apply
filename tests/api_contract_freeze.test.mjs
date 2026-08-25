// The frozen API contract, enforced.
//
// docs/developer/QUICK_APPLY_API_CONTRACT.md is what the new UI will be built
// against, so it must not be allowed to drift from the server. The chain here
// is: the document lists routes → this test's FROZEN table must match the
// document exactly → every FROZEN entry must be registered in the server.
// Break any link and the suite fails, naming what moved.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC_PATH = path.join(ROOT, 'docs', 'developer', 'QUICK_APPLY_API_CONTRACT.md');
const SERVER_PATH = path.join(ROOT, 'dashboard', 'server.mjs');

// method + doc route + the exact source snippet that proves registration.
// Param routes are registered as regexes in the server; the snippet is the
// distinctive part of that regex source.
const FROZEN = [
  ['GET', '/api/profile/full', "'/api/profile/full'"],
  ['GET', '/api/application-profile', "'/api/application-profile'"],
  ['PUT', '/api/application-profile', "'/api/application-profile'"],
  ['POST', '/api/profile/undo', "'/api/profile/undo'"],
  ['POST', '/api/settings/resume-upload', "'/api/settings/resume-upload'"],
  ['POST', '/api/settings/resume-profiles/:id/manage', 'resume-profiles\\/([^/]+)\\/manage'],
  ['POST', '/api/settings/resume-profiles/:id/approve', 'resume-profiles\\/([^/]+)\\/approve'],
  ['POST', '/api/jobs/import', "'/api/jobs/import'"],
  ['POST', '/api/jobs/search', "'/api/jobs/search'"],
  ['POST', '/api/jobs/discover-in-browser', "'/api/jobs/discover-in-browser'"],
  ['GET', '/api/jobs/discover-in-browser/status', "'/api/jobs/discover-in-browser/status'"],
  ['POST', '/api/jobs/discover-in-browser/continue', "'/api/jobs/discover-in-browser/continue'"],
  ['GET', '/api/search/profile-directions', "'/api/search/profile-directions'"],
  ['GET', '/api/search/plans', "'/api/search/plans'"],
  ['POST', '/api/search/plans', "'/api/search/plans'"],
  ['DELETE', '/api/search/plans/:id', 'searchPlanMatch'],
  ['POST', '/api/search/run', "'/api/search/run'"],
  ['GET', '/api/search/run/status', "'/api/search/run/status'"],
  ['POST', '/api/search/run/stop', "'/api/search/run/stop'"],
  ['POST', '/api/jobs/:id/flag', 'flagMatch'],
  ['POST', '/api/jobs/import-url', "'/api/jobs/import-url'"],
  ['POST', '/api/jobs/import-company-careers', "'/api/jobs/import-company-careers'"],
  ['GET', '/api/jobs', "'/api/jobs'"],
  ['POST', '/api/jobs/clear-search-records', 'clear-search-records'],
  ['GET', '/api/summary', "'/api/summary'"],
  ['POST', '/api/run/scoring', "'/api/run/scoring'"],
  ['POST', '/api/jobs/:id/approve', 'approve|reject|save|manual-review|restore|reconsider|reset'],
  ['POST', '/api/jobs/:id/reject', 'approve|reject|save|manual-review|restore|reconsider|reset'],
  ['POST', '/api/jobs/:id/save', 'approve|reject|save|manual-review|restore|reconsider|reset'],
  ['POST', '/api/jobs/:id/restore', 'approve|reject|save|manual-review|restore|reconsider|reset'],
  ['POST', '/api/jobs/:id/reconsider', 'approve|reject|save|manual-review|restore|reconsider|reset'],
  ['POST', '/api/jobs/:id/resume-draft', 'resume-draft$'],
  ['POST', '/api/jobs/:id/resume-draft/export', 'resume-draft\\/export'],
  ['GET', '/api/jobs/:id/resume-draft/file', 'resume-draft\\/file'],
  ['GET', '/api/jobs/:id/resume-draft', 'resume-draft$'],
  ['DELETE', '/api/jobs/:id/resume-draft', 'resume-draft$'],
  ['POST', '/api/jobs/:id/cover-letter', 'cover-letter$'],
  ['GET', '/api/jobs/:id/cover-letter', 'cover-letter$'],
  ['DELETE', '/api/jobs/:id/cover-letter', 'cover-letter$'],
  ['POST', '/api/jobs/:id/quick-apply', 'quick-apply$'],
  ['POST', '/api/jobs/:id/quick-apply/start', 'quick-apply\\/start'],
  ['GET', '/api/jobs/:id/apply-state', 'apply-state$'],
  ['POST', '/api/jobs/:id/continue-after-verification', 'continue-after-verification'],
  ['POST', '/api/jobs/:id/review-rescan', 'review-rescan$'],
  ['POST', '/api/jobs/:id/review-complete', 'review-complete'],
  ['POST', '/api/jobs/:id/submitted-manually', 'submitted-manually'],
  ['POST', '/api/jobs/:id/cancel-application', 'cancel-application'],
  ['GET', '/api/jobs/:id/learning-candidates', 'learningCandidatesMatch'],
  ['POST', '/api/jobs/:id/learning-candidates/:candidateId/decision', 'learningCandidateDecisionMatch'],
  ['POST', '/api/jobs/:id/restart-fill-setup', 'restart-fill-setup'],
  ['GET', '/api/applications/:id/checklist', 'checklist'],
  ['GET', '/api/applications/history', "'/api/applications/history'"],
  ['GET', '/api/ai/status', "'/api/ai/status'"],
  ['GET', '/api/ai/detect-local', "'/api/ai/detect-local'"],
  ['POST', '/api/settings/ai-provider', "'/api/settings/ai-provider'"],
  ['POST', '/api/settings/ai-provider/test', "'/api/settings/ai-provider/test'"],
  ['GET', '/api/answers', "'/api/answers'"],
  ['POST', '/api/answers', "'/api/answers'"],
  ['GET', '/api/answers/:id', 'answers\\/([^/]+)'],
  ['PUT', '/api/answers/:id', 'answers\\/([^/]+)'],
  ['DELETE', '/api/answers/:id', 'answers\\/([^/]+)'],
  ['GET', '/api/settings', "'/api/settings'"],
  ['GET', '/api/extension/diagnostics', "'/api/extension/diagnostics'"],
  ['GET', '/api/extension/active-hosts', "'/api/extension/active-hosts'"],
  ['POST', '/api/jobs/:id/fill-current-step', 'fill-current-step'],
  ['POST', '/api/settings/search-preferences', "'/api/settings/search-preferences'"],
  ['POST', '/api/data/clear-job-materials', "'/api/data/clear-job-materials'"],
  ['POST', '/api/settings/reset-local-data', "'/api/settings/reset-local-data'"],
  ['GET', '/api/events', "'/api/events'"]
];

const VOCABULARY = [
  'found', 'saved', 'rejected', 'ready_to_open', 'preparing', 'filling', 'needs_you',
  'awaiting_verification', 'ready_to_submit', 'applied', 'manual_only'
];

test('the contract document and the frozen table agree exactly', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const documented = new Set(
    [...doc.matchAll(/`(GET|POST|PUT|DELETE) (\/api\/[^\s`]+)`/g)]
      .map(match => `${match[1]} ${match[2]}`)
  );
  const frozen = new Set(FROZEN.map(([method, route]) => `${method} ${route}`));

  const inDocOnly = [...documented].filter(entry => !frozen.has(entry));
  const inTableOnly = [...frozen].filter(entry => !documented.has(entry));
  assert.deepEqual(inDocOnly, [], `Routes documented but not frozen in this test:\n  ${inDocOnly.join('\n  ')}`);
  assert.deepEqual(inTableOnly, [], `Routes frozen here but missing from the document:\n  ${inTableOnly.join('\n  ')}`);
});

test('every frozen route is actually registered in the server', () => {
  const server = fs.readFileSync(SERVER_PATH, 'utf8');
  const missing = FROZEN
    .filter(([, , snippet]) => !server.includes(snippet))
    .map(([method, route]) => `${method} ${route}`);
  assert.deepEqual(
    missing, [],
    `Frozen routes with no matching registration in dashboard/server.mjs:\n  ${missing.join('\n  ')}`
  );
});

test('the frozen state vocabulary matches the server word for word', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  for (const word of VOCABULARY) {
    assert.ok(doc.includes(word), `the contract document must list "${word}"`);
  }

  const server = fs.readFileSync(SERVER_PATH, 'utf8');
  const block = server.slice(
    server.indexOf('const PUBLIC_APPLICATION_STATUS'),
    server.indexOf('function handleApplyState')
  );
  assert.ok(block.length > 0, 'expected to find PUBLIC_APPLICATION_STATUS');
  const serverWords = new Set([...block.matchAll(/:\s*'([a-z_]+)'/g)].map(match => match[1]));
  // awaiting_verification is not part of the status map: handleApplyState
  // assigns it directly when a challenge is live. It is still public
  // vocabulary, so it belongs in the comparison.
  const applyState = server.slice(
    server.indexOf('function handleApplyState'),
    server.indexOf('async function handleDetectLocalAI')
  );
  if (applyState.includes("'awaiting_verification'")) serverWords.add('awaiting_verification');
  assert.deepEqual(
    [...serverWords].sort(),
    [...new Set(VOCABULARY)].sort(),
    'the public vocabulary in the server must equal the frozen set — extending it means extending the contract first'
  );
});

test('the contract states the two rules the UI must follow', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  assert.match(doc, /renders state; it never derives it/i);
  assert.match(doc, /apply-state/);
  assert.match(doc, /Anything not listed here is internal/i);
});
