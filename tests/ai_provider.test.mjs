import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AI_PROVIDER_PRESETS,
  AI_PROVIDER_TYPES,
  detectLocalAIProviders,
  AIProviderError,
  aiProviderConfig,
  createAIProvider,
  createMockAIProvider,
  normalizeAIProviderSettings,
  publicAIProviderConfig,
  publicAIProviderSettings
} from '../scripts/lib/ai_provider.mjs';
import { checkLocalModel, loadSavedAIProviderSettings } from '../scripts/check_local_model.mjs';

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(payload)
  };
}

test('disabled AI provider uses fallback and never accesses network', async () => {
  let called = false;
  const provider = createAIProvider({
    env: {},
    fetchImpl: async () => { called = true; }
  });
  const result = await provider.structuredTask({ task: 'synthetic', input: {}, fallback: { ok: true } });
  assert.deepEqual(result.value, { ok: true });
  assert.equal(result.model_used, false);
  assert.equal((await provider.healthCheck()).network_accessed, false);
  assert.equal(called, false);
});

test('legacy LOCAL_LLM environment maps to the unified local provider', () => {
  const config = aiProviderConfig({
    env: {
      LOCAL_LLM_ENABLED: '1',
      LOCAL_LLM_BASE_URL: 'http://127.0.0.1:1234/v1',
      LOCAL_LLM_MODEL: 'synthetic-local',
      LOCAL_LLM_API_KEY: 'secret'
    }
  });
  assert.equal(config.type, 'local_openai_compatible');
  assert.equal(config.source, 'legacy_local_llm_env');
  const publicConfig = publicAIProviderConfig(config);
  assert.equal(publicConfig.credential_configured, true);
  assert.equal(Object.hasOwn(publicConfig, 'apiKey'), false);
  assert.equal(JSON.stringify(publicConfig).includes('secret'), false);
});

test('OpenAI-compatible request uses chat completions and validates JSON', async () => {
  let observed;
  const provider = createAIProvider({
    env: {},
    config: {
      enabled: true,
      type: 'openai_compatible',
      base_url: 'https://models.example.test/v1',
      model: 'synthetic-model',
      api_key: 'synthetic-key',
      input_cost_per_million: 2,
      output_cost_per_million: 8
    },
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return jsonResponse({
        choices: [{ message: { content: '{"summary":"safe"}' } }],
        usage: { prompt_tokens: 1000, completion_tokens: 250, total_tokens: 1250 }
      });
    }
  });
  const result = await provider.structuredTask({
    task: 'job_match_enrichment',
    input: { title: 'Synthetic' },
    fallback: {},
    schema: value => ({ ok: typeof value.summary === 'string' })
  });
  assert.equal(result.value.summary, 'safe');
  assert.equal(observed.url, 'https://models.example.test/v1/chat/completions');
  assert.equal(observed.options.headers.authorization, 'Bearer synthetic-key');
  const requestBody = JSON.parse(observed.options.body);
  assert.equal(requestBody.model, 'synthetic-model');
  assert.equal(requestBody.response_format.type, 'json_schema');
  assert.equal(result.response_format, 'json_schema');
  assert.deepEqual(result.usage, {
    input_tokens: 1000,
    output_tokens: 250,
    total_tokens: 1250,
    estimated_cost_usd: 0.004,
    cost_is_estimate: true
  });
});

test('Career Brain extraction sends the structured semantic contract through the unified gateway', async () => {
  let requestBody;
  const provider = createAIProvider({
    env: {},
    config: {
      enabled: true,
      type: 'local_openai_compatible',
      base_url: 'http://127.0.0.1:1234/v1',
      model: 'synthetic-qwen'
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({
        identity: { full_name: 'Synthetic Candidate' },
        education: [], experience: [], projects: [],
        skills: { programming: ['JavaScript'], ai_tools: [], frameworks: [], cloud: [], data: [], business: [] },
        certifications: [], languages: [], career_goals: [], confidence: 0.9
      }) } }] });
    }
  });
  const result = await provider.structuredTask({
    task: 'career_profile_extraction',
    input: { resume_text: 'synthetic resume' },
    fallback: {},
    schema: value => ({ ok: Array.isArray(value.experience) && Number.isFinite(value.confidence) })
  });
  assert.equal(result.value.identity.full_name, 'Synthetic Candidate');
  assert.equal(requestBody.response_format.json_schema.name, 'career_profile_extraction');
  assert.deepEqual(requestBody.response_format.json_schema.schema.required, [
    'identity', 'education', 'experience', 'projects', 'skills', 'certifications', 'languages', 'career_goals', 'confidence'
  ]);
  assert.match(requestBody.messages[0].content, /Never infer or invent facts/);
  assert.match(requestBody.messages[0].content, /^\/no_think/);
  assert.match(requestBody.messages[1].content, /^\/no_think/);
  assert.equal(requestBody.max_tokens, 4096);
  assert.equal(requestBody.reasoning_effort, 'none');
});

test('OpenAI-compatible structured output negotiates json_schema, json_object, then plain text', async () => {
  const formats = [];
  const provider = createAIProvider({
    env: {},
    config: {
      enabled: true,
      type: 'local_openai_compatible',
      base_url: 'http://127.0.0.1:1234/v1',
      model: 'synthetic-qwen',
      retries: 0
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const format = body.response_format?.type || 'text';
      formats.push(format);
      if (format !== 'text') return jsonResponse({ error: 'unsupported format' }, { ok: false, status: 400 });
      assert.equal(Object.hasOwn(body, 'response_format'), false);
      return jsonResponse({ choices: [{ message: { content: '```json\n{"summary":"fallback worked"}\n```' } }] });
    }
  });
  const result = await provider.structuredTask({
    task: 'job_match_enrichment',
    input: { title: 'Synthetic' },
    fallback: {},
    schema: value => ({ ok: typeof value.summary === 'string' })
  });
  assert.deepEqual(formats, ['json_schema', 'json_object', 'text']);
  assert.equal(result.value.summary, 'fallback worked');
  assert.equal(result.model_used, true);
  assert.equal(result.response_format, 'text');
});

test('schema-invalid structured output negotiates the next supported format', async () => {
  const formats = [];
  const provider = createAIProvider({
    env: {},
    config: { enabled: true, type: 'local_openai_compatible', model: 'fixture-model', timeoutMs: 5000 },
    fetchImpl: async (_url, options) => {
      const format = JSON.parse(options.body).response_format.type;
      formats.push(format);
      const content = format === 'json_schema'
        ? JSON.stringify({ summary: 'missing required fields' })
        : JSON.stringify({ summary: 'ok', skill_matches: [], gaps: [], confidence: 0.5 });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }
  });
  const result = await provider.structuredTask({
    task: 'job_match_enrichment', input: {}, fallback: {},
    schema: value => ({ ok: Array.isArray(value.skill_matches) && Array.isArray(value.gaps) && Number.isFinite(value.confidence) })
  });
  assert.deepEqual(formats, ['json_schema', 'json_object']);
  assert.equal(result.response_format, 'json_object');
});

test('Anthropic request uses messages protocol without exposing credential', async () => {
  let observed;
  const provider = createAIProvider({
    env: {},
    config: {
      enabled: true,
      type: 'anthropic',
      model: 'synthetic-claude',
      api_key: 'synthetic-anthropic-key'
    },
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return jsonResponse({ content: [{ type: 'text', text: '{"summary":"safe"}' }] });
    }
  });
  const result = await provider.structuredTask({
    task: 'resume_summary',
    input: { text: 'synthetic' },
    fallback: {},
    schema: value => value.summary === 'safe'
  });
  assert.equal(result.value.summary, 'safe');
  assert.equal(observed.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(observed.options.headers['x-api-key'], 'synthetic-anthropic-key');
  assert.equal(provider.config.credential_configured, true);
  assert.equal(JSON.stringify(provider.config).includes('synthetic-anthropic-key'), false);
});

test('cloud providers require HTTPS and official providers require credentials', () => {
  assert.throws(
    () => createAIProvider({
      env: {},
      config: { enabled: true, type: 'openai_compatible', base_url: 'http://models.example.test/v1', model: 'x' }
    }),
    error => error instanceof AIProviderError && error.category === 'configuration'
  );
  assert.throws(
    () => createAIProvider({ env: {}, config: { enabled: true, type: 'openai', model: 'x' } }),
    error => error.category === 'configuration'
  );
  assert.throws(
    () => createAIProvider({
      env: {},
      config: { enabled: true, type: 'local_openai_compatible', base_url: 'https://models.example.test/v1', model: 'x' }
    }),
    error => error.category === 'configuration'
  );
});

test('provider errors are bounded, classified, and retried', async () => {
  let calls = 0;
  const provider = createAIProvider({
    env: {},
    config: {
      enabled: true,
      type: 'local_openai_compatible',
      base_url: 'http://127.0.0.1:1234/v1',
      model: 'synthetic'
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new Error('synthetic reset');
      return jsonResponse({ data: [] });
    }
  });
  assert.equal((await provider.healthCheck()).status, 'READY');
  assert.equal(calls, 2);

  const invalid = createAIProvider({
    env: {},
    config: {
      enabled: true,
      type: 'local_openai_compatible',
      base_url: 'http://127.0.0.1:1234/v1',
      model: 'synthetic'
    },
    fetchImpl: async () => jsonResponse({ choices: [{ message: { content: 'not json' } }] })
  });
  await assert.rejects(
    invalid.structuredTask({ task: 'synthetic', input: {}, fallback: {} }),
    error => error.category === 'invalid_structured_output'
  );
});

test('mock AI provider is deterministic and offline', async () => {
  const provider = createMockAIProvider({ explain_match: { explanation: 'synthetic' } });
  assert.equal((await provider.healthCheck()).network_accessed, false);
  assert.deepEqual(
    (await provider.structuredTask({ task: 'explain_match', fallback: {} })).value,
    { explanation: 'synthetic' }
  );
});

test('saved settings preserve an existing credential without returning it', () => {
  const saved = normalizeAIProviderSettings({
    enabled: true,
    type: 'openai',
    model: 'synthetic-model',
    api_key: ''
  }, {
    existing: {
      enabled: true,
      type: 'openai',
      base_url: 'https://api.openai.com/v1',
      model: 'old-model',
      api_key: 'existing-secret',
      timeout_ms: 1000
    }
  });
  assert.equal(saved.api_key, 'existing-secret');
  const publicSettings = publicAIProviderSettings(saved, { env: {} });
  assert.equal(publicSettings.status, 'READY');
  assert.equal(publicSettings.credential_configured, true);
  assert.equal(JSON.stringify(publicSettings).includes('existing-secret'), false);

  const cleared = normalizeAIProviderSettings({ ...saved, enabled: false, clear_api_key: true }, { existing: saved });
  assert.equal(cleared.api_key, '');
});

test('AI health check uses the same ignored saved settings as the Dashboard', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-ai-settings-'));
  try {
    fs.writeFileSync(path.join(dataDir, 'ai_provider.local.json'), JSON.stringify({
      schema_version: '1.0',
      enabled: true,
      type: 'local_openai_compatible',
      base_url: 'http://127.0.0.1:1234/v1',
      model: 'synthetic-local',
      api_key: 'synthetic-local-key',
      timeout_ms: 1000
    }));
    const saved = loadSavedAIProviderSettings({ dataDir });
    assert.equal(saved.model, 'synthetic-local');

    let observedUrl = '';
    const result = await checkLocalModel({
      dataDir,
      fetchImpl: async url => {
        observedUrl = url;
        return jsonResponse({ data: [{ id: 'synthetic-local' }] });
      }
    });
    assert.equal(observedUrl, 'http://127.0.0.1:1234/v1/models');
    assert.equal(result.status, 'READY');
    assert.equal(result.model_count, 1);
    assert.equal(JSON.stringify(result).includes('synthetic-local-key'), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('local model servers are detected without the user typing an endpoint', async () => {
  // The common setup is LM Studio on its default port. Detection uses an
  // injected transport here so the offline suite never touches a socket.
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url.startsWith('http://127.0.0.1:1234')) {
      return { ok: true, json: async () => ({ data: [{ id: 'qwen2.5-14b-instruct' }, { id: 'llama-3.1-8b' }] }) };
    }
    throw new Error('ECONNREFUSED');
  };

  const detected = await detectLocalAIProviders({ fetchImpl });
  assert.equal(detected.length, 1, 'only the reachable local server is reported');
  assert.equal(detected[0].preset_id, 'lm_studio');
  assert.equal(detected[0].type, 'local_openai_compatible');
  assert.deepEqual(detected[0].models, ['qwen2.5-14b-instruct', 'llama-3.1-8b']);
  assert.ok(seen.every(url => url.includes('127.0.0.1')), 'detection must only probe loopback');
});

test('no local model server is a normal outcome, not an error', async () => {
  const detected = await detectLocalAIProviders({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
  });
  assert.deepEqual(detected, []);
});

test('an unreachable or erroring local endpoint is simply not offered', async () => {
  const detected = await detectLocalAIProviders({
    fetchImpl: async () => ({ ok: false, json: async () => ({}) })
  });
  assert.deepEqual(detected, []);
});

test('the provider catalog covers every option the product promises', () => {
  const byId = new Map(AI_PROVIDER_PRESETS.map(preset => [preset.id, preset]));
  for (const id of ['lm_studio', 'ollama', 'vllm', 'openai', 'anthropic', 'gemini', 'openai_compatible', 'disabled']) {
    assert.ok(byId.has(id), `the settings screen must offer ${id}`);
  }
  // Gemini rides the OpenAI-compatible transport rather than adding a protocol.
  assert.equal(byId.get('gemini').type, 'openai_compatible');
  assert.match(byId.get('gemini').base_url, /^https:\/\//, 'a cloud endpoint must be HTTPS');
  assert.equal(byId.get('lm_studio').base_url, 'http://127.0.0.1:1234/v1');
  assert.equal(byId.get('lm_studio').requires_api_key, false, 'a local model needs no credential');

  // Every preset maps onto a real transport type.
  for (const preset of AI_PROVIDER_PRESETS) {
    assert.ok(AI_PROVIDER_TYPES.includes(preset.type), `${preset.id} maps to an unknown type`);
  }
});

test('OpenAI cloud requests use max_completion_tokens and no explicit temperature', async () => {
  // The reasoning-model families reject max_tokens and non-default
  // temperature; a BYO-key user typing a current model name must not 400.
  let requestBody = null;
  const provider = createAIProvider({
    env: {},
    config: { enabled: true, type: 'openai', model: 'gpt-4o-mini', api_key: 'sk-synthetic', retries: 0 },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return jsonResponse({ choices: [{ message: { content: '{"summary":"ok"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    }
  });
  const result = await provider.structuredTask({ task: 'job_summary', input: { text: 'x' }, fallback: {}, schema: () => true });
  assert.equal(result.status, 'ok');
  assert.equal(requestBody.max_completion_tokens, 4096);
  assert.equal(Object.hasOwn(requestBody, 'max_tokens'), false);
  assert.equal(Object.hasOwn(requestBody, 'temperature'), false);
  assert.equal(Object.hasOwn(requestBody, 'reasoning_effort'), false);
});
