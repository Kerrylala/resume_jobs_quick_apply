import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildOfflineDemoSummary,
  renderOfflineDemoHtml
} from '../scripts/lib/offline_demo_report.mjs';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function syntheticTextPdf(lines) {
  const operators = lines.map((line, index) =>
    `${index ? '0 -20 Td\n' : ''}(${String(line).replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)')}) Tj`
  ).join('\n');
  const stream = `BT\n/F1 12 Tf\n72 720 Td\n${operators}\nET`;
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Length ${Buffer.byteLength(stream)} >>
stream
${stream}
endstream
endobj
%%EOF
`);
}

test('offline demo report proves the full synthetic workflow without candidate values', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-jobs-demo-report-'));
  const jobId = 'job_fixture';
  writeJson(path.join(root, 'data', 'job_leads.json'), [{
    job_id: jobId,
    title: 'Product Manager',
    company: 'Synthetic Labs',
    location: 'Remote',
    ats: 'greenhouse',
    match_score: 92,
    dedupe: { merged_source_count: 2 },
    score_breakdown: { matched_requirements: ['target_role', 'location'] }
  }]);
  const resumeContent = syntheticTextPdf([
    'Synthetic Candidate',
    'candidate@local.invalid',
    'https://linkedin.com/in/synthetic-candidate'
  ]);
  writeJson(path.join(root, 'synthetic-profile.json'), {
    approved_for_real_applications: true,
    linkedin: 'https://linkedin.com/in/synthetic-candidate',
    profile_meta: {
      approved_for_real_applications: true,
      last_reviewed_at: '2026-07-23T00:00:00.000Z'
    }
  });
  writeJson(path.join(root, 'data', 'resume_profiles.json'), {
    items: [{
      resume_id: 'resume_fixture',
      content_hash: 'sha256:fixture',
      approved_at: '2026-07-23T00:00:00.000Z'
    }]
  });
  const resumeFilePath = path.join(root, 'resume-library', 'resume_fixture.pdf');
  fs.mkdirSync(path.dirname(resumeFilePath), { recursive: true });
  fs.writeFileSync(resumeFilePath, resumeContent);
  writeJson(path.join(root, 'data', 'question_bank.json'), {
    answers: [{ question: 'Why?', answer: 'PRIVATE VALUE', user_confirmed: true }]
  });
  writeJson(path.join(root, 'data', 'dashboard_state.json'), {
    application_status_overrides: {
      [jobId]: {
        application_status: 'READY_FOR_MANUAL_SUBMIT',
        active_session_id: 'run_fixture'
      }
    },
    application_execution_sessions: {
      run_fixture: {
        schema: 'ApplicationExecutionSession',
        schema_version: '1.1',
        session_id: 'run_fixture',
        application_id: 'application_fixture',
        job_id: jobId,
        package_id: 'package_fixture',
        executor_type: 'extension',
        target_url: 'https://boards.greenhouse.io/synthetic/jobs/fixture',
        execution_status: 'NEEDS_REVIEW',
        approved_profile_version: {
          profile_id: 'career_fixture', family_id: 'career_fixture', version: 1,
          approved_at: '2026-07-23T00:00:00.000Z', snapshot_digest: 'sha256:fixture'
        },
        approved_field_mappings: [{
          canonical_key: 'email', value: 'candidate@local.invalid',
          source: 'synthetic_package', confidence: 1, user_confirmed: true
        }],
        safety: {
          resume_upload_allowed: false, sensitive_answers_allowed: false, login_allowed: false,
          challenge_bypass_allowed: false, final_submit_allowed: false
        },
        recovery_count: 1,
        reports: [
          {
            application_submitted: false,
            application_completion: { application_completion_rate: 70 }
          },
          {
            application_submitted: false,
            application_completion: {
              application_completion_rate: 100,
              ready_for_30_second_review: true
            }
          }
        ]
      }
    },
    audit_events: [
      { to_status: 'APPROVED_FOR_PACKAGE' }
    ]
  });
  writeJson(path.join(root, 'applications', jobId, 'application_package.json'), {
    status: 'PACKAGE_READY',
    application_id: 'application_fixture',
    selected_resume: {
      resume_id: 'resume_fixture',
      file_reference: resumeFilePath,
      content_hash: 'sha256:fixture',
      approved_at: '2026-07-23T00:00:00.000Z'
    },
    application_completion: {
      portal: 'greenhouse',
      application_completion_rate: 60,
      potential_completion_rate: 75,
      resume_intelligence_summary: {
        available_fact_count: 8,
        confirmed_fact_count: 8
      }
    }
  });
  writeJson(path.join(root, 'browser', 'job_apply_autofill_local_test_result_001.json'), {
    success: true,
    complex_form: { filled_fields_count: 12 },
    field_memory_learning: {
      baseline_completion_rate: 59,
      learned_completion_rate: 62,
      completion_rate_improvement: 3
    },
    safety: {
      only_localhost_urls_used: true,
      real_websites_opened: false,
      uploaded_resume: false,
      logged_in: false,
      clicked_or_submitted: false
    },
    screenshots: ['C:\\temp\\before.png']
  });

  const summary = buildOfflineDemoSummary(root, {
    generatedAt: '2026-07-23T00:00:00.000Z'
  });
  const serialized = JSON.stringify(summary);
  const html = renderOfflineDemoHtml(summary);

  assert.equal(summary.success, true);
  assert.equal(summary.pipeline.passed_steps, 10);
  assert.equal(summary.pipeline.total_steps, 10);
  assert.equal(summary.outcome, 'READY_FOR_MANUAL_SUBMIT');
  assert.equal(summary.completion.final_rate, 100);
  assert.equal(summary.completion.field_memory_improvement_points, 3);
  assert.equal(summary.knowledge.resume_intake_verified, true);
  assert.equal(summary.knowledge.resume_metadata_matches_package, true);
  assert.equal(summary.knowledge.local_resume_analysis_verified, true);
  assert.equal(summary.knowledge.local_resume_suggestion_count, 3);
  assert.equal(summary.knowledge.local_resume_raw_text_retained, false);
  assert.equal(summary.knowledge.local_resume_suggestions_retained, false);
  assert.equal(summary.knowledge.selected_resume_fact_present_after_review, true);
  assert.equal(summary.knowledge.candidate_profile_reviewed_after_apply, true);
  assert.equal(summary.safety.application_submitted, false);
  assert.equal(serialized.includes('PRIVATE VALUE'), false);
  assert.equal(serialized.includes('candidate@local.invalid'), false);
  assert.equal(serialized.includes('linkedin.com/in/synthetic-candidate'), false);
  assert.match(html, /Complete offline product demo/);
  assert.match(html, /Final Submit/);
});

test('package script and portable Windows entry both use the same offline demo runner', () => {
  const packageValue = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  const portableEntry = fs.readFileSync(
    path.join(PROJECT_ROOT, 'dist', 'ResumeJobs Offline Demo.cmd'),
    'utf8'
  );

  assert.equal(packageValue.scripts.demo, 'node scripts/run_offline_demo.mjs');
  assert.equal(packageValue.scripts['demo:no-open'], 'node scripts/run_offline_demo.mjs --no-open');
  assert.match(portableEntry, /node scripts\\run_offline_demo\.mjs/i);
  assert.match(portableEntry, /Node\.js 18 or later is required/);
});
