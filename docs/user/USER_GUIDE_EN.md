# Resume Jobs Personal AI Job Application Agent - User Guide

## 1. Overview

Resume Jobs is a locally run personal AI Job Application Agent. It connects goal setting, job discovery, match review, user approval, application preparation, assisted form filling, and manual submission in one traceable workflow. Its north-star metric is **Application Completion Rate** for jobs the user has approved.

It can help you:

- Define target roles, locations, seniority, skills, and workplace preferences.
- Collect, normalize, and deduplicate job leads.
- Review match scores, strengths, gaps, and supporting evidence.
- Decide which jobs should continue and how many may be opened at once.
- Prepare a resume selection, cover-letter draft, and question answers for each job.
- Fill known, low-risk fields through the Chrome Extension or visible Local Browser Agent after explicit approval.
- Track application state and resume safely after a pause.

Resume Jobs does not make the final decision for you. Login, CAPTCHA, MFA, file upload, sensitive questions, and final submission remain manual.

## 2. Workflow

### Step 1: Create a job-search goal

Open **Job Search**, create or select a Search Profile under **Search Configuration**, and enter:

- Target roles and keywords.
- Countries, cities, or remote locations.
- Seniority, employment type, and workplace mode.
- Required and preferred skills.
- Preferred or excluded companies and excluded keywords.
- Posting age, minimum salary, and search-result limits.
- `maximum_jobs_to_open`, which limits how many jobs continue at once.

Save the profile before searching. Start with a small result limit until the rules match your intent.

### Step 2: Search for jobs

Select **Run Search**. The system collects candidates according to the active profile, then normalizes, deduplicates, and checks them. Records that fail source or quality validation are excluded from the normal match list and recorded in the local run result for diagnosis.

The default test workflow can run entirely offline. Access to real public job pages is a controlled operation and should only occur within an explicitly approved scope.

### Step 3: Review scoring

Select **Score Jobs** and review:

- Match score and tier.
- Role, location, and skill alignment.
- Identified strengths.
- Missing skills, weak evidence, and other risks.
- Original source link and scoring evidence.

A score is a prioritization aid, not a prediction of hiring success. Always verify that the job is genuine, open, and suitable.

### Step 4: Approve jobs

Select **Prepare Review Queue**, then choose one of the available actions:

- **Approve** to continue preparing the application.
- **Reject** to stop processing the job.
- **Manual Review** to defer the decision.
- **Reset** to return to an earlier allowed state.

The workflow respects the active profile's `maximum_jobs_to_open` limit.

### Step 5: Build an application package

For an approved job, select **Build Package**. A package may contain:

- The selected resume version and its source.
- A cover-letter draft or a clear missing-information marker.
- Common-question answers and their provenance.
- Unanswered questions, sensitive questions, and manual review items.

Review the entire **Application Package** panel. The product must not invent experience; missing facts remain blank or require your confirmation.

### Step 6: Use assisted filling

After reviewing the package, select **Approve AI Fill**, then explicitly select **Start AI Fill Assistant**. AI Fill Assistant fills known, approved, low-risk fields and pauses for your review.

The workflow pauses for:

- Login.
- CAPTCHA.
- SMS, email, or authenticator MFA.
- Resume or document upload.
- Unknown questions or missing trustworthy answers.
- Salary, work authorization, equal-employment, or other sensitive questions.
- Page changes where the next action cannot be confirmed as safe.

### Step 7: Submit manually

At `READY_FOR_MANUAL_SUBMIT`, review every field, attachment, and declaration. Only you may click the site's final **Submit / Send / Confirm** control. After submitting, return to the Dashboard and use **Mark Submitted** to record your manual action.

## 3. Setup

Requirements:

- Windows 11.
- Node.js 18 or later, including npm.
- Chrome or Microsoft Edge; assisted filling can use the Chrome Extension or visible Local Browser Agent.
- Optional: LM Studio or another local OpenAI-compatible endpoint for fallback-capable text assistance.

If dependencies are not installed, run once from the project folder:

```powershell
npm install
```

The launcher does not download software or change system configuration.

## 4. First Launch

1. Open the project's `dist` folder.
2. Double-click `ResumeJobs Launcher.cmd`. To add a desktop icon, run the shortcut command shown below once.
3. The launcher checks Node.js, npm, project dependencies, required files, configuration status, and port 8767.
4. It starts the canonical application entry with `npm run app`.
5. When ready, the default browser opens `http://127.0.0.1:8767`.
6. Keep the launcher window open. Press Enter or Q to stop only the processes started by that launcher.

Missing search preferences or a private profile are shown as friendly warnings; they do not prevent the Dashboard from opening. Closing the launcher does not delete jobs, applications, or settings.

### Registering a resume for the first time

1. Open **Resume**.
2. Choose a local PDF, DOCX, or UTF-8 TXT file and enter its library name, target roles, and language.
3. Select **Add Local Resume**, read the confirmation, and allow a local library copy.
4. Resume Jobs verifies the type and size, calculates a SHA-256 hash, and creates an unapproved version. Duplicate content is rejected.
5. Review the path, version, target roles, and Content Hash, then select **Review and Approve Version**.

Local import is not a recruiting-site upload. Import stores the local file, path, hash, and metadata. The active resume is analyzed immediately on this computer, and new non-sensitive facts are saved to Candidate Profile as unconfirmed review drafts; existing facts are never overwritten and raw resume text is not saved. Choose **Analyze Local Copy** to reverify the hash and review the current suggestions again. Applying a reviewed suggestion revokes profile approval, so you must review all Candidate Facts and confirm a new snapshot. An unapproved resume version still cannot make an Application Package `PACKAGE_READY`; external attachment, login, and final submission remain disabled.

To install a shortcut on the current Windows desktop, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/create_resume_jobs_shortcut.ps1 -InstallDesktop
```

## 5. Dashboard

- **Home** summarizes onboarding, product status, and completion insights.
- **Resume** registers, reviews, analyzes, and approves local resume versions.
- **Profile** manages candidate facts and reusable Answer Memory.
- **Job Search** manages Search Profiles and runs discovery.
- **Job Matches** shows match scores, evidence, filters, and review actions.
- **Applications** prepares and reviews application packages, fill readiness, and progress.
- **Settings** contains Job Search Sources, optional local model status, and safety configuration. Safety locks cannot be disabled there.
- **Application Completion** shows the average automated completion rate for approved jobs with a package or fill report.
- **Fields Needing You** counts new, sensitive, high-risk, or low-confidence fields that still require user action.
- **Make the next application faster** summarizes repeated blockers and recommends the next fact, answer, or field mapping worth confirming. The feedback uses field names, states, and counts—not answer values.

If a view appears stale, refresh it or reopen the Dashboard. Avoid repeatedly selecting an action that is already running.

Confirming Candidate Facts means only that you reviewed those facts. It does not enable real-site autofill, external resume attachment, or final submission. Work authorization, salary, EEO, and other sensitive facts still require confirmation for each job.

## 6. Job Search Configuration

Each Search Profile represents one job-search strategy. Use separate profiles for materially different goals.

Important fields include:

- `target_roles`: role names and keywords.
- `preferred_locations`: acceptable locations.
- `workplace_modes`: remote, hybrid, onsite, or any.
- `seniority_levels`: entry, junior, mid, senior, and similar levels.
- `required_skills` / `preferred_skills`: required and bonus skills.
- `excluded_keywords` / `excluded_companies`: explicit exclusions.
- `posted_within_days`: maximum posting age.
- `maximum_search_results`: candidate limit per run.
- `maximum_jobs_to_open`: number of jobs allowed to continue together.

Before the first Live Search, open **Settings -> Job Search Sources**. Enter the
SearXNG endpoint, enable it, save, and choose **Test Connection**. `READY` means
it can be used; `DISABLED`, `MISCONFIGURED`, `UNREACHABLE`, and `ERROR` include
an actionable explanation. A local suggestion is shown but is not saved
automatically.

Choose one explicit mode:

- **Offline Demo** creates one synthetic localhost job and uses no network.
- **Live Search** discovers public jobs and uses deterministic scoring.
- **Live Search + AI Enrichment** adds optional local-model explanations after
  the same live search and scoring. Missing AI never blocks Live Search.

To add one known public posting, paste its detail-page URL into **Import one
public job URL**, choose **Import and Score**, and confirm the one-time public
fetch in the product modal. The importer rejects credentials, remote HTTP,
private/internal destinations, redirects, non-HTML responses, and oversized
pages. It does not open an application form, log in, upload, or submit.

## 7. Job Scoring

Scoring combines the active goal, location, seniority, skills, and job-data quality. The strengths and gaps are more useful than the number alone:

- A high score indicates alignment with the current profile, not authenticity or hiring probability.
- Missing descriptions, uncertain sources, and conflicting fields reduce confidence.
- Scores may change when the profile, job details, or scoring rules change.
- The decision to continue always belongs to you.

## 8. Application Package

An Application Package is the local pre-fill record for one job. It brings together the resume version, cover letter, answers, provenance, sensitive fields, and missing items. Its summary shows the available candidate-fact count, core-fact coverage, estimated completion rate, and estimated review time.

Resume Intelligence analyzes the active resume during an explicit local import and can be rerun with **Analyze Local Copy**. DOCX analysis extracts Word document XML, UTF-8 TXT is read directly, and text-based PDF analysis uses best-effort text-stream extraction. Scanned files, encrypted PDFs, and complex font encodings may not be analyzable. Every extracted fact starts unconfirmed, existing and sensitive facts are never overwritten automatically, raw text is not saved, and missing core facts remain visible.

When the Resume Library contains multiple approved versions, the product recommends one using the job title, registered target roles, and registered skills. The Application Package panel shows the recommendation, confidence, candidate scores, and matching evidence. Before fill approval, you may select another version and choose **Use selected version**; this per-application override does not change the active Resume Library version. Resume changes are locked after filling begins.

Before approving it, verify:

- The resume version is appropriate for the role.
- The recommendation evidence is sufficient; make any override before **Approve AI Fill**.
- File references point to the correct reviewed materials.
- The cover letter contains no invented experience or false claims.
- Every answer comes from user confirmation or trustworthy source material.
- Sensitive and unresolved questions have been handled explicitly.

Building a package does not upload a file or submit an application.

## 9. Answer Memory

**Answer Memory** stores common answers that you have explicitly confirmed. Editing a saved answer creates a new version while retaining the old one for audit purposes.

- Enter the question as shown and the confirmed answer.
- Select its source and scope.
- Only confirmed answers may be reused.
- Sensitive answers are never inferred automatically.
- Update the answer when your circumstances change.

### Form Field Memory and completion

**Form Field Memory** remembers which canonical profile key matches a portal field. It never stores the candidate answer value. New mappings appear in the extension's **Learn questions** area:

- Only non-sensitive mappings that you explicitly approve are reused.
- Repeated successful use raises mapping confidence.
- Rejected mappings are not used.
- Salary, work authorization, identity, and EEO mappings remain manual even when detected.

The Completion value in an Application Package is an estimate before opening the page. The value recorded after an extension run is the observed result. Neither means the application was submitted.

## 10. Browser Automation

Browser assistance offers two modes. **Chrome Extension (recommended)** uses your normal browser; **Local Browser Agent (advanced)** opens a visible dedicated Chrome/Edge window. Both use the same reviewed application setup, so you never load profile data into either mode manually. Starting the Dashboard does not visit recruiting sites. For one job, review the application, choose **Approve AI Fill**, select a mode, and click **Start AI Fill Assistant**. Only reviewed safe fields become available to the assistant; resume files, sensitive-answer permission, and submit permission do not. Workday dynamic multi-step support remains limited.

The automation is a filling assistant, not an unattended applicant. It does not bypass CAPTCHA or MFA, log in on your behalf, automatically upload resumes, or click the final submit button.

## 11. Security Rules

- Never submit a real application automatically.
- Never bypass CAPTCHA, MFA, or site access controls.
- Never invent experience, education, skills, or identity information.
- Never infer sensitive salary, work-authorization, government-ID, or equal-employment answers.
- Do not log in, upload a resume, or access real recruiting sites without explicit authorization.
- Data stays in local project folders by default; protect and back up private material appropriately.

### Complete offline demo

To understand the full product flow without configuring private data, open `dist` and double-click:

```text
ResumeJobs Offline Demo.cmd
```

The demo uses a synthetic candidate, synthetic resume reference, Demo Search, Demo Job, mock local model, and a local fake application form. It exercises deduplication, scoring, approval, application preparation, safe filling, unknown-question pause and recovery, Completion reporting, and Field Memory learning.

The bilingual report opens in your default browser. A successful run shows:

- Pipeline `10/10`.
- Final state `READY_FOR_MANUAL_SUBMIT`.
- Final Submit `Not clicked`.
- Real-site access, private-profile use, login, resume upload, and formal-data modification all `false`.

Reports are written under `output/offline_demo/`. Names and answers shown in screenshots are synthetic test data, not your personal information.

## 12. FAQ

**The launcher says Node.js is missing.**  
Install Node.js 18 or later with npm, close the old launcher window, and try again.

**The launcher says dependencies are missing.**  
Run `npm install` in the project folder, then launch again.

**Port 8767 is in use.**  
If Resume Jobs already owns the port, the launcher opens the existing Dashboard. If another program owns it, close that program. Developers can also pass a different `-Port`.

**The Dashboard contains no jobs.**  
Save an enabled Search Profile in Job Search. For real public jobs, configure
and test SearXNG under Settings -> Job Search Sources. Offline Demo is
synthetic and never represents a real vacancy.

**Why can I not start filling?**  
Check that the job is approved, the package is ready, Approve AI Fill was selected, and no sensitive or unknown question remains unresolved.

**Why is there no automatic submission?**  
Manual final submission is a non-bypassable product safety rule.

**How do I stop the app?**  
Press Enter or Q in the launcher window. If the window is lost, run `scripts/stop_dashboard_windows.ps1`; it stops a process only after confirming that it belongs to Resume Jobs.

**The shortcut stopped working after moving the project.**  
The repository does not ship a machine-specific `.lnk` file because it contains an absolute local path. Generate one for the current machine with `scripts/create_resume_jobs_shortcut.ps1 -InstallDesktop`, or use the portable `dist/ResumeJobs Launcher.cmd`.
