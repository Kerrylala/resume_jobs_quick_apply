# Launchers (normal users)

All launchers start the **same product** (the local Dashboard served by
`dashboard/server.mjs`) in different modes — there is only one product and one
backend.

- `ResumeJobs Launcher.cmd` — starts the Dashboard in normal user mode.
- `ResumeJobs Offline Demo.cmd` — runs the fully offline synthetic demo and
  opens its report. No network access, no real applications.

Developer-only launcher: [tools/launchers/ResumeJobs Developer.cmd](../tools/launchers/)
starts the same Dashboard with `-DeveloperMode` enabled.
