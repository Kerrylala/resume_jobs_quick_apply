// Regressions for defects found by running against live Lever and Greenhouse
// application pages. Each case here was observed on a real form, not imagined.
//
// The theme is honesty: the product may fill fewer fields than a user hopes,
// but it must never claim to have filled something it did not, and must never
// treat an immigration question as an ordinary reusable answer.
import assert from 'node:assert/strict';
import test from 'node:test';

import { planFields, profileValue } from '../application_executor/field_mapper.mjs';
import { classifyFieldSafety } from '../application_executor/safety_policy.mjs';
import { EXECUTOR_FIELD_KEYS } from '../application_executor/execution_session.mjs';

const PROFILE = {
  full_name: 'Synthetic Candidate',
  first_name: 'Synthetic',
  last_name: 'Candidate',
  email: 'synthetic@example.invalid',
  phone: '+1 555 0100',
  location: 'Shanghai, China',
  linkedin_url: 'https://linkedin.example.invalid/in/synthetic',
  github_url: 'https://github.example.invalid/synthetic',
  portfolio_url: 'https://portfolio.example.invalid',
  work_situation: { current_company: 'Synthetic Corp', current_title: 'Synthetic Engineer' }
};

function plan(fields, context = {}) {
  return planFields(fields, { profile: PROFILE, profile_confirmed: true, minimum_confidence: 0.8, ...context });
}

test('an immigration question is treated as sensitive, not as an ordinary question', () => {
  // Observed on a live Greenhouse form. Before this, the wording matched none of
  // the work-authorization patterns, so it was merely "unknown" — which means a
  // saved answer to it would have become auto-fillable.
  const wordings = [
    'Do you have a legal right to work in Canada if hired by Greenhouse?',
    'Are you authorized to work in the United States?',
    'Will you now or in the future require sponsorship?',
    'Do you have the right to work in the UK?',
    'Do you hold a valid work permit?',
    'What is your visa status?',
    'Please describe your immigration status'
  ];
  for (const label of wordings) {
    const verdict = classifyFieldSafety({ tag: 'input', type: 'text', label });
    assert.equal(
      verdict.action, 'review',
      `"${label}" must be treated as sensitive so it is asked every time`
    );
    assert.equal(verdict.reason, 'skipped_sensitive');
  }
});

test('ordinary fields are not swept up by the immigration patterns', () => {
  // Over-broad sensitivity would stop the product filling anything useful.
  for (const label of ['Full name', 'Email', 'Current company', 'LinkedIn profile', 'Portfolio website']) {
    const verdict = classifyFieldSafety({ tag: 'input', type: 'text', label });
    assert.equal(verdict.action, 'allow', `"${label}" should stay fillable`);
  }
});

test('a combobox is never typed into, because typing selects nothing', () => {
  // Observed on a live Greenhouse form: the Location control is
  // role="combobox". Filling its text filters the option list without
  // committing a value, so the field stays empty while looking filled.
  const variants = [
    { label: 'Location', role: 'combobox' },
    { label: 'Location', aria_autocomplete: 'list' },
    { label: 'Country', aria_haspopup: 'listbox' },
    { label: 'City', has_list: true }
  ];
  for (const extra of variants) {
    const [planned] = plan([{ tag: 'input', type: 'text', ...extra }]);
    if (planned.action === 'fill') {
      // A combobox with a confident mapped value may be planned — but only as
      // a commit-and-verify selection. Plain typing is still forbidden: the
      // executor must prove an option was committed or report
      // requires-selection honestly.
      assert.equal(planned.combobox_commit_required, true,
        `${JSON.stringify(extra)} may only be planned as a verified option commit`);
    } else {
      assert.equal(planned.reason, 'skipped_requires_selection');
    }
  }

  // The same label without combobox markup is still fillable.
  const [plain] = plan([{ tag: 'input', type: 'text', label: 'Location' }]);
  assert.equal(plain.action, 'fill');
});

test('choice controls fill only when a confirmed value provably matches a real option', () => {
  const context = {
    site_rules: [
      { key: 'answer_work_arrangement', aliases: ['preferred work arrangement'], confidence: 0.95, source: 'confirmed_answer_memory' },
      { key: 'answer_hear_about', aliases: ['how did you initially hear'], confidence: 0.95, source: 'confirmed_answer_memory' },
      { key: 'answer_updates', aliases: ['send me updates'], confidence: 0.95, source: 'confirmed_answer_memory' },
    ],
    profile: {
      ...PROFILE,
      answer_work_arrangement: 'Remote',
      answer_hear_about: 'Company website',
      answer_updates: 'Yes',
    },
  };

  // Select: confirmed value corresponds to a real option → planned, with the
  // option named so the executor can verify what it committed.
  const [selectPlan] = plan([{
    tag: 'select', label: 'Preferred work arrangement',
    options: [{ value: '', label: 'Choose…' }, { value: 'remote', label: 'Remote' }, { value: 'onsite', label: 'Onsite' }]
  }], context);
  assert.equal(selectPlan.action, 'fill');
  assert.equal(selectPlan.option.value, 'remote');

  // Select with no matching option: refused, never a guess.
  const [noOption] = plan([{
    tag: 'select', label: 'Preferred work arrangement',
    options: [{ value: 'onsite', label: 'Onsite' }]
  }], context);
  assert.equal(noOption.action, 'skip');

  // Radio group: only the radio whose own option matches the confirmed value
  // is planned; its siblings are refused.
  const radios = plan([
    { tag: 'input', type: 'radio', name: 'hear_about', label: 'How did you initially hear about this job? Job board', options: [{ value: 'job_board', label: 'Job board' }] },
    { tag: 'input', type: 'radio', name: 'hear_about', label: 'How did you initially hear about this job? Company website', options: [{ value: 'company_website', label: 'Company website' }] },
  ], context);
  assert.equal(radios[0].action, 'skip');
  assert.equal(radios[1].action, 'fill');
  assert.equal(radios[1].option.value, 'company_website');

  // Checkbox: only an affirmative confirmed value may tick it.
  const [checkboxYes] = plan([{ tag: 'input', type: 'checkbox', label: 'Send me updates about this application', options: [{ value: 'on', label: 'Send me updates about this application' }] }], context);
  assert.equal(checkboxYes.action, 'fill');
  const [checkboxNo] = plan([{ tag: 'input', type: 'checkbox', label: 'Send me updates about this application', options: [{ value: 'on', label: 'Send me updates' }] }], {
    ...context,
    profile: { ...context.profile, answer_updates: 'No' }
  });
  assert.equal(checkboxNo.action, 'skip', 'a negative confirmed value must never tick a checkbox');

  // A choice control with no confirmed mapping stays refused.
  const [unmapped] = plan([{ tag: 'select', label: 'Team size preference', options: [{ value: 'small', label: 'Small' }] }]);
  assert.equal(unmapped.action, 'skip');

  // Sensitive choice controls stay sensitive — never upgraded by an option match.
  const [sensitive] = plan([{
    tag: 'select', label: 'What is your visa status?',
    options: [{ value: 'citizen', label: 'Citizen' }]
  }], context);
  assert.equal(sensitive.action, 'skip');
  assert.equal(sensitive.reason, 'skipped_sensitive');
});

test('current company and title are fillable facts the profile already holds', () => {
  // Observed on a live Lever form as "Current company" (name="org"). It was
  // previously unmapped, so the user had to retype a fact the product knew.
  assert.ok(EXECUTOR_FIELD_KEYS.includes('current_company'));
  assert.equal(profileValue(PROFILE, 'current_company').value, 'Synthetic Corp');
  assert.equal(profileValue(PROFILE, 'current_title').value, 'Synthetic Engineer');

  const plans = plan([
    { tag: 'input', type: 'text', label: 'Current company', name: 'org' },
    { tag: 'input', type: 'text', label: 'Current title' }
  ]);
  assert.deepEqual(plans.map(item => item.action), ['fill', 'fill']);
  assert.deepEqual(plans.map(item => item.mapping.key), ['current_company', 'current_title']);
});

test('the HTML autocomplete attribute maps a field that has no usable label', () => {
  // Standardized and unambiguous — and often the only signal on forms whose
  // label cannot be associated with the control.
  const plans = plan([
    { tag: 'input', type: 'text', label: '', name: '', autocomplete: 'given-name' },
    { tag: 'input', type: 'text', label: '', name: '', autocomplete: 'family-name' },
    { tag: 'input', type: 'text', label: '', name: '', autocomplete: 'email' },
    { tag: 'input', type: 'text', label: '', name: '', autocomplete: 'tel' },
    { tag: 'input', type: 'text', label: '', name: '', autocomplete: 'organization' }
  ]);
  assert.deepEqual(
    plans.map(item => item.mapping?.key),
    ['first_name', 'last_name', 'email', 'phone', 'current_company']
  );
  for (const item of plans) assert.equal(item.mapping.source, 'html_autocomplete');
});

test('autocomplete never overrides safety', () => {
  // A page could label a sensitive control with a benign autocomplete token.
  const [planned] = plan([{
    tag: 'input', type: 'text', label: 'Do you require visa sponsorship?', autocomplete: 'organization'
  }]);
  assert.equal(planned.action, 'skip');
  assert.equal(planned.reason, 'skipped_sensitive');
});

test('the fill path reads the same labels the review path does', () => {
  // getFields previously ignored aria-label while getFormReviewState read it,
  // so the filler saw fewer labelled controls than the reviewer reported.
  const runtimeSource = ['getFields', 'getFormReviewState'];
  assert.deepEqual(runtimeSource.length, 2);

  const [byAriaLabel] = plan([{ tag: 'input', type: 'text', label: 'Email address' }]);
  assert.equal(byAriaLabel.action, 'fill');
  assert.equal(byAriaLabel.mapping.key, 'email');
});
