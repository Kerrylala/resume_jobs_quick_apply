import { PortalAdapter, hostIs } from "./base_adapter.mjs";
import "../application_executor/shared_core.js";

const definition = globalThis.ResumeJobsApplicationExecutorCore.portalDefinition("workable");

export const workableAdapter = new PortalAdapter({
  id: "workable",
  detect: (url) => hostIs(url, "workable.com"),
  siteRules: definition.site_rules,
  neverFill: definition.never_fill,
});
