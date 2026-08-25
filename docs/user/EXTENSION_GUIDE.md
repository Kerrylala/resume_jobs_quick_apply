# Chrome Extension Guide

## Install

1. Start Resume Jobs with `npm start`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode.
4. Choose **Load unpacked** and select
   `extensions/application_assistant`.
5. Pin **Resume Jobs AI Fill Assistant**.

Reload the unpacked extension after pulling changes. Run
`npm run executor:sync-extension-core` before packaging if the shared executor
core changed.

## Daily workflow

1. Review an Application Package in the Dashboard.
2. Approve AI Fill.
3. Select **Chrome Extension (recommended)**.
4. Start AI Fill Assistant.
5. The Dashboard opens the preferred public application URL. On Lever job
   pages, Resume Jobs opens the corresponding `/apply` page.
6. The extension connects the opened page to the active reviewed package. Use
   the on-page control or popup **Fill safe fields** action when ready.
7. Choose **Review skipped fields**, then complete the remaining work manually.

## Diagnostics

The compact popup is user-facing and shows:

- company and role;
- Connected / Not connected;
- Application found and Package ready;
- Lever, Greenhouse, or Unknown website;
- current page;
- detected, filled and skipped counts plus skipped reasons.

The Review issues panel shows one diagnostic per field. Advanced diagnostics
include the redacted raw report and field-memory records. Reports never persist
the candidate values.

The Dashboard also provides **Settings → Extension Connection**. Normal mode shows:

- whether the installed extension was observed on the Dashboard page;
- whether it is connected;
- the current page;
- whether the current application and reviewed Package match.

Internal connection state and technical identifiers are available only under
**Advanced diagnostics**.

The Manifest V3 service worker establishes the connection when the opened
application page loads, so daily use does not require opening the popup first.
Opening the popup also refreshes the connection. The Dashboard considers a
connection stale after 30 seconds so an old cached run cannot appear connected.

## Native Messaging

Native Messaging is **not required**. The extension uses its localhost host
permission and extension-origin HTTP requests to communicate with
`http://127.0.0.1:8767`. The Manifest does not request the `nativeMessaging`
permission and the product does not install a native host, executable, or
registry entry.

## Supported adapters

- Lever public application pages
- Greenhouse public application pages
- Ashby public application pages
- Generic conservative fallback

Legacy Workday detection remains available in the extension, but portal changes,
authentication and multi-step flows commonly require manual handling.

## Safety

The extension never activates buttons, submits, logs in, solves CAPTCHA/MFA, or
uploads files during Application Executor runs. Automatic fill receives no
resume bytes. The separate **Attach Resume** action requires product-owned
confirmation and is never triggered by page load or field filling. The browser
connection requires the installed extension, the exact approved page, one
reviewed package, and no final-submit permission.

## Troubleshooting

- **Connected: No** — keep the Dashboard on `127.0.0.1:8767`, verify the exact
  approved URL, then close/reopen the popup.
- **Receiving end does not exist** — reload the page after loading/reloading the
  unpacked extension.
- **Profile not approved** — approve the Career Brain profile and rebuild the
  package. Example profiles are blocked on public websites.
- **No mapping** — leave the field blank, complete it yourself, and confirm a
  reusable field mapping later if appropriate.

An installed-extension real-site result is not considered verified until the
installed instance actually connects. Automated fixture tests validate the
runtime contract but do not replace that manual connection check.
