# Resume Jobs Browser Extension Architecture

## Purpose

`extensions/application_assistant` is the only product browser-autofill
implementation. It assists with known application fields after a user has
approved a job and reviewed its Application Package. It never owns discovery,
matching, approval, or final submission.

## Components

| Component | Responsibility |
|---|---|
| `manifest.json` | Manifest V3 permissions and priority-host activation boundary |
| `popup.html` / `popup.js` | Company/role/readiness status, canonical session sync, safe-fill action and skipped-field review |
| `content.js` | Field detection, safe value resolution, fill execution, pause states, completion report, and on-page status |
| `field_memory.js` | De-valued field-signature learning and user-confirmed mapping reuse |
| `default_mappings.json` | Conservative built-in label/name/id mappings |
| `site_rules.example.json` | Documented site-rule contract; local reviewed rules remain private |

## Runtime flow

```text
Dashboard Start AI Fill Assistant
  -> validates one PACKAGE_READY Application Package
  -> creates/idempotently resumes ApplicationExecutionSession
  -> opens the approved job URL
  -> extension requests localhost /api/extension/active-handoff?url=current_page
  -> Dashboard verifies extension origin + active session + exact page match
  -> the exact session enters chrome.storage.local
  -> approved_field_mappings become an in-memory fill view
  -> content.js classifies fields and fills only eligible known values
  -> unknown/sensitive/authentication fields remain blank for user review
  -> extension POSTs a de-valued fill report with application_session_id
  -> Dashboard derives NEEDS_USER_INPUT or READY_FOR_MANUAL_SUBMIT
  -> user reviews the page and performs final Submit manually
```

The handoff is read-only. It contains no resume file bytes, password, CAPTCHA,
MFA value, browser cookie, or final-submit permission. A normal webpage cannot
call the private handoff because the server requires a `chrome-extension://`
origin and listens only on `127.0.0.1`.

## Permissions

The release manifest uses:

- `activeTab` for an explicit one-tab user action on other public job pages;
- `scripting` to inject `field_memory.js` and `content.js` after that action;
- `storage` for the active execution session, value-free mappings, reports and
  de-valued field memory;
- host access only for localhost and the priority Greenhouse, Lever, and
  Workday hosts.

There is no catch-all `http://*/*` or `https://*/*` host permission. Private
profiles are not declared as web-accessible resources and the extension does
not load Career Profile or package-bundle files independently.

## Portal adapter maturity

| Portal | Discovery | Fill behavior | Important limitation |
|---|---|---|---|
| Greenhouse | Public provider baseline | Safe known-field preview | Custom questions require review or confirmed memory |
| Lever | Public provider baseline | Safe known-field preview | Custom questions require review or confirmed memory |
| Workday | Detector only | Limited dynamic-form preview | Account and multi-step flows require user interaction |
| Other public page | User URL/generic discovery | Manual popup injection using `activeTab` | Conservative generic mappings only |

The canonical adapter capability contract is
`scripts/lib/portal_adapters.mjs`. It always reports:

- login handling: false;
- CAPTCHA/MFA handling: false;
- resume attach: explicit user action only;
- final submit: false.

## Field resolution

Each fill candidate combines:

1. a user-confirmed value in the session's `approved_field_mappings`;
2. its package provenance and confidence;
3. built-in mapping or active site rule;
4. active Form Field Memory mapping, if user-confirmed;
5. confidence and sensitivity gates.

The fill report records field signature, canonical key, source, confidence,
and review reason. Form Field Memory deliberately removes candidate values and
stores only portal/domain, field signature, canonical key, confidence,
confirmation state, last-used time, and usage counters.

## Mandatory pause states

Autofill pauses or skips when it sees:

- login/password pages;
- CAPTCHA, OTP, MFA, or verification controls;
- unknown or low-confidence fields;
- salary, work authorization, sponsorship, demographic, or other sensitive
  questions without an approved per-application answer;
- subjective long-form questions without a confirmed answer;
- every file control;
- any Submit, Apply, Send, or Confirm control.

The extension reports these states to the Dashboard; it does not attempt to
bypass them.

## Resume attachment

Resume attachment is disabled in the Application Executor. The session cannot
grant upload permission and neither transport receives resume bytes.

## Error and notification behavior

The popup and on-page panel use product-owned inline status and review panels.
Browser-native `alert`, `confirm`, and `prompt` are forbidden
and checked by the release test suite. Dashboard unavailability, missing
handoff, stale package, unsafe profile, blocked page state, and report failure
produce explicit messages without silently continuing.

## Validation

```bash
npm test
npm run test:e2e
npm run test:browser
npm run test:browser:headed
```

`playwright-core` drives an installed Edge/Chrome for the reproducible smoke
path; the built-in CDP harness then exercises the complete field-memory and
hard-stop contract. `test:browser:headed` runs the same localhost-only checks
visibly. Both modes use synthetic profile values, a temporary browser profile,
debug screenshots, and de-valued reports. They cover safe inputs, dynamic
questions, Field Memory confirmation, login/CAPTCHA/MFA stops, idempotent
recovery, and the manual-submit boundary. Real-site validation requires
separate explicit user authorization.
