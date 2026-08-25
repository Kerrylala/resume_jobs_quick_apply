# Contributing — developer notes

Start with the repository's [CONTRIBUTING.md](../../CONTRIBUTING.md); this page
adds the deeper development detail.

## Development setup

```bash
npm install
npm run validate
npm test
```

Use synthetic fixtures and temporary directories for tests. The default test
entry blocks network access and project-tree writes.

## Pull requests

- Keep each pull request focused on one product outcome.
- Reuse existing modules and data contracts.
- Add or update tests for behavior changes.
- Document user-facing changes.
- Do not commit runtime JSON, resumes, profiles, answer values, API keys,
  browser profiles, screenshots containing personal data, or generated
  application packages.

## Safety-sensitive changes

Changes involving real websites, browser automation, resume attachment, login,
or submission need an explicit threat-model update and must remain
human-controlled by default. See [SECURITY.md](../../SECURITY.md).
