# Resume Jobs AI - Quick Start

This guide takes a new local installation from download to a working Dashboard.
After installation, Windows users can start the product without a terminal.

## 1. Install the requirements

1. Install [Node.js 18 or newer](https://nodejs.org/).
2. Install Chrome or Microsoft Edge.
3. Download or clone this repository.

## 2. Install the app

Open PowerShell in the project folder and run:

```powershell
npm install
```

The current release has no required third-party runtime package, but this
command verifies the package metadata and prepares the normal Node.js workflow.

## 3. Start Resume Jobs

### Windows

Double-click:

```text
dist\ResumeJobs Launcher.cmd
```

The launcher checks Node.js, required project files, and port 8767; starts the
existing Dashboard server; and opens the default browser.

To create a desktop shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create_resume_jobs_shortcut.ps1
```

### macOS or Linux

```bash
npm start
```

Open <http://127.0.0.1:8767>.

## 4. Complete first-time setup

Follow the Dashboard's current-step action in this order:

1. **Resume** - upload one PDF, DOCX, or UTF-8 TXT resume. The active version
   is analyzed locally; raw resume text is not stored in Candidate Facts.
2. **Profile** - edit, add, reject, delete, and approve extracted facts. Only
   approve a snapshot after checking every fact.
3. **Job Search** - save at least one target role and your location, skills,
   seniority, exclusions, salary preference, and result limit.
4. **Find Jobs** - use a configured Live Search provider, paste one public
   job-detail URL, or choose the synthetic Offline Demo.
5. **Job Matches** - review the score, six candidate-fit dimensions, evidence,
   gaps, and safety status. Approve only jobs you want to continue.
6. **Applications** - build and review the Application Package, selected resume,
   answer provenance, unknown questions, and completion estimate.
7. **AI Fill Assistant** - approve field filling, choose Chrome Extension or
   Local Browser Agent, and open the page. Handle login, CAPTCHA, MFA,
   sensitive questions, resume attach, and final Submit yourself.

## 5. Run the safe demo first

```powershell
npm run demo
```

The demo uses an isolated temporary directory, synthetic candidate/job data,
and localhost only. It is the recommended way to learn the complete workflow.

## 6. Optional AI provider

Search and deterministic matching do not require AI. To add advisory
explanations, open **Settings -> AI Provider**, select a provider, enter its
endpoint/model, save, and choose **Test Connection**. Credentials stay in the
ignored local settings file and are never returned by the API.

## 7. Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `extensions/application_assistant`.
5. Pin **Resume Jobs AI Fill Assistant**. Reload the unpacked extension after
   updating the source.

After Dashboard **Start AI Fill Assistant**, open the popup on the matching job page. It
syncs the active Application Package and approved safe mappings from localhost;
no manual Profile import is needed. It enables **Fill safe fields** when all
safety gates pass.

To use the visible controlled-browser mode instead, select **Local Browser
Agent (advanced)** while reviewing the Package. Both modes share the same
reviewed application setup and safety policy.

## Troubleshooting

- **Node.js is required** - install Node.js 18+ and restart the launcher.
- **Port 8767 is in use** - stop the other local process or use a different
  `PORT` with `npm start`.
- **Live Search is unavailable** - configure and test SearXNG, paste a public
  job URL, or use the Offline Demo.
- **No match appears after URL import** - confirm that the URL is a public job
  detail page and run **Score Jobs** again.
- **Resume analysis fails** - encrypted, scanned, or complex-font PDFs may not
  contain extractable text. DOCX, UTF-8 TXT, and text-based PDF work best.
- **Extension says Not connected** - return to the approved application in the
  Dashboard, choose **Start AI Fill Assistant**, then open the extension on the
  application page that Resume Jobs opened. The default Dashboard port is 8767.
- **Stop the Windows app** - close the launcher window or run
  `scripts\stop_dashboard_windows.ps1`.

See [中文故障排查.md](中文故障排查.md) or
[USER_GUIDE_EN.md](USER_GUIDE_EN.md) for more detail.
