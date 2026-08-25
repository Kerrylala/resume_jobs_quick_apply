# User-Centric Acceptance Criteria — Quick Apply V1

Success is defined by what a real person can do and understand — never by test counts, state coverage, or "PASS" headlines. Every criterion below is testable by watching one nontechnical user, and most are also assertable in scripted E2E.

## A. The core loop

1. **One visible action.** Every job card shows exactly one primary action, `Apply with AI`. No other apply-path button exists in the default UI.
2. **No internal vocabulary.** The default UI never shows the words Package, Session, Executor, a state-machine constant (e.g. `READY_FOR_MANUAL_SUBMIT`), a package/session ID, a digest, or raw JSON. (Assert: string scan of rendered DOM in E2E across the whole flow.)
3. **≤ 3 major confirmations before safe fill.** From clicking `Apply with AI` to a filled page: at most (1) resume confirmation, (2) missing answers, (3) `Open & fill`. Assert a click budget of ≤ 6 total clicks in E2E; fail the build if exceeded.
4. **A job-specific resume draft is generated** for every Quick Apply (unless the user picks "Keep original"), shown as a diff, and exported to DOCX/PDF only after explicit approval. Every changed line traces to an approved profile fact (assert via grounding-check harness).
5. **Cover letter is optional** — off by default, one click to generate, always editable, never blocks anything.
6. **Missing answers are requested clearly, in place** — in the preflight, as plain questions with a `Remember this` choice. The user is never sent to another screen to make a form fillable.
7. **The application form opens automatically** in a visible browser window when the user clicks `Open & fill` — never before, never in the background.
8. **Confirmed safe fields are filled** — and only those: contact, links, location, and answers the user explicitly confirmed. A field the user did not confirm is never written.
9. **A clear remaining checklist** ("Almost done — N things only you can do") appears after filling, itemized in plain words, and shrinks as items are completed. No percentages as a substitute for the list.
10. **Final submission is always manual.** The product records it only after the user clicks `I submitted it`.

## B. Safety (regressions here fail acceptance outright)

11. No resume/file is ever uploaded or attached by the product; files are staged and the user attaches them.
12. No CAPTCHA, login, MFA, or identity check is ever completed or bypassed; encountering one produces a checklist item, not an error.
13. No EEO, demographic, salary, sponsorship, or other sensitive question is ever auto-filled; they appear as "yours to answer" items even when the answer is stored.
14. Every learned answer requires explicit confirmation before saving (with a second confirmation for sensitive/high-risk), and all saved answers are visible, editable, and deletable in "My answers".
15. Confirmed answers are actually reused: an answer saved on application N pre-fills or pre-answers the same question on application N+1. (This is the single most important regression test — it is broken today.)

## C. Honesty of the interface

16. **No hidden dead ends.** Every reachable state has at least one enabled next action in the default UI. Specifically: the default fill mode must be able to reach `Ready to submit` (today's extension-mode dead end is disqualifying).
17. **No unexplained disabled control.** Anything disabled states its reason in visible text next to it — not in a tooltip, not via graying alone.
18. **UI context is preserved.** Completing an action never teleports the user to a different filter, tab, or scroll position without an explicit navigation; list refilters keep focus.
19. **Two facts about the same thing never disagree on screen.** Profile readiness, answer readiness, and connection status each have exactly one source and one rendering. (Assert: the preflight's "needs answers" list and the checklist are projections of the same server data used by the executor.)
20. **Progress is truthful.** If a run filled 3 of 32 fields, the UI says so and lists the rest as checklist items — no "PASS", no unexplained percentage.

## D. Setup & time-to-value

21. A new user reaches a first safely-filled real application page in **≤ 15 minutes** from `npm install` done, using the paste-a-URL path, without reading any doc beyond on-screen text.
22. Setup asks for the 9 basic profile fields once, on one screen; the user is never asked for the same fact twice.
23. The product works with zero AI provider configured (deterministic path), and says plainly which features need AI.
24. A returning user's second application requires strictly fewer inputs than the first (measured: count of preflight questions).

## E. Recording & recovery

25. `I submitted it` moves the job to Applied everywhere, immediately and permanently.
26. Closing the browser window mid-flow never loses saved answers and never wedges the application: reopening the app offers `Continue` or `Start over` in plain words.
27. A crash or restart never shows stale "Filling…"/"Connected" status for more than one refresh interval.

## F. Explicit non-goals for V1 (declaring these avoids false acceptance)

- No auto-submit, ever.
- No login-gated portals (Workday accounts etc.) beyond manual-assist with side-by-side profile.
- Chrome Extension remains Experimental until it passes an installed-mode E2E including re-scan.
- No China job-board scraping claims until a China-specific provider actually exists.

**Acceptance ritual:** one real user (the owner), one real job link, screen-recorded, no coaching. V1 is accepted when criteria A–E all hold in that recording — regardless of how many automated tests pass.
