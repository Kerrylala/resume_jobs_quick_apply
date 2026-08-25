# Release Checklist — 1.0.0-rc.1

Updated: 2026-08-12

## Product

- [x] Dashboard exposes only Home, Resume, Profile, Job Search, Job Matches,
  Applications, and Settings.
- [x] Resume upload supports PDF, DOCX, and UTF-8 TXT and creates reviewable,
  unconfirmed Resume Intelligence facts.
- [x] Candidate facts support add, edit, approve, reject, delete, and export.
- [x] Job ingestion supports configured SearXNG, synthetic Offline Demo, and an
  explicitly confirmed public job-detail URL through one normalized pipeline.
- [x] Matching exposes technical, experience, education, location, salary, and
  career-direction evidence.
- [x] Application Package, Answer Memory, Form Field Memory, Completion,
  confidence, and safe browser fill remain in the main path.
- [x] Extension handoff is bound to the active Application Session, reviewed
  Package, and exact page.
- [x] Login, CAPTCHA, MFA, unknown, sensitive, and file fields pause or remain
  manual; final submission remains user-controlled.
- [x] Release UI has zero browser-native `alert`, `confirm`, or `prompt` calls.

## Repository hygiene

- [x] Runtime JSON, private profiles, resumes, credentials, applications,
  reports, browser state, caches, and local extension bundles are ignored.
- [x] Goal/manager/reviewer/research/runtime-monitor product UI and obsolete
  OpenClaw persona templates are absent from the release surface.
- [x] Unused Axios, provider registry, and obsolete extension-bundle generator
  were removed after import/reference checks.
- [x] README, Quick Start, license, contributing/security policies, screenshots,
  demo media, architecture docs, English guides, and Chinese guides are present.
- [x] Critical mutable JSON paths use same-directory atomic replacement.

## Validation

- [x] `npm run validate` — passed; runtime files were readable or correctly
  absent, JavaScript entry checks passed, and all risky-action flags were false.
- [x] `npm test` — 224 passed, 0 failed, 0 skipped in the current stabilization
  baseline; the final critical suite is repeated after the continuous soak.
- [x] `npm run test:launcher` — 4 passed, including isolated start and managed
  shutdown after the PowerShell 5.1 environment-inheritance fix.
- [x] `npm run test:e2e` — full synthetic product workflow reaches
  `READY_FOR_MANUAL_SUBMIT`.
- [x] `npm run test:browser` — Playwright Core + installed Edge/Chrome + CDP,
  localhost only, 6 temporary screenshots, no submit or upload.
- [x] `npm run test:browser:headed` — visible localhost mode passed and closed
  its temporary browser/profile cleanly.
- [x] `npm run demo:no-open` — 10/10 steps, 100% observed completion,
  `READY_FOR_MANUAL_SUBMIT`, final Submit not clicked.
- [x] All privacy-sensitive legacy skips were replaced with temporary synthetic
  fixtures.
- [x] Unicode-safe release audit — 239 files, zero
  secret/private-runtime/local-path/cache findings.
- [x] 10 Dashboard cold starts, 10 Launcher start/stop cycles, repeated
  Package/Session/Memory/Browser Agent cycles, and three crash recoveries pass.

## Publication gate

- [x] The current release tree is suitable for a new public repository after
  ignored local files are left behind.
- [x] Public code, synthetic fixtures, screenshots, demo media, tests,
  documentation, license, and contribution/security policies are suitable for
  open-source review.
- [ ] Do **not** make the existing Git history public as-is. Its baseline history
  contains runtime JSON and historical reports that are deleted in the release
  tree. Publish from a new clean history or perform a separately reviewed
  history scrub.
- [ ] Confirm repository owner/contact and final GitHub URLs before publishing.
- [ ] Review `git status` and stage only the intended release tree; the current
  working directory contains preserved pre-existing uncommitted changes.

## Must never be uploaded

- personal profile, Resume Intelligence, Answer Memory, or search-history JSON;
- resumes, cover letters, generated packages, or application history;
- API keys, model tokens, cookies, passwords, `.env`, or local AI settings;
- local Chrome/Edge profiles, sessions, extension storage, or local bundles;
- real-site screenshots, recordings, unredacted logs, or reports;
- archives, backups, caches, and temporary output.

The code tree is release-ready only when the unchecked publication decisions
are completed by the repository owner. They are intentionally not automated.
