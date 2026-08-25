# Quick Apply — Implementation Plan

Companion to `CLAUDE_INDEPENDENT_PRODUCT_AUDIT.md` and `QUICK_APPLY_TARGET_PRODUCT.md`.
**Status: plan only. Nothing here has been implemented.** Strategy C: a new Quick Apply frontend over the existing backend, current Dashboard retained as Advanced during migration.

---

## 1. Module disposition

### Preserve unchanged (the assets)
| Module | Why |
|---|---|
| `scripts/lib/application_state.mjs` transition core (`:11-76`) | Sound state machine; keep as backend truth |
| `application_executor/shared_core.js` safety classifiers | The product's spine (field/page safety, URL pinning) |
| `application_executor/execution_session.mjs` mapping builder | Small, correct executor contract (9 keys + confirmed answers) |
| `scripts/lib/career_brain.mjs` store/versioning/approval | Ground truth for facts; needed by tailoring |
| `scripts/lib/ai_provider.mjs` + `ai_usage.mjs` | Production-grade; gains two new tasks (tailoring, letters) |
| `scripts/lib/resume_document_intelligence.mjs` | PDF/DOCX extraction incl. bilingual segmentation |
| `scripts/lib/learning_candidates.mjs` | Value-free field memory + confirmation-gated learning |
| `scripts/lib/job_url_ingestion.mjs` | SSRF-hardened URL import — the first-run path |
| `browser_agent/` + `playwright_executor.mjs` | V1 default fill mode |
| Safety/report layers (`safety_policy.mjs`, `execution_report.mjs`, server re-sanitization) | Non-negotiable |

### Adapt (targeted fixes, listed in §3–4)
`build_application_package_preview.mjs` (slim + fix answer filter) · `career_brain.mjs:490-566` profile projection (emit `location`, stop dropping work-situation fields; add start_date/notice_period fields) · `application_state.mjs` review path (clear stale rescan; session TTL) · `server.mjs` (extract route table; new endpoints; read-time rejection suppression) · `job_records.mjs` (description fallback bug; `repeat_wait` default) · `candidate_records.mjs` (answer semantics; drop dual resume-id keys at write) · discovery pipeline (detail-page cap, score labeling)

### Hide by default (keep working, Advanced-only)
Current Dashboard UI (whole) · interview questions / STAR stories / missing skills (move to Career Tools) · risk display · deterministic score JSON · executor selection · portal/provider metadata · diagnostics & IDs

### Retire
| Item | Evidence |
|---|---|
| `renderJobsTableLegacy` (`app.js:623-810`) | dead code |
| `extensions/application_assistant/package_bundle.local.js` | superseded, 1,520 lines |
| `data/jobs_approved.json` / `data/jobs_rejected.json` | dead stores (`server.mjs:408-409`) |
| Extension as a default mode | unverified installed; no re-scan; submit-flow dead end — mark Experimental, revisit post-V1 |
| Extension resume-upload code path (`content.js:886-936`) | contradicts "never uploads" guarantee |
| `cover_letter_draft` (keep `cover_letter`) and `planned_answers` (keep `application_answers`) | duplicate serializations |
| Resume "confidence %" display | hardcoded lookup table masquerading as a probability |
| 10-step stepper, 12-tab inventory, completion % as primary status | replaced by Quick Apply IA |
| Scrapling provider (POSIX-only, disabled) | keep out of V1; re-evaluate later |

---

## 2. API changes (server)

New/changed endpoints (thin orchestrations over existing lib functions):

1. `POST /api/jobs/:id/quick-apply` — one call = approve (if needed) + build package + return preflight projection `{job, resume, will_fill[], needs_answers[], warnings[]}`. Composes existing `handleDecision` + package build; no new domain logic.
2. `POST /api/jobs/:id/quick-apply/start` — accepts inline answers `{answers:[{question, value, remember, sensitive_ack}]}`, persists remembered ones to Answer Memory **with `approved_for_real_applications: true` for confirmed non-sensitive answers**, then approve-fill + start-fill with auto-selected executor.
3. `GET /api/jobs/:id/checklist` — renders `latest_review_rescan` + `application_completion.blockers[]` + challenge/upload state into `{items:[{id,label,kind,done}], can_mark_submitted}` (data already exists; this is projection only).
4. Answer Memory CRUD: `GET /api/answers`, `PUT /api/answers/:id`, `DELETE /api/answers/:id` (store + normalizer already exist; add list/edit).
5. `GET/PUT /api/application-profile` — single read/write for the 9 contact/link keys + work-situation fields, backed by Career Brain (after the projection fix).
6. Tailoring: `POST /api/jobs/:id/resume-draft` (generate), `GET .../resume-draft` (draft + diff), `POST .../resume-draft/approve` (export DOCX/PDF, register job-linked resume version), `DELETE`.
7. Housekeeping: add the 12 missing routes to (or better, generate) the 404 manifest; version the API (`/api/v1/`) so Advanced and Quick Apply can coexist.

Backend fixes bundled with the API work (the audit's P0 list): answer semantics (`candidate_records.mjs:411` call sites), profile projection fields, stale-rescan clearing (`application_state.mjs:418-430`, `:952-957`), session TTL + stuck-state auto-escape, sticky connection bit, read-time rejected suppression, `description_text` fallback, blended-vs-deterministic score labels, extension port/manifest cleanups.

## 3. Frontend changes

- **New Quick Apply SPA** (`dashboard/public/quick/` or replacing `index.html` with the old UI moved to `/advanced`): 5-tab IA per target doc; component-based (small framework or hand-rolled modules — but **no** single 5,000-line file, no innerHTML string templating, no global mutable state).
- Screens: Home (one next action), Jobs (5 buckets + URL import), Applications (cards + checklist), Profile (resume / application profile / my answers), Settings; preflight drawer; almost-done checklist; tailored-resume diff view; first-run wizard.
- i18n from day one (string catalog; zh-CN + en).
- Keep `/api/events` SSE but fix reconnect resync (refresh on `onopen`; support `Last-Event-ID` or send a snapshot event).
- The old dashboard stays served at `/advanced` untouched.

## 4. Data migrations (all additive or read-boundary; core stores unchanged)

| Migration | Kind | Risk |
|---|---|---|
| Backfill `approved_for_real_applications: true` for existing `user_confirmed && sensitive_category==='none' && risk_level!=='high'` answers | one-time script + backup | Low |
| Add `location`, `work_authorization`, `sponsorship`, `start_date`, `notice_period` to profile projection; add Career Brain fields | code + normalizer default | Low |
| Normalize `relocation_ok` string→boolean | read-boundary | Low |
| Backfill `first_seen/last_seen/times_seen/discovery_status` on legacy `job_leads.json` rows | one-time script | Low |
| Collapse dual resume-id keys (write one, read both for a release) | staged | Low |
| Drop `planned_answers`/`cover_letter_draft` from newly built packages (readers already prefer the kept fields) | forward-only | Low |
| New store: `data/resume_drafts/` + index for job-linked tailored versions | additive | Low |
| No changes to `dashboard_state.json` schema in Phase 1–2; session TTL is additive metadata | — | — |

Rollback: every migration script writes a timestamped backup (reuse the existing `archive/` rotation); Quick Apply UI is additive, so rollback = point the default route back at the old UI.

## 5. Phases & backlog

### Phase 0 — Trust fixes (backend only; current UI benefits immediately) — **P0**
1. Answer semantics fix + backfill (unblocks answer reuse).
2. Profile projection fix (location + work-situation fields reach the executor).
3. Stale-rescan clear; extension-mode honesty (hide rescan/review buttons for extension sessions; make Browser Agent the default selection).
4. Checklist endpoint + render blockers in the *existing* package panel (quick win).
5. Rejected-suppression on read; description fallback fix; score labeling.
- *Exit test:* Scenario D (manual answer reuse) passes end-to-end; a second application shows fewer "needs you" items than the first.

### Phase 1 — Quick Apply core — **P0**
6. `/quick-apply` + `/start` + auto-executor; preflight drawer; almost-done checklist; Applications cards; 5-bucket Jobs list; URL-import-first onboarding; Home single action; old UI moved to Advanced.
- *Exit test:* approved job → filled page in ≤3 decisions / ≤6 clicks; no Package/Session/Executor word visible; empty-modal and disabled-without-reason defects gone.

### Phase 2 — Tailored resume + answers UX — **P1**
7. `resume_tailoring` AI task (schema-validated; fact-grounding check against approved Career Brain facts; refuse on unverifiable content).
8. DOCX writer (template-based; e.g. docx npm lib) + PDF export (headless Chrome print via existing playwright-core); job-linked draft store; diff/approve UI; staged-file handoff in the checklist.
9. Answer Memory CRUD UI ("My answers"); application-profile screen; optional AI cover letter (replacing the template that can argue against the applicant).
- *Exit test:* tailored draft generated, diffed, approved, exported; no invented facts (spot-check harness); user edits an answer and the next preflight uses it.

### Phase 3 — Polish + GitHub — **P2**
10. i18n (zh-CN); SSE resync; session TTL sweeps; discovery cap tuning + provider pagination; Interview Prep as Career Tools; delete retired code; Advanced screen retirement begins.
11. GitHub: clean-history export (`git init` on release tree — **never publish existing `.git`**), CI (offline suite + launcher test), English troubleshooting doc, SearXNG optional-setup doc or de-emphasis, fix `quick_start.md` dependency claim, move playwright-core to dependencies (or lazy-install), demote root reports to `docs/history/`.

## 6. Risk assessment

| Risk | Level | Mitigation |
|---|---|---|
| Tailored-resume hallucination | High | Facts-only prompt + schema + grounding check + mandatory diff review + user approval; keep "Keep original" one click away |
| DOCX fidelity to original formatting | Medium-High | V1: generate from a clean template rather than round-tripping the original file; label as "tailored format" |
| Two UIs drifting during migration | Medium | Shared API layer; Advanced is read-mostly; retire screens on a schedule |
| Backfill mislabels an answer as auto-fillable | Low-Medium | Backfill only `user_confirmed && non-sensitive && !high-risk`; show all backfilled answers in "My answers" with a "confirmed by you" badge |
| Browser Agent Windows orphan processes | Medium | Add the missing SIGTERM/Windows shutdown test; use `--close-after-fill` default + PID sweep on server start |
| Regression in state machine during TTL work | Medium | The existing 224-test suite + new transition tests; TTL implemented as a new derived flag before any auto-transition |

## 7. Test strategy

- Keep the offline suite green throughout; add contract tests for every new endpoint.
- New: Scenario tests A–D from the audit as scripted synthetic E2E (click-budget assertions included — fail the build if the happy path exceeds 3 decisions).
- New: tailoring grounding test (every generated line maps to an approved fact id).
- New: installed-extension smoke (real `--load-extension` launch) before the extension ever leaves Experimental.
- New: Windows shutdown/orphan assertion for the Browser Agent.
- Real-page checks remain manual, scripted, and read-only-by-default, with the existing safety guard.

## 8. Current-data migration for the real user

One guided pass on first Quick Apply launch: import existing Career Brain (already approved), resume v1, the 3 in-flight applications (mapped to "Needs you" cards with honest checklists), 8 discovered jobs into buckets, and the rejected pair into Rejected. The learning/answer backfill runs here with a review screen. Nothing is deleted; `archive/` backup taken first.

## 9. GitHub migration

1. Finish the staged privacy deletions locally (already in index).
2. Build the release tree with the existing `audit:release` tooling.
3. `git init` fresh history in the export; verify zero personal data via the existing scanner **plus** a history scan.
4. Publish with CI, English docs, URL-import-first quick start, honest capability statement (what "fill" currently covers), Extension marked Experimental.
5. The current repo stays private forever (its single commit contains personal data).
