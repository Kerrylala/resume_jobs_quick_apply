# AI Provider Configuration

Resume Jobs works without an AI provider. Search, normalization, deterministic scoring, approval safety, workflow state, Application Packages, and browser safety remain available when AI is disabled.

AI is advisory. It may add explanations or draft suggestions, but it cannot change deterministic scores, approve a job, invent candidate facts, upload a resume, bypass a hard stop, or submit an application.

## Supported provider types

| Type | Use case | Default endpoint |
|---|---|---|
| `local_openai_compatible` | LM Studio, vLLM, or another loopback OpenAI-compatible server | `http://127.0.0.1:1234/v1` |
| `openai` | OpenAI API | `https://api.openai.com/v1` |
| `anthropic` | Anthropic Claude API | `https://api.anthropic.com/v1` |
| `openai_compatible` | Another compatible HTTPS cloud endpoint | user supplied |
| `disabled` | Deterministic/offline operation | none |

Local mode accepts only `localhost`, `127.0.0.1`, or `::1`. A remote endpoint must use HTTPS.

## Configure in the Dashboard

1. Start Resume Jobs and open **Settings**.
2. Find **AI Provider**.
3. Select a provider, endpoint, and model.
4. Enter a key if the provider requires one.
5. Enable the provider and choose **Save AI Provider**.
6. Choose **Test Connection**. This is the only Settings action that contacts the configured provider.

The CLI health check reads the same ignored saved settings file as the
Dashboard (or environment variables when that file is absent):

```powershell
npm run ai:check
```

The credential is written to the ignored local file `data/ai_provider.local.json`. It is never returned by the settings API, displayed again, logged in reports, or bundled into the Chrome extension. Anyone with access to the local Windows account and repository folder may still be able to read that file, so environment variables or OS-level secret management are preferable on shared machines.

To remove a saved credential, disable the provider, select **Remove the saved API key**, and save.

## Configure with environment variables

Environment variables are used when no saved local provider file exists.

| Variable | Description |
|---|---|
| `AI_PROVIDER_ENABLED` | `1` enables the configured provider |
| `AI_PROVIDER_TYPE` | `local_openai_compatible`, `openai`, `anthropic`, or `openai_compatible` |
| `AI_PROVIDER_BASE_URL` | API base URL including `/v1` when required |
| `AI_PROVIDER_MODEL` | Provider model identifier |
| `AI_PROVIDER_API_KEY` | Provider credential; optional for some local servers |
| `AI_PROVIDER_TIMEOUT_MS` | Request timeout from 100 to 120000 ms; default 15000 |

Example for LM Studio in PowerShell:

```powershell
$env:AI_PROVIDER_ENABLED = '1'
$env:AI_PROVIDER_TYPE = 'local_openai_compatible'
$env:AI_PROVIDER_BASE_URL = 'http://127.0.0.1:1234/v1'
$env:AI_PROVIDER_MODEL = 'your-loaded-model-id'
npm start
```

Legacy `LOCAL_LLM_ENABLED`, `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_API_KEY`, and `LOCAL_LLM_TIMEOUT_MS` values remain compatible when no unified `AI_PROVIDER_*` value or saved provider file is present.

## Task contract

Product modules call one structured task interface:

```js
const result = await provider.structuredTask({
  task: 'job_match_enrichment',
  input: { /* bounded product data */ },
  schema: value => ({ ok: true }),
  fallback: { /* deterministic result */ }
});
```

The provider must return one valid JSON object. Output is size-bounded, schema-checked, and classified on timeout, network, HTTP, JSON, or schema errors. Disabled mode returns a cloned deterministic fallback without network access.

OpenAI-compatible providers use `/chat/completions`. Anthropic providers use `/messages`. Health checks use `/models`. Provider-specific API payloads are isolated in `scripts/lib/ai_provider.mjs`.

## Data sent to a provider

The current job enrichment task sends bounded job text, deterministic score evidence, and the active search goal. It does not send application state transitions or permission to take browser actions. Before enabling a cloud provider, review its data policy and assume submitted text leaves the local machine.

Resume extraction remains deterministic until a separately documented AI task is explicitly enabled. Sensitive candidate facts must always remain reviewable and unconfirmed until the user approves them.

## Troubleshooting

- **DISABLED**: enable and save the provider, or continue in deterministic mode.
- **MISCONFIGURED**: provide a model, valid endpoint, and required key.
- **HTTP/HTTPS error**: remote HTTP is rejected; use HTTPS. Local mode must use loopback.
- **Connection failed**: confirm the local server is running or the cloud endpoint/key is correct, then use Test Connection.
- **Invalid structured output**: the selected model did not return a valid schema-compatible JSON object. The product does not apply the invalid response.
- **AI enrichment unavailable**: deterministic search and scoring still complete; review Job Matches without AI enrichment.

## Tests

`tests/ai_provider.test.mjs` uses only injected synthetic transports. It covers disabled behavior, legacy local configuration, saved Dashboard settings, OpenAI-compatible and Anthropic protocols, HTTPS/loopback validation, credential redaction, retries, error classification, and deterministic mock behavior.
