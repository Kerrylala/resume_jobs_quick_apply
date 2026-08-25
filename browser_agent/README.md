# Local Browser Agent

The Local Browser Agent is the optional advanced Application Executor. The
Dashboard creates its session after the user approves the package and explicitly
chooses **Local Browser Agent**. It launches a visible local Chrome/Edge window,
uses a dedicated ignored profile, fills only reviewed non-sensitive text fields,
writes screenshots and a redacted `ApplicationExecution` report, and pauses for
the user.

It never uploads files, logs in, handles CAPTCHA/MFA, activates submit controls,
or submits an application. Runtime profiles and sessions are stored under the
ignored `browser_profiles/` and `browser_sessions/` directories.
