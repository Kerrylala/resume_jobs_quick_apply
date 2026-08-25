# Developer launcher

`ResumeJobs Developer.cmd` starts the **same product** as the normal-user
launchers in `dist/`, with `-DeveloperMode` passed to
`scripts/start_dashboard_windows.bat`. It is kept out of `dist/` so normal
users only see the two supported entry points.

There is one product: every launcher ultimately runs `npm run app`
(`node dashboard/server.mjs`) with different flags.
