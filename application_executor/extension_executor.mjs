import { ApplicationExecutor, EXECUTOR_MODES, assertExecutionContext } from "./executor_interface.mjs";
import { createApplicationExecution, assertRedactedExecutionReport } from "./execution_report.mjs";

export class ExtensionExecutor extends ApplicationExecutor {
  constructor() {
    super(EXECUTOR_MODES.EXTENSION);
  }

  async execute(context = {}) {
    const safe = assertExecutionContext({ ...context, executor: this.mode });
    return {
      executor: this.mode,
      status: "waiting_for_extension",
      session: safe,
    };
  }

  normalizeReport(context = {}, fields = [], extra = {}) {
    return assertRedactedExecutionReport(createApplicationExecution({
      ...context,
      ...extra,
      executor: this.mode,
      fields,
    }));
  }
}
