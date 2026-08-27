# Resume Jobs Developer Guide

## Architecture

Resume Jobs is a local Node.js product with one Dashboard server, a file-backed
domain model, public job providers, one Manifest V3 browser extension, and an
optional visible Playwright executor transport.

```text
Dashboard UI/API
  -> Resume Intelligence + versioned Career Brain
  -> Job Discovery Agent + Search Preferences + provider/user URL ingestion
  -> canonical JobRecord + deterministic gates + semantic matching
  -> explicit approval
  -> Application Package 2.0 + Completion Engine + Interview Preparation
  -> ApplicationExecutionSession + shared Application Executor
       -> Chrome Extension (normal)
       -> Local Browser Agent (advanced)
  -> safe fill report + pause/recovery/audit
  -> READY_FOR_MANUAL_SUBMIT
```

Important modules:

- `dashboard/server.mjs` - localhost API and static server.
- `dashboard/public/` - Home, Resume, Profile, Job Search, Job Matches,
  Applications, and Settings.
- `scripts/lib/resume_document_intelligence.mjs` - bounded PDF, DOCX, and UTF-8
  TXT parsing.
- `scripts/lib/resume_intelligence.mjs` - candidate fact allowlist,
  provenance, confidence, and review snapshots.
- `scripts/lib/career_brain.mjs` - primary versioned Career Profile schema,
  legacy migration, approval, activation, import/export, and safe application
  adapter.
- `scripts/lib/job_search_agent.mjs` - evidence-backed direct/transferable role
  plans for China and global sources.
- `scripts/lib/job_records.mjs` - canonical cross-source JobRecord,
  normalization, provenance, and deduplication.
- `scripts/lib/hybrid_matching.mjs` - deterministic-authoritative hybrid match
  composition.
- `scripts/lib/candidate_matching.mjs` - six candidate/job fit dimensions.
- `scripts/lib/ai_provider.mjs` - the only AI provider contract.
- `scripts/lib/ai_usage.mjs` - metadata-only token/cost accounting.
- `scripts/lib/application_package_2.mjs` - Career Brain-aware package and
  interview preparation sections.
- `scripts/lib/application_completion.mjs` - estimated and observed Application
  Completion Rate.
- `scripts/lib/application_state.mjs` - state, audit, idempotency, pause, and
  recovery.
- `scripts/lib/json_repository.mjs` - atomic JSON replacement for critical
  mutable state.
- `application_executor/` - executor contract, shared browser-compatible field
  mapper/safety core, execution-report redaction, and transport coordinators.
- `portal_adapters/` - Lever, Greenhouse, Ashby, and conservative generic
  execution adapters.
- `scripts/lib/portal_adapters.mjs` - compatibility capabilities for existing
  completion and product code.
- `extensions/application_assistant/` - recommended normal browser-fill transport.
- `browser_agent/` - optional visible Playwright transport using the same rules.

There is no database, second Dashboard, or OpenClaw runtime dependency.

## Commands

```bash
npm start
npm run app
npm run validate
npm test
npm run test:e2e
npm run test:launcher
npm run test:browser
npm run test:browser:headed
npm run test:browser-agent
npm run test:real-portals
npm run executor:sync-extension-core
npm run ai:check
npm run demo
```

CLI examples:

```bash
node scripts/resume_jobs_cli.mjs status
node scripts/resume_jobs_cli.mjs validate
node scripts/resume_jobs_cli.mjs discovery-fixture
node scripts/resume_jobs_cli.mjs score
node scripts/resume_jobs_cli.mjs approval-queue
node scripts/resume_jobs_cli.mjs model-health
node scripts/resume_jobs_cli.mjs build-package --job-id <job_id>
```

## Environment variables

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | Dashboard port | `8767` |
| `RESUME_JOBS_DATA_DIR` | Runtime state | `<project>/data` |
| `RESUME_JOBS_REPORTS_DIR` | Generated reports | `<project>/reports` |
| `RESUME_JOBS_APPLICATIONS_DIR` | Application Packages | `<project>/applications` |
| `RESUME_JOBS_ARCHIVE_DIR` | Local backups | `<project>/archive` |
| `RESUME_JOBS_RESUME_LIBRARY_DIR` | Versioned resume library | `<project>/documents/resumes` |
| `RESUME_JOBS_PROFILE_PATH` | Private Candidate Profile | extension-local profile |
| `RESUME_JOBS_BROWSER_PROFILES_DIR` | Dedicated Browser Agent profile root | `<project>/browser_profiles` |
| `RESUME_JOBS_BROWSER_SESSIONS_DIR` | Browser Agent contexts, reports and screenshots | `<project>/browser_sessions` |
| `RESUME_JOBS_CHROME_EXECUTABLE` | Explicit Chrome/Edge executable for Browser Agent | auto-detect |
| `LIVE_JOB_SEARCH` | Compatibility override for saved Live Search | unset |
| `SEARXNG_URL` | Compatibility override for saved SearXNG endpoint | unset |
| `AI_PROVIDER_ENABLED` | Enable advisory AI | disabled |
| `AI_PROVIDER_TYPE` | local/OpenAI/Anthropic/generic compatible | disabled |
| `AI_PROVIDER_BASE_URL` | Provider API base URL | provider default |
| `AI_PROVIDER_MODEL` | Model identifier | empty |
| `AI_PROVIDER_API_KEY` | Optional local / required official-cloud key | empty |
| `AI_PROVIDER_TIMEOUT_MS` | Request timeout | `15000` |

Legacy `LOCAL_LLM_*` variables remain input-compatible, but all calls are
normalized through `ai_provider.mjs`. See [AI_PROVIDER.md](AI_PROVIDER.md).

## Data and privacy

Runtime JSON, applications, reports, resumes, private profiles, API settings,
browser state, and extension-local bundles are ignored by Git. Tests must use
temporary roots through `RESUME_JOBS_*` variables.

Critical Dashboard, discovery, scoring, and AI-enrichment JSON writes use a
same-directory temporary file, `fsync`, and atomic rename. Missing runtime files
are a valid clean-install state.

Never log candidate values in aggregate metrics. Completion feedback contains
field keys, blocker states, and counts only.

## Resume Intelligence and Career Brain

Resume import validates the file signature/content, enforces a 10 MB limit,
calculates SHA-256, and creates an unapproved version. During explicit upload,
the active resume is analyzed locally. The server:

1. verifies the library path and current content hash;
2. extracts bounded local text;
3. persists only new, non-sensitive, unconfirmed facts;
4. never stores raw text or silently overwrites an existing fact;
5. keeps non-active resume analysis as preview-only;
6. revokes approval whenever the current fact snapshot changes.

Encrypted, scanned, textless, or unsupported documents fail safely.

The uploaded raw text is non-enumerable and memory-only. When the user opts in
to AI analysis, the server passes that text directly to the unified gateway,
then normalizes and merges the structured response with the deterministic local
draft. Raw text is never written to Career Brain storage or returned by the
API. An approved Career Profile can satisfy workflow/package review gates while
the legacy Candidate Profile remains a compatibility input.

## Job ingestion and matching

`data/job_sources.json` is the persisted Live Search provider contract.
SearXNG discovers public pages; provider detection and generic extraction feed
the canonical job-record normalizer. A user may also import one public
job-detail URL through `POST /api/jobs/import-url`. That path requires an
explicit UI confirmation and enforces HTTPS/loopback, DNS/private-address,
redirect, content type, response size, and timeout controls.

`score_jobs.mjs` applies hard filters and deterministic scoring, then a bounded
candidate-profile adjustment. `hybrid_matching.mjs` may add semantic score,
strengths, weaknesses, missing evidence, immediate fit, career-growth value,
skill gaps, career reason, confidence, and a user recommendation, but cannot
promote a hard-filtered job. Unknown candidate facts stay unknown rather than
being guessed.

`job_search_agent.mjs` builds the pre-search explanation from the active Search
Configuration and approved Career Brain. Its result includes target roles,
evidence-backed adjacent roles, locations, profile keywords, market-appropriate
sources, and planned query/source/time/reason records. `discover_jobs.mjs`
copies that reason into each executed `query_result`; the Dashboard must render
the persisted record rather than infer history later.

Every normalized JobRecord also carries user-visible discovery provenance:
`source_market`, `source_category`, `search_query`, `search_time`,
`why_discovered`, and `provider`. Legacy records receive honest fallbacks such
as `Not recorded`; the UI must not invent a historic query. Source categories
are China (`company_career`, `public_job_pages`, `user_imported_urls`) or Global
(`ats`, `career_pages`).

## AI provider

AI is optional and advisory. The provider settings API redacts credentials and
the test endpoint is the only configuration action that performs a connection.
Model output may add explanations or suggestions but cannot change provider
readiness, deterministic score, approval, application state, upload policy, or
submit policy. OpenAI-compatible structured calls negotiate `json_schema`,
`json_object`, then unformatted text. Local reasoning models receive bounded
output and `reasoning_effort: none`; hidden reasoning is never parsed as facts.

## Browser design

The extension loads the generated `executor_core.js`, then `field_memory.js`
and `content.js`. `application_executor/shared_core.js` is the canonical source;
run `npm run executor:sync-extension-core` after changing it, and keep the parity
test green. Private profile files
are not web-accessible resources. Automatic host access is limited to localhost,
Greenhouse, Lever, Ashby, and legacy Workday hosts; another public page uses
`activeTab` after a user opens the popup.

After `Start AI Fill Assistant`, the Dashboard validates the ready Application
Package and creates one `ApplicationExecutionSession`. That canonical execution
record owns a fixed input snapshot (application, job and package IDs, executor,
target URL, approved safe-field mappings and safety locks) plus mutable status
and report history. The extension-origin localhost
handoff returns that session after an exact page match; the extension never
loads Career Profile or package-bundle files independently. Resume bytes,
sensitive answers, login/challenge permission and submit permission are absent.
See [EXTENSION_ARCHITECTURE.md](../architecture/EXTENSION_ARCHITECTURE.md)
for the executor boundary in detail.

The Dashboard can instead attach `browser_agent/run.mjs` to the same execution
session. The private context under `browser_sessions/` is the canonical session
plus transport authorization and callback metadata; it contains no separately
loaded profile. The agent launches a visible dedicated persistent profile, uses
`PlaywrightPageRuntime` only for DOM transport, and posts the shared redacted
`ApplicationExecution` back to the same fill-report endpoint. Production has no
headless flag; `--headless-test` is accepted only by the localhost integration
test. See [ARCHITECTURE.md](../architecture/ARCHITECTURE.md).

All release UI follows [UX_DESIGN_RULES.md](UX_DESIGN_RULES.md). Browser-native
`alert`, `confirm`, and `prompt` are prohibited and test-enforced.

## Testing

`npm test` installs network and project-write guards and runs unit/API/browser
contracts with synthetic temporary data. `npm run test:e2e` exercises the full
product workflow. `npm run test:browser` uses Playwright Core with an installed
Edge/Chrome plus the CDP fallback contract; add `:headed` for visible local QA.
`npm run test:browser-agent` executes the production Browser Agent against a
localhost form with a temporary profile, verifies screenshots/report redaction,
and confirms upload, sensitive and submit controls remain untouched.

`npm run test:browser-agent-dashboard` verifies the complete isolated Dashboard
to Application Package to Browser Agent handoff, safe fill, Retry, Re-scan,
status update, graceful cleanup, and grouped redacted `ApplicationExecution`
report.

Reliability and release commands:

- `npm run test:dashboard-lifecycle` — 10 cold starts, port checks, five SSE
  reconnects, and three abrupt Dashboard recoveries on isolated data.
- `npm run test:reliability-matrix` — repeated Package, Session, Profile,
  Memory, Browser Agent Retry, and Re-scan cycles.
- `npm run test:browser-agent-crash` — three forced Browser Agent exits and
  same-profile recoveries with orphan-process checks.
- `npm run test:launcher-cycles` — 10 Windows start/stop cycles.
- `npm run test:dashboard-responsive` — desktop/laptop/tablet/mobile layout and
  accessibility checks.
- `npm run audit:release` — release-tree credentials, runtime data, local path,
  permissions, and loopback audit.
- `npm run test:soak` — continuous Dashboard API/UI/SSE/process/log monitor;
  the release acceptance duration is two hours.

`npm run test:real-portals` is an explicit network test. It reads the current
public Greenhouse and Lever form markup, verifies exact high-confidence core
field mappings, and confirms resume upload remains disabled. It sends no
candidate values and performs no form writes, upload, login, or submission.

Before handing off a product change:

```bash
npm run validate
npm test
npm run test:launcher
npm run test:e2e
npm run test:browser
npm run test:browser-agent
npm run test:browser-agent-dashboard
npm run test:dashboard-responsive
npm run audit:release
npm run test:real-portals
```

Do not use a real website, login, personal resume, or application submission as
a test fixture without separate explicit authorization.

## Adding a provider or portal adapter

1. Implement the `portal_adapters/` contract and keep compatibility capability
   metadata in `scripts/lib/portal_adapters.mjs` where existing consumers need it.
2. Start with recorded or synthetic fixtures and injected transports.
3. Preserve provenance, canonical URL rules, and safe failure states.
4. Add offline contract tests and Dashboard diagnostics.
5. Keep login, CAPTCHA/MFA, upload, and Submit unsupported unless a separately
   reviewed product change explicitly introduces a safe user-controlled gate.
