# Resume Jobs AI

> A local-first AI job application agent that turns approved job matches into
> review-ready application packages while keeping personal facts, risky
> answers, browser actions, and final submission under your control.

[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
![Release](https://img.shields.io/badge/release-1.0.0--rc.1-3157d5)
[![License: MIT](https://img.shields.io/badge/license-MIT-0f766e.svg)](LICENSE)
[![Safety: human submit](https://img.shields.io/badge/final_submit-human_only-f59e0b)](SECURITY.md)

<!-- Product tour GIF and screenshots are pending privacy review and are not
included in this clean workspace yet. See PUBLIC_SOURCE_MANIFEST.md. -->

Resume Jobs helps one person build a versioned **Career Brain**, search China
and global opportunities, understand deterministic and semantic match quality,
build an Application Package, and fill known fields with either the included
browser extension or the optional visible Local Browser Agent.

The product's north-star metric is **Application Completion Rate**: the share
of an approved application that can be completed safely before the user takes
over.

## Product capabilities

- **Resume Intelligence** imports versioned PDF, DOCX, and UTF-8 TXT resumes,
  extracts review-only facts, and records provenance and confidence.
- **Career Brain** keeps approved, versioned identity, education, experience,
  projects, grouped skills, languages, preferences, career goals, and interview
  stories as the product's primary candidate knowledge model.
- **Candidate-aware matching** evaluates technical fit, experience,
  education, location, salary, and career direction without inventing missing
  facts.
- **Job Discovery Agent** derives direct and evidence-backed transferable roles,
  shows target/adjacent roles, locations, keywords, sources and query reasons
  before execution, and supports SearXNG, direct public application/company
  URLs, and a
  fully synthetic localhost demo.
- **Hybrid matching** combines authoritative deterministic gates with advisory
  semantic score, strengths, gaps and confidence, then separates immediate fit,
  career-growth value, skill gaps, and Apply/Consider/Do-not-apply guidance.
- **Answer Memory** versions user-confirmed answers; model suggestions remain
  unconfirmed until reviewed.
- **Form Field Memory** learns de-valued field mappings and reuses only mappings
  the user confirmed.
- **Application Package 2.0** binds one approved job to the approved Career
  Profile, best eligible resume, confirmed answers, cover-letter state,
  interview preparation, risks, safety gates, and a completion estimate.
- **Two safe Application Executors** use the same package, field mapper, portal
  adapters, safety policy, and report: the Chrome Extension is the recommended
  daily mode; the optional Local Browser Agent opens a visible dedicated Chrome
  session for advanced diagnostics. Both stop for login, CAPTCHA, MFA, unknown
  or sensitive questions, resume attachment, and final submission.
- **Optional AI providers** support a local OpenAI-compatible endpoint, OpenAI,
  Anthropic, or another HTTPS OpenAI-compatible endpoint. AI remains advisory;
  deterministic code owns scores, approval, and workflow state.

## Product preview

Product screenshots are pending privacy review and are not included yet. To
see the product, run the offline demo: `npm run demo`.

## Quick start

Requirements:

- Windows 11, macOS, or Linux
- Node.js 18 or newer
- Chrome or Microsoft Edge for browser assistance and the localhost E2E demo

```bash
git clone https://github.com/Kerrylala/resume-jobs-quick-apply.git
cd resume-jobs-quick-apply
npm install
npm start
```

Open [http://127.0.0.1:8767](http://127.0.0.1:8767).

Windows users can double-click `dist/ResumeJobs Launcher.cmd`. See
[quick_start.md](docs/user/quick_start.md) for the complete first-run walkthrough and
desktop shortcut instructions.

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

## Try the complete offline demo

```bash
npm run demo
```

The demo uses synthetic data, an isolated temporary directory, and a local fake
application form. It does not read your personal profile, contact a real job site,
upload a resume, or submit an application.

## Browser extension

Load `extensions/application_assistant` as an unpacked Manifest V3 extension.
Private profiles are not web-accessible resources. Automatic activation is
limited to localhost, Greenhouse, Lever, Ashby, and legacy Workday hosts; other
public pages use Chrome's one-tab `activeTab` permission after the user opens
the popup.

After **Start AI Fill Assistant**, the popup receives the reviewed application
setup only when the open page matches the selected job. It receives no resume
file bytes or final-submit permission. Resume attachment remains a separate,
explicitly confirmed manual action.

Use **Settings → Extension Connection** to verify the installed extension,
connection, current page, and matched application. Technical transport details
and identifiers are available only under **Advanced diagnostics**. Resume Jobs
uses localhost HTTP and does not require Native Messaging.

## Application Executor modes

Choose the executor while reviewing an approved Application Package:

- **Chrome Extension (recommended)** opens the exact approved URL in your
  normal browser. The popup displays company, role, simple readiness state,
  detected/filled/skipped counts, and fields that need review.
- **Local Browser Agent (advanced)** launches a visible Chrome/Edge window with
  a dedicated ignored profile. It takes before/after screenshots, writes a
  redacted execution report, fills the same safe fields, and pauses with the
  browser open for review.

The modes are not separate products. Both consume the same reviewed Application
Package, follow the same safety rules, and return the same redacted result. See the
[Extension guide](docs/user/EXTENSION_GUIDE.md) and
[Browser Agent guide](docs/user/BROWSER_AGENT_GUIDE.md).

## Safety model

Resume Jobs is not an unattended auto-submit bot.

- Final Submit is never clicked automatically.
- Login, CAPTCHA, MFA, and verification stop for the user.
- Application Executor never uploads or receives resume bytes.
- Sensitive and high-risk answers require confirmation.
- AI cannot change deterministic scores, approve a job, or advance an
  application state.
- Real-site access, login, resume upload, and submission require explicit user
  authorization.

Read [SECURITY.md](SECURITY.md) before using browser assistance on a real
application.

## Your data stays on your machine

- Everything you enter — resumes, profile facts, answers, applications,
  browser sessions — is written to local files under `data/`, `documents/`,
  and `browser_profiles/`. Nothing is uploaded anywhere.
- Those directories are excluded from Git, so cloning or forking this
  repository never carries anyone's candidate data.
- AI is optional and off by default. When you enable it, only the job posting
  and the specific facts a task needs are sent to the provider **you**
  configure (a local model, or your own API key). Contact details are never
  part of an AI request.
- Destructive actions archive first: **Delete all user data** copies every
  store into `archive/` before wiping, so a misclick is recoverable.

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

## Documentation

- [Documentation index](docs/INDEX.md)
- [Quick start](docs/user/quick_start.md)
- [中文用户指南](docs/user/USER_GUIDE_CN.md)
- [English user guide](docs/user/USER_GUIDE_EN.md)
- [中文安装指南](docs/user/中文安装指南.md)
- [中文运行指南](docs/user/中文运行指南.md)
- [Developer guide](docs/developer/DEVELOPER_GUIDE.md)
- [Architecture](docs/architecture/ARCHITECTURE.md)
- [Application Executor user guide](docs/user/USER_GUIDE.md)
- [Chrome Extension guide](docs/user/EXTENSION_GUIDE.md)
- [Local Browser Agent guide](docs/user/BROWSER_AGENT_GUIDE.md)
- [Extension architecture](docs/architecture/EXTENSION_ARCHITECTURE.md)
- [AI provider contract](docs/developer/AI_PROVIDER.md)
- [Security policy](SECURITY.md)
- [Release checklist](docs/release/RELEASE_CHECKLIST.md)

## Release status

`1.0.0-rc.1` uses a shared Application Executor contract for Extension and
Local Browser Agent modes, with Lever, Greenhouse, Ashby, and generic adapters.
Offline and localhost browser validation is part of the release suite. Public
portal validation remains explicitly supervised and never uploads, logs in,
handles challenges, or submits.

## License

[MIT](LICENSE)
