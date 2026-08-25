# Resume Jobs UX Design Rules

These rules apply to every user-facing Release surface, including the
Dashboard, launcher pages, Chrome extension, Mock ATS demo, and future product
UI.

## No browser native dialog

**No browser native dialog.**

Release product code must never use:

- `alert()`, `window.alert()`, or `globalThis.alert()`
- `confirm()`, `window.confirm()`, or `globalThis.confirm()`
- `prompt()`, `window.prompt()`, or `globalThis.prompt()`

Native dialogs are inconsistent across browsers, block automation, provide
weak context, and can make a working action appear unresponsive.

Use product-owned UI instead:

- Confirmation Modal for consequential or destructive decisions.
- Inline form or modal for text input such as Rename.
- Success Toast for brief completed-action feedback.
- Warning Banner for important persistent context.
- Inline Error beside the task that failed.
- Notification region with `aria-live` for asynchronous state changes.

## Confirmation Modal

Every confirmation must explain:

1. what will happen;
2. what will not happen when safety boundaries matter;
3. whether the action is reversible;
4. a specific primary action label, such as `Delete Resume` or
   `Approve Profile`.

Destructive actions use danger styling. Cancel is always available, Escape
closes the modal, and keyboard focus starts on the safer action.

## Toasts and notifications

- Successful actions may use a short Toast and must also leave authoritative
  state visible in the page.
- Failures use an Inline Error or persistent Notification, not a disappearing
  toast alone.
- Warnings remain visible until the user changes the relevant state.
- Status regions use `role="status"` and `aria-live="polite"` where
  appropriate.

## Input

Do not request user input through `prompt()`. Use a labeled inline editor or a
product modal with validation, Save, and Cancel controls.

## Release gate

`tests/no_native_dialogs.test.mjs` scans Release source and fails when it finds
a browser-native `alert`, `confirm`, or `prompt` call. Debug-only experiments
may exist under `developer/` or `internal/`, but they must be disabled by
default, excluded from Release surfaces, and never become a product
dependency.
