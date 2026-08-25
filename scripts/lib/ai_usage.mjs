function text(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function normalizeAIUsageEvent(input = {}, { now = new Date().toISOString() } = {}) {
  return {
    event_id: text(input.event_id) || `ai_usage_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`,
    recorded_at: text(input.recorded_at) || now,
    task: text(input.task),
    provider: text(input.provider),
    model: text(input.model),
    response_format: text(input.response_format),
    status: text(input.status) || 'ok',
    latency_ms: Math.round(number(input.latency_ms)),
    input_tokens: Math.round(number(input.input_tokens)),
    output_tokens: Math.round(number(input.output_tokens)),
    total_tokens: Math.round(number(input.total_tokens || number(input.input_tokens) + number(input.output_tokens))),
    estimated_cost_usd: Number(number(input.estimated_cost_usd).toFixed(8)),
    contains_candidate_values: false
  };
}

export function appendAIUsageEvent(store = {}, input = {}, { now = new Date().toISOString(), maxEvents = 2000 } = {}) {
  const events = Array.isArray(store?.events) ? store.events.map(event => normalizeAIUsageEvent(event)) : [];
  const event = normalizeAIUsageEvent(input, { now });
  return {
    store: {
      schema_version: '1.0',
      events: [...events, event].slice(-Math.max(1, maxEvents))
    },
    event
  };
}

export function summarizeAIUsage(store = {}) {
  const events = (Array.isArray(store?.events) ? store.events : []).map(event => normalizeAIUsageEvent(event));
  const byTask = {};
  for (const event of events) {
    const key = event.task || 'unknown';
    const summary = byTask[key] || { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 };
    summary.calls += 1;
    summary.input_tokens += event.input_tokens;
    summary.output_tokens += event.output_tokens;
    summary.total_tokens += event.total_tokens;
    summary.estimated_cost_usd += event.estimated_cost_usd;
    byTask[key] = summary;
  }
  const totals = Object.values(byTask).reduce((result, item) => ({
    calls: result.calls + item.calls,
    input_tokens: result.input_tokens + item.input_tokens,
    output_tokens: result.output_tokens + item.output_tokens,
    total_tokens: result.total_tokens + item.total_tokens,
    estimated_cost_usd: result.estimated_cost_usd + item.estimated_cost_usd
  }), { calls: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: 0 });
  totals.estimated_cost_usd = Number(totals.estimated_cost_usd.toFixed(8));
  for (const item of Object.values(byTask)) item.estimated_cost_usd = Number(item.estimated_cost_usd.toFixed(8));
  return {
    schema_version: '1.0',
    totals,
    by_task: byTask,
    last_event_at: events.at(-1)?.recorded_at || '',
    privacy: { candidate_values_recorded: false }
  };
}

