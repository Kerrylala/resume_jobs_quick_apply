# Contributor instructions

Resume Jobs is an existing local-first product. Reuse and extend the current
Dashboard, data contracts, state machine, Application Package, and Chrome
extension instead of creating parallel implementations.

Before editing:

1. Run `git status` and preserve unrelated user changes.
2. Read `README.md`, `docs/developer/DEVELOPER_GUIDE.md`, and `SECURITY.md`.
3. Work on one explicit product task at a time.
4. Read `docs/developer/UX_DESIGN_RULES.md` for UI work. Release UI must not use browser
   native `alert`, `confirm`, or `prompt` dialogs.

After editing:

1. Run the smallest relevant tests, then `npm test` for product changes.
2. Keep generated data, reports, profiles, resumes, credentials, and local
   extension bundles out of Git.
3. Update `CHANGELOG.md` with a concise user-facing result.

Accessing a real job site, logging in, uploading a resume, or submitting an
application requires explicit user authorization. Never bypass CAPTCHA or MFA,
invent candidate facts, or enable final submission implicitly.
