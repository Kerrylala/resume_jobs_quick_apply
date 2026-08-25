# GitHub Release Checklist

## Release-tree checks

- [x] `npm run audit:release` reports `ready`.
- [x] Dashboard binds to `127.0.0.1` by default.
- [x] Extension has no `<all_urls>` or Native Messaging permission.
- [x] Manifest permissions cannot upload or submit.
- [x] Release source contains no browser-native dialog calls.
- [x] Public examples use synthetic values and localhost fixtures.
- [x] No machine-specific project/home path is present in release files.
- [x] Historical runtime JSON and reports are removed from the Git index while
      local copies remain untouched.
- [x] Unicode filenames are enumerated without Git quote-path loss.
- [x] Compiled caches and auto-generated agent workspace templates are excluded.

## Must remain out of Git

- `data/*.json`, local AI/search settings, profiles and answer memory;
- `applications/`, Packages, Sessions, attempts and reports;
- `documents/` and all resumes;
- `browser_profiles/`, `browser_sessions/`, cookies and extension local state;
- `.env*` except a sanitized example, API keys, tokens and credentials;
- `archive/`, `logs/`, `output/`, `tmp/` and generated screenshots;
- machine-specific `.lnk` files.

## Maintainer validation

```powershell
npm install
npm run validate
npm test
npm run test:dashboard-responsive
npm run test:launcher
npm run audit:release
```

Real public-page and installed-extension checks are supervised, separate from
the offline suite, and never include upload, login, challenge handling,
sensitive answers, or Submit.

## Before publishing

- [ ] Review `git diff --cached` and confirm all staged runtime removals are intentional.
- [ ] Review `git status --ignored` for newly generated private material.
- [x] Confirm screenshots and every unique demo GIF frame contain only synthetic/redacted data.
- [ ] Confirm README version, CHANGELOG, license and safety limitations.
- [ ] Publish from a reviewed clean history; the existing history contains
      historical runtime/Profile-memory paths.
- [ ] Add the owner-approved GitHub URL; no remote is configured yet.
- [ ] Do not commit or push from an acceptance run without explicit owner approval.
