// Guards the offline suite against time-dependent rot.
//
// Background: `tests/rescan_freshness.test.mjs` built a scan at a hardcoded
// 2026-08-15 but completed the review against the *real* clock. It passed on
// the day it was written and failed 24 h later, once the review-scan TTL
// elapsed. The suite silently stopped being a regression gate.
//
// Two guards here:
//   1. TTL semantics must be purely relative — the same fixture must behave
//      identically whatever absolute date it is anchored at.
//   2. A static scan for the specific mistake: a success-path call to a
//      clock-injectable review function that omits `now` in a file that
//      otherwise pins time with hardcoded ISO literals.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  completeApplicationReview,
  prepareApplicationExecutionSession,
  recordApplicationExecutionSessionReport,
  recordApplicationReviewRescan,
  startApplicationExecutionSession,
  transitionApplicationState
} from '../scripts/lib/application_state.mjs';

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));

function executionSession(jobId) {
  return {
    schema: 'ApplicationExecutionSession',
    schema_version: '1.1',
    session_id: `session-${jobId}`,
    application_id: `application-${jobId}`,
    job_id: jobId,
    package_id: `package-${jobId}`,
    executor_type: 'extension',
    target_url: `https://jobs.lever.co/acme/${jobId}/apply`,
    execution_status: 'SESSION_CREATED',
    approved_profile_version: {
      profile_id: 'career-reviewed',
      family_id: 'career-reviewed',
      version: 2,
      approved_at: '2026-01-01T00:00:00.000Z',
      snapshot_digest: 'sha256:reviewed'
    },
    approved_field_mappings: [{
      canonical_key: 'email',
      value: 'reviewed@example.test',
      source: 'application_package',
      confidence: 1,
      user_confirmed: true
    }],
    safety: {
      resume_upload_allowed: false,
      sensitive_answers_allowed: false,
      login_allowed: false,
      challenge_bypass_allowed: false,
      final_submit_allowed: false
    },
    idempotency_key: `key-${jobId}`
  };
}

function cleanRescanAt(jobId, now) {
  const packageReady = transitionApplicationState({}, {
    jobId, toStatus: 'PACKAGE_READY', initialStatus: 'APPROVED_FOR_PACKAGE', actor: 'user', now
  });
  const prepared = prepareApplicationExecutionSession(packageReady.state, {
    jobId, actor: 'user', idempotencyKey: `prepare-${jobId}`, session: executionSession(jobId), now
  });
  const started = startApplicationExecutionSession(prepared.state, {
    jobId, actor: 'user', idempotencyKey: `start-${jobId}`, session: prepared.session, now
  });
  const paused = recordApplicationExecutionSessionReport(started.state, {
    jobId, actor: 'browser_agent', now, report: {
      total_fields_seen: 3, filled_fields_count: 2, skipped_fields_count: 1,
      fields_requiring_user_review_count: 1
    }
  });
  const scanned = recordApplicationReviewRescan(paused.state, {
    jobId, actor: 'browser_agent', now, report: {
      scan_id: 'scan-clean', detected_count: 3, required_count: 2,
      required_filled_count: 2, required_empty_count: 0
    }
  });
  return scanned.state;
}

const HOUR = 60 * 60 * 1000;

// Anchors deliberately span past, near-present and far future. If any assertion
// below starts depending on the real calendar, every anchor breaks at once.
const ANCHORS = [
  '2020-01-01T00:00:00.000Z',
  '2026-08-15T00:00:00.000Z',
  '2099-12-31T00:00:00.000Z'
];

test('review-scan freshness is relative to the injected clock, never the calendar', () => {
  for (const anchor of ANCHORS) {
    const base = Date.parse(anchor);
    const jobId = `clock-${base}`;

    // Same instant: review completes.
    const immediate = completeApplicationReview(cleanRescanAt(jobId, anchor), {
      jobId, actor: 'user', confirmed: true, now: anchor
    });
    assert.equal(
      immediate.record.application_status,
      'READY_FOR_MANUAL_SUBMIT',
      `a scan reviewed at its own timestamp must be fresh (anchor ${anchor})`
    );

    // Just inside the 24 h TTL: still fresh.
    const insideTtl = new Date(base + 23 * HOUR).toISOString();
    const late = completeApplicationReview(cleanRescanAt(jobId, anchor), {
      jobId, actor: 'user', confirmed: true, now: insideTtl
    });
    assert.equal(
      late.record.application_status,
      'READY_FOR_MANUAL_SUBMIT',
      `a 23 h old scan must still be fresh (anchor ${anchor})`
    );

    // Past the TTL: rejected, and for the TTL reason specifically.
    const pastTtl = new Date(base + 25 * HOUR).toISOString();
    assert.throws(
      () => completeApplicationReview(cleanRescanAt(jobId, anchor), {
        jobId, actor: 'user', confirmed: true, now: pastTtl
      }),
      error => error.code === 'APPLICATION_REVIEW_RESCAN_STALE' && error.reason === 'scan_expired',
      `a 25 h old scan must expire (anchor ${anchor})`
    );
  }
});

// Functions whose success path is gated on a TTL compared against `now`.
const CLOCK_INJECTABLE_CALLS = ['completeApplicationReview', 'reviewScanFreshness'];

// A clock is "pinned" when a hardcoded timestamp is fed in as `now`, either
// directly (`now: '2026-…'`) or through a helper's default parameter
// (`function stateWithCleanRescan(jobId, { now = '2026-…' })`). Merely
// mentioning an ISO string elsewhere — e.g. a fixture's `approved_at` — does
// not pin the clock and must not be flagged.
const PINNED_NOW = /\bnow\s*[:=]\s*['"]\d{4}-\d{2}-\d{2}T/;

// Returns the balanced-paren argument text starting at the '(' index.
function callArguments(source, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, i);
    }
  }
  return '';
}

// Names of file-local helpers that pin the clock via a default parameter.
// Calling one of these inside a test pins that test's clock.
function pinningHelpers(source) {
  const names = new Set();
  const declaration = /function\s+([A-Za-z0-9_$]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = declaration.exec(source))) {
    if (PINNED_NOW.test(match[2])) names.add(match[1]);
  }
  return names;
}

test('time-pinned tests do not mix a hardcoded clock with the real clock', () => {
  const offenders = [];
  const files = fs.readdirSync(TESTS_DIR).filter(name => name.endsWith('.test.mjs'));

  for (const name of files) {
    const source = fs.readFileSync(path.join(TESTS_DIR, name), 'utf8');
    const helpers = pinningHelpers(source);

    // Scope the check to one test at a time: a file may legitimately contain
    // both time-pinned and real-clock tests. Tests are top level and
    // sequential, so splitting on the `test(` boundary is enough.
    const boundaries = [...source.matchAll(/\btest\(/g)].map(entry => entry.index);
    for (let i = 0; i < boundaries.length; i += 1) {
      const start = boundaries[i];
      const block = source.slice(start, boundaries[i + 1] ?? source.length);

      const pinned = PINNED_NOW.test(block)
        || [...helpers].some(helper => block.includes(`${helper}(`));
      if (!pinned) continue;

      for (const fn of CLOCK_INJECTABLE_CALLS) {
        let cursor = 0;
        for (;;) {
          const index = block.indexOf(`${fn}(`, cursor);
          if (index < 0) break;
          cursor = index + fn.length;

          const args = callArguments(block, index + fn.length);
          if (/\bnow\b/.test(args)) continue;

          // Rejection cases legitimately omit `now`: they assert a throw for a
          // reason checked before the TTL, so the real clock cannot change the
          // outcome. Those calls sit inside `assert.throws(() => ...)`.
          const preceding = block.slice(Math.max(0, index - 200), index);
          if (/assert\.throws\(\s*\(\s*\)\s*=>\s*$/.test(preceding)) continue;

          const line = source.slice(0, start + index).split('\n').length;
          offenders.push(`${name}:${line} calls ${fn}() without an explicit \`now\``);
        }
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'A time-pinned test builds state at a hardcoded timestamp but checks it against '
    + 'the real clock. Pass the same `now` through, or the test will start failing '
    + `once the review-scan TTL elapses.\n${offenders.join('\n')}`
  );
});
