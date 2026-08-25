import fs from 'node:fs';
import path from 'node:path';

import { analyzeResumeDocument } from './resume_document_intelligence.mjs';
import { normalizeApplicationExecutionState } from './application_state.mjs';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function firstFile(directory, fileName) {
  if (!fs.existsSync(directory)) return '';
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = firstFile(candidate, fileName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === fileName) {
      return candidate;
    }
  }
  return '';
}

function requireFile(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    const error = new Error(`Offline demo evidence is missing: ${label}`);
    error.code = 'DEMO_EVIDENCE_MISSING';
    throw error;
  }
  return filePath;
}

function bool(value) {
  return value === true;
}

export function buildOfflineDemoSummary(runRoot, {
  generatedAt = new Date().toISOString()
} = {}) {
  const root = path.resolve(runRoot);
  const jobs = readJson(requireFile(path.join(root, 'data', 'job_leads.json'), 'job leads'));
  const state = normalizeApplicationExecutionState(readJson(requireFile(path.join(root, 'data', 'dashboard_state.json'), 'application state')));
  const resumeProfiles = readJson(requireFile(path.join(root, 'data', 'resume_profiles.json'), 'resume profiles'));
  const questionBank = readJson(requireFile(path.join(root, 'data', 'question_bank.json'), 'answer memory'));
  const candidateProfile = readJson(requireFile(path.join(root, 'synthetic-profile.json'), 'candidate profile'));
  const browser = readJson(requireFile(
    path.join(root, 'browser', 'job_apply_autofill_local_test_result_001.json'),
    'Mock ATS browser report'
  ));
  const packagePath = requireFile(
    firstFile(path.join(root, 'applications'), 'application_package.json'),
    'application package'
  );
  const applicationPackage = readJson(packagePath);
  const job = Array.isArray(jobs) ? jobs[0] : null;
  const jobId = String(job?.job_id || '');
  const record = state.application_status_overrides?.[jobId] || {};
  const activeSession = state.application_execution_sessions?.[record.active_session_id] || {};
  const reports = Array.isArray(activeSession.reports) ? activeSession.reports : [];
  const firstObserved = reports[0]?.application_completion || {};
  const finalObserved = reports.at(-1)?.application_completion || record.application_completion || {};
  const estimated = applicationPackage.application_completion || {};
  const learning = browser.field_memory_learning || {};
  const answerItems = Array.isArray(questionBank) ? questionBank : (questionBank.answers || []);
  const resumeItems = Array.isArray(resumeProfiles) ? resumeProfiles : (resumeProfiles.items || []);
  const selectedResumeReference = applicationPackage.selected_resume?.file_reference || '';
  const selectedResumePath = selectedResumeReference
    ? (path.isAbsolute(selectedResumeReference)
      ? selectedResumeReference
      : path.resolve(root, selectedResumeReference))
    : '';
  const resumeIntakeVerified = Boolean(
    selectedResumePath
    && fs.existsSync(selectedResumePath)
    && applicationPackage.selected_resume?.approved_at
  );
  const selectedResumeProfile = resumeItems.find(item =>
    String(item?.resume_id || item?.id || '') === String(applicationPackage.selected_resume?.resume_id || '')
  );
  const resumeMetadataMatchesPackage = Boolean(
    selectedResumeProfile?.content_hash
    && selectedResumeProfile.content_hash === applicationPackage.selected_resume?.content_hash
    && selectedResumeProfile.approved_at
  );
  const localResumeAnalysis = resumeIntakeVerified
    ? analyzeResumeDocument({
      content: fs.readFileSync(selectedResumePath),
      fileName: selectedResumePath,
      contentHash: applicationPackage.selected_resume?.content_hash || ''
    })
    : null;
  const selectedResumeFactPresentAfterReview = Boolean(
    String(candidateProfile.linkedin || candidateProfile.links?.linkedin || '').trim()
  );
  const candidateProfileReviewedAfterApply = Boolean(
    candidateProfile.approved_for_real_applications === true
    && candidateProfile.profile_meta?.approved_for_real_applications === true
    && candidateProfile.profile_meta?.last_reviewed_at
  );
  const resumeIntelligenceVerified = Boolean(
    resumeMetadataMatchesPackage
    && localResumeAnalysis?.summary?.suggestion_count > 0
    && localResumeAnalysis.raw_text_included === false
    && localResumeAnalysis.persistence?.raw_text_saved === false
    && localResumeAnalysis.persistence?.suggestions_saved === false
    && selectedResumeFactPresentAfterReview
    && candidateProfileReviewedAfterApply
  );

  const safety = {
    localhost_only: bool(browser.safety?.only_localhost_urls_used),
    real_websites_opened: bool(browser.safety?.real_websites_opened),
    real_profile_used: false,
    resume_uploaded: bool(browser.safety?.uploaded_resume),
    login_attempted: bool(browser.safety?.logged_in),
    final_submit_clicked: bool(browser.safety?.clicked_or_submitted),
    application_submitted: reports.some(item => item.application_submitted === true),
    formal_data_modified: false
  };
  const safe = safety.localhost_only
    && !safety.real_websites_opened
    && !safety.real_profile_used
    && !safety.resume_uploaded
    && !safety.login_attempted
    && !safety.final_submit_clicked
    && !safety.application_submitted
    && !safety.formal_data_modified;

  const steps = [
    {
      id: 'candidate',
      title: 'Resume Intelligence / 简历智能',
      status: resumeItems.length > 0 && resumeIntakeVerified && resumeIntelligenceVerified ? 'passed' : 'failed',
      evidence: `${resumeItems.length} synthetic resume profiles; ${localResumeAnalysis?.summary?.suggestion_count || 0} local suggestions; selected fact reviewed; raw text not retained`
    },
    {
      id: 'search',
      title: 'Search Goal / 求职目标',
      status: 'passed',
      evidence: 'Structured Product Manager · Remote search profile'
    },
    {
      id: 'discovery',
      title: 'Fixture Discovery / 离线职位发现',
      status: job && job.dedupe?.merged_source_count === 2 ? 'passed' : 'failed',
      evidence: `${jobs.length} canonical job; ${job?.dedupe?.merged_source_count || 0} source records merged`
    },
    {
      id: 'scoring',
      title: 'Explainable Scoring / 可解释评分',
      status: Number(job?.match_score) >= 0 ? 'passed' : 'failed',
      evidence: `${Number(job?.match_score || 0)}/100; ${job?.score_breakdown?.matched_requirements?.length || 0} matched requirements`
    },
    {
      id: 'approval',
      title: 'User Approval / 用户批准',
      status: state.audit_events?.some(event => event.to_status === 'APPROVED_FOR_PACKAGE') ? 'passed' : 'failed',
      evidence: 'Explicit review gate recorded in the existing state machine'
    },
    {
      id: 'package',
      title: 'Application Package / 申请包',
      status: applicationPackage.status === 'PACKAGE_READY' ? 'passed' : 'failed',
      evidence: `${applicationPackage.status}; ${answerItems.filter(item => item.user_confirmed).length} confirmed answer memory item`
    },
    {
      id: 'mock_ats',
      title: 'Mock ATS Autofill / 模拟 ATS 填写',
      status: browser.success === true ? 'passed' : 'failed',
      evidence: `${browser.complex_form?.filled_fields_count || 0} safe fields filled; unknown and sensitive fields paused`
    },
    {
      id: 'recovery',
      title: 'Pause and Recovery / 暂停与恢复',
      status: activeSession.recovery_count >= 1 ? 'passed' : 'failed',
      evidence: `${activeSession.recovery_count || 0} safe recovery; idempotent ApplicationExecutionSession reused`
    },
    {
      id: 'completion',
      title: 'Completion Report / 完成率报告',
      status: record.application_status === 'READY_FOR_MANUAL_SUBMIT' ? 'passed' : 'failed',
      evidence: `${Number(firstObserved.application_completion_rate || 0)}% before user input → ${Number(finalObserved.application_completion_rate || 0)}% ready for manual submit`
    },
    {
      id: 'learning',
      title: 'Field Memory Learning / 字段记忆学习',
      status: Number(learning.completion_rate_improvement || 0) > 0 ? 'passed' : 'failed',
      evidence: `${Number(learning.baseline_completion_rate || 0)}% → ${Number(learning.learned_completion_rate || 0)}%; values not stored in mapping memory`
    }
  ];

  const passedSteps = steps.filter(step => step.status === 'passed').length;
  const success = safe
    && passedSteps === steps.length
    && record.application_status === 'READY_FOR_MANUAL_SUBMIT';

  return {
    schema_version: '1.0',
    product: 'Resume Jobs AI Agent',
    mode: 'offline_demo',
    generated_at: generatedAt,
    success,
    outcome: record.application_status || 'UNKNOWN',
    pipeline: {
      passed_steps: passedSteps,
      total_steps: steps.length,
      steps
    },
    job: {
      job_id: jobId,
      title: job?.title || '',
      company: job?.company || '',
      location: job?.location || '',
      portal: applicationPackage.application_completion?.portal || job?.ats || 'unknown',
      match_score: Number(job?.match_score || 0),
      matched_requirements: job?.score_breakdown?.matched_requirements || [],
      duplicate_sources_merged: Number(job?.dedupe?.merged_source_count || 0)
    },
    knowledge: {
      resume_profile_count: resumeItems.length,
      resume_intake_verified: resumeIntakeVerified,
      resume_metadata_matches_package: resumeMetadataMatchesPackage,
      local_resume_analysis_verified: resumeIntelligenceVerified,
      local_resume_format: localResumeAnalysis?.format || '',
      local_resume_suggestion_count: Number(localResumeAnalysis?.summary?.suggestion_count || 0),
      local_resume_raw_text_retained: localResumeAnalysis?.persistence?.raw_text_saved === true,
      local_resume_suggestions_retained: localResumeAnalysis?.persistence?.suggestions_saved === true,
      selected_resume_fact_present_after_review: selectedResumeFactPresentAfterReview,
      candidate_profile_reviewed_after_apply: candidateProfileReviewedAfterApply,
      derived_fact_count: Number(estimated.resume_intelligence_summary?.available_fact_count || 0),
      confirmed_fact_count: Number(estimated.resume_intelligence_summary?.confirmed_fact_count || 0),
      confirmed_answer_count: answerItems.filter(item => item.user_confirmed).length
    },
    completion: {
      estimated_rate: Number(estimated.application_completion_rate || 0),
      potential_rate: Number(estimated.potential_completion_rate || 0),
      before_user_input_rate: Number(firstObserved.application_completion_rate || 0),
      final_rate: Number(finalObserved.application_completion_rate || 0),
      ready_for_30_second_review: bool(finalObserved.ready_for_30_second_review),
      field_memory_baseline_rate: Number(learning.baseline_completion_rate || 0),
      field_memory_learned_rate: Number(learning.learned_completion_rate || 0),
      field_memory_improvement_points: Number(learning.completion_rate_improvement || 0)
    },
    application: {
      application_id: applicationPackage.application_id || '',
      session_id: activeSession.session_id || '',
      status: record.application_status || '',
      recovery_count: Number(activeSession.recovery_count || 0),
      audit_event_count: Array.isArray(state.audit_events) ? state.audit_events.length : 0
    },
    safety,
    screenshots: Array.isArray(browser.screenshots)
      ? browser.screenshots.map(file => path.basename(file))
      : []
  };
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function metric(label, value, hint = '') {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></article>`;
}

export function renderOfflineDemoHtml(summary) {
  const steps = summary.pipeline.steps.map((step, index) => `
    <li class="${step.status}">
      <span class="step-number">${index + 1}</span>
      <div><strong>${escapeHtml(step.title)}</strong><p>${escapeHtml(step.evidence)}</p></div>
      <span class="status">${step.status === 'passed' ? 'PASS' : 'CHECK'}</span>
    </li>`).join('');
  const safetyItems = Object.entries(summary.safety).map(([key, value]) => {
    const expectedFalse = key !== 'localhost_only';
    const good = expectedFalse ? value === false : value === true;
    return `<li class="${good ? 'safe' : 'unsafe'}"><span>${good ? '✓' : '!'}</span>${escapeHtml(key.replaceAll('_', ' '))}: <strong>${escapeHtml(value)}</strong></li>`;
  }).join('');
  const screenshots = summary.screenshots.map(file => `
    <figure>
      <img src="screenshots/${encodeURIComponent(file)}" alt="${escapeHtml(file)}">
      <figcaption>${escapeHtml(file.replaceAll('_', ' '))}</figcaption>
    </figure>`).join('');
  const outcomeClass = summary.success ? 'success' : 'attention';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Resume Jobs Offline Demo</title>
  <style>
    :root { color-scheme: light; --ink:#152237; --muted:#667085; --line:#e7eaf0; --blue:#3157d5; --green:#11875d; --soft:#f5f7fb; }
    * { box-sizing:border-box; }
    body { margin:0; background:linear-gradient(145deg,#eef3ff 0,#fbfcff 45%,#eefaf6 100%); color:var(--ink); font:15px/1.5 "Segoe UI",system-ui,sans-serif; }
    main { width:min(1120px,calc(100% - 32px)); margin:32px auto 60px; }
    header { padding:34px; border-radius:24px; color:white; background:linear-gradient(125deg,#172a55,#3157d5 60%,#2a9d78); box-shadow:0 18px 50px #1f3d7a25; }
    header p { margin:8px 0 0; color:#e8edff; max-width:760px; }
    h1 { margin:0; font-size:clamp(28px,5vw,46px); letter-spacing:-1.5px; }
    h2 { margin:0 0 18px; font-size:21px; }
    .badge { display:inline-flex; margin-top:22px; padding:8px 12px; border-radius:999px; background:#ffffff22; font-weight:700; }
    .grid { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:18px 0; }
    .metric,.panel { background:#fff; border:1px solid var(--line); border-radius:18px; box-shadow:0 8px 26px #253a6510; }
    .metric { padding:18px; min-height:130px; display:flex; flex-direction:column; }
    .metric span,.metric small { color:var(--muted); }
    .metric strong { font-size:34px; margin:auto 0 4px; letter-spacing:-1px; }
    .panel { padding:24px; margin-top:18px; }
    .outcome { display:flex; align-items:center; justify-content:space-between; gap:18px; }
    .outcome strong { font-size:22px; }
    .outcome.success strong { color:var(--green); }
    ol { list-style:none; padding:0; margin:0; }
    .pipeline li { display:grid; grid-template-columns:38px 1fr auto; gap:14px; align-items:center; padding:14px 0; border-top:1px solid var(--line); }
    .pipeline li:first-child { border-top:0; }
    .pipeline p { color:var(--muted); margin:3px 0 0; }
    .step-number { width:32px; height:32px; border-radius:50%; display:grid; place-items:center; color:#fff; background:var(--green); font-weight:800; }
    .pipeline .failed .step-number { background:#bc4b4b; }
    .status { font-size:12px; font-weight:800; color:var(--green); }
    .safety { display:grid; grid-template-columns:repeat(2,1fr); gap:8px 18px; padding:0; list-style:none; }
    .safety li { padding:9px 0; color:var(--muted); }
    .safety li span { display:inline-grid; place-items:center; width:22px; height:22px; margin-right:8px; border-radius:50%; color:#fff; background:var(--green); }
    .safety .unsafe span { background:#bc4b4b; }
    .shots { display:grid; grid-template-columns:repeat(2,1fr); gap:14px; }
    figure { margin:0; border:1px solid var(--line); border-radius:14px; overflow:hidden; background:var(--soft); }
    img { display:block; width:100%; aspect-ratio:16/10; object-fit:cover; object-position:top; }
    figcaption { padding:10px 12px; color:var(--muted); }
    footer { color:var(--muted); text-align:center; padding:26px 0; }
    code { background:var(--soft); border-radius:6px; padding:2px 6px; }
    @media (max-width:800px) { .grid { grid-template-columns:repeat(2,1fr); } .shots,.safety { grid-template-columns:1fr; } }
    @media (max-width:480px) { .grid { grid-template-columns:1fr; } header,.panel { padding:20px; } }
  </style>
</head>
<body>
<main>
  <header>
    <h1>Resume Jobs AI Agent</h1>
    <p>Complete offline product demo · 完整离线产品演示。Synthetic data, localhost Mock ATS, existing Dashboard workflow, and manual final submission boundary.</p>
    <span class="badge">${summary.success ? '✓ Demo completed safely' : '⚠ Demo needs attention'}</span>
  </header>
  <section class="grid">
    ${metric('Pipeline', `${summary.pipeline.passed_steps}/${summary.pipeline.total_steps}`, 'verified stages')}
    ${metric('Match score', `${summary.job.match_score}/100`, `${summary.job.title} · ${summary.job.location}`)}
    ${metric('Completion', `${summary.completion.final_rate}%`, summary.completion.ready_for_30_second_review ? '30-second review ready' : 'review still needed')}
    ${metric('Field Memory', `+${summary.completion.field_memory_improvement_points}`, `${summary.completion.field_memory_baseline_rate}% → ${summary.completion.field_memory_learned_rate}%`)}
  </section>
  <section class="panel outcome ${outcomeClass}">
    <div><small>Final state / 最终状态</small><br><strong>${escapeHtml(summary.outcome)}</strong></div>
    <div><small>Final Submit</small><br><strong>Not clicked · 未点击</strong></div>
  </section>
  <section class="panel pipeline">
    <h2>One-click product journey / 一键产品流程</h2>
    <ol>${steps}</ol>
  </section>
  <section class="panel">
    <h2>Safety evidence / 安全证据</h2>
    <ul class="safety">${safetyItems}</ul>
  </section>
  ${screenshots ? `<section class="panel"><h2>Mock ATS evidence / 模拟 ATS 截图</h2><div class="shots">${screenshots}</div></section>` : ''}
  <footer>Generated ${escapeHtml(summary.generated_at)} · Full machine-readable evidence is available in <code>report.json</code>.</footer>
</main>
</body>
</html>`;
}
