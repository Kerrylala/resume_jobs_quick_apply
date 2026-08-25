# Local Browser Agent Guide

## Purpose

Local Browser Agent is the optional advanced Application Executor. It launches
a visible local Chrome or Edge session, uses the same approved Application
Package and safety rules as the extension, saves before/after screenshots and a
redacted execution report, then pauses for review.

It is not a background auto-apply bot and it is not a second Resume Jobs app.

## Requirements

- Node.js 18+
- Chrome or Microsoft Edge
- A reviewed Career Brain and Application Package
- Explicit **Start AI Fill Assistant** confirmation in the Dashboard

If browser discovery fails, set:

```powershell
$env:RESUME_JOBS_CHROME_EXECUTABLE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm start
```

## Use

1. Open the approved Application Package.
2. Select **Local Browser Agent (advanced)**.
3. Read and confirm the safety modal.
4. A visible dedicated browser window opens the exact approved URL.
5. The agent detects the page's fields, fills safe reviewed text fields and
   pauses.
6. Review the Dashboard field counts/reasons and the website form.
7. Complete manual steps yourself, or close the browser to end the session.

## Runtime files

Per-session data is written under `browser_sessions/<session-id>/`:

- `context.json` — private local application setup; includes reviewed facts.
- `status.json` — redacted live status and counts.
- `ApplicationExecution.json` — grouped, redacted execution report.
- `screenshots/before-fill.png` and `after-fill.png`.
- `browser-agent.log`.

The optional persistent browser profile is
`browser_profiles/resume-jobs-agent/`. Both roots are ignored by Git. Do not
publish or attach these directories without reviewing them for personal data.

## Safety and visible mode

Real use is always visible. Headless mode exists only behind the explicit
`--headless-test` switch used by the localhost automated test. The agent rejects
session requests for upload, login, challenge handling or final submission.
Adapters also skip file inputs, buttons, passwords, CAPTCHA/OTP fields,
sensitive questions, unconfirmed facts and low-confidence mappings.

## Validation

```bash
npm run test:browser-agent
npm run test:browser-agent-dashboard
```

This launches the production Browser Agent against a localhost synthetic form,
fills two safe fields, confirms upload/sensitive/submit fields are skipped,
checks screenshots and report redaction, then removes its temporary profile.
The Dashboard integration command additionally verifies Package delivery,
fill-attempt status, Retry, Re-scan, safe shutdown, and the redacted result
contract.
