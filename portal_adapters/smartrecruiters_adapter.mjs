import { PortalAdapter, hostIs } from "./base_adapter.mjs";
import "../application_executor/shared_core.js";

const definition = globalThis.ResumeJobsApplicationExecutorCore.portalDefinition("smartrecruiters");

export const smartrecruitersAdapter = new PortalAdapter({
  id: "smartrecruiters",
  detect: (url) => hostIs(url, "smartrecruiters.com"),
  siteRules: definition.site_rules,
  neverFill: definition.never_fill,
});
