# Contributing

Thanks for taking a look. This is a local-first product: it runs entirely on
the user's machine and holds their real job-search data, so contributions are
judged first on whether they keep that promise.

## Setup

```bash
npm install
npm start
```

The Dashboard runs at <http://127.0.0.1:8767>. `npm run demo` starts a fully
synthetic offline walkthrough that needs no real accounts.

## Before opening a pull request

```bash
npm test
```

The offline suite must stay green — it is the product's contract, not a
formality. Add a test with any behavior change; several existing tests exist
specifically because a defect shipped once.

## Rules that are not negotiable

These are enforced by code and tests, not by convention:

- **Never submit.** Final Submit, login, CAPTCHA, and MFA belong to the user.
- **Never fabricate candidate facts.** Anything a generated resume or cover
  letter says must trace to a fact the user confirmed. AI output that cannot
  be grounded is rejected in full.
- **Never commit real data.** `data/`, `documents/`, `archive/`,
  `browser_profiles/`, and `browser_sessions/` are ignored. Test fixtures use
  synthetic people.
- **No native dialogs** (`alert`, `confirm`, `prompt`) in release UI.
- API changes must update `docs/developer/QUICK_APPLY_API_CONTRACT.md` and
  `tests/api_contract_freeze.test.mjs` in the same change.
- After editing `application_executor/shared_core.js`, run
  `npm run executor:sync-extension-core` so the extension copy stays
  byte-identical.

## Safety-sensitive changes

Anything touching real websites, browser automation, resume attachment, login,
or submission needs an explicit threat-model update in
[SECURITY.md](SECURITY.md) and must stay human-controlled by default.

## Reporting problems

Open an issue with the steps you took and what you expected. Never paste real
personal data — redact it or use a synthetic example.

Deeper developer notes live in
[docs/developer/CONTRIBUTING.md](docs/developer/CONTRIBUTING.md) and the
[developer guide](docs/developer/DEVELOPER_GUIDE.md).
