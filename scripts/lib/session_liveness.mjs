// Backend-derived session liveness. The persisted `session.connection` blob is
// a historical artifact that is never cleared, so it must not be trusted as a
// live signal: liveness is derived here, per request, from injectable evidence
// (in-memory extension heartbeat, browser-agent PID + status-file timestamps)
// and never written back to stored state.

const ACTIVE_EXECUTION_STATUSES = new Set([
  'EXECUTOR_READY',
  'EXTENSION_CONNECTED',
  'FIELDS_DETECTED',
  'FILLING',
  'NEEDS_REVIEW'
]);

export const DEFAULT_CONNECTION_TTL_MS = 30_000;
export const DEFAULT_SESSION_STALE_TTL_MS = 10 * 60 * 1000;

function parseTime(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function deriveSessionLiveness({
  session = null,
  extensionLastSeenMs = null,
  browserAgentPidAlive = false,
  agentStatusUpdatedAt = null,
  now = Date.now(),
  connectionTtlMs = DEFAULT_CONNECTION_TTL_MS,
  sessionStaleTtlMs = DEFAULT_SESSION_STALE_TTL_MS
} = {}) {
  const reasons = [];
  const executionStatus = String(session?.execution_status || '');
  const executorType = String(session?.executor_type || '');

  let connectionLive = false;
  let connectionSource = 'none';
  let lastSeenAt = null;

  if (executorType === 'extension') {
    if (Number.isFinite(extensionLastSeenMs)) {
      lastSeenAt = new Date(extensionLastSeenMs).toISOString();
      if (now - extensionLastSeenMs <= connectionTtlMs) {
        connectionLive = true;
        connectionSource = 'extension_heartbeat';
      } else {
        reasons.push('extension_heartbeat_expired');
      }
    } else if (session?.connection?.status === 'CONNECTED') {
      connectionSource = 'stale_persisted';
      reasons.push('persisted_connection_not_verifiable');
    } else {
      reasons.push('no_extension_heartbeat');
    }
  } else {
    if (browserAgentPidAlive === true) {
      const statusTime = parseTime(agentStatusUpdatedAt);
      if (statusTime !== null) {
        lastSeenAt = new Date(statusTime).toISOString();
        if (now - statusTime <= sessionStaleTtlMs) {
          connectionLive = true;
          connectionSource = 'pid_and_status_file';
        } else {
          reasons.push('agent_status_file_stale');
        }
      } else {
        connectionLive = true;
        connectionSource = 'pid_only';
        reasons.push('agent_status_timestamp_unavailable');
      }
    } else {
      reasons.push(session?.browser_agent?.process_id ? 'agent_process_not_running' : 'no_agent_process');
    }
  }

  const updatedAtTime = parseTime(session?.updated_at);
  const inactiveForMs = updatedAtTime !== null ? Math.max(0, now - updatedAtTime) : null;
  const isActiveStatus = ACTIVE_EXECUTION_STATUSES.has(executionStatus);
  const sessionStale = isActiveStatus
    && !connectionLive
    && (inactiveForMs === null || inactiveForMs > sessionStaleTtlMs);
  if (sessionStale) reasons.push('active_session_without_live_connection');

  const recoveryAvailable = sessionStale || executionStatus === 'FAILED';

  return {
    connection_live: connectionLive,
    connection_source: connectionSource,
    last_seen_at: lastSeenAt,
    session_stale: sessionStale,
    recovery_available: recoveryAvailable,
    inactive_for_ms: inactiveForMs,
    reasons
  };
}
