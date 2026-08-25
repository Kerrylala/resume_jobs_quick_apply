import "./shared_core.js";

const core = globalThis.ResumeJobsApplicationExecutorCore;
if (!core) throw new Error("Application Executor shared core failed to load.");

export const DEFAULT_FIELD_MAPPINGS = core.DEFAULT_FIELD_MAPPINGS;
export const normalizeFieldDescriptor = core.normalizeFieldDescriptor;
export const profileValue = core.profileValue;
export const mapField = core.fieldMapping;
export const planField = core.planField;
export const planFields = core.planFields;
