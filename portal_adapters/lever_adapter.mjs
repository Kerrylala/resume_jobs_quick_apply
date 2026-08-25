import { PortalAdapter, hostIs } from "./base_adapter.mjs";
import "../application_executor/shared_core.js";

const definition = globalThis.ResumeJobsApplicationExecutorCore.portalDefinition("lever");

export const leverAdapter = new PortalAdapter({
  id: "lever",
  detect: (url) => hostIs(url, "jobs.lever.co") && /\/apply(?:\/|$|\?)/i.test(url),
  siteRules: definition.site_rules,
  neverFill: definition.never_fill,
});
