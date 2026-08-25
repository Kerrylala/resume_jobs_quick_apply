# Resume Jobs AI Architecture

## Product boundary

Resume Jobs is one local-first Node.js product. The Dashboard, local API,
Career Brain, job records, Application Package, ApplicationExecutionSession state,
and Chrome extension remain the canonical architecture. The optional Local
Browser Agent is a second execution transport, not a second application.

```text
Career Brain + approved Job + confirmed Answers
                    |
                    v
           Application Package
                    |
                    v
     ApplicationExecutionSession
                    |
          Application Executor contract
             /                  \
    Chrome Extension       Local Browser Agent
             \                  /
              Portal Adapter + Field Mapper
                    |
                Safety Policy
                    |
         ApplicationExecution report
                    |
      Existing application state machine
```

## Layer ownership

| Layer | Location | Responsibility |
| --- | --- | --- |
| Product UI/API | `dashboard/` | User workflow, approvals, state, executor selection and diagnostics |
| Domain and persistence | `scripts/lib/` | Career Brain, matching, packages, lifecycle and local records |
| Executor core | `application_executor/` | Executor contract, shared mapping, safety and report redaction |
| Portal adapters | `portal_adapters/` | Detect and describe Lever, Greenhouse, Ashby and generic forms |
| Extension transport | `extensions/application_assistant/` | DOM events, popup handoff, one-tab browser interaction |
| Playwright transport | `browser_agent/` | Visible persistent browser, screenshots, local logs and reports |

## Canonical execution flow

1. The user approves a job and reviews its Application Package.
2. The user approves safe fill and chooses an executor.
3. `POST /api/jobs/:job_id/start-fill` validates the ready package and creates
   one `ApplicationExecutionSession` for `extension` or `browser_agent`.
4. The chosen executor receives that exact session: application/job/package
   identity, target URL, approved safe-field mappings and safety locks.
5. A portal adapter calls `detect`, `get_fields`, `map_fields`, `fill_fields`
   and `report`.
6. The shared safety policy rejects uploads, auth/challenges, submit controls,
   sensitive fields, unconfirmed facts and low-confidence mappings.
7. The executor writes only approved text fields and pauses.
8. A redacted `ApplicationExecution` report is attached to the execution session.
9. Existing lifecycle logic advances to `NEEDS_USER_INPUT` or
   `READY_FOR_MANUAL_SUBMIT`; the product never enters submitted state itself.

## Shared core and extension packaging

`application_executor/shared_core.js` is browser-compatible and is the source
of truth. `npm run executor:sync-extension-core` copies it to
`extensions/application_assistant/executor_core.js` for Manifest V3 packaging.
`tests/application_executor.test.mjs` requires byte parity, preventing a second
maintained rule set.

DOM value setters and React event dispatch remain transport details. Mapping,
portal detection, safety categories and execution-report shape are shared.

## Data contracts

- **Career Brain**: reviewed, versioned user facts with provenance.
- **Application Package**: one approved job plus the selected resume version,
  reviewed facts/answers, preparation material, risks and safety gates.
- **ApplicationExecutionSession**: canonical execution identity, approved input
  snapshot, executor mode, target URL, status and report history. Legacy
  `ApplicationRun` records migrate at the read boundary only.
- **ApplicationExecution**: redacted per-field outcome report. `fields` groups
  detected, filled, skipped and failed entries; `field_results` preserves the
  flat compatibility view. Entries contain field labels, mapping keys, source,
  confidence, outcome and reason, but never the candidate value. Safety records
  both attempted and completed upload/submit flags, which remain false.

The example contract is `application_executor/ApplicationExecution.json`.

## Portal adapter contract

Every adapter implements:

- `detect(target)`
- `get_fields(runtime)`
- `map_fields(fields, context)`
- `fill_fields(runtime, plans)`
- `report(context, results)`

The generic adapter is deliberately conservative. Portal-specific rules may
raise confidence or add never-fill terms; they may not relax the global safety
policy.

## Local data and open-source boundary

Generated runs, resumes, profiles, applications, reports, screenshots, browser
profiles, browser sessions, logs, secrets and provider configuration remain in
Git-ignored paths. Source templates and synthetic tests may be committed.

## Safety invariants

- No executor activates final Submit.
- No executor uploads files.
- No executor logs in or handles CAPTCHA/MFA/OTP.
- Sensitive, legal, demographic and risky questions remain user-owned.
- Only the exact approved HTTP(S) URL may be executed.
- Real portal access requires an explicit user action.
- Reports contain no filled candidate values.
