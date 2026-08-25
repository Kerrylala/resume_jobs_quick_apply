# Application Executor User Guide

## What it does

AI Fill Assistant takes an Application Package you already reviewed, opens the
approved application page, fills safe facts it knows from Career Brain, and
pauses for you. It explains every detected, filled and skipped field.

It does not upload a resume, log in, solve CAPTCHA/MFA, answer sensitive
questions, or submit an application.

## Before filling

1. Upload and review your resume.
2. Correct and approve Career Brain facts.
3. Find or import a job, then approve it.
4. Build the Application Package.
5. Confirm the resume version, answers, risks and missing information.
6. Select **Approve AI Fill**.

## Choose an executor

### Chrome Extension (recommended)

Use this for normal daily applications. Install the unpacked extension once,
then keep the Dashboard running. Select the mode and start AI Fill Assistant.
The job opens in your browser; open the extension popup if it does not connect
automatically.

### Local Browser Agent (advanced)

Use this for an isolated visible browser session and detailed screenshots/logs.
The Dashboard launches a dedicated Chrome/Edge profile. Leave the Dashboard
running, review the filled page, and close the agent browser when finished.

## Read the status panel

The Application Package page shows:

- Connected: whether the selected executor is attached.
- Status: waiting, starting, paused for review, needs input or ready.
- URL: the exact page in the run.
- Application, Package and Run identifiers.
- Detected, filled, skipped and failed field counts.
- Reasons a field was skipped.

Common skip reasons include missing reviewed value, sensitive question, file
upload disabled, authentication/challenge, choice needing review, and low
mapping confidence.

## Finish the application

Review every filled field. Complete uploads, unknown answers, sensitive choices,
login and verification yourself. Use the website's final Submit only after your
own review. Then return to Resume Jobs and record the manual submission.

## Troubleshooting

- **Extension says not connected:** confirm the Dashboard is open, the job URL
  exactly matches the approved job, the fill run is active, and the extension
  was loaded from `extensions/application_assistant`.
- **Browser Agent will not start:** install Chrome or Edge, or set
  `RESUME_JOBS_CHROME_EXECUTABLE` to the executable path.
- **A field was skipped:** read the reason. Add/approve the fact in Career Brain
  only when it is true; never manufacture a value to increase completion.
- **A portal changed:** save the diagnostics and report the portal URL and field
  labels without sharing personal filled values.
