import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLocalMockAtsHandoffUrl,
  buildLocalMockFillProfile,
  isLocalMockAtsUrl
} from '../scripts/lib/mock_ats_demo.mjs';

test('localhost Mock ATS handoff carries only job and execution-session identity', () => {
  const base = 'http://127.0.0.1:8767/mock-ats/jobs/123456';
  assert.equal(isLocalMockAtsUrl(base), true);
  assert.equal(isLocalMockAtsUrl('https://example.com/mock-ats/jobs/123456'), false);
  const handoff = new URL(buildLocalMockAtsHandoffUrl(base, {
    jobId: 'synthetic-job',
    sessionId: 'application-session'
  }));
  assert.equal(handoff.searchParams.get('job_id'), 'synthetic-job');
  assert.equal(handoff.searchParams.get('application_session_id'), 'application-session');
});

test('localhost Mock Fill profile excludes sensitive and upload controls', () => {
  const profile = buildLocalMockFillProfile({
    job: { title: 'Software Engineer' },
    applicationProfile: {
      full_name: 'Synthetic User',
      email: 'synthetic@example.invalid',
      work_authorization: 'sensitive',
      sponsorship: 'sensitive',
      salary_expectation: 'sensitive'
    }
  });
  assert.equal(profile.full_name, 'Synthetic User');
  assert.equal(profile.desired_role, 'Software Engineer');
  assert.equal(Object.hasOwn(profile, 'work_authorization'), false);
  assert.equal(Object.hasOwn(profile, 'sponsorship'), false);
  assert.equal(Object.hasOwn(profile, 'resume_file'), false);
});
