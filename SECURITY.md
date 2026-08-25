# Security and privacy

Resume Jobs handles sensitive local information. Treat every Candidate Fact,
resume, answer, screenshot, browser profile, and Application Package as private.

## Reporting a vulnerability

Please report suspected vulnerabilities through
[GitHub Security Advisories](../../security/advisories/new) (private
disclosure), or open a regular issue for lower-severity hardening
suggestions. Do not include any real candidate data in a report.

## Default safety boundary

- The Dashboard binds to `127.0.0.1` only.
- Workflow state is derived from current domain records, not browser cache.
- Final submission is manual.
- Login, CAPTCHA, MFA, and verification are not automated.
- Resume attachment requires a separate explicit action.
- Sensitive and high-risk answers require user confirmation.
- Model output cannot change deterministic score, approval, application state,
  browser policy, upload policy, or submit policy.
- Release UI does not use browser-native `alert`, `confirm`, or `prompt`.
- Dashboard responses prevent framing, MIME sniffing, and referrer disclosure.

## Local API and extension boundary

State-changing browser requests carrying an `Origin` are accepted only from the
exact loopback Dashboard port or a syntactically valid Chrome extension origin.
Foreign browser origins, including another localhost port, are rejected before
route handling. Origin-less local CLI clients remain inside the local-user trust
boundary, so the Dashboard must continue to bind only to `127.0.0.1`.

The localhost API validates the Chrome extension origin format but does not pin
one permanent extension ID, because unpacked-extension IDs can differ by local
installation. Another locally installed extension would still need explicit
loopback host permission, an active user-created Application Session, and the
exact application URL to obtain a handoff. Treat installed browser extensions
as part of the local-browser trust boundary and remove extensions you do not
trust. A future signed distribution may add explicit extension-ID pairing.

The private extension handoff requires all of the following:

- a request origin matching `chrome-extension://<extension-id>`;
- an active Dashboard Application Session created by explicit **Start AI Fill Assistant**;
- an exact canonical current-page/job-page match, retaining functional query
  identity while removing tracking parameters;
- an existing reviewed Application Package.

It is read-only, returns no resume file bytes, and forces
`final_submit_allowed=false`. The Dashboard accepts extension fill reports only
for the active job/session and discards any claimed submit result.

Extension diagnostics use the same extension-origin boundary. Heartbeats carry
only extension version, normalized current URL, page readiness, and
server-derived application/job/session identifiers. They never carry candidate
field values or resume bytes. Native Messaging is not part of the product; no
native host or registry installation is required.

The Extension does not fill from a cached Session after a missing or failed
handoff. When the Dashboard reset epoch changes, the next popup connection
clears cached Session, report, question, mapping, and legacy private state before
requesting a new handoff.

The extension does not expose private profiles as web-accessible resources.
Permanent host access is limited to localhost, Greenhouse, Lever, Ashby, and
legacy Workday hosts; another public page requires an explicit `activeTab`
action.

Normal executor runs never transport or attach resume bytes. Resume attachment
is a separate manual action with product-owned confirmation; it is never part
of automatic field filling.

## Public URL and provider access

Importing a public job URL requires product-owned confirmation. Remote URLs must
use HTTPS and cannot contain credentials, private, link-local, reserved,
mapped-private, NAT64 or 6to4 DNS targets, non-standard remote ports, redirects,
or oversized/non-HTML responses.

AI provider endpoints are validated. Local providers must use loopback; remote
providers must use HTTPS. Credentials are stored only in ignored local state,
never returned by Settings APIs, and never written to reports or extension
bundles.

Local JSON persistence is fail-closed: a missing optional store can use its
documented default, but corrupt, unreadable, or permission-denied data is never
treated as an empty valid state. The original file is preserved and the
Dashboard directs the user to restore a backup or explicitly reset local data.

**Reset Local Data** deletes only product-owned stores and local browser state.
An explicitly configured Candidate Profile outside those directories is
preserved; remove or replace that user-managed file separately if intended.

## Never commit

- `.env` files, API keys, tokens, cookies, passwords, or credentials
- runtime `data/*.json` other than documented synthetic templates
- `applications/`, `reports/`, `output/`, `tmp/`, or `archive/`
- `documents/` or any personal resume
- `browser_profiles/` or `browser_sessions/`
- `extensions/application_assistant/profile.local.json`
- `extensions/application_assistant/package_bundle.local.js`
- screenshots or recordings containing candidate or application data

## Real-site use

Real-site filling must be supervised and limited to a user-selected job. Confirm
the URL, selected Resume Version, Candidate Facts, planned answers, sensitive
questions, completion estimate, and current application state before continuing.

Do not bypass site protections, invent candidate facts, or use Resume Jobs to
submit false information. Accessing a real job site, logging in, uploading a
resume, or submitting an application requires explicit user authorization.

## Reporting a vulnerability

Do not open a public issue containing personal data, credentials, a private URL,
or an unredacted application. Report the minimum reproducible technical details
to the maintainer through a private channel.
