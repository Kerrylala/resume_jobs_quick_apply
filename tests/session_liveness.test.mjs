import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveSessionLiveness } from '../scripts/lib/session_liveness.mjs';

const NOW = Date.parse('2026-08-15T12:00:00.000Z');

function extensionSession(overrides = {}) {
  return {
    executor_type: 'extension',
    execution_status: 'EXTENSION_CONNECTED',
    updated_at: '2026-08-15T11:00:00.000Z',
    connection: { status: 'CONNECTED', connected_at: '2026-08-14T00:00:00.000Z' },
    ...overrides
  };
}

function agentSession(overrides = {}) {
  return {
    executor_type: 'local_browser_agent',
    execution_status: 'FILLING',
    updated_at: '2026-08-15T11:59:30.000Z',
    browser_agent: { process_id: 4321 },
    ...overrides
  };
}

test('a fresh extension heartbeat is live; the persisted connection blob alone is not', () => {
  const live = deriveSessionLiveness({
    session: extensionSession(),
    extensionLastSeenMs: NOW - 5_000,
    now: NOW
  });
  assert.equal(live.connection_live, true);
  assert.equal(live.connection_source, 'extension_heartbeat');
  assert.equal(live.session_stale, false);

  const persistedOnly = deriveSessionLiveness({ session: extensionSession(), now: NOW });
  assert.equal(persistedOnly.connection_live, false);
  assert.equal(persistedOnly.connection_source, 'stale_persisted');
  assert.ok(persistedOnly.reasons.includes('persisted_connection_not_verifiable'));
});

test('an expired extension heartbeat is not live', () => {
  const result = deriveSessionLiveness({
    session: extensionSession(),
    extensionLastSeenMs: NOW - 60_000,
    now: NOW
  });
  assert.equal(result.connection_live, false);
  assert.ok(result.reasons.includes('extension_heartbeat_expired'));
});

test('browser agent liveness needs the PID and a recent status file timestamp', () => {
  const live = deriveSessionLiveness({
    session: agentSession(),
    browserAgentPidAlive: true,
    agentStatusUpdatedAt: '2026-08-15T11:58:00.000Z',
    now: NOW
  });
  assert.equal(live.connection_live, true);
  assert.equal(live.connection_source, 'pid_and_status_file');

  const staleFile = deriveSessionLiveness({
    session: agentSession(),
    browserAgentPidAlive: true,
    agentStatusUpdatedAt: '2026-08-15T10:00:00.000Z',
    now: NOW
  });
  assert.equal(staleFile.connection_live, false);
  assert.ok(staleFile.reasons.includes('agent_status_file_stale'));

  const pidOnly = deriveSessionLiveness({
    session: agentSession(),
    browserAgentPidAlive: true,
    now: NOW
  });
  assert.equal(pidOnly.connection_live, true);
  assert.equal(pidOnly.connection_source, 'pid_only');
});

test('a crashed agent makes an executing session stale and recoverable after the TTL', () => {
  const result = deriveSessionLiveness({
    session: agentSession({ updated_at: '2026-08-15T11:00:00.000Z' }),
    browserAgentPidAlive: false,
    now: NOW
  });
  assert.equal(result.connection_live, false);
  assert.equal(result.session_stale, true);
  assert.equal(result.recovery_available, true);
  assert.ok(result.reasons.includes('agent_process_not_running'));
});

test('a recently updated session is not yet stale even without a live connection', () => {
  const result = deriveSessionLiveness({
    session: agentSession({ updated_at: new Date(NOW - 30_000).toISOString() }),
    browserAgentPidAlive: false,
    now: NOW
  });
  assert.equal(result.session_stale, false);
  assert.equal(result.recovery_available, false);
});

test('terminal and inactive statuses are never marked stale; FAILED is recoverable', () => {
  for (const execution_status of ['SESSION_CREATED', 'READY_FOR_MANUAL_SUBMIT', 'CANCELLED', 'COMPLETE']) {
    const result = deriveSessionLiveness({
      session: agentSession({ execution_status, updated_at: '2026-08-15T00:00:00.000Z' }),
      browserAgentPidAlive: false,
      now: NOW
    });
    assert.equal(result.session_stale, false, execution_status);
    assert.equal(result.recovery_available, false, execution_status);
  }
  const failed = deriveSessionLiveness({
    session: agentSession({ execution_status: 'FAILED' }),
    browserAgentPidAlive: false,
    now: NOW
  });
  assert.equal(failed.recovery_available, true);
});

test('the stale TTL is configurable per call', () => {
  const result = deriveSessionLiveness({
    session: agentSession({ updated_at: new Date(NOW - 120_000).toISOString() }),
    browserAgentPidAlive: false,
    now: NOW,
    sessionStaleTtlMs: 60_000
  });
  assert.equal(result.session_stale, true);
});
