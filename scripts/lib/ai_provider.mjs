const PROVIDER_TYPES = new Set([
  'disabled',
  'local_openai_compatible',
  'openai',
  'anthropic',
  'openai_compatible'
]);

const DEFAULTS = Object.freeze({
  type: 'disabled',
  model: '',
  baseUrls: {
    local_openai_compatible: 'http://127.0.0.1:1234/v1',
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    openai_compatible: ''
  },
  timeoutMs: 15000,
  retries: 1,
  maxResponseBytes: 1024 * 1024
});

export const AI_PROVIDER_TYPES = Object.freeze([...PROVIDER_TYPES]);

// What the settings screen offers. Each preset is only a label plus defaults —
// the transport is still one of the types above, so adding a provider here
// never adds a new protocol path. Gemini rides the OpenAI-compatible endpoint
// Google publishes, which is why it needs no adapter of its own.
export const AI_PROVIDER_PRESETS = Object.freeze([
  {
    id: 'lm_studio', label: 'LM Studio', local: true,
    type: 'local_openai_compatible', base_url: 'http://127.0.0.1:1234/v1', requires_api_key: false
  },
  {
    id: 'ollama', label: 'Ollama', local: true,
    type: 'local_openai_compatible', base_url: 'http://127.0.0.1:11434/v1', requires_api_key: false
  },
  {
    id: 'vllm', label: 'vLLM', local: true,
    type: 'local_openai_compatible', base_url: '', requires_api_key: false
  },
  {
    id: 'openai', label: 'OpenAI', local: false,
    type: 'openai', base_url: 'https://api.openai.com/v1', requires_api_key: true
  },
  {
    id: 'anthropic', label: 'Anthropic Claude', local: false,
    type: 'anthropic', base_url: 'https://api.anthropic.com/v1', requires_api_key: true
  },
  {
    id: 'gemini', label: 'Google Gemini', local: false,
    type: 'openai_compatible',
    base_url: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    requires_api_key: true
  },
  {
    id: 'openai_compatible', label: 'OpenAI-compatible API', local: false,
    type: 'openai_compatible', base_url: '', requires_api_key: true
  },
  {
    id: 'disabled', label: 'No AI', local: false,
    type: 'disabled', base_url: '', requires_api_key: false
  }
]);

// Loopback endpoints probed when the settings screen opens.
export const LOCAL_AI_PROBE_TARGETS = Object.freeze([
  { preset_id: 'lm_studio', label: 'LM Studio', base_url: 'http://127.0.0.1:1234/v1' },
  { preset_id: 'ollama', label: 'Ollama', base_url: 'http://127.0.0.1:11434/v1' }
]);

// Asks a loopback OpenAI-compatible server which models it has loaded.
// Never throws and never reports an error to the user: a missing local model
// server is the normal case, not a failure.
export async function detectLocalAIProviders({
  targets = LOCAL_AI_PROBE_TARGETS,
  timeoutMs = 2000,
  fetchImpl = globalThis.fetch
} = {}) {
  const probe = async target => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${target.base_url.replace(/\/$/, '')}/models`, {
        method: 'GET', signal: controller.signal
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const models = Array.isArray(payload?.data)
        ? payload.data.map(entry => String(entry?.id || '')).filter(Boolean).slice(0, 100)
        : [];
      return { ...target, type: 'local_openai_compatible', models };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const found = await Promise.all(targets.map(probe));
  return found.filter(Boolean);
}

export class AIProviderError extends Error {
  constructor(category, message, details = {}) {
    super(message);
    this.name = 'AIProviderError';
    this.code = 'AI_PROVIDER_ERROR';
    this.category = category;
    this.details = details;
  }
}

function booleanValue(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeType(value) {
  const type = String(value || '').trim().toLowerCase();
  if (!PROVIDER_TYPES.has(type)) {
    throw new AIProviderError('configuration', `Unsupported AI provider type: ${type || '(empty)'}`);
  }
  return type;
}

function normalizeBaseUrl(value, type) {
  const baseUrl = String(value || DEFAULTS.baseUrls[type] || '').trim().replace(/\/+$/, '');
  if (type === 'disabled') return '';
  if (!baseUrl) throw new AIProviderError('configuration', 'AI provider endpoint is required.');
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AIProviderError('configuration', 'AI provider endpoint must be a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new AIProviderError('configuration', 'AI provider endpoint must use HTTP or HTTPS.');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname);
  if (type === 'local_openai_compatible' && !loopback) {
    throw new AIProviderError('configuration', 'Local AI provider endpoint must use localhost or a loopback address.');
  }
  if (!loopback && parsed.protocol !== 'https:') {
    throw new AIProviderError('configuration', 'Remote AI provider endpoints must use HTTPS.');
  }
  return baseUrl;
}

function legacyLocalConfig(env) {
  const present = Object.keys(env || {}).some(key => key.startsWith('LOCAL_LLM_'));
  if (!present) return null;
  return {
    enabled: env.LOCAL_LLM_ENABLED === '1',
    type: 'local_openai_compatible',
    baseUrl: env.LOCAL_LLM_BASE_URL,
    model: env.LOCAL_LLM_MODEL,
    apiKey: env.LOCAL_LLM_API_KEY,
    timeoutMs: env.LOCAL_LLM_TIMEOUT_MS
  };
}

export function aiProviderConfig({ env = process.env, config = {} } = {}) {
  const hasUnifiedEnv = Object.keys(env || {}).some(key => key.startsWith('AI_PROVIDER_'));
  const legacy = hasUnifiedEnv ? null : legacyLocalConfig(env);
  const source = {
    ...(legacy || {}),
    ...config
  };
  const requestedType = source.type
    ?? env.AI_PROVIDER_TYPE
    ?? (legacy ? 'local_openai_compatible' : DEFAULTS.type);
  const enabled = booleanValue(
    source.enabled ?? env.AI_PROVIDER_ENABLED,
    legacy?.enabled ?? false
  );
  const type = enabled ? normalizeType(requestedType === 'disabled' ? 'disabled' : requestedType) : 'disabled';
  const timeoutMs = Number(source.timeoutMs ?? source.timeout_ms ?? env.AI_PROVIDER_TIMEOUT_MS ?? DEFAULTS.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new AIProviderError('configuration', 'AI provider timeout must be between 100 and 120000 ms.');
  }
  const retries = Number(source.retries ?? DEFAULTS.retries);
  if (!Number.isInteger(retries) || retries < 0 || retries > 3) {
    throw new AIProviderError('configuration', 'AI provider retries must be between 0 and 3.');
  }
  const baseUrl = normalizeBaseUrl(
    source.baseUrl ?? source.base_url ?? env.AI_PROVIDER_BASE_URL,
    type
  );
  const apiKey = String(source.apiKey ?? source.api_key ?? env.AI_PROVIDER_API_KEY ?? '').trim();
  const model = String(source.model ?? env.AI_PROVIDER_MODEL ?? '').trim();
  const inputCostPerMillion = Number(source.inputCostPerMillion ?? source.input_cost_per_million ?? 0);
  const outputCostPerMillion = Number(source.outputCostPerMillion ?? source.output_cost_per_million ?? 0);
  if (![inputCostPerMillion, outputCostPerMillion].every(value => Number.isFinite(value) && value >= 0)) {
    throw new AIProviderError('configuration', 'AI provider token costs must be zero or positive numbers.');
  }
  if (type !== 'disabled' && !model) {
    throw new AIProviderError('configuration', 'AI provider model is required when AI is enabled.');
  }
  if (['openai', 'anthropic'].includes(type) && !apiKey) {
    throw new AIProviderError('configuration', `${type} requires an API key when enabled.`);
  }
  return {
    enabled: type !== 'disabled',
    type,
    baseUrl,
    model,
    apiKey,
    timeoutMs,
    retries,
    inputCostPerMillion,
    outputCostPerMillion,
    maxResponseBytes: DEFAULTS.maxResponseBytes,
    source: legacy ? 'legacy_local_llm_env' : (Object.keys(config).length ? 'explicit_config' : 'environment')
  };
}

export function publicAIProviderConfig(config) {
  return {
    enabled: config.enabled === true,
    type: config.type,
    base_url: config.baseUrl,
    model: config.model,
    timeout_ms: config.timeoutMs,
    credential_configured: Boolean(config.apiKey),
    source: config.source,
    advisory_only: true,
    deterministic_state_changes: false,
    input_cost_per_million: config.inputCostPerMillion,
    output_cost_per_million: config.outputCostPerMillion
  };
}

export function normalizeAIProviderSettings(input = {}, { existing = {} } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const previous = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const type = normalizeType(source.type ?? previous.type ?? 'local_openai_compatible');
  const apiKeyInput = Object.hasOwn(source, 'api_key') ? String(source.api_key || '').trim() : null;
  const apiKey = source.clear_api_key === true
    ? ''
    : apiKeyInput
      ? apiKeyInput
      : String(previous.api_key || '');
  const settings = {
    schema_version: '1.1',
    enabled: source.enabled === true,
    type,
    base_url: String(source.base_url ?? previous.base_url ?? DEFAULTS.baseUrls[type] ?? '').trim(),
    model: String(source.model ?? previous.model ?? '').trim(),
    api_key: apiKey,
    timeout_ms: Number(source.timeout_ms ?? previous.timeout_ms ?? DEFAULTS.timeoutMs),
    input_cost_per_million: Number(source.input_cost_per_million ?? previous.input_cost_per_million ?? 0),
    output_cost_per_million: Number(source.output_cost_per_million ?? previous.output_cost_per_million ?? 0)
  };
  aiProviderConfig({ env: {}, config: settings });
  return settings;
}

export function publicAIProviderSettings(settings, { env = process.env } = {}) {
  try {
    const hasSavedSettings = settings && typeof settings === 'object' && Object.keys(settings).length > 0;
    const config = aiProviderConfig(hasSavedSettings
      ? { env: {}, config: settings }
      : { env });
    const selectedType = hasSavedSettings
      ? normalizeType(settings.type || 'local_openai_compatible')
      : (config.type === 'disabled' ? 'local_openai_compatible' : config.type);
    const selectedBaseUrl = hasSavedSettings
      ? String(settings.base_url || DEFAULTS.baseUrls[selectedType] || '')
      : (config.baseUrl || DEFAULTS.baseUrls[selectedType] || '');
    const selectedModel = hasSavedSettings ? String(settings.model || '') : config.model;
    const publicConfig = publicAIProviderConfig(config);
    return {
      ...publicConfig,
      type: selectedType,
      base_url: selectedBaseUrl,
      model: selectedModel,
      status: config.enabled ? 'READY' : 'DISABLED',
      message: config.enabled
        ? `${selectedType} is configured for advisory AI tasks. Deterministic product rules remain authoritative.`
        : 'AI assistance is disabled. Search, scoring, and the application workflow still work deterministically.'
    };
  } catch (error) {
    return {
      enabled: settings?.enabled === true,
      type: String(settings?.type || 'local_openai_compatible'),
      base_url: String(settings?.base_url || ''),
      model: String(settings?.model || ''),
      timeout_ms: Number(settings?.timeout_ms || DEFAULTS.timeoutMs),
      credential_configured: Boolean(settings?.api_key),
      source: settings && Object.keys(settings).length ? 'local_settings' : 'environment',
      advisory_only: true,
      deterministic_state_changes: false,
      status: 'MISCONFIGURED',
      message: error?.message || 'AI provider configuration is invalid.'
    };
  }
}

function endpoint(config, path) {
  return `${config.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function requestHeaders(config) {
  if (config.type === 'anthropic') {
    return {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(config.apiKey ? { 'x-api-key': config.apiKey } : {})
    };
  }
  return {
    'content-type': 'application/json',
    ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {})
  };
}

async function requestJson(url, options, config, fetchImpl) {
  if (typeof fetchImpl !== 'function') throw new AIProviderError('configuration', 'No fetch implementation is available.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal });
    const declaredLength = Number(response.headers?.get?.('content-length') || 0);
    if (declaredLength > config.maxResponseBytes) {
      throw new AIProviderError('response_too_large', 'AI provider response exceeds the size limit.');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > config.maxResponseBytes) {
      throw new AIProviderError('response_too_large', 'AI provider response exceeds the size limit.');
    }
    if (!response.ok) {
      throw new AIProviderError('http', `AI provider returned HTTP ${response.status}.`, { status: response.status });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AIProviderError('invalid_json', 'AI provider returned invalid JSON.');
    }
  } catch (error) {
    if (error instanceof AIProviderError) throw error;
    if (error?.name === 'AbortError') {
      throw new AIProviderError('timeout', `AI provider timed out after ${config.timeoutMs} ms.`);
    }
    throw new AIProviderError('network', 'AI provider request failed.', {
      message: error?.message || String(error)
    });
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry(operation, retries, retryCategories = ['network', 'timeout', 'http']) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!retryCategories.includes(error.category) || attempt === retries) throw error;
    }
  }
  throw lastError;
}

function taskOutputContract(task) {
  if (task === 'career_profile_extraction') {
    const stringArray = { type: 'array', items: { type: 'string' } };
    return {
      instruction: 'Extract only facts supported by the resume. Return identity, education, experience, projects, skills, certifications, languages, career_goals, and confidence. Use empty values when unknown. Never infer or invent facts.',
      schema: {
        type: 'object',
        properties: {
          identity: { type: 'object', additionalProperties: true },
          education: { type: 'array', items: { type: 'object', additionalProperties: true } },
          experience: { type: 'array', items: { type: 'object', additionalProperties: true } },
          projects: { type: 'array', items: { type: 'object', additionalProperties: true } },
          skills: {
            type: 'object',
            properties: {
              programming: stringArray,
              ai_tools: stringArray,
              frameworks: stringArray,
              cloud: stringArray,
              data: stringArray,
              business: stringArray
            },
            additionalProperties: false
          },
          certifications: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
          languages: { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
          career_goals: stringArray,
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['identity', 'education', 'experience', 'projects', 'skills', 'certifications', 'languages', 'career_goals', 'confidence'],
        additionalProperties: false
      }
    };
  }
  if (task === 'semantic_job_match') {
    return {
      instruction: 'Return score, recommendation, strengths, weaknesses, missing, immediate_fit, career_growth_value, skill_gaps, recommended_action, career_reason, and confidence. Explain present-day fit separately from long-term career growth. Treat unknown facts as unknown and do not override supplied deterministic filters.',
      schema: {
        type: 'object',
        properties: {
          score: { type: 'number', minimum: 0, maximum: 100 },
          recommendation: { type: 'string', enum: ['Apply', 'Consider', 'Do not apply'] },
          strengths: { type: 'array', items: { type: 'string' } },
          weaknesses: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' } },
          immediate_fit: { type: 'string' },
          career_growth_value: { type: 'string' },
          skill_gaps: { type: 'array', items: { type: 'string' } },
          recommended_action: { type: 'string', enum: ['Apply', 'Consider', 'Do not apply'] },
          career_reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['score', 'recommendation', 'strengths', 'weaknesses', 'missing', 'immediate_fit', 'career_growth_value', 'skill_gaps', 'recommended_action', 'career_reason', 'confidence'],
        additionalProperties: false
      }
    };
  }
  if (task === 'resume_tailoring') {
    const factRefArray = { type: 'array', items: { type: 'string' }, minItems: 1 };
    return {
      instruction: 'Tailor the resume for the SPECIFIC job in the input — targeting THIS job is the whole point; a summary that could sit on any resume is a failure. '
        + 'Work ONLY from the numbered facts supplied in the input. You may also name the job title from the input when positioning the candidate — nothing else may be added. '
        + 'SUMMARY (job-targeted, 2-3 sentences): sentence one positions the candidate toward the job title using their strongest facts that MATCH the job description; the rest weave in the remaining most-relevant facts. '
        + 'Choose facts by relevance to the job description keywords — a different job must produce a different summary from the same facts. '
        + 'BULLET_REWRITES: rewrite the bullets whose facts overlap the job description so the matching words LEAD the line; prioritize the most job-relevant bullets. '
        + 'When rewriting, NEVER drop technical terms, tools, or methods from the fact that match the job description — trading matching keywords away for brevity makes the resume worse. '
        + 'You may select, reorder, and reword existing facts; you may NOT add companies, roles, skills, numbers, dates, or achievements that are not in the facts. '
        + 'STRICT REWORDING RULE: a rewrite must be built from the words of its referenced facts (plus the job title when positioning). Do not append interpretation, '
        + 'commentary, or claims — no "demonstrating…", "aligning with…", "ensuring…", "proficient in…" additions. '
        + 'If you cannot improve a bullet using only its own words, omit it. Shorter and factual beats longer and embellished. '
        + 'Every rewritten line must list the fact_refs it came from, copied exactly from the input. '
        + 'Return summary and bullet_rewrites. An empty bullet_rewrites array is acceptable; a generic summary is not.',
      schema: {
        type: 'object',
        properties: {
          summary: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              fact_refs: factRefArray
            },
            required: ['text', 'fact_refs'],
            additionalProperties: false
          },
          bullet_rewrites: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fact_ref: { type: 'string' },
                text: { type: 'string' }
              },
              required: ['fact_ref', 'text'],
              additionalProperties: false
            }
          }
        },
        required: ['summary', 'bullet_rewrites'],
        additionalProperties: false
      }
    };
  }
  if (task === 'cover_letter_generation') {
    return {
      instruction: 'Write the BODY paragraphs of a cover letter for the SPECIFIC job in the input — targeting THIS job is the whole point. '
        + 'A letter that could be sent to any company for any role is a failure; a different job must produce a different letter from the same facts. '
        + 'GROUNDING RULE: build every sentence from the words of the numbered facts you cite in that paragraph\'s fact_refs. '
        + 'You may also use the job title and the company name from the input — those are data from the posting, not invention. '
        + 'Do not add skills, numbers, employers, or claims that are not in the facts; do not invent anything about the company; '
        + 'never claim the candidate worked at, interned at, or was employed by the company being applied to; '
        + 'and never comment on fit, weaknesses, or career trajectory. '
        + 'STRUCTURE (2-4 paragraphs, 120-250 words total): the first paragraph positions the candidate toward the job title using their strongest facts that MATCH the job description; '
        + 'the middle paragraph(s) present the most job-relevant achievements, projects, and education as concrete evidence, keeping the technical terms that match the job description; '
        + 'the final paragraph states interest in the role at the company by name. '
        + 'Every paragraph must list its fact_refs, copied exactly from the input — cite EVERY fact whose words the paragraph uses, '
        + 'including the project or employer entry itself whenever you name a project or employer. '
        + 'Copy proper nouns, abbreviations, and dates EXACTLY as the facts write them: if a fact says PCA, write PCA, never its expansion; '
        + 'if a fact says Mar 2026, write Mar 2026, not March. Any word the cited facts do not contain gets the whole output rejected. '
        + 'State dates exactly as the facts state them, without adding words like currently, expected, or upcoming — you do not know today\'s date, so any tense you add can be wrong. '
        + 'One thin sentence is not a cover letter — a body under 120 words will be rejected.',
      schema: {
        type: 'object',
        properties: {
          paragraphs: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                fact_refs: { type: 'array', items: { type: 'string' }, minItems: 1 }
              },
              required: ['text', 'fact_refs'],
              additionalProperties: false
            }
          }
        },
        required: ['paragraphs'],
        additionalProperties: false
      }
    };
  }
  if (task === 'job_match_enrichment') {
    return {
      instruction: 'Return exactly these fields: summary (string), skill_matches (array of strings), gaps (array of strings), confidence (number from 0 to 1).',
      schema: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          skill_matches: { type: 'array', items: { type: 'string' } },
          gaps: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['summary', 'skill_matches', 'gaps', 'confidence'],
        additionalProperties: false
      }
    };
  }
  return {
    instruction: 'Return one JSON object.',
    schema: { type: 'object', additionalProperties: true }
  };
}

function taskRequest(config, { task, input }, responseFormat = 'json_schema') {
  const contract = taskOutputContract(task);
  const system = `/no_think\nReturn one valid JSON object only for task: ${task}. ${contract.instruction} Never change approval, browser, upload, or submission state.`;
  if (config.type === 'anthropic') {
    return {
      url: endpoint(config, '/messages'),
      body: {
        model: config.model,
        max_tokens: 2048,
        temperature: 0,
        system,
        messages: [{ role: 'user', content: JSON.stringify(input) }]
      }
    };
  }
  const safeTaskName = String(task || 'structured_task').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || 'structured_task';
  const responseFormatValue = responseFormat === 'json_schema'
    ? {
        type: 'json_schema',
        json_schema: {
          name: safeTaskName,
          strict: false,
          schema: contract.schema
        }
      }
    : responseFormat === 'json_object'
      ? { type: 'json_object' }
      : null;
  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `/no_think\n${JSON.stringify(input)}` }
    ]
  };
  if (config.type === 'openai') {
    // OpenAI's current chat models take max_completion_tokens (max_tokens is
    // rejected by the reasoning families), and those same families reject any
    // non-default temperature — schema validation + grounding provide the
    // determinism guarantees instead.
    body.max_completion_tokens = 4096;
  } else {
    body.temperature = 0;
    body.max_tokens = 4096;
  }
  if (config.type === 'local_openai_compatible') body.reasoning_effort = 'none';
  if (responseFormatValue) body.response_format = responseFormatValue;
  return {
    url: endpoint(config, '/chat/completions'),
    body
  };
}

function parseStructuredContent(content) {
  const source = String(content || '').trim();
  const candidates = [
    source,
    source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  ];
  const firstBrace = source.indexOf('{');
  const lastBrace = source.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(source.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch {
      // Providers may wrap structured output in several candidate fragments.
      // Invalid candidates are skipped; failure is explicit after all formats.
    }
  }
  throw new AIProviderError('invalid_structured_output', 'AI provider message content is not valid JSON.');
}

function taskContent(config, payload) {
  if (config.type === 'anthropic') {
    return Array.isArray(payload?.content)
      ? payload.content.find(item => item?.type === 'text')?.text
      : '';
  }
  return payload?.choices?.[0]?.message?.content;
}

function taskUsage(config, payload) {
  const source = payload?.usage && typeof payload.usage === 'object' ? payload.usage : {};
  const inputTokens = Number(source.input_tokens ?? source.prompt_tokens ?? 0) || 0;
  const outputTokens = Number(source.output_tokens ?? source.completion_tokens ?? 0) || 0;
  const totalTokens = Number(source.total_tokens ?? inputTokens + outputTokens) || inputTokens + outputTokens;
  const estimatedCost = inputTokens / 1_000_000 * config.inputCostPerMillion
    + outputTokens / 1_000_000 * config.outputCostPerMillion;
  return {
    input_tokens: Math.max(0, Math.round(inputTokens)),
    output_tokens: Math.max(0, Math.round(outputTokens)),
    total_tokens: Math.max(0, Math.round(totalTokens)),
    estimated_cost_usd: Number(Math.max(0, estimatedCost).toFixed(8)),
    cost_is_estimate: true
  };
}

export function createAIProvider({ env = process.env, config = {}, fetchImpl = globalThis.fetch } = {}) {
  const normalized = aiProviderConfig({ env, config });
  const publicConfig = publicAIProviderConfig(normalized);
  const headers = requestHeaders(normalized);
  return {
    config: publicConfig,
    async healthCheck() {
      if (!normalized.enabled) {
        return {
          status: 'DISABLED',
          enabled: false,
          network_accessed: false,
          provider: normalized.type,
          ...publicConfig
        };
      }
      const payload = await withRetry(
        () => requestJson(endpoint(normalized, '/models'), { method: 'GET', headers }, normalized, fetchImpl),
        normalized.retries
      );
      return {
        status: 'READY',
        enabled: true,
        network_accessed: true,
        provider: normalized.type,
        model_count: Array.isArray(payload?.data) ? payload.data.length : 0,
        model_ids: Array.isArray(payload?.data)
          ? payload.data.map(item => String(item?.id || '').trim()).filter(Boolean).slice(0, 100)
          : [],
        ...publicConfig
      };
    },
    async structuredTask({ task, input, schema, fallback }) {
      const startedAt = Date.now();
      if (!normalized.enabled) {
        return {
          status: 'fallback',
          reason: 'provider_disabled',
          value: structuredClone(fallback),
          model_used: false,
          provider: normalized.type,
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: 0, cost_is_estimate: true },
          latency_ms: Date.now() - startedAt
        };
      }
      const responseFormats = normalized.type === 'anthropic'
        ? ['native']
        : ['json_schema', 'json_object', 'text'];
      let value;
      let negotiatedFormat = responseFormats[0];
      let lastError;
      let usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: 0, cost_is_estimate: true };
      for (const [index, responseFormat] of responseFormats.entries()) {
        const request = taskRequest(normalized, { task, input }, responseFormat);
        try {
          const payload = await withRetry(
            () => requestJson(request.url, {
              method: 'POST',
              headers,
              body: JSON.stringify(request.body)
            }, normalized, fetchImpl),
            normalized.retries,
            ['network', 'timeout']
          );
          const candidate = parseStructuredContent(taskContent(normalized, payload));
          usage = taskUsage(normalized, payload);
          const validation = typeof schema === 'function' ? schema(candidate) : { ok: true };
          if (validation !== true && validation?.ok !== true) {
            throw new AIProviderError('schema_validation', 'AI provider output failed schema validation.', {
              errors: validation?.errors || []
            });
          }
          value = candidate;
          negotiatedFormat = responseFormat;
          break;
        } catch (error) {
          lastError = error;
          const canNegotiate = normalized.type !== 'anthropic'
            && index < responseFormats.length - 1
            && (
              error?.category === 'invalid_structured_output'
              || error?.category === 'schema_validation'
              || (error?.category === 'http' && [400, 404, 415, 422].includes(Number(error?.details?.status)))
            );
          if (!canNegotiate) throw error;
        }
      }
      if (value === undefined) throw lastError || new AIProviderError('invalid_structured_output', 'AI provider did not return structured output.');
      return {
        status: 'ok',
        value,
        model_used: true,
        provider: normalized.type,
        model: normalized.model,
        response_format: negotiatedFormat,
        usage,
        latency_ms: Date.now() - startedAt
      };
    }
  };
}

export function createMockAIProvider(responses = {}) {
  return {
    config: {
      enabled: true,
      type: 'mock',
      credential_configured: false,
      advisory_only: true,
      deterministic_state_changes: false
    },
    async healthCheck() {
      return { status: 'READY', enabled: true, network_accessed: false, provider: 'mock' };
    },
    async structuredTask({ task, fallback }) {
      const available = Object.hasOwn(responses, task);
      return {
        status: available ? 'ok' : 'fallback',
        value: structuredClone(available ? responses[task] : fallback),
        model_used: available,
        provider: 'mock',
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost_usd: 0, cost_is_estimate: true },
        latency_ms: 0
      };
    }
  };
}
