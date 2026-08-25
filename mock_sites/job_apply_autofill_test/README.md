# Job Apply Autofill Test Site

Local mock forms for manually testing the Chrome autofill extension.

## Start server

```bash
cd mock_sites/job_apply_autofill_test
python3 server.py
```

The server uses Python standard library modules only: `http.server`, `socketserver`, `pathlib`, and `os`.

## Test URLs

- http://127.0.0.1:8766/index.html
- http://127.0.0.1:8766/complex_form.html
- http://127.0.0.1:8766/safety_state.html?state=login
- http://127.0.0.1:8766/safety_state.html?state=captcha
- http://127.0.0.1:8766/safety_state.html?state=mfa

## What should be filled

On `index.html`, the extension should safely fill normal fields such as:

- Full Name
- First Name
- Last Name
- Email
- Phone
- City
- Country
- LinkedIn
- GitHub
- Portfolio
- School
- Degree
- Major
- Graduation Year
- Work Authorization, if a clear select option match exists
- Desired Role
- Years of Experience
- Summary

On `complex_form.html`, the extension should fill or suggest rules for normal application fields using Chinese labels, placeholder text, aria-labels, nearby text, and safe select dropdowns.

The complex form also includes radio buttons, checkboxes, a user-driven second step, an unknown dynamic question, and a sensitive salary question. Radio/checkbox controls require explicit reviewed rules; unknown and sensitive questions stay blank for user review.

The `safety_state.html` query variants simulate login, CAPTCHA, and MFA-only pages. All variants must return `NEEDS_USER_INPUT` without filling any field.

## What should be skipped

The extension should skip:

- file upload fields
- password fields
- hidden fields
- disabled fields
- captcha-like fields
- verification code fields
- OTP / SMS code fields
- passport / sensitive identity fields
- submit, apply, send, confirm, reset, and button controls

## Safety expectations

- Submit button should not be clicked.
- File upload should stay empty.
- Password should stay empty.
- Captcha/verification fields should stay empty.
- No login should happen.
- No application should be submitted.
- No resume should be uploaded.
- No email should be sent.
