import assert from 'node:assert/strict';
import test from 'node:test';

import { validateSelectedProfile } from '../scripts/build_application_package_preview.mjs';

function reviewedProfile(overrides = {}) {
  return {
    approved_for_real_applications: true,
    allow_autofill_real_sites: false,
    allow_resume_attach: false,
    allow_final_submit: false,
    full_name: 'Synthetic Candidate',
    profile_meta: {
      candidate_fact_review: {
        snapshot_digest: 'sha256:synthetic-review'
      }
    },
    ...overrides
  };
}

test('Application Package accepts reviewed local facts without enabling real-site autofill', () => {
  assert.doesNotThrow(() => validateSelectedProfile(
    reviewedProfile(),
    'C:\\temp\\profile.json',
    { status: 'package_preview_profile_review' }
  ));
});

test('Application Package still blocks profiles without a reviewed fact snapshot', () => {
  assert.throws(
    () => validateSelectedProfile(
      reviewedProfile({ profile_meta: {} }),
      'C:\\temp\\profile.json',
      { status: 'package_preview_profile_review' }
    ),
    error => error?.code === 'PROFILE_MISSING_OR_INVALID'
      && error?.details?.failures?.includes('candidate_fact_review_missing')
  );
});
