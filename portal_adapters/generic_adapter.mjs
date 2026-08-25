import { PortalAdapter } from "./base_adapter.mjs";
import "../application_executor/shared_core.js";

const definition = globalThis.ResumeJobsApplicationExecutorCore.portalDefinition("generic");

export const genericAdapter = new PortalAdapter({
  id: "generic",
  detect: (url) => /^https?:\/\//i.test(url),
  siteRules: definition.site_rules,
  neverFill: definition.never_fill,
});
