import "./shared_core.js";

const core = globalThis.ResumeJobsApplicationExecutorCore;
if (!core) throw new Error("Application Executor shared core failed to load.");

export const APPLICATION_EXECUTION_SCHEMA_VERSION = core.SCHEMA_VERSION;
export const sanitizeFieldResult = core.sanitizeFieldResult;
export const createApplicationExecution = core.createApplicationExecution;

export function assertRedactedExecutionReport(report) {
  const serialized = JSON.stringify(report || {});
  if (/"value"\s*:/i.test(serialized)) throw new Error("Application execution reports must not persist field values.");
  if (report?.safety?.final_submit !== false || report?.safety?.submit_attempted !== false) {
    throw new Error("Application execution report violates the no-submit safety contract.");
  }
  return report;
}
