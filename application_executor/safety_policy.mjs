import "./shared_core.js";

const core = globalThis.ResumeJobsApplicationExecutorCore;
if (!core) throw new Error("Application Executor shared core failed to load.");

export const classifyFieldSafety = core.classifyFieldSafety;
export const classifyPageSafety = core.classifyPageSafety;
// Same URL comparison the page-safety classifier uses, so callers that need to
// check "are we still on the approved page?" cannot drift from it.
export const comparableExecutionUrl = core.comparableExecutionUrl;
// And the same application-scope rule (multi-step wizards walk several URLs
// on one host) — agent and classifier share one implementation.
export const withinApplicationScope = core.withinApplicationScope;

export function assertSafeExecutionRequest(context = {}) {
  if (context.final_submit || context.submit || context.login || context.solve_challenge) {
    throw new Error("Unsafe execution request: login, challenge handling, and submission are disabled.");
  }
  if (context.upload_resume) {
    // Resume upload is the one automated file action the user can authorize —
    // and only with a per-job authorization that names this very job and the
    // exact file fingerprint. Anything less keeps the old hard refusal.
    const authorization = context.resume_upload_authorization;
    const jobId = String(context.job_id || "");
    const authorized = authorization
      && authorization.job_id != null
      && String(authorization.job_id) === jobId
      && jobId !== ""
      && typeof authorization.sha256 === "string"
      && authorization.sha256.length > 0;
    if (!authorized) {
      throw new Error("Unsafe execution request: resume upload without a matching per-job authorization is disabled.");
    }
  }
  return true;
}

export function safeExecutionFlags() {
  return {
    upload_attempted: false,
    login_attempted: false,
    challenge_attempted: false,
    submit_attempted: false,
    final_submit: false,
  };
}
