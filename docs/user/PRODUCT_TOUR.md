# Product tour

**English** · [简体中文](PRODUCT_TOUR.zh-CN.md)

The detail that used to live in the front-page README: the full first-use
workflow, daily rhythm, executor modes, extension behavior, and the project
layout. Start with the [README](../../README.md) if you have not read it yet.

## First-use workflow

```text
Upload Resume
  -> AI-assisted Career Brain draft
  -> Review, version, and approve Career Profile
  -> Create Job Search
  -> Find jobs or import one public job URL
  -> Review explainable matches
  -> Approve selected jobs
  -> Build and review Application Package
  -> Approve AI Fill
  -> Open the application and use AI Fill Assistant
  -> Resolve unknown, sensitive, login, CAPTCHA, or MFA steps
  -> Review the completed form
  -> Submit manually
```

Workflow steps are derived from current domain records. Browser cache, demo
flags, and old reports do not decide the current step.

## Daily use

The Home view is the daily starting point. It summarizes Career Brain
readiness, the highest-scoring jobs that still need review, applications in
progress, and the safest next action. Match cards keep discovery evidence
(source category, query, search time, discovery reason, and provider) beside
the fit explanation, so a recommendation is never a context-free score.

Discovery sources use one visible taxonomy:

- China: company career sites, public job pages, and user-imported URLs.
- Global: public application forms and company career pages.

Application Package review shows the selected resume version, cover-letter
state and preview, prepared interview questions, confirmed STAR stories,
missing skills, and unresolved risk before browser assistance can begin.

## Browser extension

Load `extensions/application_assistant` as an unpacked Manifest V3 extension.
It runs on public application pages — including company-hosted careers domains,
not just the big ATS vendors — and stays dormant until you start a fill.

**A page's URL reaches the local app only when its host belongs to an active
fill session.** The extension asks the app which hosts are active (a request
that carries no page information at all) and stays silent everywhere else, so
ordinary browsing is never reported anywhere.

After **Start AI Fill Assistant**, the popup receives the reviewed application
setup only when the open page belongs to the selected job. It receives no resume
file bytes or final-submit permission. Resume attachment remains a separate,
explicitly confirmed manual action.

On the page itself, the Assistant shows a small chip with the live application
state plus two buttons — fill this step (填写这一步) and re-scan (重新扫描) —
for the moments you do not want to wait for the automatic cycle. The chip and
popup are currently Chinese-only; the dashboard itself is bilingual.

The **Application Assistant (browser extension)** panel on the Settings page
verifies the installed extension, connection, current page, and matched
application. Technical transport details and identifiers live in the advanced
diagnostics view. Resume Jobs uses localhost HTTP and does not require Native
Messaging.

## Application Executor modes

Choose the fill mode while preparing an approved application:

- **Product browser (the in-app recommended default)** launches a visible
  Chrome/Edge window with a dedicated ignored profile. It auto-uploads the
  tailored resume, auto-rescans as you work, takes before/after screenshots,
  writes a redacted execution report, and pauses with the browser open for
  review.
- **Your own browser (via the Assistant extension)** opens the approved URL in
  your normal browser, using your existing sign-ins. The popup displays
  company, role, readiness state, detected/filled/skipped counts, and fields
  that need review. Resume attachment stays manual in this mode.

Multi-step applications are supported in both modes: when a portal walks you
through several pages, each new step is detected, allowed to settle, and filled
once with your confirmed answers. Navigation stays yours — the product never
clicks **Next**, **Save & Continue**, or **Submit**.

The modes are not separate products. Both consume the same reviewed Application
Package, follow the same safety rules, and return the same redacted result. See the
[Extension guide](EXTENSION_GUIDE.md) and
[Browser Agent guide](BROWSER_AGENT_GUIDE.md).

## Project structure

```text
dashboard/                   Local Dashboard and HTTP API
application_executor/        Shared mapping, safety, executor, and report contract
portal_adapters/             Lever, Greenhouse, Ashby, and generic adapters
browser_agent/               Optional visible Playwright transport
extensions/application_assistant/
                             AI Fill Assistant and Form Field Memory
providers/                   Public job-source and provider detectors
scripts/lib/                 Product domain and persistence modules
scripts/                     CLI, launcher, discovery, scoring, and package tools
tests/                       Offline unit, integration, browser, and E2E tests
mock_sites/                  Localhost-only ATS fixtures
data/                        Local runtime state; private data is ignored
```

## Development and validation

```bash
npm run validate
npm test
npm run test:e2e
npm run test:browser
npm run test:browser-agent
npm run test:browser-agent-dashboard
npm run test:launcher
npm run test:real-portals
```

The default suite installs a network and project-write guard. Tests use
synthetic inputs and temporary data roots; they do not read or rewrite formal
job, profile, resume, or application data.

`npm run test:real-portals` is intentionally separate from the offline suite.
It performs a read-only check of current public Greenhouse and Lever form-field
contracts and never writes values, uploads a resume, logs in, or submits.

## Release status

`1.0.0-rc.1` uses a shared Application Executor contract for Extension and
Local Browser Agent modes, with Lever, Greenhouse, Ashby, and generic adapters.
Offline and localhost browser validation is part of the release suite. Public
portal validation remains explicitly supervised and never uploads, logs in,
handles challenges, or submits.
