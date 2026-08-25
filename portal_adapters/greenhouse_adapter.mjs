import { PortalAdapter, hostIs } from "./base_adapter.mjs";
import "../application_executor/shared_core.js";

const definition = globalThis.ResumeJobsApplicationExecutorCore.portalDefinition("greenhouse");

export const greenhouseAdapter = new PortalAdapter({
  id: "greenhouse",
  detect: (url) => hostIs(url, "greenhouse.io") && (/[?&]gh_jid=/i.test(url) || /\/jobs\//i.test(url) || /\/embed\/job_app(?:\/|\?|$)/i.test(url)),
  siteRules: definition.site_rules,
  neverFill: definition.never_fill,
});
