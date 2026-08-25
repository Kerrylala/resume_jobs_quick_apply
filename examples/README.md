# Examples

All example data in this repository is synthetic. Real candidate data, resumes,
answers, and browser state are never committed.

Where to find runnable, synthetic examples today:

- Extension templates (placeholder identities only):
  [extensions/application_assistant/profile.local.template.json](../extensions/application_assistant/profile.local.template.json)
  and
  [site_rules.local.example.json](../extensions/application_assistant/site_rules.local.example.json).
- Mock application forms used by tests and the safe local demo:
  [mock_sites/job_apply_autofill_test/](../mock_sites/job_apply_autofill_test/).
- Synthetic resume fixture used by offline tests:
  [tests/fixtures/synthetic_first_run_resume.txt](../tests/fixtures/synthetic_first_run_resume.txt).
- Offline demo (generates a synthetic end-to-end report without network access):
  `npm run demo`, launched for normal users by `dist/ResumeJobs Offline Demo.cmd`.
