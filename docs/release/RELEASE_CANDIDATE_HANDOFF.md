# Resume Jobs AI 1.0.0-rc.1 Release Candidate Handoff

Frozen: 2026-08-12 (Asia/Shanghai)

Status: **RELEASE CANDIDATE FROZEN**

This handoff freezes the accepted implementation without changing product
architecture or adding features. The final smoke suite used only offline,
synthetic, or localhost fixtures. It did not open a public job site, upload a
resume, log in, handle a challenge, or submit an application.

## Exact startup instructions

### Windows 11 normal-user startup

1. Install Node.js 18 or newer from <https://nodejs.org/>.
2. Extract the clean release into a normal writable folder.
3. Open PowerShell in that folder once and run:

   ```powershell
   npm install
   ```

4. Double-click:

   ```text
   dist\ResumeJobs Launcher.cmd
   ```

5. The launcher checks Node.js, npm, required files, dependencies, and port
   8767. It starts the canonical `npm run app` entry and opens:

   <http://127.0.0.1:8767>

6. Keep the launcher window open. Close it or press `Ctrl+C` to stop only the
   Dashboard process tree started by that launcher. This does not delete local
   data.

Optional desktop shortcut:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\create_resume_jobs_shortcut.ps1
```

### Terminal startup on Windows, macOS, or Linux

```bash
npm install
npm start
```

Then open <http://127.0.0.1:8767>. The Dashboard binds to loopback only by
default. The equivalent product command is `npm run app`.

### Safe first look

To learn the workflow using synthetic data and a localhost form:

```bash
npm run demo
```

The demo is isolated from normal runtime data and never contacts a real job
site.

## Current supported workflow

1. **Resume** — import a text-based PDF, DOCX, or UTF-8 TXT resume. Resume
   Intelligence creates review-only facts and never silently approves them.
2. **Profile** — edit, add, reject, delete, version, and approve the Career
   Brain facts after checking their source and accuracy.
3. **Settings** — optionally configure an advisory AI provider. Deterministic
   workflow, approval, scoring, safety, and submission rules do not depend on
   AI output.
4. **Job Search** — save target roles and preferences; use a configured
   SearXNG source, explicitly import one public job URL, or use Offline Demo.
5. **Job Matches** — review discovery provenance, fit, gaps, warnings, and the
   recommended action; explicitly approve or reject each job.
6. **Applications** — build and review a job-bound Application Package with an
   approved Profile version, selected Resume version, confirmed answers,
   interview preparation, completion estimate, and risks.
7. **AI Fill Assistant** — create one ApplicationExecutionSession and choose
   either the Chrome Extension (recommended) or visible Local Browser Agent
   (advanced). Both use the same Package, mappings, and safety policy.
8. **User review** — the executor fills only approved safe fields. The user
   handles file attachment, unknown or sensitive questions, login, CAPTCHA,
   MFA, verification, and final submission.

Supported public-form adapters are Lever, Greenhouse, and Ashby, plus a
conservative generic adapter. Workday discovery is supported with limited,
manual handling for dynamic application forms.

## Known limitations

- The source, fixture, service-worker, content-script, popup, and localhost
  extension contracts pass, but the currently installed unpacked Extension has
  not completed a supervised real-instance heartbeat/connection check.
- SearXNG was reachable during acceptance, but three bounded live searches
  returned no upstream results. Direct public URL and company-career discovery
  remain available; zero results do not lock the product.
- Workday dynamic and multi-step forms are detector-only/limited and normally
  require manual completion.
- Encrypted, scanned, textless, or complex-font PDFs may not expose extractable
  text. DOCX, UTF-8 TXT, and text-based PDFs are the reliable inputs.
- AI configuration is optional and provider availability is external to the
  product. AI suggestions remain advisory and require review.
- Resume upload to an application, EEO or sensitive answers, login,
  CAPTCHA/MFA, and final Submit are intentionally not automated.
- The current approved Profile has no confirmed STAR stories; the product asks
  the user to add them and does not invent them.

## Rollback locations

Private rollback material must remain local and must never be copied into the
public repository.

- Final frozen source and runtime backup:
  `<RC_BACKUP_ROOT>\resume-jobs-ai-1.0.0-rc.1_final_20260812_122123`
- Pre-smoke verified baseline:
  `<RC_BACKUP_ROOT>\resume-jobs-ai-1.0.0-rc.1_20260812_121806`
- Overnight stabilization backup:
  `<PROJECT_ROOT>\archive\overnight_stabilization_20260811_230614`

Each final backup contains separate `source/` and `runtime/` trees plus
SHA-256 manifests. Restore only the required tree into a separate recovery
folder first, compare it, and then copy back the specific files needed. Do not
use destructive Git reset/clean commands against the working product.

The directory ending in `_20260812_121659` is explicitly marked incomplete and
is **not** an approved rollback source.

## Normal-user acceptance checklist

- [ ] Node.js 18+ is installed and `npm install` completes.
- [ ] Double-clicking `dist\ResumeJobs Launcher.cmd` opens the Dashboard at
      `http://127.0.0.1:8767` without a terminal stack trace.
- [ ] Home clearly presents the next action.
- [ ] A supported resume creates reviewable, unapproved Career Brain facts.
- [ ] Profile facts can be edited and approved only after review.
- [ ] Search preferences save and the UI explains unavailable/empty providers.
- [ ] Job Matches show source, query/reason, fit, gaps, and lifecycle state.
- [ ] Approving a job unlocks its independent Application Package.
- [ ] Start AI Fill Assistant explains any missing Profile, Package, URL, or
      executor requirement instead of silently disabling an action.
- [ ] The selected executor detects fields and fills only approved safe fields.
- [ ] Upload, sensitive/EEO questions, login, CAPTCHA/MFA, and Submit remain
      manual.
- [ ] Closing the launcher stops its Dashboard and leaves local data intact.

## Final critical smoke result

Run on 2026-08-12 after the overnight acceptance:

| Command | Result |
|---|---|
| `npm run validate` | PASS; all risky-action flags false |
| `npm test` | PASS; 224/224 tests |
| `npm run test:e2e` | PASS; synthetic workflow reached manual-submit readiness |
| `npm run test:browser` | PASS; localhost only, no upload or Submit |
| `npm run test:browser-agent` | PASS |
| `npm run test:browser-agent-dashboard` | PASS; Retry/Re-scan and safety checks |
| `npm run test:launcher` | PASS; 4/4 Windows launcher tests |
| `npm run audit:release` | PASS; 239 pre-handoff files, 0 findings |

After this handoff document was added, the final release tree was audited
again before export; the export manifest is authoritative for the final file
count and hashes.

The smoke changed two generated localhost browser-test reports. Both were
restored from the pre-smoke backup, and all 552 protected runtime files then
matched their original SHA-256 hashes. No Browser Agent, test server,
Dashboard, temporary Chrome/Edge process, or monitored test port remained.

## GitHub publication warnings

- Publish only the clean export tree identified in the final handoff report.
- Do not copy `.git/` or publish the existing Git history. Read-only inventory
  found historical runtime/Profile-memory paths; the current clean tree does
  not make those historical blobs safe.
- Never publish runtime `data/*.json`, resumes/documents, Profiles, API or
  provider settings, Answer/Form Field Memory, Applications, Packages,
  Sessions, browser profiles/state, extension-local bundles, logs, archives,
  private reports, real-site screenshots, `.env`, cookies, tokens, or keys.
- Machine-specific `.lnk` files are excluded. Portable `.cmd`, PowerShell, and
  source files are included.
- Public screenshots and `demo.gif` contain synthetic product data only; real
  page evidence remains excluded.
- Before publication, the owner must confirm repository/contact URLs, license
  attribution, release notes, and the exact export contents.
- No remote is configured, and this freeze performs no commit, push, release,
  publication, or application action.
