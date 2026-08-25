import { leverAdapter } from "./lever_adapter.mjs";
import { greenhouseAdapter } from "./greenhouse_adapter.mjs";
import { ashbyAdapter } from "./ashby_adapter.mjs";
import { smartrecruitersAdapter } from "./smartrecruiters_adapter.mjs";
import { workableAdapter } from "./workable_adapter.mjs";
import { genericAdapter } from "./generic_adapter.mjs";

export { PortalAdapter } from "./base_adapter.mjs";
export { leverAdapter, greenhouseAdapter, ashbyAdapter, smartrecruitersAdapter, workableAdapter, genericAdapter };

export const portalAdapters = Object.freeze([
  leverAdapter,
  greenhouseAdapter,
  ashbyAdapter,
  smartrecruitersAdapter,
  workableAdapter,
  genericAdapter,
]);

export function adapterForUrl(url) {
  return portalAdapters.find((adapter) => adapter.detect(url)) || genericAdapter;
}
