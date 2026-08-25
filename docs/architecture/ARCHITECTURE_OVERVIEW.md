# Architecture

Resume Jobs AI is one local-first product with one Dashboard, one set of
file-backed domain records, one Application Package builder, and one canonical
Application Session lifecycle. Chrome Extension and Local Browser Agent are
two transports behind the same Application Executor contract; neither owns a
second profile or workflow store.

The maintained architecture document is
[docs/architecture/ARCHITECTURE.md](ARCHITECTURE.md). Developer commands and module
ownership are documented in [docs/developer/DEVELOPER_GUIDE.md](../developer/DEVELOPER_GUIDE.md).

Safety invariants are non-bypassable:

- workflow state comes from current domain records;
- only an approved Profile, approved job, and reviewed Package can create an
  Application Session;
- executors receive approved safe mappings from that Session;
- upload, login, CAPTCHA/MFA handling, sensitive answers, and final Submit stay
  with the user.
