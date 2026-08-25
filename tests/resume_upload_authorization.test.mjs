// The resume-upload authorization chain, at the unit level.
//
// The product may upload the tailored resume ONLY when an explicit per-job
// authorization travels with the execution session, and the authorization must
// name the session's own job and the exact file fingerprint. Everything else —
// login, challenge handling, sensitive answers, final Submit — stays
// unconditionally forbidden. These tests pin both sides: what a valid
// authorization enables, and every shape that must keep refusing.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertApplicationExecutionSession,
  createApplicationExecutionSession
} from '../application_executor/execution_session.mjs';
import { assertSafeExecutionRequest } from '../application_executor/safety_policy.mjs';
import { computeReviewBlockers, sessionResumeUploadConfirmed } from '../scripts/lib/application_state.mjs';
import '../application_executor/shared_core.js';

const core = globalThis.ResumeJobsApplicationExecutorCore;

const PACKAGE = {
  package_id: 'pkg_upload_1',
  application_id: 'app_upload_1',
  status: 'PACKAGE_READY',
  job_id: 'job_upload_a',
  job_information: { job_id: 'job_upload_a', company: 'Upload Co', title: 'Engineer' },
  career_profile_reference: {
    profile_id: 'profile_1', family_id: 'profile_1', version: 3,
    user_approved: true, approved_at: '2026-08-01T00:00:00.000Z'
  },
  application_profile: {
    full_name: { value: 'Upload Candidate', source: 'career_brain', confidence: 1, user_confirmed: true },
    email: { value: 'upload@example.invalid', source: 'career_brain', confidence: 1, user_confirmed: true }
  },
  application_answers: []
};

function baseSession(overrides = {}) {
  return createApplicationExecutionSession({
    applicationPackage: PACKAGE,
    job: { job_id: 'job_upload_a', company: 'Upload Co', title: 'Engineer' },
    targetUrl: 'https://jobs.example.test/upload/apply',
    idempotencyKey: 'upload-test-1',
    ...overrides
  });
}

test('a session without authorization keeps resume upload off', () => {
  const session = baseSession();
  assert.equal(session.safety.resume_upload_allowed, false);
  assert.equal(session.resume_upload_authorization, undefined);
});

test('a matching per-job authorization enables upload for that job only', () => {
  const session = baseSession({
    resumeUpload: {
      authorized: true, job_id: 'job_upload_a', draft_id: 'draft_x',
      sha256: 'sha256:feed', file_name: 'draft_x.docx', format_preference: 'pdf'
    }
  });
  assert.equal(session.safety.resume_upload_allowed, true);
  assert.equal(session.resume_upload_authorization.job_id, 'job_upload_a');
  assert.equal(session.resume_upload_authorization.sha256, 'sha256:feed');
  assert.equal(session.resume_upload_authorization.format_preference, 'pdf');
});

test('an authorization for a DIFFERENT job never enables upload', () => {
  const session = baseSession({
    resumeUpload: { authorized: true, job_id: 'job_upload_b', sha256: 'sha256:feed' }
  });
  assert.equal(session.safety.resume_upload_allowed, false);
});

test('an authorization without a file fingerprint never enables upload', () => {
  const session = baseSession({
    resumeUpload: { authorized: true, job_id: 'job_upload_a', sha256: '' }
  });
  assert.equal(session.safety.resume_upload_allowed, false);
});

test('resume_upload_allowed=true with no authorization object is rejected as unsafe', () => {
  const session = baseSession();
  assert.throws(
    () => assertApplicationExecutionSession({
      ...session,
      safety: { ...session.safety, resume_upload_allowed: true }
    }),
    error => error.code === 'UNSAFE_APPLICATION_EXECUTION_SESSION'
  );
});

test('resume_upload_allowed=true with a cross-wired job binding is rejected as unsafe', () => {
  const session = baseSession();
  assert.throws(
    () => assertApplicationExecutionSession({
      ...session,
      safety: { ...session.safety, resume_upload_allowed: true },
      resume_upload_authorization: { job_id: 'job_upload_b', sha256: 'sha256:feed' }
    }),
    error => error.code === 'UNSAFE_APPLICATION_EXECUTION_SESSION'
  );
});

test('login, challenge, sensitive answers and final submit stay unconditionally forbidden', () => {
  const session = baseSession({
    resumeUpload: { authorized: true, job_id: 'job_upload_a', sha256: 'sha256:feed' }
  });
  for (const key of ['sensitive_answers_allowed', 'login_allowed', 'challenge_bypass_allowed', 'final_submit_allowed']) {
    assert.throws(
      () => assertApplicationExecutionSession({
        ...session,
        safety: { ...session.safety, [key]: true }
      }),
      error => error.code === 'UNSAFE_APPLICATION_EXECUTION_SESSION',
      `${key}=true must always be rejected`
    );
  }
});

test('assertSafeExecutionRequest allows upload only with the matching authorization', () => {
  // No authorization: the old hard refusal stands.
  assert.throws(() => assertSafeExecutionRequest({ upload_resume: true, job_id: 'job_a' }));
  // Authorization for another job: refused.
  assert.throws(() => assertSafeExecutionRequest({
    upload_resume: true, job_id: 'job_a',
    resume_upload_authorization: { job_id: 'job_b', sha256: 'sha256:feed' }
  }));
  // Authorization without a fingerprint: refused.
  assert.throws(() => assertSafeExecutionRequest({
    upload_resume: true, job_id: 'job_a',
    resume_upload_authorization: { job_id: 'job_a', sha256: '' }
  }));
  // Matching authorization: allowed.
  assert.equal(assertSafeExecutionRequest({
    upload_resume: true, job_id: 'job_a',
    resume_upload_authorization: { job_id: 'job_a', sha256: 'sha256:feed' }
  }), true);
  // The permanently forbidden actions stay forbidden even alongside a valid
  // upload authorization.
  for (const action of ['final_submit', 'submit', 'login', 'solve_challenge']) {
    assert.throws(() => assertSafeExecutionRequest({
      [action]: true, upload_resume: true, job_id: 'job_a',
      resume_upload_authorization: { job_id: 'job_a', sha256: 'sha256:feed' }
    }), undefined, `${action} must stay forbidden`);
  }
});

test('the execution record reports uploads truthfully and keeps the rest hard-false', () => {
  const reported = core.createApplicationExecution({
    execution_id: 'exec_1', job_id: 'job_upload_a', executor: 'local_browser_agent',
    url: 'https://jobs.example.test/upload/apply',
    field_results: [],
    resume_upload: {
      attempted: true, status: 'confirmed', reason: '',
      file: { name: 'draft_x.pdf', format: 'pdf' },
      evidence: { input_holds_file: true, page_shows_file_name: true }
    },
    safety: {
      upload_attempted: true, resume_uploaded: true,
      // A hostile report cannot flip the permanently forbidden flags.
      login_attempted: true, submit_attempted: true, final_submit: true, submitted: true
    }
  });
  assert.equal(reported.safety.upload_attempted, true);
  assert.equal(reported.safety.resume_uploaded, true);
  assert.equal(reported.safety.login_attempted, false);
  assert.equal(reported.safety.submit_attempted, false);
  assert.equal(reported.safety.final_submit, false);
  assert.equal(reported.safety.submitted, false);
  assert.equal(reported.resume_upload.status, 'confirmed');
  assert.equal(reported.resume_upload.file.name, 'draft_x.pdf');
  assert.equal(reported.resume_upload.evidence.input_holds_file, true);
});

test('a VERIFIED upload satisfies the file checklist item; anything less keeps it', () => {
  const scan = { file_upload_required: true, file_upload_present: false };
  // No confirmation → the manual-attach blocker stands.
  assert.ok(computeReviewBlockers(scan).some(item => item.code === 'FILE_UPLOAD_REQUIRED'));
  // A verified upload from this attempt clears it (Greenhouse empties the
  // input after taking the file, so the re-scan alone cannot see it).
  assert.equal(
    computeReviewBlockers(scan, { resumeUploadConfirmed: true })
      .some(item => item.code === 'FILE_UPLOAD_REQUIRED'),
    false
  );
  // The file visibly present in the input also clears it, as before.
  assert.equal(
    computeReviewBlockers({ file_upload_required: true, file_upload_present: true })
      .some(item => item.code === 'FILE_UPLOAD_REQUIRED'),
    false
  );
  // Confirmation comes only from a report that really carried it.
  assert.equal(sessionResumeUploadConfirmed({ reports: [{ resume_upload_attempted: true }] }), false);
  assert.equal(sessionResumeUploadConfirmed({ reports: [{ resume_upload_confirmed: true }] }), true);
  assert.equal(sessionResumeUploadConfirmed({}), false);
});

test('a record with no upload block reports upload false, not fabricated', () => {
  const reported = core.createApplicationExecution({
    execution_id: 'exec_2', job_id: 'job_upload_a', executor: 'extension',
    url: 'https://jobs.example.test/upload/apply', field_results: []
  });
  assert.equal(reported.safety.upload_attempted, false);
  assert.equal(reported.safety.resume_uploaded, false);
  assert.equal(reported.resume_upload, null);
});
