# GitHub Release Readiness Report

Status: **RELEASE TREE READY; HISTORY/OWNER REVIEW REQUIRED BEFORE PUBLICATION**

## Automated release-tree audit

- Candidate release files: 239
- Findings: 0
- Dashboard loopback default: yes
- Shutdown endpoint requires a private runtime token: yes
- Extension Native Messaging: no
- Extension `<all_urls>`: no
- Manifest submit/upload permission: no
- Browser-native product dialogs: 0

The audit uses NUL-delimited, unquoted Git paths so non-ASCII filenames are not
lost. It checks secret-like literals, private-token URLs, runtime/private
paths, resume/document binaries, generated screenshots, private configuration,
and user/project absolute paths. Synthetic test credentials and short fixture
tokens are classified explicitly rather than hiding real findings.

Final distribution checks:

- release tree: 239 files; no file above 1 MiB and no reparse file;
- npm dry-run: 237 files with no private/runtime path;
- production dependency audit: zero known vulnerabilities;
- lockfile: 40/40 dependencies declare licenses, all 40 resolved URLs use the
  npm registry and none contains credentials;
- syntax/data: 128 JavaScript files and 11 JSON files pass;
- documentation: 71 Markdown files, 43 relative links, zero missing;
- private-value comparison: two high-signal local values compared against 227
  release text files, zero matches. Values were never printed or recorded.

## Runtime untracking

Historical tracked `data/*.json` and generated `reports/` paths were removed
from the Git index. Local files were not deleted. Before/after SHA-256 checks on
the 16 existing affected private files show:

- missing: 0;
- changed: 0.

The staged change contains 265 historical runtime removals, one compiled-cache
removal, plus `reports/.gitkeep`.
No source commit or push was performed.

## Safe to publish

- product source and synthetic fixtures;
- Dashboard/Extension/Browser Agent assets;
- launcher scripts and portable `.cmd` wrappers;
- tests, screenshots/demo assets confirmed synthetic, guides, MIT license,
  contribution and security policy;
- `.gitignore`, `data/README.md`, and `reports/.gitkeep`.

The three public screenshots and all three unique `demo.gif` frames were
visually checked and contain synthetic product data only. Private real-page QA
screenshots remain local and ignored. Five root agent-workspace templates that
an external tool can regenerate are also ignored because they are not product
documentation. A previously tracked Python bytecode cache is staged for
index-only removal and remains present locally; the audit now blocks compiled
caches. The npm dry-run contains none of these non-product files.

## Must stay private

- runtime job/profile/search/AI/answer JSON;
- resumes and documents;
- applications, Packages, Sessions, attempts and reports;
- cookies, browser/extension local state and persistent profiles;
- logs, screenshots from real forms, backups, API keys, tokens and `.env`;
- machine-specific shortcuts and private application URLs.

## Important publication caveat

Existing Git history may contain historical runtime data even though the
current release tree does not. Publish from a reviewed clean history or perform
a separately reviewed history scrub. Do not make the existing history public
without that review. The repository owner must also confirm contact information,
final GitHub URLs, staged scope, and publication authorization.

Read-only history inventory found 288 historical runtime-path objects and 15
Profile/memory-path objects across one commit, with no credential-file or
resume-binary path match. This path-level result does not prove the blob
contents are safe; direct publication of the existing history remains blocked.

Rollback: restore Git index entries only from the current commit if the owner
does not want untracking; local runtime files require no rollback because they
were never removed. The full verified private backup remains under `archive/`.
