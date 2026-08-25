import { PortalAdapter, hostIs } from "./base_adapter.mjs";
import "../application_executor/shared_core.js";

const definition = globalThis.ResumeJobsApplicationExecutorCore.portalDefinition("ashby");

export const ashbyAdapter = new PortalAdapter({
  id: "ashby",
  detect: (url) => hostIs(url, "ashbyhq.com") && !/\/(?:privacy|terms)(?:\/|$)/i.test(url),
  siteRules: definition.site_rules,
  neverFill: definition.never_fill,
});
