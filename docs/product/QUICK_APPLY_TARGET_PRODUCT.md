# Quick Apply — Target Product Definition

Companion to `CLAUDE_INDEPENDENT_PRODUCT_AUDIT.md`. This defines what Resume Jobs should feel like to a real job seeker. It reuses the existing backend; it is not a rewrite spec.

---

## 1. Product vision

**One sentence:** Upload your resume once, and from then on every good job is two clicks away from a safely pre-filled application page that you review and submit yourself.

Resume Jobs is a **job-application assistant**, not a workflow-management system. The user thinks in exactly four nouns: **my profile, jobs, applications, my answers**. Packages, sessions, executors, states, and scores are implementation details the product keeps to itself.

## 2. The normal user

- Is job hunting, possibly stressed, possibly non-technical, possibly not a native English speaker (the current owner works in Chinese — the UI must be localizable, with zh-CN as the first target).
- Will not read documentation.
- Judges every screen by one question: *"what should I do right now?"*
- Trusts the product only if it never does anything surprising in their browser and never lies about what it did.

## 3. Default workflow (the whole product on one line)

```
Set up once (5 min)  →  See good jobs  →  Apply with AI  →  Answer what's missing  →  Review the filled page  →  Submit it yourself
```

## 4. Proposed navigation (5 primary areas)

```
Home            One recommended next action + recent activity. Nothing else.
Jobs            Buckets: New · Good matches · Saved · Applied · Rejected. Plus "Add a job by link".
Applications    Cards for in-progress applications, each with a "N things left" checklist.
Profile         My resume · Application profile (contact / links / work situation) · My answers.
Settings        AI provider · Job sources · Data & privacy.
```

Secondary (overflow menu, not tabs):

```
Career Tools    Interview preparation, STAR stories, skill-gap analysis.
Advanced        The current Dashboard (diagnostics, raw data, executor override, IDs).
```

Rules: no step numbers anywhere; no view is a stack of other views; every list paginates; nothing renders raw JSON outside Advanced.

## 5. The "Apply with AI" flow

Entry point: **one button on every job card and job detail: `Apply with AI`.** (Secondary link: `Apply manually` — just opens the page.)

```
[Apply with AI]
   │
   ▼
Preflight drawer (one compact panel, §6)
   │  – resume confirmed (tailored draft optional, §7)
   │  – missing answers asked here, now (§8)
   ▼
[Open & fill]  →  browser opens the application page, safe fields fill (§9)
   │
   ▼
"Almost done" checklist (§10) — the N things only you can do
   │
   ▼
User submits on the employer page  →  [I submitted it] → recorded
```

**Hard budget: at most 3 decisions before the page is filled** — (1) confirm/adjust resume, (2) answer missing questions, (3) click Open & fill. Everything else is automatic or deferred.

Approval semantics: clicking `Apply with AI` **is** the job approval. No separate approve step, no batch checkboxes, no fill-approval step. (The backend may still record approve → package → fill-approve transitions; the UI performs them as one action.)

## 6. Compact application preflight (replaces the Package screen)

One drawer, one screen-height, exact layout:

```
┌────────────────────────────────────────────────┐
│ Apply to Epoch AI — Data Scientist              │
│                                                │
│ Resume    ▸ Candidate_Resume_2026.pdf              │
│            [Use a tailored version — draft ready] │
│                                                │
│ Cover letter (optional)   ▸ Off  [Generate]    │
│                                                │
│ Will be filled for you (6)              ▸ show │
│   name, email, phone, location, LinkedIn, GitHub│
│                                                │
│ Needs your answer (2)                          │
│   Do you require visa sponsorship?  [Yes][No]  │
│   Earliest start date               [____]     │
│   ☑ Remember these for future applications     │
│                                                │
│ You will always handle: resume file attach,    │
│ identity checks, and the final Submit.         │
│                                                │
│           [Open & fill]        [Not now]       │
└────────────────────────────────────────────────┘
```

Backend mapping: the drawer is a projection of the existing package build — but **readiness is only** "resume chosen + required known answers present". Interview questions, STAR stories, missing skills, risk, completion % never appear here (they live in Career Tools / Advanced).

## 7. Tailored resume flow (new capability — see implementation plan)

```
Job description + approved profile facts + source resume
   → AI drafts a job-specific resume (facts only from the approved profile — nothing invented)
   → user sees a DIFF view: "changed summary, reordered 3 bullets, added keywords X, Y"
   → [Accept] / [Edit] / [Keep original]
   → accepted draft is exported as DOCX + PDF and saved as a job-linked resume version
   → the preflight shows "Tailored for this job ✓"; the file is offered for the user to attach
```

Rules: every changed line is traceable to an approved profile fact; the product **never uploads the file itself** — it stages it and shows where to attach; the original resume is never modified; drafts are versioned per job and deletable.

## 8. Answer setup flow

**Once, in Profile → Application profile:** contact (first/last name, email, phone, city, country), links (LinkedIn, GitHub, portfolio), work situation (authorization status, needs sponsorship?, open to relocation?, salary expectation, earliest start date, notice period). Each work-situation field shows one of two badges: `Filled automatically` or `Asked every time` (for sensitive policy fields).

**During apply:** any question the form needs that isn't known appears in the preflight (§6) with a `Remember this` checkbox. Saved answers are immediately reusable (this requires audit fix P0-1).

**My answers (Profile tab):** a visible, editable, deletable list — question, answer, where it came from, when last used. Nothing about the answer system is hidden or write-only.

**Learning from manual typing:** after the user types into the filled page and the page is re-checked, the product asks per item: *"You answered '…' to '…'. Save it for next time?"* — explicit yes/no, extra confirmation for sensitive items, exactly as the current learning loop already does.

## 9. Browser fill flow

- **One mode, chosen automatically.** V1 default: Local Browser Agent (the only mode that currently completes review + learning). The Chrome Extension is `Experimental` in Advanced until it supports re-scan and has an installed-mode test. The user never sees the word "executor".
- What the user sees, in order: `Opening the application page…` → `Filling safe fields… (6 of 6)` → the "Almost done" checklist. One status line, not a state machine.
- Everything the current safety policy enforces stays: never login, never CAPTCHA, never sensitive/EEO fields, never file upload, never Submit; URL pinning; redacted reports. These are the product's spine, not options.
- If the page can't be handled (login wall, unsupported site): say so in one sentence and fall back to `Apply manually` with the profile shown side-by-side for copy-paste. A dead end is never silent.

## 10. Remaining-manual checklist ("Almost done")

Generated from the existing re-scan + completion blockers:

```
Almost done — 4 things only you can do:
  ○ Attach your resume        (file staged: Candidate_Resume_2026_ExampleCo.pdf)
  ○ Answer "desired salary"   (we never auto-fill this)
  ○ Complete the "I'm not a robot" check
  ○ Review everything, then press Submit on the page

  [Open the page]     [I submitted it]     [Something went wrong]
```

- Items disappear as re-checks confirm them.
- `I submitted it` records the application (terminal state, shows in Jobs → Applied).
- `Something went wrong` offers: re-open page, retry filling, start over, or mark manual — plain words, no "recovery required".

## 11. Advanced mode

The current Dashboard remains available under Advanced (unchanged initially): raw data views, diagnostics, executor override, IDs, state history, learning internals, provider health. Nothing links from the default UI into Advanced except the menu entry. Advanced screens are removed one-by-one as their last unique capability is ported (see implementation plan).

## 12. Safety boundaries (unchanged, restated as product promises)

1. Never logs in, never touches CAPTCHA or identity checks.
2. Never answers EEO/demographic/sensitive questions.
3. Never attaches or uploads files by itself.
4. Never presses Submit — you always do.
5. Never stores what you didn't confirm; every learned answer is shown before saving.
6. Everything runs and stays on your computer.

These six sentences appear once, on the first-run screen, and behind a permanent `What it never does` link.

## 13. Exact user-facing vocabulary

| Never say | Say instead |
|---|---|
| Application Package / Build Package | (nothing — it's invisible) "Preparing…" |
| Executor / Session / EXECUTOR_READY | (nothing) |
| Approve AI Fill / FILL_APPROVED | `Open & fill` |
| NEEDS_REVIEW | `Needs you` |
| READY_FOR_MANUAL_SUBMIT | `Ready to submit — your turn` |
| MANUALLY_SUBMITTED | `Applied` |
| RECOVERY_REQUIRED / Recover and rebuild | `Something went wrong — start this application again` |
| Answers ready / question bank | `My answers` |
| Core fact coverage 29% / 18% ready | `3 things left` |
| Resume recommendation (60% confidence) | (nothing — auto-pick; show the chosen file name) |
| Re-scan application | `Check the page again` |
| Mark review complete | (absorbed into the checklist) |

Application card statuses (the complete public vocabulary): `Found` · `Preparing` · `Filling` · `Needs you (N things)` · `Ready to submit` · `Applied` · `Saved` · `Rejected`.

## 14. First-run experience (target: 10 minutes to first fill)

```
1. Welcome → the six never-promises → [Get started]
2. Upload resume → profile extracted → "Confirm these 9 basics" (one screen, pre-filled)
3. "Paste a job link, or set up job search later" → user pastes a Lever/Greenhouse URL
4. Job card appears with match summary → [Apply with AI] → preflight → Open & fill
5. Almost-done checklist → user submits → [I submitted it] → 🎉 Applied: 1
```

Note the deliberate order: URL import is the first-run path (it works today); configuring SearXNG search is optional and later — the reverse of the current product.
