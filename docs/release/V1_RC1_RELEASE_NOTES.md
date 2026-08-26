# Resume Jobs AI v1.0.0-rc.1 — Release Notes

> Draft for the GitHub Release page. Paste into the release body when creating
> the `v1.0.0-rc.1` tag. Written to be honest: nothing below claims more than
> the offline test suite and supervised local runs have demonstrated.

Local-first AI job application assistant. Find jobs across the web, see why
each one matches, generate resumes that never invent facts, autofill
applications — and always click Submit yourself.

## What works today

- **Job discovery** from public company career pages and ATS boards
  (Greenhouse, Lever, Ashby, SmartRecruiters, Workable and others), plus
  import of any public job URL. Optional SearXNG integration for web search.
- **Explainable matching**: deterministic scores decomposed by skills,
  experience, education, location, and seniority, with named gaps. A senior
  role is filtered from recommendations for an early-career profile rather
  than silently dropped.
- **Career profile**: resume upload (PDF/DOCX/TXT) → parsed, versioned,
  human-approved profile with undo. Handles multi-section US layouts,
  role-first entries, grouped skill lines, and bilingual content.
- **Grounded tailoring**: job-targeted resume summaries and full-length cover
  letters whose every claim must trace to an approved profile fact. Ungrounded
  AI output (invented skills, numbers, employers — including full-width digits
  and CJK text) is rejected wholesale with a deterministic fallback. Exports
  to DOCX always and PDF when Chrome/Edge is present, with round-trip
  verification.
- **Application autofill** in two modes sharing one safety contract: a Chrome
  extension (MV3, talks only to 127.0.0.1) and a visible local browser agent.
  Multi-step wizard forms are followed step by step; a page-side chip offers
  one-click fill-this-step (填写这一步) and re-scan (重新扫描).
- **Answer memory**: hand-typed answers are captured as candidates and, once
  you approve them, reused on later applications. Field mappings are learned
  value-free.
- **Bilingual dashboard**: Chinese/English UI toggle; README, security policy,
  contributing guide, and changelog in both languages. (The page-side chip and
  extension popup are currently Chinese-only.)
- **~460 offline tests** pin the behavior, including every safety rule below.

## Installation

Requirements: Node.js 18+, Chrome or Edge, Windows 11 / macOS / Linux.

```bash
git clone https://github.com/Kerrylala/resume_jobs_quick_apply.git
cd resume_jobs_quick_apply
npm install
npm start        # open http://127.0.0.1:8767
```

No cloud account, no telemetry, no build step. `npm run demo` runs a fully
synthetic offline walkthrough.

## Safety boundaries (enforced by code and tests, not by convention)

- Final Submit is **never** clicked automatically.
- Login, CAPTCHA, MFA, and verifications always stop for the user.
- Generated documents cannot contain claims outside the approved profile.
- Sensitive/EEO answers require explicit confirmation.
- The extension keeps no persistent state; page URLs leave the tab only for
  hosts with an active fill session, and only to 127.0.0.1.
- All candidate data lives in gitignored local files; **Delete all user data**
  archives every store before wiping.

## What is experimental

- **Tailored resume / cover letter quality** (labeled experimental in the UI):
  grounding is enforced, but fluency depends on the model you bring; the
  deterministic fallback is plainer.
- **Multi-step autofill on arbitrary portals**: the step-scope rules are
  tested and adversarially reviewed, but the long tail of custom widgets is
  large; unusual controls fall back to "needs you".
- **Seniority filtering and match weights**: tuned against a limited set of
  real postings so far.

## Known limitations

- Workday is discovery-only; dynamic Workday forms are not filled.
- Login-walled job boards are surfaced as leads, not full postings.
- Job sources depend on external availability and page structure stability.
- The page-side Assistant chip and extension popup are Chinese-only for now;
  the dashboard itself is bilingual.
- Heaviest real-world testing has been on Windows 11; macOS/Linux run the same
  offline suite with less field mileage.
- The tailored-resume PDF export requires a local Chrome/Edge for printing.

## Roadmap

**Next**: demo video, broader ATS/widget coverage, packaged one-click install,
richer cover-letter styles. **Later**: multiple profiles, pluggable job
sources, community field mappings. See the README roadmap for the living
version.

## Integrity note

Every screenshot and demo asset in this repository uses synthetic candidates
and fictional employers. The release contains no real personal data.
