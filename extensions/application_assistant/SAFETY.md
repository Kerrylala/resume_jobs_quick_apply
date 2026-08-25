# AI Fill Assistant safety policy

## Hard stops

The extension must pause and return control to the user for:

- login or account creation;
- CAPTCHA, OTP, email verification, or MFA;
- resume or supporting-document upload;
- unknown or low-confidence questions;
- salary, work authorization, identity, EEO, disability, veteran, demographic,
  government-ID, signature, or legal declarations;
- unsupported page transitions;
- final Submit, Send, Confirm, or equivalent irreversible actions.

## Data sources

Autofill values come from exactly one place: the ApplicationExecutionSession's
user-confirmed approved field mappings, fetched fresh from the local Resume
Jobs app on every run. The extension stores nothing — no profiles, no answers,
no jobs, no reports, no chrome.storage — and its only network destination is
the local app on 127.0.0.1, reached solely through the service worker.

Model suggestions and newly inferred values are not trusted automatically.

## Field mapping

Form Field Memory is de-valued. A mapping is reusable only when it is:

- explicitly confirmed by the user;
- non-sensitive;
- active;
- above the required confidence threshold.

Candidate values must never be written into mapping memory.

## Real-site use

Real-site filling is a supervised action. Confirm the job URL, profile,
application package, resume version, and stop conditions before beginning.

Permissions are minimal: `activeTab` + `scripting`, with host access limited
to localhost and the supported ATS domains. There is no storage, history,
cookies, webRequest, or `<all_urls>` permission.

Never use the extension to bypass site protections or submit false
information.
