# Claude Independent Product & Architecture Audit — Resume Jobs AI

**Audit date:** 2026-08-14
**Auditor:** Claude (independent read-only audit; no prior agent's conclusions assumed)
**Method:** static code audit of the full tree, live dashboard walkthrough against an isolated copy of runtime data (`RESUME_JOBS_DATA_DIR` + sibling overrides, port 8899), report-vs-code cross-verification, and git-history inspection. **No product source code, runtime data, or git state was modified.** All personal values observed in runtime data are redacted from this report.

---

## 1. Executive verdict

Resume Jobs AI is a **well-gated, safety-disciplined backend wearing a frontend that actively fights the user**. The domain layer (Career Brain, state machine, executor safety policy, learning pipeline) is genuinely good engineering. But the product the user experiences is assembled from five concurrent profile representations, three approval stores, three package-readiness flags, and four fill-readiness layers plus a fifth invented independently in the frontend — so the UI routinely displays contradictory facts on a single screen ("Career Brain READY" next to "Missing core facts: First Name, Last Name, City, Country, LinkedIn" next to "Nothing new to answer"). Three P0 defects make the advertised core loop impossible to complete: **(1)** manually entered answers can never become reusable (the UI never sets `approved_for_real_applications`, so the package filter rejects them forever — `candidate_records.mjs:411` vs `app.js:4614-4631` vs `build_application_package_preview.mjs:152`); **(2)** the "recommended" Chrome Extension mode can never reach `READY_FOR_MANUAL_SUBMIT` because re-scan is Browser-Agent-only (`server.mjs:5230-5238`, `application_state.mjs:1100`), so "Submit yourself" is structurally unreachable in the default mode; **(3)** tailored resume generation — the core promised capability — **does not exist anywhere in the codebase** (only substring-ranked selection among already-uploaded files; zero document-writing code). The 224 passing tests are real but measure the wrong thing: no automated test performs a real fill, the extension's shared-core integration is never exercised, and real-page fill completion is ~9% (3 contact fields) versus near-100% on localhost mocks. The user is confused because the product is confusing — not because the user is missing something.

**Strategic recommendation: C — add a separate Quick Apply UI over the existing backend** (with a short list of mandatory backend P0 fixes), keeping the current Dashboard temporarily as an Advanced mode, then retiring it screen-by-screen. Details in §17.

---

## 2. Baseline (Phase 0)

- **Branch:** `codex/resume-jobs-product-completion`. **Exactly one commit** in the entire repository: `f00dd9b` "baseline before goal mode automation" (2026-06-27), on which both `main` and the current branch sit. No remote.
- **The entire release candidate is untracked.** `git ls-files` shows 122 tracked files — a *June-era, different product* (old Python scripts, `goal_mode/`, old docs). `README.md`, `tests/`, `application_executor/`, `browser_agent/`, `extensions/`, `portal_adapters/` are all untracked. The index holds staged deletions of `data/*.json` and old reports — but those blobs (including the owner's personal profile: name, education, LinkedIn field, local resume paths in `data/user_profile.json`, `data/resume_profiles.json`) **remain reachable from HEAD**.
- **Repo size:** ~1.3 GB working tree (node_modules, .venv, browser profiles), 22 MB `.git`.
- **Runtime dirs:** `data/` (16 JSON stores), `applications/` (3 per-job package dirs), `documents/resumes/` (1 uploaded resume), `browser_profiles/`, `browser_sessions/`, `archive/` (hundreds of `dashboard_state.json.*.bak` files — physical evidence of state-repair churn), `logs/`, `reports/`.
- **Entry points:** `npm start` → `dashboard/server.mjs` (port 8767); `dist/ResumeJobs Launcher.cmd` / `Developer.cmd` / `Offline Demo.cmd`; `npm run demo`.
- **Tests:** 40 test files; `npm test` runs 39 offline-guarded (network+repo-write blocked); browser tests are separate opt-in scripts.
- **Two executor modes:** Chrome Extension (default, "recommended") and Local Browser Agent ("advanced").
- **Legacy remains:** `data/jobs_approved.json`/`jobs_rejected.json` dead stores; `renderJobsTableLegacy` (188 lines dead code, `app.js:623-810`); `package_bundle.local.js` (1,520-line superseded extension bridge); 24 distinct compatibility shims (catalogued in §13).

### Chronology — how the complexity accumulated

Reconstructed from the ~30 root reports and cross-checked against code:

| Phase | Dates | What happened | Layer added |
|---|---|---|---|
| 0 — Original product | ≤2026-08-06 | Dashboard + JSON stores + MV3 extension filling **localhost mocks**. 122→139 tests. | — |
| 1 — First contact with reality | 08-07 → 08-09 | SearXNG returned **zero** results; real Greenhouse fill got **2 of 19 fields**. | URL-import fallback; resume parser rewrite; five in-flight P0 repairs |
| 2 — Executor split | 08-10 | Installed-Chrome extension handoff could not be driven → "PARTIAL / NOT YET ACCEPTED" | **A whole second transport** (`browser_agent/` + `application_executor/` shared core + `portal_adapters/`) |
| 3 — State repair era | 08-11 | Four conflicting records deadlocked one job; challenge signal blocked all filling | Session schema 1.1; `legacy_application_runs` quarantine; "Recover and rebuild"; passive/active challenge classifier; canonical state vocabulary + read-boundary alias normalization |
| 4 — Freeze | 08-12 | 34 overnight bug fixes, soak, "PASS" acceptance, RC frozen | more compat shims retained deliberately |

**Conclusion:** complexity grew primarily by **patch accumulation in response to real-world failures**, not by product requirements. Each real-page failure produced a new layer *beside* the old one rather than a replacement — which is why five profile representations and two executors coexist. The repair code around the application state machine is now **~870 lines versus the 66-line state machine it protects (~13×)**, and the live `dashboard_state.json` still contains quarantined `legacy_application_runs` at schema v3.0.

### Report claims vs code (spot-check)

- `FINAL_PRODUCT_ACCEPTANCE_REPORT.md` says "PASS" while its own body admits "installed Extension connection is still reported as unverified." The "eight-hour" acceptance is 2h soak + 1.2h supplementary monitoring inside a wall-clock window.
- `README.md` recommends the Chrome Extension as the daily mode; `OVERNIGHT_PRODUCT_AUDIT.md` grades it "INSTALLED UNVERIFIED" and OGS-008 remains open. The recommended mode is the never-observed-working one.
- The "239-file zero-finding release audit" audited a staged export tree that has **never been committed to git**.
- The best-disciplined report is `MULTI_JOB_WORKFLOW_ACCEPTANCE_REPORT.md`, which explicitly bounds its own claim ("does not mean the current real application is ready to submit").
- No report fabricates a submission — all honestly record `submissions: 0`. The overstatement is in headline framing, not in data.

---

## 3. Architecture map (Phase 1)

| Component | Source of truth | Persistence | Key consumers | Does the user need to know it exists? |
|---|---|---|---|---|
| Career Brain | `scripts/lib/career_brain.mjs` | `data/career_profiles.local.json` | package builder, workflow gates | As "Your profile" only |
| Candidate Profile (legacy) | `scripts/lib/resume_intelligence.mjs` | `data/candidate_profile.local.json` (+3 fallback paths, `server.mjs:669-696`) | resume intelligence, completion plan | **No** — pure compat layer |
| Resume Versions | `scripts/lib/candidate_records.mjs` | `data/resume_profiles.json` + `documents/resumes/` | package builder | As "My resume" |
| Job Discovery | `scripts/discover_jobs.mjs` + `providers/` | `job_leads.json`, `search_runs.json` | scoring | As "Find jobs" |
| JobRecord | `scripts/lib/job_records.mjs` | `job_leads.json` → `jobs_shortlist.json` | everything | No (implementation) |
| Job Match | `score_jobs.mjs` + `candidate_matching.mjs` + `hybrid_matching.mjs` | `jobs_shortlist.json` | dashboard, packages | As "Match score" |
| Job Approval | `approval_safety.mjs` + `server.mjs:3223` | `job_reviews.json` **+** `dashboard_state.json` override | package gates | As "Approve" |
| Application Package | `build_application_package_preview.mjs` + `application_package_2.mjs` | `applications/<job>/` (6 files) | execution session | **No** — should be an invisible preparation step |
| Application state | `application_state.mjs` (17 states) | `dashboard_state.json` → `application_status_overrides` | server, UI | Only as ~5 plain statuses |
| ApplicationExecutionSession | `execution_session.mjs` (10 states, **no transition table**) | `dashboard_state.json` + `browser_sessions/<id>/` | executors | **No** |
| Answer Memory | `candidate_records.mjs:415-497` | `data/question_bank.json` (**currently absent**) | package builder | As "My answers" |
| Form Field Memory | `learning_candidates.mjs:248-317` | `form_field_memory.local.json` (value-free — verified) | executor rules | **No** |
| Chrome Extension | `extensions/job_apply_autofill/` (2,412-line `content.js`) | `chrome.storage` (own field memory!) | fills forms | As "the browser helper" |
| Local Browser Agent | `browser_agent/run.mjs` + `playwright_executor.mjs` | `browser_sessions/`, `browser_profiles/` | fills forms | As "the browser helper" |
| Dashboard | `dashboard/server.mjs` (6,034 lines, 39 routes) + `app.js` (5,096 lines) | — | user | — |
| SSE / polling | `server.mjs:162-202` / `app.js:2088-2128` | in-memory | UI freshness | **No** |
| Windows launchers | `scripts/start_dashboard_windows.ps1` (356 lines, bilingual) + `dist/*.cmd` | — | user | As "the app icon" |

### Duplicate concepts — every place two modules can disagree about one fact

This is the **dominant architectural defect** and the direct cause of the user's confusion:

1. **Profile: 5 representations** (Career Brain store, legacy candidate profile, frozen per-application profile, extension profile file, session `approved_field_mappings`). Three *different approval predicates* exist; `workflow_state.mjs:128-131` ORs two of them, so the workflow can say "profile approved" while `currentApprovedProfileVersion()` returns null and blocks execution. The same package file contains **two differently-shaped `career_profile_reference` objects** (`application_package_2.mjs:125-132` vs `career_brain.mjs:571-576`).
2. **Resume: duplicate active-id keys** (`active_resume_profile_id` and `active_resume_id`, written together at `candidate_records.mjs:340-347`, read inconsistently in 4 places).
3. **Approval: 3 stores** — `job_reviews.json` (lowercase decisions), `dashboard_state.json` overrides (uppercase states), and a never-written `approval_status` field on shortlist records; plus two dead stores (`jobs_approved.json`/`jobs_rejected.json`). Written non-atomically — a crash between the two writes leaves them divergent.
4. **Package readiness: 3 flags** — `application_package.json.status`, `package_manifest.json.package_status`, and the overlay's `package_status`. `deriveApplicationStatus` (`application_state.mjs:208`) treats `preview_created` as `PACKAGE_READY` *even when the package document itself says `NEEDS_USER_INPUT`* (masked today only by write order — a latent bug).
5. **Fill readiness: 4 server layers + 1 unrelated frontend layer.** The frontend "Answers ready ○ / No reusable answers yet" (`app.js:1574`) is computed from `plannedAnswers.length > 0` — a condition **no server gate uses**. A first-run user sees a failure marker for the normal empty state while the server simultaneously reports `can_start_fill: true`. Observed live.
6. **Two parallel state machines** — 17 application states (with transition table) and 10 session states (with **no** transition table — any state can jump to any state), sharing four state names with different meanings, coupled via hard-coded string arrays in five files.
7. **Browser connection: 4 notions** — persisted `session.connection.status` (a sticky bit never reset — reports CONNECTED forever), an in-memory TTL map (lost on restart), a PID-liveness probe, and the agent's `status.json`. Guaranteed disagreement after any restart.
8. **Answer storage: same answers serialized three ways in one package file** (`planned_answers`, `application_answers`, `form_answers.answers`); executors read only `application_answers`.
9. **Field mapping: 4 sources** — shared-core defaults, a second extension defaults file, the server's confirmed field memory, and the extension's own `chrome.storage` field memory with a different hash algorithm.
10. **Job status: 7 concurrent fields per job** (`status`, `approval_status`, `application_status`, `lifecycle_status`, `shortlist_status`, `discovery_status`, `package_status`) plus 3 derived labels; the lifecycle deriver accepts alias names that aren't canonical states.
11. **Selected job: 3 notions** (server `selected_job_ids`, client `packageReviewJobId`, extension `matched_job_id`) — the hidden `SELECTED_JOB_MISSING` blocker comes from this.
12. **Executor selection: 3 persistence points and 3 documented ways for UI and server to disagree**, one of which silently lets the UI override the saved choice at start-fill (`server.mjs:5027-5029`).

---

## 4. Actual user journey (Phase 2 — observed live)

Run against an isolated data copy; observations are from the real rendered UI, not from code inference.

- **The SPA stacks every workflow section into one continuously scrolling page.** The "Home" view measured **14,490 px tall (~20 viewport heights) with 94 visible buttons**; 237 buttons in the DOM; the Applications view's accessibility tree serializes to **124,000 characters**. Nav "tabs" largely re-show/hide stacked sections; "Home" is literally three pages (daily dashboard + resume upload + the full Career Brain editor).
- **Contradictory state on one screen, verbatim:** Home shows "CAREER BRAIN … READY … 37 reusable facts · approved for package preparation" while the package panel for the same profile shows "Missing core facts: First Name, Last Name, City, Country, Linkedin" and "Core fact coverage 29%" — and, in the same panel, both "Answers ready ○ No reusable answers yet" and "Nothing new to answer — All known questions are ready."
- **Raw internals rendered to the user:** full deterministic score JSON (`{"title_match": …}`) on every job card; a 25-key raw package JSON dump; raw tokens `active_resume_tiebreaker`, `target_role_not_matched_in_title`; skip-reason enums ("Skipped Value Missing · Skipped Not Visible · Skipped Captcha Control"); "Estimated review 290 sec"; ID rows (Session ID / Package ID / digest) in "Advanced diagnostics".
- **Ten-step workflow as the primary metaphor:** a permanent 10-step rail ("Step 9 · Review the application") plus section eyebrows "STEP 3–4", "STEP 5–6", "STEP 7–10", plus an 8-stage search sub-stepper — three concurrent progress systems.
- **Percentages everywhere, checklist nowhere:** "18% ready / 19% / 20%", "Application Completion 19%", "Fields Needing You: 92" — while the per-field blocker list the backend already computes (`application_completion.mjs:208-217`) is never rendered.
- **Dead end observed live:** clicking "Review Career Brain" on Home opened a **completely empty generic "Confirm action" modal** (title and buttons, no body text); confirming returned to Home. There is no Career Brain top-level nav item despite the product constantly telling the user to go to "Career Brain".
- **Disabled controls don't explain themselves:** locked tabs put their reason in a `title` attribute on a `disabled` button — which Chrome never shows. The fill-method select and "Approve Profile" disable with no message at all. During any mutation, *every* job-card button grays out silently.
- **Two different "Approve Profile" buttons** hit two different endpoints with two different confirmation modals.
- **Language:** the dashboard is 100% English; only the launchers are bilingual. For the actual user (Chinese-speaking) every product concept arrives in a foreign language on top of being technical.

### Click-count map

Counts are primary clicks / modals / mandatory scrolling, from the live UI plus code confirmation (`app.js` confirm sites):

| Scenario | Clicks | Modals | Technical concepts forced on the user | Major decisions before a filled page |
|---|---|---|---|---|
| **A — First application** (approved match → opened, safely filled form) | 5–7 (Build Package → panel → [batch checkbox] → [executor choice] → Approve AI Fill → Start AI Fill Assistant) | 2 | package, executor, fill approval, batch selection, readiness states | **4–5** (limit should be ≤3) |
| **B — Second application** (profile + answers configured) | 4–5 | 2 | same — nothing gets simpler with experience | 3–4 |
| **C — Rejected job reconsideration** | ~6 (find in Rejected filter → Reconsider & Approve → as A) | 3 | rejection history model, then all of A | 5 |
| **D — Manual answer reuse** | 3–5 extra (type in controlled window → Re-scan → learning card → Save confirmed information [+ high-risk modal]) **then all of B** | 1–2 | learning candidates, risk levels, scopes | — |

Scenario D has two structural failures: it **only works in Local Browser Agent mode** (the recommended Extension mode has no re-scan and no learning loop), and answers typed into the Settings "Answer Memory" form are **permanently unusable** (§8). Every scenario exceeds the three-major-decision threshold. The happy path from resume upload to recorded submission totals ~18–22 clicks and 7–9 modals across 4 tabs with 3 tab-unlock gates and 6 classes of server blockers that make buttons silently vanish.

---

## 5. Comparison to the desired Quick Apply flow (Phase 3)

**Can the existing backend support "Job card → Apply with AI → preflight → resume → answers → open page → safe fill → checklist → manual submit"? Yes, with the P0 fixes.** Evidence: the synthetic E2E already drives approve → package → approve-fill → start-fill → fill-report → re-scan → review-complete → `READY_FOR_MANUAL_SUBMIT` → `MANUALLY_SUBMITTED` purely over the existing HTTP API. The Quick Apply flow is an orchestration + presentation problem, not a missing-backend problem — **except** for tailored resume generation, which must be built (§7).

### Feature triage matrix

| Feature | Current location | Real user value | Classification | Reason / migration risk |
|---|---|---|---|---|
| Interview Questions | Package panel | Medium, wrong moment | **Career Tools** (Interview Prep) | Generated content is fine; showing it during apply blocks nothing but attention. Risk: low |
| STAR Stories | Package + Career Brain | Medium | **Career Tools** | Same. Risk: low |
| Missing Skills | Package + job cards | Low during apply | **Career Tools / Advanced detail** | Currently pollutes the package with "skills" like "Role Is Contract-Based…". Risk: low |
| Risk score | Package panel | Low ("Not Assessed risk") | **Developer diagnostics** | Meaningless to users as rendered. Risk: none |
| Career growth analysis | Job card details | Medium | **Advanced detail on job card** | Useful but verbose. Risk: low |
| Semantic match explanation | Job card (raw JSON) | Low as JSON | **Advanced detail**; delete raw JSON | Risk: none |
| Cover letter | Package (template mail-merge) | Medium *if real* | **Default, optional, off until AI-generated** | Current template can argue *against* the applicant (observed: pastes negative "growth" text into the letter). Risk: reputational if kept as-is |
| Resume recommendation / confidence | Package panel | Negative (fake %: a 3-value lookup table) | **Retire the % display**; keep silent auto-selection | Risk: none |
| Tailored resume generation | **Does not exist** | **The core promise** | **Default — must be built** | §7 |
| Application answers | Package + Settings | High | **Default** — one "Application Profile" screen | Risk: medium (needs the A1 fix) |
| Answer Memory | Write-only Settings form | High | **Default** — visible, editable list | Needs new GET/edit/delete API. Risk: low |
| Form Field Memory | Invisible | — | **Internal** (correctly invisible) | Keep value-free guarantee |
| Executor selection | Per-application dropdown | Negative | **Developer** — auto-select with override in Advanced | Risk: low (server already validates mismatch) |
| Package IDs / Session IDs | "Advanced diagnostics" | None | **Developer** | Risk: none |
| Portal names (lever/greenhouse) | Filters, cards | Low | **Advanced detail** | Risk: none |
| Browser diagnostics | Package panel + Settings | None for users | **Developer** | Risk: none |
| SSE diagnostics | AI Settings | None | **Developer** | Risk: none |
| Lifecycle status names | Filter dropdown (raw values), badges | Confusing at 17 | **Backend-only**; user sees ~5 plain statuses | Risk: low — mapping exists (`applicationStatusLabel`) |
| Application completion % | Cards, Home | Negative (a % explains nothing) | **Retire**; replace with "N things left" checklist | Backend blockers list already exists. Risk: low |
| 10-step stepper / step eyebrows | Global header + sections | Negative | **Retire** | Risk: none |
| 12-tab job inventory + 6 filters | Job Matches | Negative | **Retire**; 5 buckets (New / Good matches / Saved / Applied / Rejected) | `lifecycle_status` already exists. Risk: medium (freshness axis must become sort/badge) |

---

## 6. Application Package audit (Phase 4)

The package is **both** a valid backend preparation artifact **and** a badly overloaded frontend screen.

- **Contents:** 6 files per job; `application_package.json` merges a v1 payload and a v2 payload by object spread. Massive internal redundancy: the same resume encoded 3×, the same STAR array referenced 3×, missing skills 3×, the same answers serialized 3×, and **two contradictory cover-letter fields** (`cover_letter` populated template vs `cover_letter_draft` hardcoded empty `needs_user_input` — the UI reads one for display and dumps the other into raw JSON).
- **Readiness is one line:** `status: selectedResume?.approved_at ? 'PACKAGE_READY' : 'NEEDS_USER_INPUT'` (`build_application_package_preview.mjs:317`). **Nothing else matters** — verified against a real artifact that is `PACKAGE_READY` with zero answers, empty draft cover letter, and 30% completion. The 6-item UI "timeline" (Answers ready / Cover letter ready / …) gates nothing; it is decorative and misleading.
- **What filling genuinely requires:** the session's `approved_field_mappings`, built from exactly **9 allowlisted profile keys** (`execution_session.mjs:24-34`: full_name, first/last name, email, phone, location, linkedin, github, portfolio) plus confirmed non-sensitive answers. **~80% of the package by field count is never read by any executor.** The approved resume is a *gate token, not a payload* — `resume_attachment_allowed: false` everywhere; the file is never opened.
- **What should never block filling:** cover letter, interview questions, STAR stories, missing skills, risk, completion estimate — and today they correctly don't; they only *look* like they do.
- **What belongs in Interview Preparation:** interview questions, STAR stories, gaps-to-prepare (already duplicated there).
- **What belongs in diagnostics only:** IDs, digests, executor state, skip-reason enums, raw JSON.
- **Why so much scrolling:** ~12 sections, ~35 labelled fields, 11 buttons, 2 selects, and a 25-key JSON dump in one continuous card, appended below the full application list.
- **Duplication:** the builder runs as a child process re-deriving everything the server has; `assertPackageAllowed`, `selectBestResumeProfile`, `careerProfileToApplicationProfile`, and `evaluateApplicationDecision` each run twice per build; the answer bank is re-normalized O(n²); the server re-runs resume selection live on every package GET, so the displayed recommendation can disagree with the frozen package.
- **Can the backend package stay while the frontend becomes a compact preflight drawer? Yes.** The executor contract (9 keys + confirmed answers) is small and stable. The preflight only needs: job identity, resume choice, missing-answer list, and the start button.

**Recommended user-facing package summary (complete):** "Applying to {Company} — {Role}. Resume: {name}. {N} answers will be filled. {M} questions need you: [list]. [Start] / [Not now]." Everything else moves to Advanced or Interview Prep.

---

## 7. Tailored resume audit (Phase 5)

**True tailored-resume generation does not exist. Not partially, not in draft.**

- The full path from job + profile + resume is: `selectBestResumeProfile` → substring scoring (`candidate_records.mjs:56-109`: target-role substring vs job title, skill substring hits, +3 active-resume tiebreaker) → pick `eligible[0]` → copy its id/hash into the package. **The resume file is never opened, transformed, or attached.**
- "Confidence" is a hardcoded 3-value lookup (0.95 / 0.8 / 0.6). With the shipped data (empty `target_roles`), the user sees "60% confidence" which literally means "you only have one resume."
- **No document-writing code exists**: dependencies are `playwright-core` + `pdfjs-dist` (read-only); repo-wide grep for DOCX/PDF writers returns zero; `resume_document_intelligence.mjs` exports 11 functions, all readers; `documents/cover_letters/generated/` is an empty directory.
- **Cover letter** is a 4-paragraph string-concat template (no AI), and it can paste *negative* match commentary into the letter body (observed in the live package: "…it is a contract position. It may not provide the same long-term career trajectory…"). Read-only in the UI; no edit, no export.
- The AI provider (`ai_provider.mjs` — genuinely production-grade: schema validation, format renegotiation, retries, cost ledger) has exactly **two** production tasks: profile extraction and semantic match. No tailoring task, no letter task.
- **Reusable for building the real feature:** ai_provider + usage ledger; PDF/DOCX text extraction (bilingual EN/中文 section segmentation); Career Brain approved-facts store (the anti-hallucination ground truth); hybrid match strengths/gaps (the tailoring signal); content hashing; the state machine for a draft→review→approve flow.
- **Missing (all from scratch):** a document writer (recommend: generate structured Markdown/HTML → DOCX via a template engine, PDF via headless print), a job-scoped Resume Draft store, a `resume_tailoring` AI task with schema + fact-grounding check (`candidate_facts_invented` is today a hardcoded `false` literal, not a verification), a diff/review UI, an approval flow for generated content, and — deliberately — the attachment step stays manual (`resume_upload_allowed: false` is a safety invariant; surface the file for the user to attach).

---

## 8. Application Profile & Answer Memory audit (Phase 6)

- **"Answers ready" means:** `plannedAnswers.length > 0 && unanswered.length === 0` (`app.js:1574`), fed by a package-build filter requiring `status === 'approved' && approved_for_real_applications === true` plus a sensitive-topic blocklist (`build_application_package_preview.mjs:148-156`). The backing store `data/question_bank.json` **does not currently exist**, so the indicator is false on every fresh install.
- **P0 defect:** the Settings Answer Memory form never sends `approved_for_real_applications`; the normalizer defaults it to `false` (`candidate_records.mjs:411`); therefore **every manually entered answer is silently unusable forever**, while Settings simultaneously reports "Answer Memory started". The only path to a usable answer is the post-fill learning loop — which only exists in Browser Agent mode.
- **Answer Memory is write-only:** there is no GET/list/edit/delete endpoint or UI. A saved typo is uncorrectable except by re-typing the exact question. The only read-back is the raw package JSON dump.
- **The learning loop, where it works, is genuinely well-designed:** baseline snapshot → user types → re-scan diff → pending candidates (never auto-applied) → explicit per-item confirmation with a second gate for high-risk → values scrubbed from the candidate store → reuse via planned answers and value-free field-signature rules. This is the best UX thinking in the product — and it is unreachable in the default executor mode, and destroyed if the agent window was closed (re-scan reloads the page and wipes typed values).
- **Sensitive handling is sound and layered** (build blocklist, executor mapping filter, field classifier, portal never-fill lists, learning prohibitions, high-risk double confirmation). Cost: the six most common blocking questions (work auth, sponsorship, salary, start date, relocation, notice period) are permanently unanswerable by the system — correct policy, but the product never *tells* the user "these are yours to answer, here's where to pre-stage them."
- **There is no single Application Profile Setup — there are five stores.** Worse, user-entered data is silently dropped in transit: `location` never reaches the executor (profile emits `city`/`country` but the mapper looks for `location` — a required Lever/Greenhouse field that therefore never autofills); `work_authorization` and `sponsorship` have UI fields whose values are dropped by `careerProfileToApplicationProfile`; `start_date`/`notice_period` have no Career Brain field at all; the relocation checkbox can never render checked (string-vs-boolean bug).
- **Recommendation:** one "Application Profile" screen — Contact (name, email, phone, location), Links (LinkedIn, GitHub, portfolio), Work situation (authorization, sponsorship, relocation, salary, start date, notice period — stored, marked "asked every time" where policy requires), and My Answers (visible, editable list). Readiness indicator: "Profile ready for applications: {N} of 9 basic fields set · {M} saved answers" — computed from the *same* data the executor consumes, so it cannot disagree.

---

## 9. Submit-yourself flow audit (Phase 7)

Path: fill-report forces `NEEDS_REVIEW` always (correct — "a safe-fill result always requires an explicit human review"), then re-scan → review-complete (9 guards, `application_state.mjs:1077-1146`) → `READY_FOR_MANUAL_SUBMIT` → "I submitted" → terminal `MANUALLY_SUBMITTED`.

**Correct safety blockers (keep):** explicit confirmation; required-empty count; unknown-required count; missing resume upload; inaccessible form; active CAPTCHA; login required.

**Product UX failures (valid blocker, terrible explanation):** blockers concatenate into one run-on sentence; the rich per-field blocker list (`application_completion.blockers[]` with field key, reason, risk, required) is computed, persisted, and **never rendered**; `available_actions` is returned by the API and never rendered; the "4 things left" screen the user needs is one render function away from existing data.

**State-machine defects:**
- **P0:** Extension mode cannot re-scan (`EXTENSION_RESCAN_REQUIRES_ACTIVE_PAGE`, `server.mjs:5230-5238`) and review-complete requires a re-scan (`application_state.mjs:1100`) ⇒ **`READY_FOR_MANUAL_SUBMIT` and the "I submitted" button are unreachable in the recommended mode.** The UI still shows the Re-scan and Mark-review-complete buttons, which 409.
- **P0:** stale `latest_review_rescan` is never cleared on retry or restart (`application_state.mjs:1098` fallback to the record's copy) ⇒ review-complete can pass against a scan of a *previous* attempt/page.
- Closing the agent window bricks the path (relaunch reloads a blank form, wiping manual answers) and leaves a permanent "not connected" blocker even in states where connection is irrelevant.
- No session TTL anywhere: a crash during `EXECUTING` wedges the job forever, with only buried escape hatches.
- SSE reconnect never resyncs (no `Last-Event-ID`, connect frame dropped, `onopen` only stops the fallback poller) — the UI can sit on pre-disconnect state indefinitely.

**Can "4 things left: Upload resume / Enter location / Confirm sponsorship / Complete verification → [Open application page]" be generated from current data? Yes** — from `latest_review_rescan` (required-empty + unknown fields), `file_upload_required/present`, `challenge_scope`, and `application_completion.blockers[]`. All exist today; none are rendered.

---

## 10. Executor audit (Phase 8)

- **Two modes are justified in principle** (extension = real Chrome profile with logins; agent = controllable lifecycle, screenshots, re-scan) — but today each is half a product: the Extension fills better (7 matching strategies, real React native-setter + full event chain, select/checkbox/radio support, live element references) but **has no re-scan, no learning, weak failure reporting, has never been verified installed, and dead-ends the submit flow**; the Browser Agent has the better lifecycle (status files, crash recovery, redacted screenshots, re-scan) but **fills by positional index** (a React re-render between scan and fill silently mis-targets fields), refuses select/checkbox/radio, and uses a throwaway profile so any login-gated page correctly refuses.
- **The "shared core" is only byte-shared, not behavior-shared:** one file is copied by a manual script (byte-equality is tested), but `content.js` re-implements page safety, challenge detection, field matching, and report shape behind optional-core fallbacks — and the extension's own localhost test **never injects the core**, so every shared-core branch is untested.
- **Selection UX:** per-application dropdown with three disagreement paths (UI-context restore before server read; UI silently overriding persisted choice at start-fill; failed save leaving UI ahead). Users should not choose an executor at all: **auto-select** (extension if fresh + host-permission match; else agent) with override in Advanced.
- **Default for V1 on Windows: Local Browser Agent** — it is the only mode that can complete the product's own submit flow and learning loop, is the only tested-in-a-real-browser mode, and needs no unpacked-extension installation. **Mark the Extension experimental and defer it** — its real-profile advantage matters for login-gated ATS flows, which V1 should treat as manual-assist anyway. This inverts the current labels, which recommend the unverified mode and call the proven one "advanced".
- **Safety:** genuinely layered and enforced (session, page, field, report levels; server re-sanitizes reports; URL pinning against redirects). One finding to remove: a fully implemented (currently unreachable) resume-upload path inside the extension content script contradicts the documented "never uploads files" guarantee. Also: hardcoded port 8767 in the extension breaks silently under the documented `PORT` override; the manifest declares Workday with no adapter; Windows SIGTERM shutdown of the agent is unasserted and likely orphans Chrome (Node maps SIGTERM to TerminateProcess on Windows).

---

## 11. Discovery & matching audit (Phase 9)

- **One real source:** SearXNG (which, per every report since 08-07, has **never returned a single job**). The "China discovery", "company career discovery", and "crawlee playwright" providers are one-line re-export stubs of the same generic extractor; Scrapling is written, disabled by plan, and POSIX-only. The China/global source catalog in the UI is display metadata that no code branches on.
- **Why the same jobs repeat:** rejected-job suppression runs **only inside the discovery script**, never on read; the default view filters on a stale `discovery_rank` snapshot; URL-imported jobs bypass policy entirely; and the default status filter is "All history".
- **Why users see so few jobs:** six stacked caps (5 queries/run hardcoded × 10 results/query, **1 detail page fetched per provider per run**, 3 per company, 50 total, UI page size 5) plus a **14-day `repeat_wait`** that hides every re-found job from run 2 onward. No provider pagination exists (SearXNG `pageno` never sent) — rerunning discovery fetches the same first page forever.
- **Quality gates are defeated by their own pipeline:** every existing record's `description_text` is literally the internal note `public_career_page_link_discovery` (empty-string fallback bug, `job_records.mjs:216`), which then *satisfies* the has-description evidence gates — content-free pages score up to 96 and get "approve" recommendations.
- **Match scores are real but untrustworthily presented:** deterministic scoring is evidence-backed and auditable, but the UI silently swaps in a 70/30 AI-blended score for (only) the first 20 enriched jobs, under the identical "Match score" label — so 76/67/57 in the same list are not comparable, and nothing indicates which is which.
- **Visa matching does not exist** (`work_authorization_required` is never set by any provider — the check is dead code).
- **The simplified model (New / Good matches / Saved / Applied / Rejected) is ~80% built** — `deriveJobLifecycleStatus` already emits exactly these buckets. Blockers: collapse the three status axes, enforce rejection suppression on read, make freshness a sort key/badge, fix the blended-score labeling, delete the two dead stores.

---

## 12. Dashboard information architecture audit (Phase 10)

Current: 6 top-level areas + a 10-step rail + section steppers + 12 inventory tabs + 6 filter dropdowns, everything stacked into single scrolling pages, with 5 raw-JSON surfaces, ID rows, ALL-CAPS badge vocabulary, and identically-gray unexplained disabled controls. Home's "single best action" idea is right, but it competes with three other "review" prompts on the same screen. Interview Preparation is a nearly empty tab; Career Brain — the most-referenced concept in the product's own copy — has **no** nav entry (and its Home button dead-ends in an empty modal).

**Proposed default navigation (5 areas):**

```
Home        — one next action + activity summary
Jobs        — New / Good matches / Saved / Applied / Rejected (+ paste-a-URL import)
Applications— in-progress cards with "N things left" checklists
Profile     — resume, application profile (contact/links/work situation), my answers
Settings    — AI provider, search sources, data & privacy
```

Secondary (menu, not tabs): **Career Tools** (Interview Prep, STAR stories, gap analysis), **Advanced** (current dashboard surfaces, diagnostics, raw JSON, IDs, executor override). Mobile: the current CSS collapses grids but 14,000-px pages and 90-button screens are structurally unusable on mobile regardless; the Quick Apply IA fixes this for free. Accessibility: disabled-with-title anti-pattern, focus loss on list-refilter jumps, and status conveyed by color/percent only — all to be addressed by the new front end.

---

## 13. State machines & technical debt (Phase 11)

- **Technically necessary states (backend):** the 17-state application vocabulary is defensible *internally*, but `SUPERSEDED` is unreachable via transitions, `DISCOVERED` is derive-only, and `deriveJobLifecycleStatus` accepts three alias names that aren't canonical. The 10-state session machine **has no transition table at all** — add one or fold sessions into the application machine.
- **User-visible states should be ~5:** Found → Preparing → Filling → Needs you → Submitted (plus Rejected/Saved on the job side). Everything else is backend-only.
- **24 compatibility shims catalogued** (status alias map; run→session migration; 6 recovery bypass edge families; dual-shape profile references; 4-way candidate-profile path fallback; dual resume-id keys; legacy skills mapping; dead stores; a commented-out execution path; the 1,520-line superseded extension bridge; …). Each is individually defensible; together they are the reason no one can say what "approved" means.
- **Repair code ≈ 870 lines vs a 66-line transition table (~13×)**, with live quarantined legacy runs in the state file at schema v3.0 and hundreds of state-file backups in `archive/`. **The repair apparatus has become more complex than a redesign of the thing it repairs.** The core data (jobs, reviews, profiles, packages) does *not* need rewriting — the *derivation and overlay* layer does.
- **Multi-job isolation** is mostly sound (per-job overlays, session binding, executor-mismatch guards) but undermined by: the single-Browser-Agent constraint, non-atomic dual-store approval writes, the sticky connection bit, and no session TTL.
- **Removal list (eventually):** legacy candidate-profile layer + its 4-way path fallback; dead stores; `renderJobsTableLegacy`; `package_bundle.local.js`; dual resume-id keys; `planned_answers` (keep `application_answers`); `cover_letter_draft` (keep one field); the stale 404 route manifest; lowercase alias states once data is migrated.

---

## 14. Tests & acceptance claims (Phase 12)

| Claim | Best evidence | Verdict |
|---|---|---|
| "Product ready / PASS" | Synthetic E2E + localhost browser + soak + one real safe fill | **Overstated** — contradicted by its own body (extension unverified) |
| "Multi-job complete" | Real public-page safe fills (3 Lever pages, Browser Agent) | **Supported for its stated scope** (honestly bounded) |
| "Extension works" | Localhost simulation that never loads the extension or injects the shared core | **Overstated** — installed mode never verified (OGS-008 open) |
| "Learning complete" | Localhost fixtures, Browser Agent only | **Partially supported** — unreachable in default mode |
| "Tailored resume supported" | — | **Not validated; feature does not exist** |
| "Submit-ready" | Synthetic E2E reaches `READY_FOR_MANUAL_SUBMIT` | **Partially supported** — real page never reached it |
| "Real user completed an application" | — | **Never claimed** (to the project's credit); `submissions: 0` everywhere |
| "China support" | Display catalog + bilingual launchers only | **Overstated** — no China-specific discovery code; dashboard is English-only |
| Completion-rate north star | Localhost 100% vs **real ~9%** (3 contact fields of ~32–35) | **Overstated by omission** |

**Why the user is confused despite 224 passing tests:** the tests verify the state machine, the safety policy, and synthetic HTTP flows — all of which genuinely work. Nothing tests whether a person can *understand* the product, whether the recommended mode can finish the flow (it can't), whether manually entered answers are usable (they aren't), or whether real pages get meaningfully filled (~9%). Test count measured the scaffolding, not the product.

---

## 15. GitHub & open-source audit (Phase 13)

- **The single blocking issue is structural:** the publishable product has never been committed; the one existing commit is an older product containing the owner's personal profile data and 20 files with absolute Windows paths. **The existing `.git` must not be published — a clean-history export/`git init` is mandatory.** (The project's own handoff report says the same.)
- Currently tracked index: no personal data (staged deletions pending). Ignored-but-present local files include a real AI provider credential (`data/ai_provider.local.json`) and resume/profile content — correctly ignored, must stay private.
- Strong: `.gitignore`, README (verified links/screenshots), SECURITY.md, offline demo (genuinely works, ~15 min), 3-package dependency footprint.
- Gaps: no CI/.github; **no SearXNG setup docs for the primary discovery source (which has also never returned a result)**; the English quick start routes troubleshooting to a Chinese-only doc; `quick_start.md` falsely claims no runtime third-party package (pdfjs-dist; and playwright-core sits in devDependencies so `--omit=dev` breaks the Browser Agent); Windows-only launchers; hardcoded live third-party URLs in a documented test; ~30 acceptance reports as root-level noise referencing private paths.
- **Realistic time-to-first-fill for a new user:** offline demo ~15 min; **real page 60–120 min**, dominated by fact-by-fact profile review and by discovery not working (user must paste a URL) — and the resulting "success" fills 3 contact fields. First-run experience must be re-scoped around URL import, not SearXNG.

---

## 16. Root causes

1. **Additive repair culture:** every real-world failure added a layer beside the old one (second executor, second profile shape, second readiness flag, alias maps) instead of replacing it. Nothing was ever deleted; 24 shims accumulated.
2. **No single owner for any user-facing fact.** "Approved", "ready", "connected", "selected" each have 3–5 independent writers. The UI then invents its own versions ("Answers ready"). Contradiction on screen is the *expected* output of this architecture.
3. **The UI grew as a debugging console, not a product.** Raw JSON, IDs, enums, percentages, and every intermediate artifact were surfaced because developers (and prior agents) needed them; nothing was ever demoted.
4. **Acceptance was defined as tests-pass, not user-succeeds.** The recommended mode's dead-end submit path and the unusable manual answers are invisible to a test suite that never runs the recommended mode against the real flow.
5. **The core promise (tailored resume) was quietly substituted** with resume *selection* plus a confidence number, and no report challenged the substitution.

---

## 17. Strategic recommendation

**Chosen strategy: C — add a separate Quick Apply UI over the existing backend.**

- **Not A (polish only):** polish cannot fix five profile stores, an unreachable submit path, or a nonexistent core feature.
- **Not B (simplify in place):** the 5,096-line frontend monolith with global state, innerHTML templating, and dead renderers is cheaper to replace than to refactor; in-place simplification would fight every one of its structural choices.
- **Not D (replace Dashboard outright) yet:** the current Dashboard has real diagnostic value during migration and is the only editor for several stores; keep it reachable as **Advanced** until the Quick Apply UI covers each need, then retire screens progressively. (C converges to D over time, deliberately.)
- **Not E (rewrite):** the code-level evidence is that the backend *can* support the target flow — the synthetic E2E already drives the full lifecycle over the existing API; the domain modules (state machine, safety, learning, career brain, ai provider, document intelligence) are the most valuable assets in the repo.

**Mandatory backend P0 fixes accompanying C (small, surgical):**
1. Set `approved_for_real_applications: true` for user-confirmed non-sensitive answers saved via the UI (one-line semantics fix + migration for existing bank entries).
2. Make the submit path executor-agnostic: either implement extension re-scan or make Browser Agent the default mode and gate extension mode out of the review flow honestly.
3. Emit `location` (and stop dropping work-authorization / sponsorship / start-date / notice-period) in `careerProfileToApplicationProfile`; add the missing Career Brain fields.
4. Clear `latest_review_rescan` on retry/restart (stale-scan safety hole).
5. Render the existing `application_completion.blockers[]` as the "N things left" checklist.
6. Enforce rejected-job suppression on read; fix the `description_text` fallback bug; label blended vs deterministic scores.

Companion documents:
- Target product: `QUICK_APPLY_TARGET_PRODUCT.md`
- Implementation plan: `QUICK_APPLY_IMPLEMENTATION_PLAN.md`
- Acceptance criteria: `USER_CENTRIC_ACCEPTANCE_CRITERIA.md`

**No product source code was modified during this audit.**
