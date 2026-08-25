# Quick Apply API Contract (Frozen)

Frozen: 2026-08-19. This is the complete API surface the Quick Apply UI may
use. `tests/api_contract_freeze.test.mjs` cross-checks every route below
against the server, so this document cannot silently rot.

## The two rules

1. **The UI renders state; it never derives it.** The only source for a job's
   status is `GET /api/jobs/:id/apply-state`. The UI must not combine other
   endpoints to invent its own readiness or progress vocabulary — that is
   exactly how the original Dashboard ended up contradicting itself.
2. **Anything not listed here is internal.** Package, Session, Executor and
   the 17-state machine stay behind these endpoints. New UI needs go through
   extending this contract, not around it.

## Error envelope

Every non-2xx response is JSON:

```
{ "status": "blocked" | "error" | "busy", "code": "MACHINE_READABLE_CODE",
  "message": "plain sentence for the user", "blockers": [ ... optional ] }
```

`message` is renderable as-is. `code` is for logic, never for display.

## State vocabulary (closed set)

`apply-state.state` and `history.applications[].state` only ever hold:

```
found · saved · rejected · ready_to_open · preparing · filling · needs_you ·
awaiting_verification · ready_to_submit · applied · manual_only
```

`preparing` and `filling` are transient claims: the server only emits them
while an execution session is genuinely alive. Prepared work at rest — a built
package, a session that was created but never started, or an interrupted
execution — is `ready_to_open` (`resumable: true`): the user can continue from
the preflight, but nothing is running and nothing may spin.

Internal names (PACKAGE_READY, EXECUTOR_READY, session ids, package ids…)
never appear in any response the UI consumes.

## Frozen endpoints

### Profile (我的资料)

| Route | Purpose |
|---|---|
| `GET /api/profile/full` | Whole online profile: 9 sections, readiness, version lineage, `can_undo`, `ask_every_time_fields` |
| `GET /api/application-profile` | Executor-facing readiness projection |
| `PUT /api/application-profile` | Section edits (object sections merge, list sections replace); `approve:true, confirmed:true` re-approves |
| `POST /api/profile/undo` | Restore the previous profile version |
| `POST /api/settings/resume-upload` | Upload a resume file (generates/updates the profile) |
| `POST /api/settings/resume-profiles/:id/manage` | Rename / activate / delete an uploaded resume file |
| `POST /api/settings/resume-profiles/:id/approve` | Approve one uploaded resume version (`confirmed:true` + its `content_hash`). The UI's single “确认资料” action approves the online profile AND its source resume together |

### Job discovery & import

| Route | Purpose |
|---|---|
| `POST /api/jobs/import` | THE import entry point: classifies the input (`single_job_url` / `company_careers_url` / `job_board_url` / `search_query`) and routes to the right path. A board list page returns `browser_required`, never job records; every response carries `classification` |
| `POST /api/jobs/search` | Keyword search over the real discovery providers, in priority order: known company careers boards (official APIs) → SearXNG when READY. With no source available the answer is `no_sources` — an honest sentence, not a blank list. Every imported job passes the quality gate and carries `discovery` provenance |
| `POST /api/jobs/discover-in-browser` | Open a job-board page (LinkedIn, BOSS 直聘…) in the persistent assisted browser. The USER completes any sign-in/verification themselves; the system only reads job links from the session afterwards. Returns a `discovery_id` to poll |
| `GET /api/jobs/discover-in-browser/status` | Progress of the assisted read: `running` / `completed` / `failed`, jobs found so far, honest reasons, and `user_action` (`waiting_for_user` + message) when the page is at a login/verification the user must complete — while waiting the watcher never scrolls, clicks, reloads or navigates the page |
| `POST /api/jobs/discover-in-browser/continue` | The user says "I finished signing in / verifying — continue now": the watcher rescans and resumes reading immediately without reloading the page. No-op error when no session is open |
| `GET /api/search/profile-directions` | What the system would search for based on the approved Career Profile, WITHOUT running anything: derived `roles`, `adjacent_roles`, recommended `locations`, `keywords`, mined `skills`, and `entry_level`. Powers the "根据我的资料找工作 / Find jobs from my profile" entry so the user sees and can edit the directions before searching. Read-only, no side effects |
| `GET /api/search/plans` | Saved search plans (the big-filter criteria model; multiple named plans) |
| `POST /api/search/plans` | Create/update a search plan (`activate:true` selects it) |
| `DELETE /api/search/plans/:id` | Delete a search plan |
| `POST /api/search/run` | Start ONE global search run for a plan: planner queries → provider orchestrator (company ATS boards incl. Workday, SearXNG web + site:ATS when READY) → quality gate → dedup → Filter Engine (`why_filtered` recorded) → match scoring → inventory merge. Providers fail independently; SearXNG down degrades honestly |
| `GET /api/search/run/status` | Poll the run: per-provider progress/status, summary counts (raw/gated/deduped/filtered/accepted), `filtered[]` with why_filtered, `top_jobs` by match score, plus the full provider `capabilities` roster (REAL_WORKING / BROWSER_LOGIN_REQUIRED / PARTIAL / BLOCKED_EXTERNAL / NOT_IMPLEMENTED) |
| `POST /api/search/run/stop` | Stop the running search after the current source finishes |
| `POST /api/jobs/:id/flag` | User flags: `shortlist` / `unshortlist` / `save` / `unsave` / `ignore_forever` / `unignore` / `block_company` (blocking also feeds the active plan's blocked list). `saved` and `shortlisted` are durable, independent flags on the job record — starting or finishing an application never clears them. Ignored jobs are never re-recommended but keep their history |
| `POST /api/jobs/import-url` | Import one job link (the always-works path; no search config needed). Single postings pass a job quality gate: no title, no structure or a navigation page never becomes a job record |
| `POST /api/jobs/clear-search-records` | (`confirmed:true`) Remove SEARCHED jobs and the search-run history for a fresh hunt. Jobs with application activity, saved, shortlisted or hidden jobs are preserved; profile/resumes/answers/plans are never touched |
| `POST /api/jobs/import-company-careers` | Discover postings behind a company careers URL. Preview by default; `import:true` merges. `status` explains empty results: `js_rendered_page` / `board_not_found` / `provider_unreachable` / `no_postings_found` |

### Jobs & match

| Route | Purpose |
|---|---|
| `GET /api/jobs` | Job rows with `match_scores` (`combined_score` is the sort key; `semantic_score` null without AI) and `suppressed_from_default` |
| `GET /api/summary` | Counts for the five buckets |
| `POST /api/run/scoring` | Recompute the match scores of the existing job library against the CURRENT profile — the "资料已更新 → 重新计算匹配分" repair |

### Approve / reject

| Route | Purpose |
|---|---|
| `POST /api/jobs/:id/approve` | Approve for application |
| `POST /api/jobs/:id/reject` | Reject (leaves default views, stays restorable) |
| `POST /api/jobs/:id/save` | Save for later |
| `POST /api/jobs/:id/restore` | Bring a rejected/saved job back |
| `POST /api/jobs/:id/reconsider` | Reconsider a rejected job |

### Tailored resume

| Route | Purpose |
|---|---|
| `POST /api/jobs/:id/resume-draft` | Generate (the ONLY trigger; nothing generates drafts automatically). Requires an approved profile. `ai.status` ∈ `ok` / `not_requested` / `provider_disabled` / `fallback_after_error` / `rejected_ungrounded` — a rejected AI result still returns the deterministic draft |
| `GET /api/jobs/:id/resume-draft` | Read the draft (blocks with `fact_refs` provenance) |
| `DELETE /api/jobs/:id/resume-draft` | Delete the draft |
| `POST /api/jobs/:id/resume-draft/export` | Export the draft to real files: an editable DOCX always, an A4 PDF when a local browser exists (`pdf.status` explains a missing one honestly). Files are per-job, bound to the draft with sha256 + profile version; `verified` reports a text-layer round-trip check |
| `GET /api/jobs/:id/resume-draft/file` | Download the exported tailored-resume file (`?format=docx` or `?format=pdf`) — the EXACT file the fill session uploads for this job (same lookup, same path) |

The draft's `review` field is the deterministic reviewer: every posting
keyword classified `covered` / `missing_have_it` (profile supports it, with
proving `fact_refs`) / `missing_gap` (genuinely absent — stays visible, never
stuffed into the draft), plus `cut_lines` — bullets trimmed by the length
budget, each with `fact_refs` so restoring one is a single click.

### Cover letter

| Route | Purpose |
|---|---|
| `POST /api/jobs/:id/cover-letter` | Generate (the ONLY trigger). Requires an approved profile. Deterministic without AI; `ai.status` as for resume drafts plus `fallback_thin_output` (a grounded but too-thin AI body is discarded and the deterministic letter stands) and `skipped_sparse_profile` (too few confirmed facts for a grounded AI body — the deterministic letter returns immediately instead of burning minutes of doomed retries). Contains an `honest_gap`: one genuine gap named plainly instead of hidden. Never contains job-match commentary |
| `GET /api/jobs/:id/cover-letter` | Read the letter (paragraphs with `fact_refs` provenance) |
| `DELETE /api/jobs/:id/cover-letter` | Delete the letter |

### Application preparation

| Route | Purpose |
|---|---|
| `POST /api/jobs/:id/quick-apply` | Preflight: approve if needed + prepare; returns `preflight.needs_user[]` |
| `POST /api/jobs/:id/quick-apply/start` | Save confirmed answers + open the browser and fill (`confirmed:true` required) |

### Application state (the one true read)

| Route | Purpose |
|---|---|
| `GET /api/jobs/:id/apply-state` | One plain `state` word + `resumable` + `things_left` + `checklist` + `can_continue_after_verification` + `browser_open` + `monitoring` (`{active, page_state, last_scan_at}` — whether the open agent window is live-watching the page, and whether the page left the application form). `/api/jobs` rows carry the same word as `public_state` (plus durable `saved` / `shortlisted` flags and `lifecycle_status`), computed by the same server projection — the two can never disagree |

### Browser fill

| Route | Purpose |
|---|---|
| `POST /api/jobs/:id/continue-after-verification` | Resume filling in the SAME window after the user cleared a challenge/login (`confirmed:true`); refuses when the window is gone (`BROWSER_WINDOW_CLOSED`) |
| `POST /api/jobs/:id/review-rescan` | Re-scan the page |
| `POST /api/jobs/:id/review-complete` | Confirm review (`confirmed:true`) |
| `POST /api/jobs/:id/submitted-manually` | Record that the user submitted (`confirmed:true`). Accepted from every reviewable/pre-fill state incl. `RECOVERY_REQUIRED` — the user's declaration is ground truth — but blocked with 409 while an automated fill is actively running (`EXECUTOR_READY`/`EXECUTING`) |
| `POST /api/jobs/:id/cancel-application` | Abandon the in-flight application |
| `GET /api/jobs/:id/learning-candidates` | Answers the user typed by hand on the page (detected by re-scan) waiting for an explicit save/ignore decision — nothing enters the knowledge base without one |
| `POST /api/jobs/:id/learning-candidates/:candidateId/decision` | `{decision: save\|reject}`; save writes a `user_confirmed` Answer Memory record (high-risk values additionally need `confirmed_high_risk:true`) |
| `POST /api/jobs/:id/restart-fill-setup` | Safely discard the current fill attempt (preserved in history) and return to package review — the "重新开始申请" action when an application already started filling |

### Review blockers

| Route | Purpose |
|---|---|
| `GET /api/applications/:id/checklist` | "N things only you can do" — same computation the review gate uses |

### Application history

| Route | Purpose |
|---|---|
| `GET /api/applications/history` | Terminal applications (survives "clear job materials") |

### AI provider

| Route | Purpose |
|---|---|
| `GET /api/ai/status` | `{enabled, provider_type, endpoint, model, credential_configured, ready}` — no key, no network call |
| `GET /api/ai/detect-local` | Probe LM Studio / Ollama on loopback; presets list |
| `POST /api/settings/ai-provider` | Save provider settings (blank key keeps the stored one) |
| `POST /api/settings/ai-provider/test` | Live connection test (the only settings action that goes online) |

### Answers (我的答案)

| Route | Purpose |
|---|---|
| `GET /api/answers` | List with `safe_reusable_answers` |
| `POST /api/answers` | Save (server derives `canonical_key` and reuse eligibility) |
| `GET /api/answers/:id` | Read one |
| `PUT /api/answers/:id` | Edit (sticky metadata preserved) |
| `DELETE /api/answers/:id` | Delete |

### Settings (设置)

| Route | Purpose |
|---|---|
| `GET /api/settings` | Read current settings (search preferences incl. `safety.resume_upload_policy` / `safety.resume_format_preference`, AI provider status, workflow state). The UI reads only what it renders |
| `GET /api/extension/diagnostics` | Application Assistant (browser extension) status: installed/connected, `extension_version` vs `expected_extension_version`, `extension_version_stale` — the settings page uses it to ask for a reload when a stale copy is running. `current_tab` is origin+path only (no query) — readable by any local process, like every GET here |
| `GET /api/extension/active-hosts` | Extension-origin only. Hostnames of ACTIVE fill sessions (approved target + the agent's landed URL). The extension's privacy gate: page URLs are sent to the app only when the page's host is in this list, so broad content-script injection carries zero browsing data for ordinary sites |
| `POST /api/jobs/:id/fill-current-step` | "Fill THIS step now" from the page-side Assistant chip. Delivers a retry command to the ALREADY-RUNNING Local Browser Agent for this job's active session (409 when none). Nothing new is authorized: the agent re-classifies the page and fills only confirmed answers |
| `POST /api/settings/search-preferences` | Save search preferences (strict validation; dangerous automation flags stay forced off server-side) |

### Data lifecycle

| Route | Purpose |
|---|---|
| `POST /api/data/clear-job-materials` | Clear materials, KEEP application history (typed confirmation) |
| `POST /api/settings/reset-local-data` | Delete everything including browser profile (typed confirmation). Every data store is archived to `archive/` BEFORE the wipe; the response lists the copies in `pre_wipe_backups` so a misclick is recoverable |

### Events

| Route | Purpose |
|---|---|
| `GET /api/events` | SSE `dashboard-update` stream with monotonic `sequence` |

## Known constraints the UI must express honestly

- One browser window at a time: sequential applications yes, concurrent no.
- The tailored resume CAN auto-upload during a Local Browser Agent fill:
  `quick-apply/start` prepares a fresh export (regenerating a stale draft
  deterministically), authorizes the upload for that job only
  (`safety.resume_upload_authorized` in the start response), and the agent
  verifies the file really landed (`resume_upload` block in the execution
  report, statuses: `confirmed` / `UPLOAD_CONTROL_NOT_FOUND` /
  `FILE_TYPE_REJECTED` / `UPLOAD_FAILED` / `UPLOAD_NOT_CONFIRMED` /
  `STALE_RESUME` / `WRONG_JOB_BINDING` / `deferred_challenge`). Policy lives in
  search preferences `safety.resume_upload_policy` (`auto`|`never`) and
  `safety.resume_format_preference` (`auto`|`pdf`|`docx`).
- Auto-submit does not exist; final Submit is always the user's action.
  Login, CAPTCHA/challenge handling and sensitive answers remain hard-off.
- `checklist` items are the main experience, not an error path: CAPTCHA,
  EEO/immigration questions and employer-custom questions are the user's by
  design; the resume-attach item clears itself when an upload was verified.
