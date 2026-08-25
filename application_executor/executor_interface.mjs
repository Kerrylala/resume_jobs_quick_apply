export const EXECUTOR_MODES = Object.freeze({
  EXTENSION: "extension",
  BROWSER_AGENT: "local_browser_agent",
});

// The Local Browser Agent is the honest V1 default: it supports the full
// review contract (re-scan, learning). Only an explicit request selects the
// experimental extension; unknown or empty values fall back to the default.
export function normalizeExecutorMode(value) {
  return value === EXECUTOR_MODES.EXTENSION ? EXECUTOR_MODES.EXTENSION : EXECUTOR_MODES.BROWSER_AGENT;
}

export class ApplicationExecutor {
  constructor(mode) {
    this.mode = normalizeExecutorMode(mode);
  }

  async execute() {
    throw new Error("ApplicationExecutor.execute must be implemented by a transport.");
  }
}

export function assertExecutionContext(context = {}) {
  const missing = ["session_id", "application_id", "job_id", "package_id", "target_url", "approved_field_mappings"]
    .filter((key) => key === "approved_field_mappings"
      ? !Array.isArray(context[key]) || context[key].length === 0
      : !String(context[key] || "").trim());
  if (missing.length) throw new Error(`Execution context is missing: ${missing.join(", ")}`);
  let url;
  try {
    url = new URL(context.target_url);
  } catch {
    throw new Error("Execution URL must be an absolute HTTP(S) URL.");
  }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Execution URL must use HTTP(S).");
  return {
    ...context,
    target_url: url.href,
    url: url.href,
    run_id: context.session_id,
    executor: normalizeExecutorMode(context.executor_type),
  };
}
