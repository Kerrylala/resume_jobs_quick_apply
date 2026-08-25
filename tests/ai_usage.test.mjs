import assert from 'node:assert/strict';
import test from 'node:test';
import { appendAIUsageEvent, summarizeAIUsage } from '../scripts/lib/ai_usage.mjs';

test('AI usage records only technical metadata and aggregates tokens and estimated cost', () => {
  let store = {};
  ({ store } = appendAIUsageEvent(store, {
    task: 'career_profile_extraction', provider: 'openai', model: 'fixture',
    input_tokens: 1000, output_tokens: 200, estimated_cost_usd: 0.012,
    candidate_name: 'must be discarded'
  }, { now: '2026-08-09T00:00:00.000Z' }));
  ({ store } = appendAIUsageEvent(store, {
    task: 'semantic_job_match', provider: 'openai', model: 'fixture',
    input_tokens: 500, output_tokens: 100, estimated_cost_usd: 0.004
  }, { now: '2026-08-09T00:01:00.000Z' }));
  const summary = summarizeAIUsage(store);
  assert.equal(summary.totals.calls, 2);
  assert.equal(summary.totals.total_tokens, 1800);
  assert.equal(summary.totals.estimated_cost_usd, 0.016);
  assert.equal(store.events[0].contains_candidate_values, false);
  assert.equal(Object.hasOwn(store.events[0], 'candidate_name'), false);
});

