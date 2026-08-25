# Changelog

All notable product changes are documented here. Runtime data, private profile
changes, and generated application reports are intentionally excluded.

## Unreleased

### Data safety

- **Delete all user data now archives before it deletes.** Every store under
  `data/` is copied into `archive/` first, and the response lists the copies
  (`pre_wipe_backups`), so the product's most destructive action is
  recoverable. Previously one click could remove an approved profile with no
  usable backup beside it.

### Applications

- Multi-step application forms (wizard portals that walk through several URLs)
  are assisted end to end: each new step is detected, settled, and filled once,
  and the Assistant stays bound across steps. A page outside the application's
  scope is still refused.
- The Application Assistant is visible on any public application page, with
  one-click **Fill this step** and **Re-scan now** on the page-side chip. Page
  URLs reach the local app only for hosts that carry an active fill session.
- A redirect from the approved link (a job-board link landing on the company's
  own careers domain) is followed as the same application instead of being
  reported as navigation away.

### Resume and cover letter

- The tailored resume summary always targets the job: AI output that ignores
  the posting is rejected and resampled, and every fallback still names the
  role. A summary block is produced even for a sparse profile.
- Cover letters are full-length by contract (2-4 grounded paragraphs), with
  employer/role facts available to the model, and return immediately instead
  of retrying when a profile is too sparse to ground an AI letter.
- Resume parsing handles role-first US layouts, suffix section headings
  (`PRODUCTION EXPERIENCE`), grouped skill lines, and template placeholders.
- **Target roles** are editable in My Profile; they feed the resume summary,
  the cover letter, and profile-based search.
- Field-of-study to role mapping covers 40+ majors across the sciences,
  humanities, health, arts, and operations instead of defaulting to
  engineering roles.

### Anti-fabrication hardening

- Closed grounding bypasses found by adversarial review: substring number
  matching, full-width digits, unchecked CJK text, ratio-diluted invented
  clauses, punctuated proper nouns, and citations outside the offered fact
  inventory. AI output may name the target job; it may not claim employment
  there.

## 1.0.0-rc.1 — 2026-08-12

### Product

- Added versioned Resume Intelligence and Career Brain review/approval.
- Added explainable China/global discovery planning, freshness memory,
  lifecycle suppression, company limits, and source/role/location diversity.
- Added deterministic plus advisory semantic matching with warning-only user
  override and hard safety gates.
- Added Application Package 2.0 with resume/Profile bindings, completion
  estimate, cover-letter state, interview preparation, STAR stories, gaps, and
  risk.
- Unified Chrome Extension and Local Browser Agent behind one Application
  Executor and Application Session contract.
- Added explicit post-fill learning candidates, versioned Answer Memory, and
  value-free Form Field Memory.

### Reliability and UX

- Replaced browser-native dialogs with product modals, toasts, banners, and
  inline errors.
- Preserved navigation, selected application, Package panel, filters, sort,
  focus, and scroll across actions, refresh, and live updates.
- Added recovery for interrupted/legacy execution and safe fill setup restart.
- Added redacted Browser Agent screenshots, Retry, Re-scan, bounded shutdown,
  and crash recovery.
- Added normal and developer Windows launchers with loopback graceful shutdown.
- Added responsive/accessibility, lifecycle, repeated reliability, release
  privacy, and continuous soak validation.
- Prevented Reset Local Data from deleting a configured external Profile.
- Prevented stale/cross-job Extension Sessions and kept functional ATS query
  identity while removing tracking parameters.

### Safety

- Final Submit, login, CAPTCHA/MFA, sensitive/EEO answers, and resume upload
  remain manual.
- Runtime JSON, resumes, applications, reports, browser state, credentials, and
  private backups are excluded from the GitHub release tree.
- Release audit now covers Unicode filenames and blocks compiled/runtime caches.
