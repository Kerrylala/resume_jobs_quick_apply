import { planFields } from "../application_executor/field_mapper.mjs";
import { createApplicationExecution, assertRedactedExecutionReport } from "../application_executor/execution_report.mjs";

export class PortalAdapter {
  constructor({ id, detect, siteRules = [], neverFill = [] }) {
    this.id = id;
    this.siteRules = siteRules;
    this.neverFill = neverFill;
    this._detect = detect;
  }

  detect(target) {
    const value = typeof target === "string" ? target : target?.url;
    return Boolean(this._detect(String(value || "")));
  }

  async get_fields(runtime) {
    if (!runtime || typeof runtime.getFields !== "function") {
      throw new Error(`${this.id} adapter requires a runtime.getFields function.`);
    }
    return runtime.getFields();
  }

  map_fields(fields, context = {}) {
    return planFields(fields, {
      ...context,
      site_rules: this.siteRules.concat(Array.isArray(context.site_rules) ? context.site_rules : []),
      safety: {
        ...(context.safety || {}),
        never_fill: this.neverFill.concat(context.safety?.never_fill || []),
      },
    });
  }

  async fill_fields(runtime, plans) {
    if (!runtime || typeof runtime.fillField !== "function") {
      throw new Error(`${this.id} adapter requires a runtime.fillField function.`);
    }
    const results = [];
    for (const plan of Array.isArray(plans) ? plans : []) {
      if (plan.action !== "fill" || !plan.mapping) {
        results.push({
          field: plan.field,
          outcome: "skipped",
          reason: plan.reason || "not_approved_for_fill",
        });
        continue;
      }
      try {
        const filled = await runtime.fillField(plan.field, plan.mapping.value, plan);
        // A string result is an honest refusal with its reason (e.g. a
        // combobox whose option list never yielded an unambiguous match).
        if (typeof filled === "string") {
          results.push({
            field: plan.field,
            mapping_key: plan.mapping.key,
            source: plan.mapping.source,
            confidence: plan.mapping.confidence,
            outcome: "skipped",
            reason: filled,
          });
          continue;
        }
        results.push({
          field: plan.field,
          mapping_key: plan.mapping.key,
          source: plan.mapping.source,
          confidence: plan.mapping.confidence,
          outcome: filled === false ? "failed" : "filled",
          reason: filled === false ? "failed_setter" : (plan.reason || "filled_safe_field"),
        });
      } catch (error) {
        results.push({
          field: plan.field,
          mapping_key: plan.mapping.key,
          source: plan.mapping.source,
          confidence: plan.mapping.confidence,
          outcome: "failed",
          reason: "failed_setter",
        });
      }
    }
    return results;
  }

  report(context, fieldResults) {
    return assertRedactedExecutionReport(createApplicationExecution({
      ...context,
      portal: this.id,
      fields: fieldResults,
    }));
  }
}

export function hostIs(urlValue, expected) {
  try {
    const host = new URL(urlValue).hostname.toLowerCase();
    return host === expected || host.endsWith(`.${expected}`);
  } catch {
    return false;
  }
}
