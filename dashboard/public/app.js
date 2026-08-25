// Resume Jobs product Dashboard

let allJobs = [];
let filteredJobs = [];
const JOB_PAGE_SIZE = 5;
let visibleJobLimit = JOB_PAGE_SIZE;
let jobInventoryMode = 'current';
let careerBrainEditMode = false;
let isRunning = false;
let settingsData = null;
let settingsDirty = false;
let providerHealthData = null;
let activeView = 'career-brain';
let selectedJobIds = new Set();
let workflowData = { maximum_jobs_to_open: 0, selected_job_ids: [] };
const fillIdempotencyKeys = new Map();
const recoveryIdempotencyKeys = new Map();
let packageReviewJobId = '';
let executorStatusTimer = null;
let extensionDiagnosticsTimer = null;
let latestExtensionDiagnostics = null;
let latestExecutorStatus = null;
let extensionPageBridge = { observed: false, version: '', nonce: '' };
const resumeAnalysisById = new Map();
let currentUxStep = { number: 1, view: 'resume', action: 'Upload resume' };
let unlockedViews = new Set(['career-brain', 'ai-settings', 'interview-preparation']);
let dashboardEventSource = null;
let dashboardPollingTimer = null;
let reactiveRefreshTimer = null;
let pendingReactiveEvent = null;
let localMutationPending = false;
const UI_CONTEXT_KEY = 'resume_jobs_ui_context_v1';
const PACKAGE_RETURN_CONTEXT_KEY = 'resume_jobs_package_return_context_v1';
const UI_FILTER_IDS = Object.freeze([
  'filterApprovalStatus', 'filterApplicationStatus', 'filterProvider', 'filterPageType',
  'filterScore', 'sortJobs', 'filterLocation', 'filterText'
]);
let packagePanelReturnContext = null;
let uiContextSaveTimer = null;

function readStoredUiContext() {
  try {
    const value = JSON.parse(sessionStorage.getItem(UI_CONTEXT_KEY) || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function readStoredPackageReturnContext() {
  try {
    const value = JSON.parse(sessionStorage.getItem(PACKAGE_RETURN_CONTEXT_KEY) || 'null');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function persistPackageReturnContext(context) {
  try {
    if (context) sessionStorage.setItem(PACKAGE_RETURN_CONTEXT_KEY, JSON.stringify(context));
    else sessionStorage.removeItem(PACKAGE_RETURN_CONTEXT_KEY);
  } catch {
    // Return navigation remains available for the current page when storage is unavailable.
  }
}

function focusedControlToken() {
  const control = document.activeElement;
  if (!control || control === document.body) return null;
  if (control.id) return { type: 'id', id: control.id };
  const card = control.closest?.('[data-job-id]');
  if (!card) return null;
  return {
    type: 'job_control',
    job_id: String(card.dataset.jobId || ''),
    tag: control.tagName?.toLowerCase() || '',
    label: String(control.textContent || control.getAttribute?.('aria-label') || '').trim().slice(0, 120)
  };
}

function expandedJobDetails() {
  return [...document.querySelectorAll('#jobsTableBody [data-job-id]')].flatMap(card =>
    [...card.querySelectorAll('details')].map((details, index) => details.open
      ? { job_id: String(card.dataset.jobId || ''), index }
      : null).filter(Boolean)
  );
}

function captureUiContext() {
  return {
    version: 1,
    active_view: activeView,
    selected_job_id: packageReviewJobId || '',
    package_panel_open: Boolean(packageReviewJobId && !$('packageReviewPanel')?.classList.contains('hidden')),
    executor_type: $('applicationExecutorMode')?.value || '',
    inventory_mode: jobInventoryMode,
    visible_job_limit: visibleJobLimit,
    filters: Object.fromEntries(UI_FILTER_IDS.map(id => [id, $(id)?.value ?? ''])),
    expanded_job_details: expandedJobDetails(),
    scroll_y: Math.max(0, Math.round(window.scrollY || 0)),
    focus: focusedControlToken()
  };
}

function persistUiContext(context = captureUiContext()) {
  try { sessionStorage.setItem(UI_CONTEXT_KEY, JSON.stringify(context)); } catch {
    // UI state persistence is best-effort and never changes product data.
  }
}

function scheduleUiContextPersistence() {
  if (uiContextSaveTimer) clearTimeout(uiContextSaveTimer);
  uiContextSaveTimer = setTimeout(() => {
    uiContextSaveTimer = null;
    persistUiContext();
  }, 100);
}

function restoreExpandedJobDetails(items = []) {
  for (const item of Array.isArray(items) ? items : []) {
    const card = document.querySelector(`[data-job-id="${CSS.escape(String(item?.job_id || ''))}"]`);
    const details = card?.querySelectorAll('details')?.[Number(item?.index)];
    if (details) details.open = true;
  }
}

function restoreFocusedControl(token) {
  if (!token) return;
  let control = null;
  if (token.type === 'id' && token.id) control = document.getElementById(token.id);
  if (!control && token.type === 'job_control' && token.job_id) {
    const card = document.querySelector(`[data-job-id="${CSS.escape(String(token.job_id))}"]`);
    control = [...(card?.querySelectorAll('button, input, select, textarea, a') || [])]
      .find(item => item.tagName.toLowerCase() === token.tag
        && String(item.textContent || item.getAttribute('aria-label') || '').trim().slice(0, 120) === token.label);
  }
  if (control && !control.disabled) control.focus({ preventScroll: true });
}

async function restoreUiContext(context, { restorePanel = false } = {}) {
  if (!context || typeof context !== 'object') return;
  jobInventoryMode = String(context.inventory_mode || jobInventoryMode);
  visibleJobLimit = Math.max(JOB_PAGE_SIZE, Number(context.visible_job_limit || JOB_PAGE_SIZE));
  for (const id of UI_FILTER_IDS) {
    const control = $(id);
    const value = context.filters?.[id];
    if (!control || value === undefined) continue;
    if (control.tagName === 'SELECT' && ![...control.options].some(option => option.value === value)) continue;
    control.value = value;
  }
  applyFilters();
  const requestedView = String(context.active_view || 'career-brain');
  switchView(unlockedViews.has(requestedView) ? requestedView : 'career-brain', {
    preserveScroll: true,
    persist: false
  });
  if (context.executor_type && $('applicationExecutorMode')) $('applicationExecutorMode').value = context.executor_type;
  if (restorePanel && context.package_panel_open && context.selected_job_id) {
    packagePanelReturnContext = readStoredPackageReturnContext();
    await reviewApplicationPackage(context.selected_job_id, { navigate: false, rememberReturn: false });
  }
  restoreExpandedJobDetails(context.expanded_job_details);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  window.scrollTo({ top: Math.max(0, Number(context.scroll_y || 0)), behavior: 'auto' });
  restoreFocusedControl(context.focus);
  persistUiContext();
}

function jobLifecycleStatus(job = {}) {
  if (job.lifecycle_status) return String(job.lifecycle_status).toLowerCase();
  const app = String(job.application_status || '').toUpperCase();
  if (['MANUALLY_SUBMITTED', 'SUBMITTED_MANUALLY', 'INTERVIEW'].includes(app)) return 'applied';
  if (app === 'MANUAL_ONLY') return 'manual_only';
  if (app === 'UNSUPPORTED') return 'unsupported';
  if (app === 'SAVED') return 'saved';
  if (app === 'REJECTED') return 'rejected';
  if (['APPROVED_FOR_PACKAGE', 'PACKAGE_READY', 'FILL_APPROVED', 'EXECUTOR_READY', 'EXECUTING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT'].includes(app)) return 'approved';
  const decision = String(job.approval_status || 'pending').toLowerCase();
  if (decision === 'approved') return 'approved';
  if (decision === 'rejected') return 'rejected';
  if (decision === 'manual_review') return 'saved';
  return 'new';
}

function jobDisplayScore(job = {}) {
  return Number(job.match_scores?.combined_score ?? job.hybrid_match?.score ?? job.match_score ?? 0);
}

function jobScoreMethodLabel(job = {}) {
  const method = job.match_scores?.score_method
    || (job.hybrid_match?.semantic?.model_used === true ? 'hybrid' : 'deterministic');
  return method === 'hybrid' ? 'AI + rules score' : 'Rules-based score';
}

function hasApplicationWorkflow(job = {}) {
  return [
    'APPROVED_FOR_PACKAGE', 'PACKAGE_READY', 'FILL_APPROVED', 'EXECUTOR_READY',
    'EXECUTING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT', 'MANUALLY_SUBMITTED',
    'RECOVERY_REQUIRED', 'CANCELLED'
  ].includes(String(job.application_status || '').toUpperCase());
}

function isRecommendedJob(job = {}) {
  const recommendation = String(job.hybrid_match?.recommended_action || job.hybrid_match?.recommendation || '').toLowerCase();
  return job.page_type === 'job_detail'
    && jobLifecycleStatus(job) !== 'rejected'
    && !recommendation.includes('do not apply')
    && (recommendation.includes('apply') || recommendation.includes('consider') || jobDisplayScore(job) >= 70);
}

function jobDiscoveryStatus(job = {}) {
  const status = String(job.discovery_status || job.discovery_memory?.status || '').toLowerCase();
  if (status === 'new') return 'new';
  if (status === 'previously_seen' || Number(job.times_seen || job.discovery_memory?.times_seen || 1) > 1) return 'previously_seen';
  return 'new';
}

function jobFreshnessScore(job = {}) {
  const newBonus = jobDiscoveryStatus(job) === 'new' ? 1_000_000_000_000_000 : 0;
  const postedAt = Date.parse(job.posted_date || job.posted_at || '');
  const seenAt = Date.parse(job.last_seen || job.last_seen_at || job.first_seen || job.first_seen_at || '');
  return newBonus + (Number.isFinite(postedAt) ? postedAt : 0) + (Number.isFinite(seenAt) ? Math.round(seenAt / 10) : 0) + jobDisplayScore(job);
}

function jobApprovalBlockerText(job = {}) {
  const blockers = Array.isArray(job.approval_blockers) ? job.approval_blockers.filter(Boolean) : [];
  return blockers.join(' ') || job.approval_warning || 'This job is not yet a confirmed, safety-eligible job detail page.';
}

function jobApprovalWarningText(job = {}) {
  const warnings = Array.isArray(job.approval_warnings) ? job.approval_warnings : [];
  const labels = warnings.map(reason => {
    if (['target_role_not_matched', 'target_role_not_matched_in_title', 'role_title_differs_continue_after_review'].includes(reason)) {
      return 'Role title differs from your target. Continue anyway after reviewing the job.';
    }
    if (String(reason).startsWith('recommendation_')) return `Recommendation is ${humanizeToken(String(reason).replace('recommendation_', ''))}; you can continue after review.`;
    return humanizeToken(reason);
  });
  return [...new Set(labels.filter(Boolean))].join(' ');
}

function formatTransitionBlocker(error, actionLabel = 'Action') {
  const details = error?.details || {};
  const blockers = [
    ...(Array.isArray(details.blockers) ? details.blockers : []),
    ...(Array.isArray(details.failures) ? details.failures : []),
    ...(Array.isArray(details.details?.failures) ? details.details.failures : []),
    ...(Array.isArray(details.approval_safety?.reasons) ? details.approval_safety.reasons : [])
  ].map(item => item && typeof item === 'object'
    ? `${item.missing || 'Requirement'}: ${item.message || humanizeToken(item.code || 'blocked')}`
    : humanizeToken(String(item))).filter(Boolean);
  const transition = details.from_status && details.to_status
    ? `Current step: ${applicationStatusLabel(details.from_status)} → ${applicationStatusLabel(details.to_status)}.`
    : '';
  const next = details.next_action ? `Next: ${typeof details.next_action === 'string' ? details.next_action : details.next_action.label}.` : '';
  return [...new Set([details.message || error?.message || `${actionLabel} failed.`, ...blockers, transition, next].filter(Boolean))].join(' ');
}

function showJobWorkflowNotice(type, message) {
  const box = $('jobWorkflowNotice');
  if (!box) return;
  box.className = `settings-status ${type}`;
  box.textContent = message;
  if (type === 'ok') showProductToast('ok', message);
}

function showJobBlocker(jobId) {
  const job = allJobs.find(item => String(item.job_id) === String(jobId));
  if (!job) return showJobWorkflowNotice('error', 'This job is no longer available. Refresh Job Matches and try again.');
  showJobWorkflowNotice('warning', `Approval blocked: ${jobApprovalBlockerText(job)} Save it for review, reject it, or correct the source record before retrying.`);
}

function jobStartRequirementText(job, selected) {
  if (job?.active_session_id && job?.application_status !== 'FILL_APPROVED' && job?.application_status !== 'NEEDS_REVIEW') return 'An AI Fill attempt already exists. Open Review Package to continue.';
  if (!(job?.package_path || job?.package_status === 'preview_created')) return 'Missing: Application Package. Build the package first.';
  if (!job?.fill_approved_at) return 'Missing: AI Fill approval. Review the package and approve safe field fill.';
  if (!selected) return 'Missing: Selected job. Include this approved job in the application batch.';
  return 'Open Review Package for the exact synchronization blocker.';
}

const $ = id => document.getElementById(id);
let productModalResolver = null;
let productModalPreviousFocus = null;

function closeProductModal(accepted) {
  const backdrop = $('productModalBackdrop');
  if (!backdrop || backdrop.classList.contains('hidden')) return;
  backdrop.classList.add('hidden');
  $('productConfirmationModal')?.classList.remove('danger');
  const resolver = productModalResolver;
  productModalResolver = null;
  resolver?.(accepted === true);
  productModalPreviousFocus?.focus?.();
  productModalPreviousFocus = null;
}

function confirmProductAction({
  title = 'Confirm action',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'warning'
} = {}) {
  if (productModalResolver) closeProductModal(false);
  productModalPreviousFocus = document.activeElement;
  $('productModalTitle').textContent = title;
  $('productModalMessage').textContent = message;
  $('productModalConfirmBtn').textContent = confirmLabel;
  $('productModalCancelBtn').textContent = cancelLabel;
  $('productConfirmationModal').classList.toggle('danger', tone === 'danger');
  $('productModalBackdrop').classList.remove('hidden');
  $('productModalCancelBtn').focus();
  return new Promise(resolve => {
    productModalResolver = resolve;
  });
}

function showProductToast(type, message) {
  const region = $('productToastRegion');
  if (!region || !message) return;
  const toast = document.createElement('div');
  toast.className = `product-toast ${type || 'ok'}`;
  toast.textContent = `${type === 'ok' ? '✓ ' : ''}${message}`;
  region.appendChild(toast);
  setTimeout(() => toast.remove(), 3600);
}

function showApplicationHandoffFallback(url) {
  const status = $('runStatus');
  if (!status) return;
  showRunStatus('warning', 'Fill started, but the browser blocked the new tab.');
  const action = document.createElement('a');
  action.className = 'btn-primary handoff-link';
  action.href = url;
  action.target = '_blank';
  action.rel = 'noopener noreferrer';
  action.textContent = 'Open Application';
  status.appendChild(document.createTextNode(' '));
  status.appendChild(action);
}

async function fetchJSON(url, options = {}) {
  const method = options.method || 'GET';
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  const text = await res.text();
  let data = {};
  let responseWasReadable = true;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    responseWasReadable = false;
    data = {};
  }
  if (!res.ok) {
    const apiPath = data.path || url;
    const apiMethod = data.method || method;
    const detail = typeof data.message === 'string' && data.message.trim()
      ? data.message.trim()
      : responseWasReadable
        ? 'The action could not be completed. Review the requirements and try again.'
        : 'The Dashboard returned an unreadable response. Reload the page and try again.';
    const error = new Error(detail);
    error.code = data.code || '';
    error.httpStatus = res.status;
    error.details = { ...data, http_status: res.status, path: apiPath, method: apiMethod };
    throw error;
  }
  return data;
}

function executionBlockerText(blockers, fallback = 'No blocker reported.') {
  const items = Array.isArray(blockers) ? blockers.filter(Boolean) : [];
  if (!items.length) return fallback;
  return items.map(item => `${item.missing || 'Requirement'}: ${item.message || humanizeToken(item.code || 'blocked')}`).join(' ');
}

async function loadSummary() {
  const data = await fetchJSON('/api/summary');
  $('jobLeadsCount').textContent = data.job_leads_count ?? 0;
  $('shortlistCount').textContent = data.jobs_shortlist_count ?? 0;
  $('pendingCount').textContent = data.pending_count ?? 0;
  $('approvedCount').textContent = data.approved_count ?? 0;
  $('rejectedCount').textContent = data.rejected_count ?? 0;
  $('reviewCount').textContent = data.manual_review_count ?? 0;
  const completion = data.application_completion || {};
  $('completionRate').textContent = completion.average_completion_rate !== null
    && completion.average_completion_rate !== undefined
    && Number.isFinite(Number(completion.average_completion_rate))
    ? `${Number(completion.average_completion_rate)}%`
    : '—';
  $('completionMeasured').textContent = completion.approved_jobs_measured
    ? `${completion.approved_jobs_measured} of ${completion.approved_jobs_total || completion.approved_jobs_measured} approved jobs measured`
    : 'No approved applications measured';
  $('completionReviewCount').textContent = Number(completion.fields_requiring_user_review || 0);
  const insights = completion.insights || {};
  $('completionNextAction').textContent = insights.next_best_action?.message
    || 'Build an Application Package to see the highest-value fact or mapping to confirm next.';
  const blockers = Array.isArray(insights.top_blockers) ? insights.top_blockers : [];
  $('completionBlockersList').innerHTML = blockers.length
    ? blockers.map(blocker =>
      `<li><strong>${escapeHtml(display(blocker.field_key))}</strong> — ${escapeHtml(display(blocker.status))} (${Number(blocker.count || 0)})</li>`
    ).join('')
    : '<li>No repeated blockers in measured applications.</li>';
  setRunning(Boolean(data.running_job), data.running_job);
  updateUxState();
}

async function loadJobs() {
  allJobs = await fetchJSON('/api/jobs');
  selectedJobIds = new Set(allJobs.filter(job => job.selected_for_fill).map(job => String(job.job_id)));
  for (const jobId of fillIdempotencyKeys.keys()) {
    const job = allJobs.find(item => String(item.job_id) === jobId);
    if (!job || job.application_status !== 'EXECUTING') fillIdempotencyKeys.delete(jobId);
  }
  populateDynamicFilters();
  applyFilters();
  updateUxState();
}

async function loadWorkflow() {
  workflowData = await fetchJSON('/api/workflow');
  selectedJobIds = new Set((workflowData.selected_job_ids || []).map(String));
}

async function loadProviderHealth() {
  try {
    const data = await fetchJSON('/api/provider-health');
    providerHealthData = data;
    const container = $('providerHealthContainer');
    container.innerHTML = '';
    const providers = Array.isArray(data.providers) ? data.providers : [];
    if (!providers.length) container.innerHTML = '<p class="empty">No Job Search provider is registered.</p>';
    providers.forEach(provider => {
      const card = document.createElement('div');
      card.className = 'health-card';
      card.innerHTML = `
        <div class="health-provider">${escapeHtml(provider.name || provider.id)}</div>
        <div class="health-stats">
          <span class="provider-state state-${escapeAttr(String(provider.status || 'ERROR').toLowerCase())}">${escapeHtml(provider.status || 'ERROR')}</span>
          <span>${provider.enabled ? 'Enabled' : 'Disabled'}</span>
          <span>Last check: ${escapeHtml(provider.last_health_check || 'Never')}</span>
        </div>
        ${provider.last_error ? `<p class="error">${escapeHtml(provider.last_error)}</p>` : ''}
      `;
      container.appendChild(card);
    });
    const ai = data.ai_enrichment || {};
    const aiCard = document.createElement('div');
    aiCard.className = 'health-card';
    aiCard.innerHTML = `
      <div class="health-provider">Optional AI enrichment</div>
      <div class="health-stats"><span class="provider-state">${escapeHtml(ai.status || 'DISABLED')}</span></div>
      <p>${escapeHtml(ai.message || 'AI is optional and does not block Live Search.')}</p>`;
    container.appendChild(aiCard);
    updateProviderSetupGuide(data);
    if (settingsData) {
      settingsData.ai_provider = data.ai_enrichment || settingsData.ai_provider;
      settingsData.job_search_sources = {
        ...(settingsData.job_search_sources || {}),
        providers,
        ai_enrichment: data.ai_enrichment,
        offline_demo: data.offline_demo,
        downstream_adapters: data.downstream_adapters
      };
      renderJobSearchSources();
      renderAIProvider();
      renderSafetySettings();
    }
  } catch (err) {
    $('providerHealthContainer').innerHTML = '<p class="error">Provider status is unavailable. Check Settings and try again.</p>';
  }
}

function updateProviderSetupGuide(data = providerHealthData) {
  const provider = data?.providers?.find(item => item.id === 'searxng_search');
  $('providerSetupGuide')?.classList.toggle('hidden', provider?.status === 'READY' && provider?.enabled === true);
}

async function loadDailyAutomationStatus() {
  const badge = $('automationStatusBadge');
  const container = $('automationStatusContainer');
  try {
    const data = await fetchJSON('/api/daily-automation/latest');
    const status = data.status || 'unknown';
    badge.textContent = status;
    badge.className = `status-badge status-${escapeAttr(status === 'completed' ? 'approved' : status === 'blocked' || status === 'failed' ? 'rejected' : 'pending')}`;
    const counts = data.counts_after || {};
    const deltas = data.deltas || {};
    container.innerHTML = `
      <div class="automation-card"><div class="label">Last Run</div><div class="value">${escapeHtml(data.date || 'No report yet')}</div></div>
      <div class="automation-card"><div class="label">Report</div><div class="value">${escapeHtml(data.report_path || '—')}</div></div>
      <div class="automation-card"><div class="label">SearXNG</div><div class="value">${escapeHtml(data.searxng?.ok ? 'ok' : 'not ok / unknown')}</div></div>
      <div class="automation-card"><div class="label">New Leads</div><div class="value">${escapeHtml(display(deltas.new_job_leads))}</div></div>
      <div class="automation-card"><div class="label">Shortlist Count</div><div class="value">${escapeHtml(display(counts.jobs_shortlist))}</div></div>
      <div class="automation-card"><div class="label">Blocker</div><div class="value">${escapeHtml(data.blocked_reason || 'none')}</div></div>
    `;
  } catch (err) {
    badge.textContent = 'error';
    badge.className = 'status-badge status-rejected';
    container.innerHTML = '<p class="error">Latest automation status is unavailable. You can continue with Job Discovery manually.</p>';
  }
}

function populateDynamicFilters() {
  populateSelect('filterProvider', uniqueValues(allJobs.map(job => job.provider)), 'All');
  populateSelect('filterPageType', uniqueValues(allJobs.map(job => job.page_type)), 'All');
}

function populateSelect(id, values, allLabel) {
  const select = $(id);
  const oldValue = select.value;
  select.innerHTML = `<option value="">${allLabel}</option>`;
  values.forEach(value => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  });
  if (values.includes(oldValue)) select.value = oldValue;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map(String))].sort((a, b) => a.localeCompare(b));
}

function formatSearchTime(value) {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

function careerProfileFactCount(profile) {
  if (!profile) return 0;
  const sections = ['education', 'experience', 'projects', 'certifications', 'languages', 'interview_stories'];
  const structured = sections.reduce((total, key) => total + (Array.isArray(profile[key]) ? profile[key].length : 0), 0);
  const skills = Object.values(profile.skills || {}).reduce((total, values) => total + (Array.isArray(values) ? values.length : 0), 0);
  const identity = Object.values(profile.identity || {}).filter(value => String(value || '').trim()).length;
  return structured + skills + identity;
}

function renderHomeDashboard() {
  const profile = activeCareerProfile();
  const careerBadge = $('homeCareerBrainBadge');
  const careerSummary = $('homeCareerBrainSummary');
  if (careerBadge && careerSummary) {
    const state = profile?.user_approved ? 'READY' : profile ? 'REVIEW' : 'SETUP';
    careerBadge.textContent = state;
    careerBadge.className = `provider-state state-${state === 'READY' ? 'ready' : state === 'REVIEW' ? 'draft' : 'disabled'}`;
    careerSummary.innerHTML = profile
      ? `<strong>${escapeHtml(profile.name || 'Career Profile')} · v${escapeHtml(String(profile.version || 1))}</strong>
         <p>${careerProfileFactCount(profile)} reusable facts · ${profile.user_approved ? 'approved for package preparation' : 'waiting for your review'}</p>`
      : '<strong>No Career Profile yet</strong><p>Upload a resume or create a profile to start matching opportunities.</p>';
  }

  const newRecommendations = allJobs
    .filter(job => jobLifecycleStatus(job) === 'new' && job.page_type === 'job_detail')
    .sort((a, b) => jobDisplayScore(b) - jobDisplayScore(a));
  const recommended = newRecommendations.slice(0, 3);
  if ($('homeRecommendedCount')) $('homeRecommendedCount').textContent = String(newRecommendations.length);
  if ($('homeRecommendedJobs')) {
    $('homeRecommendedJobs').innerHTML = recommended.length
      ? recommended.map(job => `<button class="home-list-item" type="button" onclick="switchView('job-matches')">
          <span><strong>${escapeHtml(job.title || 'Untitled role')}</strong><small>${escapeHtml(job.company || 'Company not listed')} · ${escapeHtml(job.source_category_label || 'Public source')}</small></span>
          <b>${escapeHtml(String(jobDisplayScore(job)))}%</b>
        </button>`).join('')
      : '<div class="home-empty"><strong>No new recommendations</strong><p>Saved, approved, and rejected jobs remain available in Job Matches and Applications.</p></div>';
  }

  const applications = allJobs
    .filter(job => jobLifecycleStatus(job) !== 'rejected'
      && (['approved', 'applied'].includes(jobLifecycleStatus(job)) || hasApplicationWorkflow(job)))
    .slice(0, 3);
  if ($('homeApplicationsCount')) $('homeApplicationsCount').textContent = String(applications.length);
  if ($('homeApplicationsSummary')) {
    $('homeApplicationsSummary').innerHTML = applications.length
      ? applications.map(job => `<button class="home-list-item" type="button" onclick="switchView('applications')">
          <span><strong>${escapeHtml(job.title || 'Untitled role')}</strong><small>${escapeHtml(job.company || 'Company not listed')} · ${escapeHtml(applicationStatusLabel(job.application_status || 'approved'))}</small></span>
          <b>${Number.isFinite(Number(job.application_completion?.application_completion_rate)) ? `${Number(job.application_completion.application_completion_rate)}%` : '→'}</b>
        </button>`).join('')
      : '<div class="home-empty"><strong>No applications in progress</strong><p>Approve a match when you are ready to build its package.</p></div>';
  }

  const stories = Array.isArray(profile?.interview_stories) ? profile.interview_stories : [];
  const approvedJobs = allJobs.filter(job => job.approval_status === 'approved');
  const confirmedStories = stories.filter(story => story.user_confirmed === true);
  if ($('homeInterviewCount')) $('homeInterviewCount').textContent = String(confirmedStories.length);
  if ($('homeInterviewSummary')) {
    $('homeInterviewSummary').innerHTML = stories.length || approvedJobs.length
      ? `<strong>${confirmedStories.length} verified STAR stor${confirmedStories.length === 1 ? 'y' : 'ies'}</strong>
         <p>${approvedJobs.length} approved opportunit${approvedJobs.length === 1 ? 'y' : 'ies'} ready for role-specific preparation.</p>`
      : '<div class="home-empty"><strong>No interview plan yet</strong><p>Add one verified STAR story or approve a recommended job.</p></div>';
  }

  const profileImprovements = [];
  if (!profile) profileImprovements.push('Create Career Brain from your resume.');
  else {
    if (!profile.user_approved) profileImprovements.push('Review and approve the current Career Brain version.');
    if (!Array.isArray(profile.experience) || !profile.experience.length) profileImprovements.push('Add verified experience evidence.');
    if (!Object.values(profile.skills || {}).some(values => Array.isArray(values) && values.length)) profileImprovements.push('Add skills used for matching.');
    if (!Array.isArray(profile.languages) || !profile.languages.length) profileImprovements.push('Record languages relevant to your target market.');
    if (!stories.length) profileImprovements.push('Add a verified STAR interview story.');
  }
  if ($('homeProfileImprovementCount')) $('homeProfileImprovementCount').textContent = String(profileImprovements.length);
  if ($('homeProfileImprovements')) {
    $('homeProfileImprovements').innerHTML = profileImprovements.length
      ? `<ul class="profile-improvement-list">${profileImprovements.slice(0, 4).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<div class="home-empty"><strong>Career Brain is ready</strong><p>Keep it current when your experience or target roles change.</p></div>';
  }

  if ($('homeNextActions')) {
    const pendingMatches = allJobs.filter(job => (job.approval_status || 'pending') === 'pending').length;
    const packagesNeedingReview = allJobs.filter(job => ['PACKAGE_READY', 'NEEDS_REVIEW'].includes(job.application_status)).length;
    $('homeNextActions').innerHTML = `<ol class="next-action-list">
      <li class="primary"><strong>${escapeHtml(currentUxStep.title || 'Continue your workflow')}</strong><span>${escapeHtml(currentUxStep.detail || '')}</span></li>
      ${pendingMatches ? `<li><strong>Review ${pendingMatches} unreviewed match${pendingMatches === 1 ? '' : 'es'}</strong><span>Approve only the opportunities you want to pursue.</span></li>` : ''}
      ${packagesNeedingReview ? `<li><strong>Review ${packagesNeedingReview} application package${packagesNeedingReview === 1 ? '' : 's'}</strong><span>Resolve missing or sensitive questions before fill.</span></li>` : ''}
    </ol>`;
  }
  if ($('homeNextActionBtn')) $('homeNextActionBtn').textContent = currentUxStep.action || 'Continue';
}

function renderJobsTableLegacy() {
  const container = $('jobsTableBody');
  const maximumJobsToOpen = Number(workflowData.maximum_jobs_to_open || editableSearchProfile()?.maximum_jobs_to_open || 0);
  selectedJobIds = new Set([...selectedJobIds].filter(id => allJobs.some(job => String(job.job_id) === String(id) && job.approval_status === 'approved')));
  const approvedJobCount = Number(workflowData.approved_job_count || 0);
  $('jobSelectionStatus').textContent = `${selectedJobIds.size} selected for applications · ${approvedJobCount} approved · limit ${maximumJobsToOpen || 0}. Approving a job adds it automatically when capacity is available.`;
  if (!filteredJobs.length) {
    container.innerHTML = allJobs.length
      ? '<div class="empty-state"><strong>No matches fit these filters.</strong><p>Clear a filter to see the rest of your scored jobs.</p></div>'
      : `<div class="empty-state"><strong>No job matches yet.</strong><p>This does not lock Resume Jobs. Retry, edit the search, import a public job URL, or continue with a synthetic offline demo.</p>
          <div class="inline-actions">
            <button class="btn-primary" type="button" data-zero-search-action="retry">Retry Search</button>
            <button class="btn-secondary" type="button" data-zero-search-action="edit">Edit Search</button>
            <button class="btn-secondary" type="button" data-zero-search-action="import">Import Job URL</button>
            <button class="btn-secondary" type="button" data-zero-search-action="demo">Offline Demo</button>
          </div></div>`;
    renderApplicationsOverview();
    renderInterviewPreparation();
    updateUxState();
    return;
  }

  container.innerHTML = filteredJobs.map(job => {
    const warning = job.warning || job.approval_warning || '';
    const approvalWarningText = jobApprovalWarningText(job);
    const reasons = Array.isArray(job.match_reasons) ? job.match_reasons : (job.match_reasons ? [job.match_reasons] : []);
    const pageType = job.page_type || 'unknown';
    const recommendedDecision = job.recommended_decision || 'manual_review';
    const safeToApprove = job.safe_to_approve || false;
    const canBuildPackage = (job.approval_status || 'pending') === 'approved' && pageType === 'job_detail' && safeToApprove;
    const packageStatus = job.package_status || 'not_created';
    const completion = job.application_completion;
    const completionRate = Number.isFinite(Number(completion?.application_completion_rate))
      ? Number(completion.application_completion_rate)
      : null;
    const canReviewPackage = Boolean(job.package_path) || packageStatus === 'preview_created';
    const canStartFill = Boolean(job.fill_approved_at)
      && selectedJobIds.has(String(job.job_id))
      && !job.active_session_id;
    const canMarkSubmitted = job.application_status === 'READY_FOR_MANUAL_SUBMIT';
    const breakdown = job.score_breakdown || {};
    const fitDimensions = [
      ['Technical', breakdown.technical_match],
      ['Experience', breakdown.experience_match],
      ['Education', breakdown.education_match],
      ['Location', breakdown.location_match?.candidate_dimension || breakdown.location_match],
      ['Salary', breakdown.salary_match?.candidate_dimension || breakdown.salary_match],
      ['Career', breakdown.career_direction_match]
    ];
    const hybridMatch = job.hybrid_match || null;
    const matched = Array.isArray(hybridMatch?.strengths) && hybridMatch.strengths.length
      ? hybridMatch.strengths
      : Array.isArray(breakdown.matched_requirements) && breakdown.matched_requirements.length
      ? breakdown.matched_requirements
      : reasons.slice(0, 4);
    const whyNot = [
      ...(Array.isArray(hybridMatch?.weaknesses) ? hybridMatch.weaknesses : []),
      ...fitDimensions
        .filter(([, value]) => ['no_overlap', 'no_match', 'below_requirement', 'below_minimum'].includes(value?.status))
        .map(([label, value]) => `${label}: ${humanizeToken(value.status)}`)
    ].slice(0, 4);
    const missing = [
      ...(Array.isArray(hybridMatch?.missing) ? hybridMatch.missing : []),
      ...(Array.isArray(breakdown.missing_requirements) ? breakdown.missing_requirements : []),
      ...(Array.isArray(breakdown.uncertainty) ? breakdown.uncertainty : []),
      ...fitDimensions
        .filter(([, value]) => value?.status === 'unknown')
        .map(([label]) => `${label}: evidence not recorded`)
    ].slice(0, 4);
    const recommendedAction = hybridMatch?.recommendation || humanizeToken(recommendedDecision);
    const score = Number(hybridMatch?.score ?? job.match_score ?? 0);
    const careerRecommendation = {
      immediateFit: hybridMatch?.immediate_fit || `${score || Number(job.match_score || 0)}% current match based on recorded evidence.`,
      growthValue: hybridMatch?.career_growth_value || hybridMatch?.career_reason || 'Career growth evidence has not been assessed yet.',
      skillGaps: Array.isArray(hybridMatch?.skill_gaps) && hybridMatch.skill_gaps.length ? hybridMatch.skill_gaps : missing,
      action: hybridMatch?.recommended_action || recommendedAction
    };
    const careerAction = String(careerRecommendation.action || '').toLowerCase();
    const actionGuidance = careerAction === 'do not apply'
      ? 'The career analysis recommends not applying; you remain in control of the final decision.'
      : careerAction === 'consider'
        ? 'Review the gaps and source page before deciding whether to approve.'
        : safeToApprove
          ? 'You can approve this job after reviewing the source page.'
          : 'Keep for manual review until the page is verified.';
    const discovery = job.discovery || {};
    const matchLabel = score >= 90 ? 'Top match' : score >= 75 ? 'Strong match' : score >= 60 ? 'Possible match' : 'Review carefully';
    const selected = selectedJobIds.has(String(job.job_id));
    const selectionDisabled = job.approval_status !== 'approved'
      || (!selected && selectedJobIds.size >= maximumJobsToOpen);

    return `
      <article class="job-match-card score-${getScoreClass(score)}">
        <div class="job-card-header">
          <div>
            <p class="job-company">${escapeHtml(job.company || 'Company not listed')}</p>
            <h3>${escapeHtml(job.title || 'Untitled role')}</h3>
            <p class="job-location">${escapeHtml(display(job.location))} · ${escapeHtml(job.source_market === 'china' ? 'China' : 'Global')} / ${escapeHtml(job.source_category_label || 'Company careers')}</p>
          </div>
          <div class="match-score">
            <strong>${escapeHtml(String(score))}%</strong>
            <span>${escapeHtml(matchLabel)}</span>
          </div>
        </div>
        <dl class="discovery-evidence">
          <div><dt>Source</dt><dd>${escapeHtml(job.source_category_label || display(job.source_type || job.source))}</dd></div>
          <div><dt>Query</dt><dd>${escapeHtml(job.search_query || discovery.query || 'Not recorded')}</dd></div>
          <div><dt>Search time</dt><dd>${escapeHtml(formatSearchTime(job.search_time || discovery.searched_at || job.discovered_at))}</dd></div>
          <div><dt>Why discovered</dt><dd>${escapeHtml(job.why_discovered || discovery.why_discovered || 'Discovered from a public job source.')}</dd></div>
          <div><dt>Provider</dt><dd>${escapeHtml(job.provider || discovery.provider || 'unknown')}</dd></div>
        </dl>
        <section class="career-recommendation" aria-label="Career recommendation">
          <article><h4>Immediate fit</h4><p>${escapeHtml(careerRecommendation.immediateFit)}</p></article>
          <article><h4>Career growth value</h4><p>${escapeHtml(careerRecommendation.growthValue)}</p></article>
          <article><h4>Skill gaps</h4><div class="tag-list missing">${careerRecommendation.skillGaps.length
            ? careerRecommendation.skillGaps.map(item => `<span>${escapeHtml(humanizeToken(item))}</span>`).join('')
            : '<span>No confirmed skill gap</span>'}</div></article>
          <article class="recommended-action"><h4>Recommended action</h4><strong>${escapeHtml(careerRecommendation.action)}</strong></article>
        </section>
        ${hybridMatch?.career_reason ? `<p class="career-reason"><strong>Career reason:</strong> ${escapeHtml(hybridMatch.career_reason)}</p>` : ''}
        <div class="match-explanation">
          <div>
            <h4>Why fit</h4>
            <div class="tag-list">${matched.length
              ? matched.map(item => `<span>${escapeHtml(humanizeToken(item))}</span>`).join('')
              : '<span>Run scoring for details</span>'}</div>
          </div>
          <div>
            <h4>Why not</h4>
            <div class="tag-list caution">${whyNot.length
              ? whyNot.map(item => `<span>${escapeHtml(humanizeToken(item))}</span>`).join('')
              : '<span>No confirmed mismatch</span>'}</div>
          </div>
          <div>
            <h4>Missing</h4>
            <div class="tag-list missing">${missing.length
              ? missing.map(item => `<span>${escapeHtml(humanizeToken(item))}</span>`).join('')
              : '<span>No missing evidence recorded</span>'}</div>
          </div>
          <div class="recommended-action">
            <h4>Recommended action</h4>
            <strong>${escapeHtml(recommendedAction)}</strong>
            <span>${escapeHtml(actionGuidance)}</span>
          </div>
        </div>
        <div class="fit-dimensions" aria-label="Candidate match dimensions">
          ${fitDimensions.map(([label, value]) => `
            <span class="fit-dimension status-${escapeAttr(value?.status || 'unknown')}">
              <strong>${escapeHtml(label)}</strong>
              ${escapeHtml(humanizeToken(value?.status || 'unknown'))}${Number.isFinite(Number(value?.score)) ? ` · ${escapeHtml(String(value.score))}` : ''}
            </span>`).join('')}
          ${Number.isFinite(Number(breakdown.candidate_fit_score)) ? `<span class="fit-dimension fit-total"><strong>Candidate fit</strong>${escapeHtml(String(breakdown.candidate_fit_score))}%</span>` : ''}
        </div>
        ${warning && warning !== 'none' ? `<div class="inline-warning">${escapeHtml(warning)}</div>` : ''}
        <div class="job-card-status">
          <span class="status-badge status-${escapeAttr(job.approval_status || 'pending')}">${escapeHtml(humanizeToken(job.approval_status || 'pending'))}</span>
          <span class="status-badge app-${escapeAttr(job.application_status || 'not_started')}">${escapeHtml(applicationStatusLabel(job.application_status || 'not_started'))}</span>
          ${completionRate === null ? '' : `<span class="completion-rate">${escapeHtml(String(completionRate))}% ready</span>`}
          ${job.approval_status === 'approved' ? `<label class="selection-choice"><input type="checkbox" aria-label="Select job" ${selected ? 'checked' : ''} ${selectionDisabled ? 'disabled' : ''} onchange="toggleJobSelection(${jsString(job.job_id)}, this.checked)"> Include in application batch</label>` : ''}
        </div>
        <div class="job-card-actions">
          <button class="btn-secondary" type="button" onclick="openJobURL(${jsString(job.url)})">View Job</button>
          <button class="btn-primary" type="button" ${safeToApprove ? '' : 'disabled title="This job needs manual review first."'} onclick="setDecision(${jsString(job.job_id)}, 'approve')">Approve</button>
          <button class="btn-danger" type="button" onclick="setDecision(${jsString(job.job_id)}, 'reject')">Reject</button>
        </div>
        <details class="advanced-disclosure compact">
          <summary>More actions and score evidence</summary>
          <div class="inline-actions">
            <button class="btn-secondary" type="button" onclick="setDecision(${jsString(job.job_id)}, 'manual-review')">Keep for review</button>
            <button class="btn-secondary" type="button" onclick="setDecision(${jsString(job.job_id)}, 'restore')">Return to review</button>
            <button class="btn-primary" type="button" ${canBuildPackage ? '' : 'disabled'} onclick="buildPackagePreview(${jsString(job.job_id)})">Build Package</button>
            <button class="btn-secondary" type="button" ${canReviewPackage ? '' : 'disabled'} onclick="reviewApplicationPackage(${jsString(job.job_id)})">Review Package</button>
            <button class="btn-secondary" type="button" ${canReviewPackage ? '' : 'disabled'} onclick="approveFill(${jsString(job.job_id)})">Approve AI Fill</button>
            ${canStartFill
              ? `<button class="btn-primary" type="button" onclick="startFill(${jsString(job.job_id)})">Start AI Fill Assistant</button>`
              : `<span class="job-row-blocker"><strong>Start unavailable:</strong> ${escapeHtml(jobStartRequirementText(job, selectedJobIds.has(String(job.job_id))))}</span>`}
            <button class="btn-secondary" type="button" ${canMarkSubmitted ? '' : 'disabled'} onclick="markSubmittedManually(${jsString(job.job_id)})">Mark Submitted</button>
            <button class="btn-danger" type="button" onclick="setApplicationStatus(${jsString(job.job_id)}, 'failed')">Mark Failed</button>
          </div>
          <pre class="score-evidence">${escapeHtml(JSON.stringify(job.score_breakdown || { explanation: 'Run scoring to generate details.' }, null, 2))}</pre>
        </details>
      </article>
    `;
  }).join('');
  renderApplicationsOverview();
  renderInterviewPreparation();
  updateUxState();
}

function renderJobsTable() {
  const container = $('jobsTableBody');
  if (!container) return;
  const maximumJobsToOpen = Number(workflowData.maximum_jobs_to_open || editableSearchProfile()?.maximum_jobs_to_open || 0);
  selectedJobIds = new Set([...selectedJobIds].filter(id => allJobs.some(job => String(job.job_id) === String(id) && job.approval_status === 'approved')));
  const approvedJobCount = Number(workflowData.approved_job_count || 0);
  if ($('jobSelectionStatus')) {
    $('jobSelectionStatus').textContent = `${selectedJobIds.size} selected for applications · ${approvedJobCount} approved · limit ${maximumJobsToOpen || 0}. Approving a job adds it automatically when capacity is available.`;
  }
  if (!filteredJobs.length) {
    if ($('jobListSummary')) $('jobListSummary').textContent = `Showing 0 of ${allJobs.length} jobs`;
    $('loadMoreJobsBtn')?.classList.add('hidden');
    container.innerHTML = allJobs.length
      ? '<div class="empty-state"><strong>No jobs fit these filters.</strong><p>Clear a filter or choose All history to see other jobs.</p></div>'
      : `<div class="empty-state"><strong>No job matches yet.</strong><p>Retry, edit the search, import a public job URL, or continue with the synthetic offline demo.</p>
          <div class="inline-actions">
            <button class="btn-primary" type="button" data-zero-search-action="retry">Retry Search</button>
            <button class="btn-secondary" type="button" data-zero-search-action="edit">Edit Search</button>
            <button class="btn-secondary" type="button" data-zero-search-action="import">Import Job URL</button>
            <button class="btn-secondary" type="button" data-zero-search-action="demo">Offline Demo</button>
          </div></div>`;
    renderApplicationsOverview();
    renderInterviewPreparation();
    updateUxState();
    return;
  }

  const visibleJobs = filteredJobs.slice(0, visibleJobLimit);
  if ($('jobListSummary')) $('jobListSummary').textContent = `Showing ${visibleJobs.length} of ${filteredJobs.length} jobs`;
  if ($('loadMoreJobsBtn')) {
    const remaining = Math.max(0, filteredJobs.length - visibleJobs.length);
    $('loadMoreJobsBtn').classList.toggle('hidden', remaining === 0);
    $('loadMoreJobsBtn').textContent = `Load More (${remaining} remaining)`;
  }

  container.innerHTML = visibleJobs.map(job => {
    const warning = job.warning || job.approval_warning || '';
    const approvalWarningText = jobApprovalWarningText(job);
    const reasons = Array.isArray(job.match_reasons) ? job.match_reasons : (job.match_reasons ? [job.match_reasons] : []);
    const pageType = job.page_type || 'unknown';
    const safeToApprove = job.safe_to_approve === true;
    const lifecycle = jobLifecycleStatus(job);
    const discoveryStatus = jobDiscoveryStatus(job);
    const packageStatus = job.package_status || 'not_created';
    const canBuildPackage = lifecycle === 'approved' && safeToApprove && job.application_status === 'APPROVED_FOR_PACKAGE';
    const canReviewPackage = Boolean(job.package_path) || packageStatus === 'preview_created';
    const selected = selectedJobIds.has(String(job.job_id));
    const selectionDisabled = lifecycle !== 'approved' || (!selected && selectedJobIds.size >= maximumJobsToOpen);
    const canStartFill = Boolean(job.fill_approved_at)
      && selected
      && ['FILL_APPROVED', 'NEEDS_REVIEW'].includes(job.application_status);
    const canMarkSubmitted = job.application_status === 'READY_FOR_MANUAL_SUBMIT';
    const completionRate = Number.isFinite(Number(job.application_completion?.application_completion_rate))
      ? Number(job.application_completion.application_completion_rate)
      : null;
    const breakdown = job.score_breakdown || {};
    const hybridMatch = job.hybrid_match || null;
    const fitDimensions = [
      ['Technical', breakdown.technical_match],
      ['Experience', breakdown.experience_match],
      ['Education', breakdown.education_match],
      ['Location', breakdown.location_match?.candidate_dimension || breakdown.location_match],
      ['Salary', breakdown.salary_match?.candidate_dimension || breakdown.salary_match],
      ['Career', breakdown.career_direction_match]
    ];
    const strengths = Array.isArray(hybridMatch?.strengths) && hybridMatch.strengths.length
      ? hybridMatch.strengths
      : Array.isArray(breakdown.matched_requirements) && breakdown.matched_requirements.length
        ? breakdown.matched_requirements
        : reasons.slice(0, 4);
    const weaknesses = [
      ...(Array.isArray(hybridMatch?.weaknesses) ? hybridMatch.weaknesses : []),
      ...fitDimensions.filter(([, value]) => ['no_overlap', 'no_match', 'below_requirement', 'below_minimum'].includes(value?.status))
        .map(([label, value]) => `${label}: ${humanizeToken(value.status)}`)
    ].slice(0, 4);
    const missing = [
      ...(Array.isArray(hybridMatch?.skill_gaps) ? hybridMatch.skill_gaps : []),
      ...(Array.isArray(hybridMatch?.missing) ? hybridMatch.missing : []),
      ...(Array.isArray(breakdown.missing_requirements) ? breakdown.missing_requirements : []),
      ...(Array.isArray(breakdown.uncertainty) ? breakdown.uncertainty : [])
    ].filter((value, index, values) => value && values.indexOf(value) === index).slice(0, 8);
    const recommendedAction = hybridMatch?.recommended_action || hybridMatch?.recommendation || humanizeToken(job.recommended_decision || 'manual_review');
    const actionKey = String(recommendedAction).toLowerCase();
    const actionGuidance = actionKey === 'do not apply'
      ? 'Career analysis recommends not applying. You remain in control.'
      : actionKey === 'consider'
        ? 'Review the gaps and source page before deciding.'
        : safeToApprove
          ? 'Review the source page, then approve if you want to continue.'
          : 'Save for review until this job passes the safety checks.';
    const score = jobDisplayScore(job);
    const matchLabel = score >= 90 ? 'Top match' : score >= 75 ? 'Strong match' : score >= 60 ? 'Possible match' : 'Review carefully';
    const discovery = job.discovery || {};

    return `<article class="job-match-card compact score-${getScoreClass(score)}" data-job-id="${escapeAttr(job.job_id)}">
      <div class="job-card-header">
        <div>
          <div class="job-card-kicker"><span class="lifecycle-badge lifecycle-${escapeAttr(lifecycle)}">${escapeHtml(applicationStatusLabel(lifecycle))}</span><span class="freshness-badge freshness-${escapeAttr(discoveryStatus)}">${escapeHtml(discoveryStatus === 'new' ? 'New discovery' : `Seen ${Number(job.times_seen || 1)} times`)}</span><span>${escapeHtml(matchLabel)}</span></div>
          <h3>${escapeHtml(job.title || 'Untitled role')}</h3>
          <p class="job-location"><strong>${escapeHtml(job.company || 'Company not listed')}</strong> · ${escapeHtml(display(job.location))}</p>
        </div>
        <div class="match-score"><strong>${escapeHtml(String(score))}%</strong><span>${escapeHtml(jobScoreMethodLabel(job))}</span></div>
      </div>
      <div class="compact-match-summary">
        <section><h4>Top strengths</h4><div class="tag-list">${strengths.length ? strengths.slice(0, 2).map(item => `<span>${escapeHtml(humanizeToken(item))}</span>`).join('') : '<span>No confirmed strength yet</span>'}</div></section>
        <section><h4>Missing skills</h4><div class="tag-list missing">${missing.length ? missing.slice(0, 2).map(item => `<span>${escapeHtml(humanizeToken(item))}</span>`).join('') : '<span>No confirmed skill gap</span>'}</div></section>
        <section class="compact-recommendation"><h4>Recommended action</h4><strong>${escapeHtml(recommendedAction)}</strong></section>
      </div>
      <div class="job-card-actions">
        ${lifecycle === 'new' ? `<button class="btn-secondary" type="button" onclick="setDecision(${jsString(job.job_id)}, 'save')">Save</button>` : ''}
        ${lifecycle === 'saved' ? `<button class="btn-secondary" type="button" onclick="setDecision(${jsString(job.job_id)}, 'restore')">Return to review</button>` : ''}
        ${!['approved', 'applied', 'rejected'].includes(lifecycle) ? (safeToApprove
          ? `<button class="btn-primary" type="button" onclick="setDecision(${jsString(job.job_id)}, 'approve')">${approvalWarningText ? 'Continue & Approve' : 'Approve'}</button>`
          : `<button class="btn-secondary" type="button" onclick="showJobBlocker(${jsString(job.job_id)})">Why approval is blocked</button>`) : ''}
        ${!['rejected', 'applied'].includes(lifecycle) ? `<button class="btn-danger" type="button" onclick="setDecision(${jsString(job.job_id)}, 'reject')">Reject</button>` : ''}
        ${lifecycle === 'rejected' ? `<button class="btn-secondary" type="button" onclick="setDecision(${jsString(job.job_id)}, 'restore')">Restore to review</button><button class="btn-primary" type="button" onclick="setDecision(${jsString(job.job_id)}, 'reconsider')">Reconsider &amp; Approve</button>` : ''}
        ${canBuildPackage ? `<button class="btn-primary" type="button" onclick="buildPackagePreview(${jsString(job.job_id)})">Build Package</button>` : ''}
        ${canReviewPackage ? `<button class="btn-primary" type="button" onclick="reviewApplicationPackage(${jsString(job.job_id)})">Review Package</button>` : ''}
        ${lifecycle === 'approved' && ['APPROVED_FOR_PACKAGE', 'PACKAGE_READY'].includes(job.application_status) && !job.active_session_id ? `<button class="btn-secondary" type="button" onclick="setDecision(${jsString(job.job_id)}, 'restore')">Return to review</button>` : ''}
        ${lifecycle === 'approved' && !['MANUALLY_SUBMITTED', 'CANCELLED'].includes(job.application_status) ? `<button class="btn-danger" type="button" onclick="cancelApplication(${jsString(job.job_id)})">Cancel application</button>` : ''}
      </div>
      ${!safeToApprove && !['approved', 'applied', 'rejected'].includes(lifecycle) ? `<p class="job-row-blocker"><strong>Approval blocked:</strong> ${escapeHtml(jobApprovalBlockerText(job))}</p>` : ''}
      ${safeToApprove && approvalWarningText && !['approved', 'applied', 'rejected'].includes(lifecycle) ? `<p class="job-row-warning"><strong>Warning:</strong> ${escapeHtml(approvalWarningText)}</p>` : ''}
      <p class="job-row-next"><strong>Next:</strong> ${escapeHtml(job.next_action || 'Review this job')} · <span>${escapeHtml(job.portal_capability?.label || 'Portal capability not assessed')}</span></p>
      <details class="job-match-details">
        <summary>View details</summary>
        <dl class="discovery-evidence">
          <div><dt>Source</dt><dd>${escapeHtml(job.source_category_label || display(job.source_type || job.source))}</dd></div>
          <div><dt>Query</dt><dd>${escapeHtml(job.search_query || discovery.query || 'Not recorded')}</dd></div>
          <div><dt>Search time</dt><dd>${escapeHtml(formatSearchTime(job.search_time || discovery.searched_at || job.discovered_at))}</dd></div>
          <div><dt>Why discovered</dt><dd>${escapeHtml(job.why_discovered || discovery.why_discovered || 'Discovered from a public job source.')}</dd></div>
          <div><dt>Provider</dt><dd>${escapeHtml(job.provider || discovery.provider || 'unknown')}</dd></div>
          <div><dt>First seen</dt><dd>${escapeHtml(formatSearchTime(job.first_seen || job.first_seen_at))}</dd></div>
          <div><dt>Last seen</dt><dd>${escapeHtml(formatSearchTime(job.last_seen || job.last_seen_at))}</dd></div>
          <div><dt>Application support</dt><dd>${escapeHtml(job.portal_capability?.label || 'Not assessed')} · ${escapeHtml(job.portal_capability?.message || '')}</dd></div>
        </dl>
        <section class="career-recommendation" aria-label="Career recommendation">
          <article><h4>Immediate fit</h4><p>${escapeHtml(hybridMatch?.immediate_fit || `${score}% current match based on recorded evidence.`)}</p></article>
          <article><h4>Career growth value</h4><p>${escapeHtml(hybridMatch?.career_growth_value || hybridMatch?.career_reason || 'Not assessed yet.')}</p></article>
          <article><h4>Skill gaps</h4><div class="tag-list missing">${missing.length ? missing.map(item => `<span>${escapeHtml(humanizeToken(item))}</span>`).join('') : '<span>No confirmed skill gap</span>'}</div></article>
          <article class="recommended-action"><h4>Recommended action</h4><strong>${escapeHtml(recommendedAction)}</strong><span>${escapeHtml(actionGuidance)}</span></article>
        </section>
        ${hybridMatch?.career_reason ? `<p class="career-reason"><strong>Career reason:</strong> ${escapeHtml(hybridMatch.career_reason)}</p>` : ''}
        <div class="match-explanation">
          <div><h4>Why fit</h4><div class="tag-list">${strengths.length ? strengths.map(item => `<span>${escapeHtml(humanizeToken(item))}</span>`).join('') : '<span>No confirmed strength yet</span>'}</div></div>
          <div><h4>Why not</h4><div class="tag-list caution">${weaknesses.length ? weaknesses.map(item => `<span>${escapeHtml(humanizeToken(item))}</span>`).join('') : '<span>No confirmed mismatch</span>'}</div></div>
        </div>
        <div class="fit-dimensions" aria-label="Candidate match dimensions">${fitDimensions.map(([label, value]) => `<span class="fit-dimension status-${escapeAttr(value?.status || 'unknown')}"><strong>${escapeHtml(label)}</strong>${escapeHtml(humanizeToken(value?.status || 'unknown'))}${Number.isFinite(Number(value?.score)) ? ` · ${escapeHtml(String(value.score))}` : ''}</span>`).join('')}${Number.isFinite(Number(breakdown.candidate_fit_score)) ? `<span class="fit-dimension fit-total"><strong>Candidate fit</strong>${escapeHtml(String(breakdown.candidate_fit_score))}%</span>` : ''}</div>
        ${warning && warning !== 'none' ? `<div class="inline-warning">${escapeHtml(warning)}</div>` : ''}
        <div class="job-card-status">
          <span class="status-badge app-${escapeAttr(job.application_status || 'not_started')}">${escapeHtml(applicationStatusLabel(job.application_status || 'not_started'))}</span>
          ${completionRate === null ? '' : `<span class="completion-rate">${escapeHtml(String(completionRate))}% ready</span>`}
          ${lifecycle === 'approved' ? `<label class="selection-choice"><input type="checkbox" aria-label="Select job" ${selected ? 'checked' : ''} ${selectionDisabled ? 'disabled' : ''} onchange="toggleJobSelection(${jsString(job.job_id)}, this.checked)"> Include in application batch</label>` : ''}
        </div>
        <details class="advanced-disclosure compact"><summary>Advanced actions and score evidence</summary>
          <div class="inline-actions">
            <button class="btn-secondary" type="button" onclick="openJobURL(${jsString(job.url)})">Open Source Page</button>
            ${canReviewPackage ? `<button class="btn-secondary" type="button" onclick="approveFill(${jsString(job.job_id)})">Approve AI Fill</button>` : `<span class="job-row-blocker"><strong>AI Fill unavailable:</strong> Build and review this job's Application Package first.</span>`}
            ${canStartFill
              ? `<button class="btn-primary" type="button" onclick="startFill(${jsString(job.job_id)})">Start AI Fill Assistant</button>`
              : `<span class="job-row-blocker"><strong>Start unavailable:</strong> ${escapeHtml(jobStartRequirementText(job, selected))}</span>`}
            ${canMarkSubmitted ? `<button class="btn-secondary" type="button" onclick="markSubmittedManually(${jsString(job.job_id)})">I submitted this application</button>` : ''}
          </div>
          <pre class="score-evidence">${escapeHtml(JSON.stringify(job.score_breakdown || { explanation: 'Run scoring to generate details.' }, null, 2))}</pre>
        </details>
      </details>
    </article>`;
  }).join('');
  renderApplicationsOverview();
  renderInterviewPreparation();
  updateUxState();
}

function renderJobInventory() {
  const counts = {
    all: allJobs.length,
    current: allJobs.filter(job => job.discovery_rank?.eligible !== false).length,
    new: allJobs.filter(job => jobDiscoveryStatus(job) === 'new').length,
    seen: allJobs.filter(job => jobDiscoveryStatus(job) === 'previously_seen').length,
    recommended: allJobs.filter(isRecommendedJob).length,
    saved: allJobs.filter(job => jobLifecycleStatus(job) === 'saved').length,
    rejected: allJobs.filter(job => jobLifecycleStatus(job) === 'rejected').length,
    approved: allJobs.filter(job => jobLifecycleStatus(job) === 'approved').length,
    applied: allJobs.filter(job => jobLifecycleStatus(job) === 'applied').length,
    archived: allJobs.filter(job => jobLifecycleStatus(job) === 'archived' || job.discovery_rank?.eligible === false).length,
    manual_only: allJobs.filter(job => jobLifecycleStatus(job) === 'manual_only').length,
    unsupported: allJobs.filter(job => jobLifecycleStatus(job) === 'unsupported').length
  };
  const elementIds = {
    all: 'inventoryAllCount',
    current: 'inventoryCurrentCount',
    new: 'inventoryNewCount',
    seen: 'inventorySeenCount',
    recommended: 'inventoryRecommendedCount',
    saved: 'inventorySavedCount',
    rejected: 'inventoryRejectedCount',
    approved: 'inventoryApprovedCount',
    applied: 'inventoryAppliedCount',
    archived: 'inventoryArchivedCount',
    manual_only: 'inventoryManualOnlyCount',
    unsupported: 'inventoryUnsupportedCount'
  };
  Object.entries(elementIds).forEach(([key, id]) => { if ($(id)) $(id).textContent = String(counts[key]); });
  document.querySelectorAll('[data-job-inventory]').forEach(button => {
    button.classList.toggle('active', button.dataset.jobInventory === jobInventoryMode);
  });

  const sourceCounts = {};
  allJobs.forEach(job => {
    const source = job.source_category_label || humanizeToken(job.source_category || job.provider || 'unknown');
    sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  });
  const transparency = $('searchTransparency');
  if (transparency) {
    const filteredOut = Math.max(0, allJobs.length - filteredJobs.length);
    transparency.innerHTML = `
      <div><span>Found jobs</span><strong>${allJobs.length}</strong></div>
      <div><span>Current results</span><strong>${counts.current}</strong></div>
      <div><span>Filtered out</span><strong>${filteredOut}</strong></div>
      <div><span>Recommended</span><strong>${counts.recommended}</strong></div>
      <div class="source-breakdown"><span>Source breakdown</span><strong>${escapeHtml(Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).map(([source, count]) => `${source} ${count}`).join(' · ') || 'No sources yet')}</strong></div>`;
  }
}

function renderApplicationsOverview() {
  const container = $('applicationCards');
  if (!container) return;
  const applicationJobs = allJobs.filter(job =>
    jobLifecycleStatus(job) !== 'rejected'
    && (['approved', 'applied'].includes(jobLifecycleStatus(job))
      || hasApplicationWorkflow(job)
      || job.package_path
      || job.package_status === 'preview_created')
  );
  if (!applicationJobs.length) {
    container.innerHTML = '<div class="empty-state"><strong>No approved jobs yet.</strong><p>Approve a match first; it will appear here automatically.</p><button class="btn-primary" type="button" onclick="switchView(\'job-matches\')">Review Job Matches</button></div>';
    return;
  }
  container.innerHTML = applicationJobs.map(job => {
    const hasPackage = Boolean(job.package_path) || job.package_status === 'preview_created';
    const completionRate = Number.isFinite(Number(job.application_completion?.application_completion_rate))
      ? Number(job.application_completion.application_completion_rate)
      : null;
    return `
      <article class="application-card">
        <div>
          <p class="job-company">${escapeHtml(job.company || 'Company not listed')}</p>
          <h3>${escapeHtml(job.title || 'Untitled role')}</h3>
          <p>${escapeHtml(applicationStatusLabel(job.application_status || (hasPackage ? 'package_ready' : 'approved_for_package')))}</p>
        </div>
        <div class="application-card-action">
          ${completionRate === null ? '' : `<strong>${completionRate}% ready</strong>`}
          <button class="${hasPackage ? 'btn-primary' : 'btn-secondary'}" type="button" ${hasPackage ? `onclick="reviewApplicationPackage(${jsString(job.job_id)})"` : `onclick="buildPackagePreview(${jsString(job.job_id)})"`}>${hasPackage ? 'Review Package' : 'Build Package'}</button>
        </div>
      </article>`;
  }).join('');
}

function applyFilters() {
  const approvalStatus = $('filterApprovalStatus').value;
  const applicationStatus = $('filterApplicationStatus').value;
  const provider = $('filterProvider').value;
  const pageType = $('filterPageType').value;
  const score = $('filterScore').value;
  const location = $('filterLocation').value.toLowerCase().trim();
  const text = $('filterText').value.toLowerCase().trim();
  const sort = $('sortJobs').value;

  filteredJobs = allJobs.filter(job => {
    if (jobInventoryMode === 'current' && job.discovery_rank?.eligible === false) return false;
    if (jobInventoryMode === 'recommended' && (!isRecommendedJob(job) || job.suppressed_from_default === true)) return false;
    if (jobInventoryMode === 'new' && (jobDiscoveryStatus(job) !== 'new' || job.suppressed_from_default === true)) return false;
    if (jobInventoryMode === 'seen' && jobDiscoveryStatus(job) !== 'previously_seen') return false;
    const lifecycle = jobLifecycleStatus(job);
    if (jobInventoryMode === 'archived' && lifecycle !== 'archived' && job.discovery_rank?.eligible !== false) return false;
    if (['saved', 'rejected', 'approved', 'applied', 'manual_only', 'unsupported'].includes(jobInventoryMode)
      && lifecycle !== jobInventoryMode) return false;
    if (approvalStatus === 'active' && lifecycle === 'rejected') return false;
    if (approvalStatus && approvalStatus !== 'active' && lifecycle !== approvalStatus) return false;
    if (applicationStatus && (job.application_status || 'not_started') !== applicationStatus) return false;
    if (provider && job.provider !== provider) return false;
    if (pageType && job.page_type !== pageType) return false;
    if (location && !(job.location || '').toLowerCase().includes(location)) return false;

    const numericScore = jobDisplayScore(job);
    if (score === '90' && numericScore < 90) return false;
    if (score === '80' && numericScore < 80) return false;
    if (score === '70' && numericScore < 70) return false;
    if (score === '60' && numericScore < 60) return false;
    if (score === '0' && numericScore >= 60) return false;

    if (text) {
      const haystack = [
        job.job_id,
        job.title,
        job.company,
        job.location,
        job.provider,
        job.ats,
        job.url,
        job.page_type,
        job.approval_safety,
        job.approval_warning,
        job.recommended_decision,
        job.package_status,
        job.package_path,
        job.next_action,
        Array.isArray(job.match_reasons) ? job.match_reasons.join(' ') : job.match_reasons
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  }).sort((a, b) => {
    if (sort === 'freshness_desc') return jobFreshnessScore(b) - jobFreshnessScore(a);
    if (sort === 'score_asc') return jobDisplayScore(a) - jobDisplayScore(b);
    if (sort === 'title_asc') return String(a.title || '').localeCompare(String(b.title || ''));
    return jobDisplayScore(b) - jobDisplayScore(a);
  });

  renderJobInventory();
  renderJobsTable();
}

async function toggleJobSelection(jobId, checked) {
  jobId = String(jobId);
  const job = allJobs.find(item => String(item.job_id) === jobId);
  const maximumJobsToOpen = Number(workflowData.maximum_jobs_to_open || editableSearchProfile()?.maximum_jobs_to_open || 0);
  if (!checked) selectedJobIds.delete(jobId);
  else if (job?.approval_status === 'approved' && selectedJobIds.size < maximumJobsToOpen) selectedJobIds.add(jobId);
  try {
    const result = await fetchJSON('/api/workflow/selection', {
      method: 'POST',
      body: JSON.stringify({ job_ids: [...selectedJobIds] })
    });
    workflowData = result;
    selectedJobIds = new Set((result.selected_job_ids || []).map(String));
    showRunStatus('ok', `Selection saved: ${selectedJobIds.size}/${result.maximum_jobs_to_open}`);
  } catch (err) {
    showRunStatus('error', `Selection failed: ${err.message}`);
    await loadWorkflow();
  }
  renderJobsTable();
}

async function setDecision(jobId, action) {
  if (action === 'reject' && !await confirmProductAction({
    title: 'Reject this job?',
    message: 'The job will leave Active matches and remain available in Rejected history. You can restore it later.',
    confirmLabel: 'Reject Job',
    tone: 'danger'
  })) return;
  if (action === 'reconsider' && !await confirmProductAction({
    title: 'Restore and approve this rejected job?',
    message: 'This performs two audited steps: restore the job to review, then approve it for an Application Package. Existing history is preserved.',
    confirmLabel: 'Reconsider & Approve'
  })) return;
  const messages = {
    approve: 'Job approved. Application Package is now available',
    reject: 'Job moved to Rejected history',
    save: 'Job saved for review',
    'manual-review': 'Job saved for review',
    restore: 'Job restored to review',
    reconsider: 'Job restored and approved'
  };
  const result = await postJobAction(
    `/api/jobs/${encodeURIComponent(jobId)}/${action}`,
    messages[action] || 'Job status saved',
    action === 'reconsider' ? { confirmed: true, idempotency_key: `reconsider-${jobId}-${Date.now()}` } : {}
  );
  if (!result) return;
  if (['approve', 'reconsider'].includes(action)) {
    jobInventoryMode = 'approved';
    $('filterApprovalStatus').value = 'approved';
    visibleJobLimit = JOB_PAGE_SIZE;
    applyFilters();
    showJobWorkflowNotice('ok', `Approved · ${applicationStatusLabel(result.transition?.to_status || 'APPROVED_FOR_PACKAGE')}. Next: Build Application Package.`);
    const card = document.querySelector(`[data-job-id="${CSS.escape(String(jobId))}"]`);
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card?.querySelector('button[onclick*="buildPackagePreview"]')?.focus();
  } else if (action === 'reject') {
    showJobWorkflowNotice('ok', 'Rejected and archived in Rejected jobs. It no longer appears in Active jobs.');
  } else if (['save', 'manual-review'].includes(action)) {
    showJobWorkflowNotice('ok', 'Saved for later review.');
  } else if (action === 'restore') {
    showJobWorkflowNotice('ok', 'Restored to Review Pending.');
  }
}

async function setApplicationStatus(jobId, action) {
  await postJobAction(`/api/jobs/${encodeURIComponent(jobId)}/${action}`, `${action} saved`);
}

async function cancelApplication(jobId) {
  if (!await confirmProductAction({
    title: 'Cancel this application attempt?',
    message: 'This stops the current local fill attempt and preserves the job, prepared materials, reports, and history. It does not change anything on the employer website.',
    confirmLabel: 'Cancel Application',
    tone: 'danger'
  })) return;
  await postJobAction(
    `/api/jobs/${encodeURIComponent(jobId)}/cancel-application`,
    'Application attempt cancelled',
    { confirmed: true, idempotency_key: `cancel-${jobId}-${Date.now()}` }
  );
}

async function buildPackagePreview(jobId) {
  const result = await postJobAction(`/api/jobs/${encodeURIComponent(jobId)}/build-package-preview`, 'Application Package created');
  if (!result) return;
  showJobWorkflowNotice('ok', `Application Package ready · ${applicationStatusLabel(result.application_status)}. Review it before any browser action.`);
  await reviewApplicationPackage(jobId);
}

async function buildSelectedPackages() {
  const jobIds = [...selectedJobIds];
  if (!jobIds.length) {
    showRunStatus('error', 'Select at least one approved job first.');
    return;
  }
  const failures = [];
  setRowButtonsDisabled(true);
  $('buildSelectedPackagesBtn').disabled = true;
  try {
    showRunStatus('running', `Building ${jobIds.length} selected application package(s)...`);
    for (const jobId of jobIds) {
      try {
        await fetchJSON(`/api/jobs/${encodeURIComponent(jobId)}/build-package-preview`, {
          method: 'POST',
          body: JSON.stringify({})
        });
      } catch (err) {
        const job = allJobs.find(item => String(item.job_id) === String(jobId));
        const jobLabel = [job?.company, job?.title]
          .map(item => String(item || '').trim())
          .filter(Boolean)
          .join(' · ') || 'Selected application';
        failures.push(`${jobLabel}: ${err.message}`);
      }
    }
    if (failures.length) showRunStatus('error', `Built ${jobIds.length - failures.length}/${jobIds.length}. ${failures.join(' | ')}`);
    else showRunStatus('ok', `Built ${jobIds.length} application package(s). Review answers before approving fill.`);
    await refreshAll();
    await loadSettings();
  } finally {
    setRowButtonsDisabled(false);
    $('buildSelectedPackagesBtn').disabled = false;
  }
}

function showLearningReviewStatus(type, message) {
  const status = $('learningReviewStatus');
  if (!status) return;
  status.className = `settings-status ${type}`;
  status.textContent = message;
}

function renderLearningCandidates(data = {}) {
  const section = $('learningReviewSection');
  const list = $('learningCandidateList');
  if (!section || !list) return;
  const candidates = (Array.isArray(data.candidates) ? data.candidates : [])
    .filter(candidate => candidate.status === 'pending');
  $('learningCandidateCount').textContent = `${candidates.length} pending`;
  section.classList.toggle('hidden', candidates.length === 0);
  if (!candidates.length) {
    list.innerHTML = '';
    return;
  }
  list.innerHTML = candidates.map(candidate => {
    const candidateId = escapeAttr(candidate.candidate_id);
    const careerAvailable = Boolean(candidate.canonical_path);
    const selectedDestination = candidate.suggested_destination === 'career_brain' && careerAvailable
      ? 'career_brain'
      : 'answer_memory';
    const selectedScope = candidate.suggested_scope || (candidate.risk_level === 'high' ? 'do_not_save' : 'employer');
    const destinationLabel = selectedDestination === 'career_brain'
      ? humanizeToken(candidate.canonical_path || 'Career Brain')
      : 'Answer Memory';
    return `<article class="learning-candidate-card" data-learning-candidate-id="${candidateId}">
      <div class="learning-candidate-heading">
        <div><strong>${escapeHtml(candidate.label || 'Application question')}</strong><p>Suggested destination: ${escapeHtml(destinationLabel)}</p></div>
        <span class="status-badge ${candidate.risk_level === 'high' ? 'learning-risk-high' : ''}">${escapeHtml(humanizeToken(candidate.risk_level || 'normal'))} risk</span>
      </div>
      <label>Detected value
        <textarea class="private-learning-value" data-learning-value>${escapeHtml(candidate.value || '')}</textarea>
      </label>
      <div class="learning-candidate-controls">
        <label>Save to
          <select data-learning-destination>
            <option value="career_brain" ${selectedDestination === 'career_brain' ? 'selected' : ''} ${careerAvailable ? '' : 'disabled'}>Career Brain draft</option>
            <option value="answer_memory" ${selectedDestination === 'answer_memory' ? 'selected' : ''}>Answer Memory</option>
          </select>
        </label>
        <label>Reuse scope
          <select data-learning-scope>
            <option value="global" ${selectedScope === 'global' ? 'selected' : ''}>Save globally</option>
            <option value="employer" ${selectedScope === 'employer' ? 'selected' : ''}>This employer only</option>
            <option value="role" ${selectedScope === 'role' ? 'selected' : ''}>This role only</option>
            <option value="do_not_save" ${selectedScope === 'do_not_save' ? 'selected' : ''}>Do not save</option>
          </select>
        </label>
      </div>
      ${candidate.risk_level === 'high' ? '<p class="inline-warning">High-risk answers default to Do not save and require an extra confirmation.</p>' : ''}
      <div class="inline-actions">
        <button class="btn-primary" type="button" onclick="saveLearningCandidate(${jsString(candidate.candidate_id)})">Save confirmed information</button>
        <button class="btn-secondary" type="button" onclick="rejectLearningCandidate(${jsString(candidate.candidate_id)})">Do not save</button>
      </div>
    </article>`;
  }).join('');
}

async function loadLearningCandidates(jobId = packageReviewJobId) {
  if (!jobId) {
    renderLearningCandidates({ candidates: [] });
    return null;
  }
  try {
    const data = await fetchJSON(`/api/jobs/${encodeURIComponent(jobId)}/learning-candidates`);
    renderLearningCandidates(data);
    return data;
  } catch (error) {
    showLearningReviewStatus('error', `Learning review unavailable: ${error.message}`);
    return null;
  }
}

async function saveLearningCandidate(candidateId) {
  const card = document.querySelector(`[data-learning-candidate-id="${CSS.escape(String(candidateId))}"]`);
  const scope = card?.querySelector('[data-learning-scope]')?.value || 'do_not_save';
  const destination = card?.querySelector('[data-learning-destination]')?.value || 'answer_memory';
  const value = card?.querySelector('[data-learning-value]')?.value || '';
  if (scope === 'do_not_save') {
    showLearningReviewStatus('warning', 'Choose a reuse scope, or use Do not save.');
    $('learningReviewStatus')?.focus({ preventScroll: true });
    return;
  }
  const risk = card?.querySelector('.learning-risk-high') ? 'high' : 'normal';
  if (risk === 'high' && !await confirmProductAction({
    title: 'Save this high-risk answer?',
    message: 'This answer will stay local and will still require confirmation before future use. Save only if the value and scope are correct.',
    confirmLabel: 'Save confirmed answer'
  })) return;
  const context = captureUiContext();
  try {
    const result = await fetchJSON(`/api/jobs/${encodeURIComponent(packageReviewJobId)}/learning-candidates/${encodeURIComponent(candidateId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({
        decision: 'save', value, destination, scope,
        confirmed_high_risk: risk === 'high'
      })
    });
    showLearningReviewStatus('ok', result.save_result?.profile_review_required
      ? 'Saved to a new Career Brain draft. Review and approve the draft before it can be reused.'
      : 'Confirmed information saved. Future matching Packages can reuse it within this scope.');
    await loadLearningCandidates(packageReviewJobId);
    if (result.save_result?.profile_review_required) await loadSettings();
    await restoreUiContext({ ...context, package_panel_open: true, selected_job_id: packageReviewJobId });
    $('learningReviewStatus')?.focus({ preventScroll: true });
  } catch (error) {
    showLearningReviewStatus('error', `Information was not saved: ${error.message}`);
    $('learningReviewStatus')?.focus({ preventScroll: true });
  }
}

async function rejectLearningCandidate(candidateId) {
  const context = captureUiContext();
  try {
    await fetchJSON(`/api/jobs/${encodeURIComponent(packageReviewJobId)}/learning-candidates/${encodeURIComponent(candidateId)}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'reject', scope: 'do_not_save' })
    });
    showLearningReviewStatus('ok', 'Information discarded. It will not be saved or reused.');
    await loadLearningCandidates(packageReviewJobId);
    await restoreUiContext({ ...context, package_panel_open: true, selected_job_id: packageReviewJobId });
    $('learningReviewStatus')?.focus({ preventScroll: true });
  } catch (error) {
    showLearningReviewStatus('error', `Information could not be discarded: ${error.message}`);
  }
}

async function reviewApplicationPackage(jobId, { navigate = true, rememberReturn = true } = {}) {
  const panel = $('packageReviewPanel');
  const openingPanel = panel?.classList.contains('hidden') !== false || String(packageReviewJobId) !== String(jobId);
  if (openingPanel && rememberReturn) {
    packagePanelReturnContext = captureUiContext();
    persistPackageReturnContext(packagePanelReturnContext);
  }
  if (navigate && activeView !== 'applications') switchView('applications', { preserveScroll: true });
  try {
    const value = await fetchJSON(`/api/jobs/${encodeURIComponent(jobId)}/application-package`);
    packageReviewJobId = String(jobId);
    const recoveryRequired = value.execution_recovery?.required === true;
    const selectedExecutor = value.selected_executor_type === 'local_browser_agent'
      ? 'local_browser_agent'
      : 'extension';
    $('applicationExecutorMode').value = selectedExecutor;
    const packageJob = value.job_information || {};
    const packageJobLabel = [packageJob.company, packageJob.title]
      .map(item => String(item || '').trim())
      .filter(Boolean)
      .join(' · ');
    $('packageReviewTitle').textContent = packageJobLabel
      ? `Application Package — ${packageJobLabel}`
      : 'Application Package';
    const factSummary = value.resume_intelligence?.summary || {};
    const completion = value.application_completion || {};
    $('packageFactCount').textContent = Number.isFinite(Number(factSummary.available_fact_count))
      ? String(Number(factSummary.available_fact_count))
      : '—';
    $('packageFactCoverage').textContent = Number.isFinite(Number(factSummary.core_fact_coverage_percent))
      ? `${Number(factSummary.core_fact_coverage_percent)}%`
      : '—';
    $('packageCompletionRate').textContent = Number.isFinite(Number(completion.application_completion_rate))
      ? `${Number(completion.application_completion_rate)}%`
      : '—';
    $('packageReviewTime').textContent = Number.isFinite(Number(completion.estimated_user_review_seconds))
      ? `${Number(completion.estimated_user_review_seconds)} sec`
      : '—';
    const missingFacts = Array.isArray(factSummary.missing_core_fact_keys)
      ? factSummary.missing_core_fact_keys
      : [];
    const profileSyncBlocker = (value.execution_readiness?.start_fill_blockers || [])
      .find(item => ['APPROVED_PROFILE_MISSING', 'APPROVED_PROFILE_VERSION_MISSING', 'APPLICATION_PACKAGE_PROFILE_STALE'].includes(item.code));
    $('packageMissingFacts').textContent = profileSyncBlocker
      ? `Package snapshot is not current: ${profileSyncBlocker.message}`
      : missingFacts.length
        ? `Missing core facts: ${missingFacts.map(humanizeToken).join(', ')}. Add or confirm them in Career Brain, approve that version, then rebuild this package.`
      : 'Core candidate facts are available. Sensitive and high-risk answers still require per-application confirmation.';
    const recommendation = value.resume_recommendation || {};
    const candidates = Array.isArray(recommendation.candidates)
      ? recommendation.candidates.filter(candidate => candidate.eligible)
      : [];
    const canRebuildPackage = !recoveryRequired && (
      ['PACKAGE_READY', 'NEEDS_REVIEW', 'APPROVED_FOR_PACKAGE'].includes(value.application_status)
      || (value.application_status === 'FILL_APPROVED' && !value.active_session_id)
    );
    $('packageResumeSelect').innerHTML = candidates.map(candidate =>
      `<option value="${escapeAttr(candidate.resume_id)}">${escapeHtml(candidate.name || 'Resume version')} · v${escapeHtml(String(candidate.version || 1))} · score ${escapeHtml(String(candidate.score ?? 0))}</option>`
    ).join('');
    $('packageResumeSelect').value = value.selected_resume?.resume_id || recommendation.recommended_resume_id || '';
    $('packageResumeSelect').disabled = candidates.length === 0 || !canRebuildPackage;
    $('rebuildPackageResumeBtn').disabled = candidates.length === 0 || !canRebuildPackage;
    const recommendedCandidate = candidates.find(candidate => candidate.resume_id === recommendation.recommended_resume_id);
    $('packageResumeRecommendation').textContent = recommendation.recommended_resume_id
      ? `Recommended: ${recommendedCandidate?.name || 'approved resume version'} (${Math.round(Number(recommendation.confidence || 0) * 100)}% confidence)`
      : 'No approved and verified resume version is eligible.';
    const reasonLabels = (recommendedCandidate?.reasons || []).map(reason => {
      if (reason.kind === 'skill_overlap') return `skills: ${(reason.values || []).join(', ')}`;
      if (reason.value) return `${reason.kind}: ${reason.value}`;
      return reason.kind;
    });
    const recommendationMessage = recommendation.package_uses_recommendation
      ? `Current package uses the recommendation. ${reasonLabels.join(' · ')}`
      : `Current package uses a user-selected version. Recommended evidence: ${reasonLabels.join(' · ') || 'active approved fallback'}.`;
    $('packageResumeReason').textContent = canRebuildPackage
      ? recommendationMessage
      : `${recommendationMessage} Resume version changes are locked after fill begins.`;
    const plannedAnswers = Array.isArray(value.application_answers) && value.application_answers.length
      ? value.application_answers
      : Array.isArray(value.planned_answers) ? value.planned_answers : [];
    const unanswered = Array.isArray(value.unanswered_questions) ? value.unanswered_questions : [];
    const sensitive = Array.isArray(value.sensitive_questions) ? value.sensitive_questions : [];
    const packageResume = value.recommended_resume || value.selected_resume || null;
    const coverLetter = value.cover_letter || value.cover_letter_draft || {};
    const coverLetterReady = Boolean(coverLetter.content)
      && !['needs_user_input', 'not_generated'].includes(coverLetter.status);
    const interviewQuestions = Array.isArray(value.interview_preparation?.possible_questions)
      ? value.interview_preparation.possible_questions
      : [];
    const starStories = Array.isArray(value.star_stories)
      ? value.star_stories
      : Array.isArray(value.interview_preparation?.star_stories)
        ? value.interview_preparation.star_stories
        : Array.isArray(value.interview_preparation?.recommended_stories)
          ? value.interview_preparation.recommended_stories
          : [];
    const missingSkills = Array.isArray(value.missing_skills)
      ? value.missing_skills
      : Array.isArray(value.interview_preparation?.missing_skills)
        ? value.interview_preparation.missing_skills
        : Array.isArray(value.interview_preparation?.gaps_to_prepare)
          ? value.interview_preparation.gaps_to_prepare
          : [];
    const packageRisk = value.risk || { level: 'not_assessed', reasons: [] };
    const approvedPackageProfile = value.approved_profile_version || value.package_binding?.approved_profile || {};
    $('packageProfileVisible').textContent = approvedPackageProfile.profile_id
      ? `v${Number(approvedPackageProfile.version || 1)} · ${approvedPackageProfile.approved_at ? 'Approved' : 'Review required'}`
      : 'Not approved';
    $('packageResumeVisible').textContent = packageResume
      ? `${packageResume.name || 'Resume'} · v${Number(packageResume.version || 1)}`
      : 'Not selected';
    $('packageResumeVisibleDetail').textContent = packageResume
      ? `${packageResume.user_approved || packageResume.approved_at ? 'Approved' : 'Review required'} · Stored as a versioned local resume`
      : 'Choose an approved version below.';
    $('packageCoverLetterState').textContent = humanizeToken(coverLetter.status || (coverLetter.content ? 'draft_ready' : 'needs_review'));
    $('packageCoverLetterPreview').textContent = coverLetter.content || 'No cover letter draft yet. Add or review one before using it.';
    $('packageInterviewQuestionCount').textContent = `${interviewQuestions.length} prepared`;
    $('packageInterviewQuestions').innerHTML = interviewQuestions.length
      ? interviewQuestions.slice(0, 6).map(question => `<li>${escapeHtml(question)}</li>`).join('')
      : '<li>No role-specific questions have been prepared yet.</li>';
    $('packageStarStoryCount').textContent = `${starStories.length} selected`;
    $('packageStarStories').innerHTML = starStories.length
      ? starStories.map(story => `<li><strong>${escapeHtml(story.title || 'Verified story')}</strong> — ${escapeHtml(story.result || story.action || 'Review STAR details')}</li>`).join('')
      : '<li>Add verified stories in Career Brain.</li>';
    $('packageMissingSkillCount').textContent = `${missingSkills.length} identified`;
    $('packageMissingSkills').innerHTML = missingSkills.length
      ? missingSkills.map(item => `<li>${escapeHtml(humanizeToken(item))}</li>`).join('')
      : '<li>No confirmed missing skill.</li>';
    $('packageRiskLevel').textContent = `${humanizeToken(packageRisk.level || 'not_assessed')} risk`;
    $('packageRiskLevel').className = `risk-${escapeAttr(packageRisk.level || 'not_assessed')}`;
    const riskReasons = Array.isArray(packageRisk.reasons) ? packageRisk.reasons : [];
    $('packageRiskReasons').innerHTML = riskReasons.length
      ? riskReasons.map(reason => `<li>${escapeHtml(
          reason === 'career_profile_not_approved' && profileSyncBlocker
            ? `Outdated package profile snapshot — ${profileSyncBlocker.message}`
            : humanizeToken(reason)
        )}</li>`).join('')
      : '<li>No package-specific risk was recorded. Final submission remains manual.</li>';
    const fillStarted = ['EXECUTOR_READY', 'EXECUTING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT', 'MANUALLY_SUBMITTED']
      .includes(value.application_status)
      || (value.application_status === 'NEEDS_REVIEW' && Boolean(value.active_session_id || value.latest_fill_report));
    const readyToOpen = Boolean(value.selected_resume)
      && ['PACKAGE_READY', 'FILL_APPROVED', 'EXECUTOR_READY', 'EXECUTING', 'NEEDS_REVIEW', 'READY_FOR_MANUAL_SUBMIT']
        .includes(value.application_status);
    const canApproveFill = value.application_status === 'PACKAGE_READY'
      && Boolean(value.selected_resume)
      && value.execution_readiness?.can_approve_fill === true;
    const retrySafeFill = value.application_status === 'NEEDS_REVIEW'
      && Boolean(value.active_session_id);
    const canStartFill = ['FILL_APPROVED', 'NEEDS_REVIEW'].includes(value.application_status)
      && value.execution_readiness?.can_start_fill === true;
    const canRestartFillSetup = Boolean(value.active_session_id)
      && ['EXECUTOR_READY', 'EXECUTING', 'NEEDS_REVIEW', 'RECOVERY_REQUIRED'].includes(value.application_status);
    $('recoverApplicationSessionBtn').classList.toggle('hidden', !recoveryRequired);
    $('recoverApplicationSessionBtn').disabled = !recoveryRequired;
    $('restartFillSetupBtn').classList.toggle('hidden', !canRestartFillSetup);
    $('restartFillSetupBtn').disabled = !canRestartFillSetup;
    $('approveFillFromPackageBtn').disabled = !canApproveFill;
    $('startFillFromPackageBtn').disabled = !canStartFill;
    $('startFillFromPackageBtn').dataset.actionMode = retrySafeFill ? 'retry' : 'start';
    $('startFillFromPackageBtn').textContent = retrySafeFill ? 'Retry safe fill' : 'Start AI Fill Assistant';
    $('packageActionHint').textContent = recoveryRequired
      ? 'This application has an older interrupted fill attempt. Recover and rebuild preserves its history, uses the latest explicitly approved profile and active resume, and creates a fresh fill setup.'
      : canApproveFill
      ? 'Review the package, then approve safe field fill.'
      : canStartFill && !retrySafeFill
        ? 'AI Fill Assistant is approved. It fills known fields and pauses for your review before anything is submitted.'
        : value.application_status === 'PACKAGE_READY'
          ? `Cannot approve AI Fill. ${executionBlockerText(value.execution_readiness?.approve_fill_blockers, 'Select an approved resume version first.')}`
          : value.application_status === 'FILL_APPROVED'
            ? `Cannot start fill. ${executionBlockerText(value.execution_readiness?.start_fill_blockers)}`
        : value.application_status === 'NEEDS_REVIEW'
          ? (value.latest_fill_report?.challenge_scope === 'active'
            ? 'Verification required. Complete it manually on the application page, then choose Retry safe fill.'
            : value.latest_fill_report?.challenge_scope === 'passive'
              ? 'Safe fields were filled. Complete the verification and review remaining fields manually; Retry safe fill remains available.'
              : executionBlockerText(value.execution_readiness?.start_fill_blockers, 'Review skipped fields or retry safe fill.'))
        : ['EXECUTOR_READY', 'EXECUTING'].includes(value.application_status)
          ? executionBlockerText(value.execution_readiness?.start_fill_blockers, 'Fill started. Complete any fields that still need you.')
          : value.application_status === 'READY_FOR_MANUAL_SUBMIT'
            ? 'All required fields are ready. Review the page and submit it yourself.'
            : executionBlockerText(value.execution_readiness?.start_fill_blockers, 'Select an approved resume version first.');
    $('packageTimeline').innerHTML = [
      ['Resume selected', Boolean(value.selected_resume), value.selected_resume?.name || (value.selected_resume ? 'Approved resume version' : 'Choose an approved version')],
      ['Answers ready', plannedAnswers.length > 0 && unanswered.length === 0, plannedAnswers.length ? `${plannedAnswers.length} confirmed answer(s)` : 'No reusable answers yet'],
      ['Cover letter ready', coverLetterReady, coverLetterReady ? 'Draft available for review' : 'Optional draft still needs review'],
      ['Fill status', fillStarted, applicationStatusLabel(value.application_status || 'not_started')],
      ['Review needed', unanswered.length + sensitive.length === 0, unanswered.length || sensitive.length ? `${unanswered.length + sensitive.length} question(s) need you` : 'No unresolved questions'],
      ['Ready to open', readyToOpen, readyToOpen ? 'Application can continue under your control' : 'Finish the package first']
    ].map(([label, complete, detail]) => `
      <li class="${complete ? 'complete' : 'waiting'}">
        <span class="timeline-icon">${complete ? '✓' : '○'}</span>
        <div><strong>${escapeHtml(label)}</strong><p>${escapeHtml(detail)}</p></div>
      </li>`).join('');
    $('packageQuestions').innerHTML = unanswered.length || sensitive.length
      ? `<strong>Review needed</strong><p>${escapeHtml([
          ...unanswered.map(item => item.question || item.original_question || item.field_key || String(item)),
          ...sensitive.map(item => item.question || item.original_question || item.field_key || String(item))
        ].slice(0, 5).join(' · '))}</p>`
      : '<strong>Nothing new to answer</strong><p>All known questions are ready. You will still review every field before submitting.</p>';
    $('packageReviewContent').textContent = JSON.stringify({
      application_id: value.application_id,
      package_status: value.package_status,
      selected_resume: value.selected_resume,
      application_status: value.application_status,
      resume_recommendation: value.resume_recommendation,
      resume_intelligence: value.resume_intelligence,
      cover_letter_draft: value.cover_letter_draft,
      planned_answers: value.planned_answers,
      answer_provenance: value.answer_provenance,
      unanswered_questions: value.unanswered_questions,
      sensitive_questions: value.sensitive_questions,
      application_completion: value.application_completion,
      package_version: value.package_version,
      job_information: value.job_information,
      career_profile_reference: value.career_profile_reference,
      package_binding: value.package_binding,
      execution_recovery: value.execution_recovery,
      recommended_resume: value.recommended_resume,
      cover_letter: value.cover_letter,
      application_answers: value.application_answers,
      interview_preparation: value.interview_preparation,
      risk: value.risk,
      approval_safety: value.approval_safety,
      timestamps: value.timestamps,
      safety: value.safety
    }, null, 2);
    panel.classList.remove('hidden');
    await loadExecutorStatus(jobId);
    await loadLearningCandidates(jobId);
    if (openingPanel) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('closePackageReviewBtn')?.focus({ preventScroll: true });
    }
    persistUiContext();
  } catch (err) {
    showRunStatus('error', `Package review failed: ${err.message}`);
  }
}

async function closeApplicationPackagePanel() {
  $('packageReviewPanel').classList.add('hidden');
  packageReviewJobId = '';
  const returnContext = packagePanelReturnContext;
  packagePanelReturnContext = null;
  persistPackageReturnContext(null);
  if (returnContext) await restoreUiContext({
    ...returnContext,
    package_panel_open: false,
    selected_job_id: ''
  });
  else persistUiContext();
}

async function rebuildPackageWithSelectedResume() {
  const resumeId = $('packageResumeSelect').value;
  if (!packageReviewJobId || !resumeId) return;
  try {
    setRowButtonsDisabled(true);
    $('rebuildPackageResumeBtn').disabled = true;
    const result = await fetchJSON(`/api/jobs/${encodeURIComponent(packageReviewJobId)}/build-package-preview`, {
      method: 'POST',
      body: JSON.stringify({ resume_id: resumeId })
    });
    showRunStatus('ok', `Package rebuilt with ${result.resume_selection?.selected_resume?.name || 'the selected resume version'}.`);
    await refreshAll();
    await reviewApplicationPackage(packageReviewJobId);
  } catch (err) {
    showRunStatus('error', `Resume override failed: ${err.message}`);
    await reviewApplicationPackage(packageReviewJobId);
  } finally {
    setRowButtonsDisabled(false);
  }
}

async function recoverApplicationExecution(jobId) {
  if (!await confirmProductAction({
    title: 'Recover and rebuild this application?',
    message: 'This preserves the interrupted attempt, reports, and history. It clears only the stale fill state, revokes the old fill approval, and rebuilds with the latest explicitly approved Career Profile and active approved Resume Version. It will not open a browser, upload a resume, or submit anything.',
    confirmLabel: 'Recover and rebuild'
  })) return;
  const executorType = $('applicationExecutorMode')?.value === 'local_browser_agent'
    ? 'local_browser_agent'
    : 'extension';
  const key = recoveryIdempotencyKeys.get(String(jobId))
    || (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `recover-${jobId}-${Date.now()}`);
  recoveryIdempotencyKeys.set(String(jobId), key);
  try {
    $('recoverApplicationSessionBtn').disabled = true;
    showRunStatus('running', 'Preserving the interrupted run and rebuilding the application setup...');
    const result = await fetchJSON(`/api/jobs/${encodeURIComponent(jobId)}/recover-execution`, {
      method: 'POST',
      body: JSON.stringify({
        confirmed: true,
        idempotency_key: key,
        executor_type: executorType
      })
    });
    showRunStatus('ok', result.idempotent_replay
      ? 'Recovery was already completed. The same draft fill attempt is ready for review.'
      : 'Recovery complete. Review the rebuilt package and approve safe field fill when ready.');
    await refreshAll();
    await reviewApplicationPackage(jobId);
  } catch (error) {
    showRunStatus('error', `Recovery failed: ${executionBlockerText(error.details?.blockers, error.message)}`);
    await reviewApplicationPackage(jobId);
  }
}

async function restartFillSetup(jobId) {
  const executorType = $('applicationExecutorMode')?.value === 'local_browser_agent'
    ? 'local_browser_agent'
    : 'extension';
  if (!await confirmProductAction({
    title: 'Restart fill setup?',
    message: 'This safely closes a controlled browser started by this Dashboard, preserves the previous attempt and reports, and returns the application to Package review so you can choose a fill method again. It does not upload or submit anything.',
    confirmLabel: 'Restart setup'
  })) return;
  try {
    $('restartFillSetupBtn').disabled = true;
    showRunStatus('running', 'Preserving the previous attempt and restarting fill setup...');
    await fetchJSON(`/api/jobs/${encodeURIComponent(jobId)}/restart-fill-setup`, {
      method: 'POST',
      body: JSON.stringify({
        confirmed: true,
        executor_type: executorType,
        idempotency_key: globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `restart-${jobId}-${Date.now()}`
      })
    });
    showProductToast('ok', 'Fill setup restarted');
    await refreshAll();
    await reviewApplicationPackage(jobId);
  } catch (error) {
    showRunStatus('error', `Fill setup could not restart: ${error.message}`);
    await reviewApplicationPackage(jobId);
  }
}

async function saveExecutorSelection() {
  updateExecutorModeDescription();
  if (!packageReviewJobId) return;
  const selector = $('applicationExecutorMode');
  const executorType = selector.value === 'local_browser_agent' ? 'local_browser_agent' : 'extension';
  try {
    selector.disabled = true;
    const result = await fetchJSON(`/api/jobs/${encodeURIComponent(packageReviewJobId)}/executor-selection`, {
      method: 'POST',
      body: JSON.stringify({ executor_type: executorType })
    });
    showProductToast('ok', result.executor_type === 'local_browser_agent'
      ? 'Local Browser Agent selected'
      : 'Chrome Extension selected');
    await loadExecutorStatus(packageReviewJobId);
  } catch (error) {
    showRunStatus('error', `Fill method was not saved: ${error.message}`);
    await loadExecutorStatus(packageReviewJobId);
  }
}

async function approveFill(jobId) {
  if (!await confirmProductAction({
    title: 'Approve safe field fill?',
    message: 'Confirm that you reviewed the selected resume, planned answers, unanswered questions, and sensitive questions.',
    confirmLabel: 'Approve AI Fill'
  })) return;
  const result = await postJobAction(
    `/api/jobs/${encodeURIComponent(jobId)}/approve-fill`,
    'fill approved',
    {
      confirmed: true,
      executor_type: $('applicationExecutorMode')?.value === 'local_browser_agent' ? 'local_browser_agent' : 'extension',
      idempotency_key: `prepare-${jobId}-${Date.now()}`
    }
  );
  if (result && !$('packageReviewPanel').classList.contains('hidden')) {
    await reviewApplicationPackage(jobId);
  }
}

async function startFill(jobId, options = {}) {
  const executorMode = $('applicationExecutorMode')?.value === 'local_browser_agent' ? 'local_browser_agent' : 'extension';
  const advanced = executorMode === 'local_browser_agent';
  const retry = options.retry === true || $('startFillFromPackageBtn')?.dataset.actionMode === 'retry';
  if (!await confirmProductAction({
    title: retry ? 'Retry safe fill?' : 'Start AI Fill Assistant?',
    message: advanced
      ? `${retry ? 'The existing fill attempt and Package will be reused. ' : ''}Local Browser Agent opens or reconnects to a visible dedicated Chrome window, fills reviewed safe text fields, saves diagnostics, and pauses. You must handle uploads, login, CAPTCHA, MFA, sensitive questions, and final Submit manually.`
      : 'This opens the selected job URL in a new tab. The Chrome Extension fills known safe fields and pauses for your review. You must handle uploads, login, CAPTCHA, MFA, sensitive questions, and final Submit manually.',
    confirmLabel: retry ? 'Retry safe fill' : 'Start AI Fill Assistant'
  })) return;
  const handoffWindow = advanced ? null : window.open('about:blank', '_blank');
  if (handoffWindow) handoffWindow.opener = null;
  try {
    showRunStatus('running', 'Preparing application...');
    jobId = String(jobId);
    if (retry) fillIdempotencyKeys.delete(jobId);
    const idempotencyKey = fillIdempotencyKeys.get(jobId)
      || (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `fill-${jobId}-${Date.now()}`);
    fillIdempotencyKeys.set(jobId, idempotencyKey);
    const result = await fetchJSON(`/api/jobs/${encodeURIComponent(jobId)}/start-fill`, {
      method: 'POST',
      body: JSON.stringify({ confirmed: true, idempotency_key: idempotencyKey, executor_mode: executorMode })
    });
    showRunStatus('running', advanced
      ? 'Preparing application... The supervised browser is starting.'
      : 'Application ready. Opening the application page and waiting for the extension to connect...');
    await refreshAll();
    if (!$('packageReviewPanel').classList.contains('hidden')) {
      await reviewApplicationPackage(jobId);
    }
    scheduleExecutorStatus(jobId);
    if (result.handoff?.job_url && handoffWindow) {
      handoffWindow.location.replace(result.handoff.job_url);
    } else if (result.handoff?.job_url) {
      const handoffUrl = new URL(result.handoff.job_url, window.location.href);
      if (
        ['127.0.0.1', 'localhost'].includes(handoffUrl.hostname)
        && handoffUrl.pathname.startsWith('/mock-ats/')
      ) {
        window.location.assign(handoffUrl.toString());
      } else {
        showApplicationHandoffFallback(handoffUrl.toString());
      }
    } else if (handoffWindow) {
      handoffWindow.close();
    }
  } catch (err) {
    if (handoffWindow) handoffWindow.close();
    showRunStatus('error', `AI Fill Assistant failed to start: ${executionBlockerText(err.details?.blockers, err.message)}`);
  }
}

function renderExecutorStatus(value = {}) {
  latestExecutorStatus = value;
  const counts = value.fields || {};
  const profile = value.approved_profile_version || {};
  $('executorSessionId').textContent = value.session_id || 'Not created';
  $('executorJobId').textContent = value.job_id || 'Not selected';
  $('executorPackageId').textContent = value.package_id || 'Not selected';
  $('executorProfileVersion').textContent = profile.profile_id
    ? `${profile.profile_id} · v${Number(profile.version || 0)} · ${profile.approved_at ? 'approved' : 'not approved'} · ${profile.snapshot_digest ? `digest ${String(profile.snapshot_digest).slice(0, 16)}` : 'digest unavailable'}`
    : 'Not approved';
  $('executorType').textContent = value.executor === 'local_browser_agent' ? 'Local Browser Agent' : 'Chrome Extension';
  $('executorTargetUrl').textContent = value.url || 'Not selected';
  $('executorConnected').textContent = value.connected ? 'Yes' : 'No';
  $('executorRunStatus').textContent = applicationStatusLabel(value.execution_status || value.status || 'not_started');
  $('executorFieldCounts').textContent = `${Number(counts.detected || 0)} detected · ${Number(counts.filled || 0)} filled · ${Number(counts.skipped || 0)} skipped${Number(counts.failed || 0) ? ` · ${Number(counts.failed)} failed` : ''}`;
  $('executorBlockers').textContent = executionBlockerText(
    value.blockers,
    value.user_message || (value.session_id ? 'Review the execution result and choose an available next action.' : 'Start AI Fill Assistant when this package is ready.')
  );
  $('executorReasons').textContent = Array.isArray(value.reasons) && value.reasons.length
    ? value.reasons.map(humanizeToken).join(' · ')
    : 'None yet';
  const reasonGroups = value.reason_groups && typeof value.reason_groups === 'object' ? value.reason_groups : {};
  $('executorReasonGroups').textContent = Object.entries(reasonGroups).length
    ? Object.entries(reasonGroups).map(([reason, count]) => `${humanizeToken(reason)}: ${Number(count || 0)}`).join(' / ')
    : 'No skipped fields recorded.';
  const canReviewExecution = value.execution_status === 'NEEDS_REVIEW';
  const readyForManualSubmit = value.execution_status === 'READY_FOR_MANUAL_SUBMIT';
  $('openApplicationPageBtn')?.classList.toggle('hidden', !(canReviewExecution || readyForManualSubmit) || !value.url);
  $('reviewSkippedFieldsBtn')?.classList.toggle('hidden', !canReviewExecution);
  $('reviewRescanBtn')?.classList.toggle('hidden', !canReviewExecution);
  $('markReviewCompleteBtn')?.classList.toggle('hidden', !canReviewExecution);
  $('markSubmittedFromPackageBtn')?.classList.toggle('hidden', !readyForManualSubmit);
  $('startFillFromPackageBtn')?.classList.toggle('hidden', readyForManualSubmit);
  const scan = value.latest_review_rescan;
  if (canReviewExecution && scan) {
    $('executorBlockers').textContent = scan.high_risk_blockers?.length
      ? scan.high_risk_blockers.map(item => item.message || humanizeToken(item.code)).join(' ')
      : `Latest re-scan: ${Number(scan.required_filled_count || 0)}/${Number(scan.required_count || 0)} required fields filled. You may confirm review complete.`;
  }
  if (canReviewExecution && $('startFillFromPackageBtn')) {
    $('startFillFromPackageBtn').dataset.actionMode = 'retry';
    $('startFillFromPackageBtn').textContent = value.challenge_scope === 'active'
      ? 'I completed verification — retry'
      : 'Retry safe fill';
    $('startFillFromPackageBtn').disabled = value.can_start_fill !== true;
  }
  if (value.session_id && $('applicationExecutorMode')) {
    $('applicationExecutorMode').value = value.executor === 'local_browser_agent' ? 'local_browser_agent' : 'extension';
    $('applicationExecutorMode').disabled = value.execution_status !== 'SESSION_CREATED';
  } else if ($('applicationExecutorMode')) {
    $('applicationExecutorMode').disabled = false;
  }
  updateExecutorModeDescription();
}

function openCurrentApplicationPage() {
  const targetUrl = latestExecutorStatus?.url;
  if (!targetUrl) return showRunStatus('error', 'No application page is available for the current fill attempt.');
  openJobURL(targetUrl);
}

function toggleSkippedFieldSummary() {
  const details = $('executorSkippedDetails');
  if (!details) return;
  details.classList.toggle('hidden');
  $('reviewSkippedFieldsBtn').textContent = details.classList.contains('hidden') ? 'Review skipped fields' : 'Hide skipped fields';
}

async function requestApplicationReviewRescan() {
  if (!packageReviewJobId) return;
  try {
    showRunStatus('running', 'Reconnecting to the controlled application page and checking required fields...');
    await fetchJSON(`/api/jobs/${encodeURIComponent(packageReviewJobId)}/review-rescan`, {
      method: 'POST',
      body: JSON.stringify({ scan_id: `review-rescan-${packageReviewJobId}-${Date.now()}` })
    });
    showRunStatus('running', 'Application re-scan started. Results will update automatically.');
    scheduleExecutorStatus(packageReviewJobId, 20);
  } catch (error) {
    showRunStatus('error', formatTransitionBlocker(error, 'Re-scan application'));
  }
}

async function markApplicationReviewComplete() {
  if (!packageReviewJobId) return;
  if (!await confirmProductAction({
    title: 'Mark application review complete?',
    message: 'Confirm that you reviewed the current application form and completed all remaining required fields. Resume Jobs will verify the latest re-scan before advancing. Final submission remains entirely manual.',
    confirmLabel: 'Confirm Review Complete'
  })) return;
  const result = await postJobAction(
    `/api/jobs/${encodeURIComponent(packageReviewJobId)}/review-complete`,
    'Application review complete. Ready for manual submission',
    { confirmed: true, application_session_id: latestExecutorStatus?.session_id || '' }
  );
  if (result) await reviewApplicationPackage(packageReviewJobId);
}

async function loadExecutorStatus(jobId = packageReviewJobId) {
  if (!jobId || !$('executorStatusPanel')) return;
  try {
    renderExecutorStatus(await fetchJSON(`/api/executor/status?job_id=${encodeURIComponent(jobId)}`));
  } catch (error) {
    renderExecutorStatus({ status: 'diagnostics_unavailable', reasons: [error.message] });
  }
}

function scheduleExecutorStatus(jobId, attempts = 12) {
  if (executorStatusTimer) clearTimeout(executorStatusTimer);
  if (!jobId || attempts <= 0) return;
  executorStatusTimer = setTimeout(async () => {
    await loadExecutorStatus(jobId);
    scheduleExecutorStatus(jobId, attempts - 1);
  }, 1500);
}

function updateExecutorModeDescription() {
  if (!$('executorModeDescription') || !$('applicationExecutorMode')) return;
  $('executorModeDescription').textContent = $('applicationExecutorMode').value === 'local_browser_agent'
    ? 'Advanced mode: launches a visible local Chrome session with screenshots and a redacted execution report.'
    : 'Recommended normal mode: the Chrome Extension connects to this approved package on the exact job URL.';
  const localBrowserAgent = $('applicationExecutorMode').value === 'local_browser_agent';
  $('extensionConnectionSection')?.classList.toggle('hidden', localBrowserAgent);
}

async function markSubmittedManually(jobId) {
  if (!await confirmProductAction({
    title: 'Record manual submission?',
    message: 'Confirm that you personally completed the final Submit on the job site. This records only the local status and does not submit anything.',
    confirmLabel: 'Record Submitted'
  })) return;
  await postJobAction(`/api/jobs/${encodeURIComponent(jobId)}/submitted-manually`, 'manual submission recorded', { confirmed: true });
}

async function postJobAction(url, successMessage, body = {}) {
  try {
    localMutationPending = true;
    setRowButtonsDisabled(true);
    const result = await fetchJSON(url, { method: 'POST', body: JSON.stringify(body) });
    showRunStatus('ok', `${successMessage}. Backup: ${result.backup || 'n/a'}`);
    await refreshAll();
    await loadSettings();
    return result;
  } catch (err) {
    const message = formatTransitionBlocker(err, successMessage);
    showRunStatus('error', message);
    if (url.startsWith('/api/jobs/')) showJobWorkflowNotice('error', message);
    return null;
  } finally {
    localMutationPending = false;
    setRowButtonsDisabled(false);
  }
}

async function runPipeline(action) {
  const labels = {
    discovery: 'Run Discovery',
    scoring: 'Run Scoring',
    'ai-enrichment': 'Run AI Enrichment',
    'approval-queue': 'Build Approval Queue'
  };
  try {
    setRunning(true, { type: action, started_at: new Date().toISOString() });
    showRunStatus('running', `${labels[action]} started...`);
    const result = await fetchJSON(`/api/run/${action}`, { method: 'POST', body: JSON.stringify({}) });
    if (action === 'discovery') $('offlineDemoOption')?.classList.add('hidden');
    showRunStatus(result.status === 'completed' ? 'ok' : 'error', formatRunResult(result));
    await refreshAll();
    await loadSettings();
    return result.status === 'completed' ? result : null;
  } catch (err) {
    if (action === 'discovery' && err.details?.code === 'LIVE_SEARCH_NOT_CONFIGURED') {
      $('offlineDemoOption')?.classList.remove('hidden');
    }
    const requirements = err.details?.requirements
      ? ` Required: ${Object.values(err.details.requirements).join('; ')}.`
      : '';
    showRunStatus('error', `${err.details?.message || err.message}${requirements}`);
    return null;
  } finally {
    setRunning(false);
  }
}

function setRunning(running, detail = null) {
  isRunning = running;
  ['runDiscoveryBtn', 'runScoringBtn', 'runApprovalQueueBtn', 'buildSelectedPackagesBtn', 'findMatchingJobsBtn', 'importJobUrlBtn'].forEach(id => {
    const btn = $(id);
    if (btn) btn.disabled = running;
  });
  if (detail && running) {
    showRunStatus('running', `Running ${detail.type || 'job'} since ${detail.started_at || 'now'}`);
  }
}

function setRowButtonsDisabled(disabled) {
  if (!disabled) {
    renderJobsTable();
    return;
  }
  document.querySelectorAll('.job-card-actions button, .job-match-card details button').forEach(btn => { btn.disabled = disabled; });
}

function showRunStatus(type, message) {
  const box = $('runStatus');
  box.className = `run-status ${type}`;
  box.textContent = message;
  if (type === 'ok') showProductToast('ok', String(message || '').split('\n')[0]);
}

function formatRunResult(result) {
  const label = humanizeToken(result.run_type || 'run');
  const filesTouched = Array.isArray(result.files_touched) ? result.files_touched.length : 0;
  const message = String(result.message || '').trim();
  return `${label} ${humanizeToken(result.status || 'completed')}.${message ? ` ${message}` : ''}${filesTouched ? ` ${filesTouched} local file(s) updated.` : ''}`;
}

async function refreshAll({ context = settingsData ? captureUiContext() : null, restorePanel = false } = {}) {
  if (settingsDirty && !await confirmProductAction({
    title: 'Refresh with unsaved settings?',
    message: 'Your Settings edits are still unsaved. Refreshing product data will keep the edits on screen, but they are not yet stored.',
    confirmLabel: 'Refresh Data'
  })) return;
  try {
    await loadWorkflow();
    await Promise.all([loadSummary(), loadJobs(), loadProviderHealth(), loadDailyAutomationStatus()]);
    if (context) await restoreUiContext(context, { restorePanel });
  } catch (err) {
    showRunStatus('error', `Refresh failed. One or more product sections could not be loaded. ${err.message}`);
  }
}

function clearStaleMutationErrors() {
  const runStatus = $('runStatus');
  if (runStatus?.classList.contains('error')) {
    runStatus.className = 'run-status';
    runStatus.textContent = '';
  }
  const workflowNotice = $('jobWorkflowNotice');
  if (workflowNotice?.classList.contains('error')) {
    workflowNotice.className = 'settings-status hidden';
    workflowNotice.textContent = '';
  }
}

async function refreshCanonicalProductState(event = null, { notify = false } = {}) {
  const context = captureUiContext();
  try {
    await loadWorkflow();
    await Promise.all([loadSummary(), loadJobs()]);
    if (packageReviewJobId && !$('packageReviewPanel')?.classList.contains('hidden')) {
      await reviewApplicationPackage(packageReviewJobId, { navigate: false, rememberReturn: false });
    } else if (event?.job_id && String(event.job_id) === String(packageReviewJobId)) {
      await loadExecutorStatus(packageReviewJobId);
    }
    clearStaleMutationErrors();
    await restoreUiContext(context);
    if (notify && event?.message) showProductToast('ok', event.message);
    return true;
  } catch (error) {
    if (notify) showRunStatus('error', `Automatic update failed: ${error.message}`);
    return false;
  }
}

function queueReactiveRefresh(event) {
  if (!event || event.event_type === 'CONNECTED') return;
  pendingReactiveEvent = {
    ...event,
    suppress_toast: localMutationPending || event.suppress_toast === true
  };
  if (reactiveRefreshTimer) clearTimeout(reactiveRefreshTimer);
  reactiveRefreshTimer = setTimeout(async () => {
    const nextEvent = pendingReactiveEvent;
    pendingReactiveEvent = null;
    reactiveRefreshTimer = null;
    await refreshCanonicalProductState(nextEvent, { notify: nextEvent?.suppress_toast !== true });
  }, 180);
}

function startReactivePollingFallback() {
  if (dashboardPollingTimer) return;
  dashboardPollingTimer = setInterval(() => refreshCanonicalProductState(null, { notify: false }), 5000);
}

function stopReactivePollingFallback() {
  if (!dashboardPollingTimer) return;
  clearInterval(dashboardPollingTimer);
  dashboardPollingTimer = null;
}

function startDashboardEventStream() {
  if (!globalThis.EventSource || dashboardEventSource) {
    if (!globalThis.EventSource) startReactivePollingFallback();
    return;
  }
  dashboardEventSource = new EventSource('/api/events');
  dashboardEventSource.addEventListener('dashboard-update', event => {
    try {
      queueReactiveRefresh(JSON.parse(event.data));
    } catch {
      startReactivePollingFallback();
    }
  });
  dashboardEventSource.onopen = () => stopReactivePollingFallback();
  dashboardEventSource.onerror = () => startReactivePollingFallback();
}

function openJobURL(url) {
  try {
    const target = new URL(String(url || ''));
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('unsupported');
    window.open(target.toString(), '_blank', 'noopener,noreferrer');
  } catch {
    showProductToast('error', 'This job does not have a valid public web address.');
  }
}

function getScoreClass(score) {
  const n = Number(score) || 0;
  if (n >= 90) return 'excellent';
  if (n >= 80) return 'high';
  if (n >= 70) return 'medium';
  return 'low';
}

function display(value) {
  return value === undefined || value === null || value === '' ? '—' : String(value);
}

function humanizeToken(value) {
  return display(value)
    .replace(/^required_skill:/, '')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function applicationStatusLabel(value) {
  const normalized = String(value || '').trim().toUpperCase();
  const labels = {
    DISCOVERED: 'New',
    REVIEW_PENDING: 'Review job',
    SAVED: 'Saved',
    REJECTED: 'Rejected',
    APPROVED: 'Approved',
    APPROVED_FOR_PACKAGE: 'Ready to prepare',
    PACKAGE_READY: 'Ready to review',
    FILL_APPROVED: 'AI Fill approved',
    SESSION_CREATED: 'Ready to start',
    EXECUTOR_READY: 'AI Fill starting',
    EXECUTING: 'AI Fill in progress',
    NEEDS_REVIEW: 'Needs your review',
    READY_FOR_MANUAL_SUBMIT: 'Ready for your submission',
    MANUALLY_SUBMITTED: 'Submitted (recorded)',
    RECOVERY_REQUIRED: 'Needs recovery',
    CANCELLED: 'Cancelled',
    MANUAL_ONLY: 'Apply manually',
    UNSUPPORTED: 'Not supported',
    NOT_STARTED: 'Not started',
    SESSION_NOT_CREATED: 'Not started',
    DIAGNOSTICS_UNAVAILABLE: 'Status unavailable'
  };
  return labels[normalized] || humanizeToken(value || 'not_started');
}

function escapeHtml(value) {
  return display(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttr(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function jsString(value) {
  return JSON.stringify(value === undefined || value === null ? '' : String(value))
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

async function loadSettings() {
  try {
    const data = await fetchJSON('/api/settings');
    settingsData = normalizeSettingsForUi(data);
    settingsDirty = false;
    renderProductReadiness(data.product_readiness);
    renderSettings();
    loadExtensionDiagnostics();
    loadAnswerMemoryList();
    if (allJobs.length) renderJobsTable();
    showSettingsStatus('ok', 'settings loaded');
    updateUxState();
  } catch (err) {
    renderProductReadiness(null, err.message);
    showSettingsStatus('error', `Settings could not be loaded: ${err.message}. Jobs Dashboard is still usable.`);
  }
}

function extensionDiagnosticCard(label, value, state = '') {
  return `<article class="extension-diagnostic-card ${escapeAttr(state)}">
    <span>${escapeHtml(label)}</span>
    <strong>${escapeHtml(value || '—')}</strong>
  </article>`;
}

function renderExtensionDiagnostics(data) {
  const container = $('extensionConnectionDiagnostics');
  if (!container) return;
  const installed = data?.extension_installed === true || extensionPageBridge.observed;
  const connected = data?.extension_connected === true;
  const contentConnected = data?.content_script_connected === true;
  const handoff = data?.active_handoff === true;
  container.innerHTML = `
    ${extensionDiagnosticCard('AI Fill Assistant', installed ? 'Installed' : 'Setup needed', installed ? 'ok' : 'warning')}
    ${extensionDiagnosticCard('Dashboard connection', extensionPageBridge.observed ? 'Ready' : 'Waiting', extensionPageBridge.observed ? 'ok' : 'warning')}
    ${extensionDiagnosticCard('Assistant connection', connected ? 'Ready' : 'Waiting', connected ? 'ok' : 'warning')}
    ${extensionDiagnosticCard('Application page', contentConnected ? 'Ready' : 'Waiting', contentConnected ? 'ok' : 'warning')}
    ${extensionDiagnosticCard('Application', handoff ? 'Ready' : 'Not started', handoff ? 'ok' : 'warning')}
    ${extensionDiagnosticCard('Current page', data?.current_tab || 'Not connected')}
    ${extensionDiagnosticCard('Application context', data?.matched_application_id ? 'Ready' : 'Not started')}
    ${extensionDiagnosticCard('Job context', data?.matched_job_id ? 'Ready' : 'Not started')}
    <p class="extension-diagnostic-guidance">${escapeHtml(data?.guidance || 'Open the extension popup on a supported application page.')}</p>
    <details class="advanced-disclosure compact"><summary>Advanced diagnostics</summary>
      <div class="extension-diagnostic-grid">
        ${extensionDiagnosticCard('Execution session', data?.matched_session_id ? 'Ready' : 'Not started', data?.matched_session_id ? 'ok' : 'warning')}
        ${extensionDiagnosticCard('Additional setup', data?.native_messaging?.required ? 'Required' : 'None', data?.native_messaging?.required ? 'warning' : 'ok')}
      </div>
      <small>Last job-tab heartbeat: ${escapeHtml(data?.last_seen || 'Never')} · Extension version: ${escapeHtml(data?.extension_version || extensionPageBridge.version || 'Unknown')} · Transport: ${escapeHtml(data?.transport || 'localhost_http')}</small>
    </details>`;
}

async function loadExtensionDiagnostics() {
  const container = $('extensionConnectionDiagnostics');
  if (!container) return;
  pingInstalledExtension();
  try {
    latestExtensionDiagnostics = await fetchJSON('/api/extension/diagnostics');
    renderExtensionDiagnostics(latestExtensionDiagnostics);
  } catch (error) {
    container.innerHTML = '<p class="error">AI Fill Assistant connection status is unavailable. Restart the Dashboard, reload the extension, and try again.</p>';
  }
}

function pingInstalledExtension() {
  const nonce = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  extensionPageBridge = { ...extensionPageBridge, nonce };
  window.postMessage({
    source: 'resume-jobs-dashboard',
    type: 'RESUME_JOBS_EXTENSION_PING',
    nonce
  }, location.origin);
}

window.addEventListener('message', (event) => {
  const message = event?.data;
  if (event.source !== window || !message || message.source !== 'resume-jobs-extension') return;
  if (message.type !== 'RESUME_JOBS_EXTENSION_PONG' || message.nonce !== extensionPageBridge.nonce) return;
  extensionPageBridge = {
    observed: message.content_script_ready === true,
    version: String(message.extension_version || '').slice(0, 32),
    nonce: extensionPageBridge.nonce
  };
  renderExtensionDiagnostics(latestExtensionDiagnostics || {});
});

function updateExtensionDiagnosticsPolling(view) {
  if (extensionDiagnosticsTimer) {
    clearInterval(extensionDiagnosticsTimer);
    extensionDiagnosticsTimer = null;
  }
  if (view !== 'ai-settings' || $('applicationExecutorMode')?.value === 'local_browser_agent') return;
  loadExtensionDiagnostics();
  extensionDiagnosticsTimer = setInterval(loadExtensionDiagnostics, 5000);
}

function renderProductReadiness(readiness, error = '') {
  const percent = $('readinessPercent');
  const checklist = $('readinessChecklist');
  const nextStep = $('readinessNextStep');
  if (!percent || !checklist || !nextStep) return;
  if (!readiness) {
    percent.textContent = '—';
    checklist.innerHTML = `<li>${escapeHtml(error ? 'Setup status unavailable' : 'Checking your local setup…')}</li>`;
    nextStep.textContent = error ? `Could not read setup: ${error}` : 'Loading next step…';
    return;
  }
  const labels = {
    resume_file_available: 'Resume uploaded',
    candidate_facts_available: 'AI Profile created',
    candidate_facts_confirmed: 'Profile reviewed',
    search_goal_configured: 'Job search configured',
    answer_memory_started: 'Answer Memory started'
  };
  const checks = readiness.checks || {};
  const guidedChecks = {
    resume_file_available: Boolean(checks.resume_selected && checks.resume_file_available),
    candidate_facts_available: Boolean(checks.resume_selected && checks.resume_file_available && checks.candidate_facts_available),
    candidate_facts_confirmed: Boolean(checks.resume_selected && checks.resume_file_available && checks.candidate_facts_confirmed),
    search_goal_configured: Boolean(checks.resume_selected && checks.resume_file_available && checks.candidate_facts_confirmed && checks.search_goal_configured),
    answer_memory_started: Boolean(checks.resume_selected && checks.resume_file_available && checks.candidate_facts_confirmed && checks.answer_memory_started)
  };
  const completion = Math.round((Object.values(guidedChecks).filter(Boolean).length / Object.keys(guidedChecks).length) * 100);
  percent.textContent = `${completion}%`;
  checklist.innerHTML = Object.entries(labels).map(([key, label]) => (
    `<li class="${guidedChecks[key] ? 'ready' : ''}">${escapeHtml(label)}</li>`
  )).join('');
  if (!guidedChecks.resume_file_available) {
    nextStep.textContent = 'Next: upload one PDF, DOCX, or UTF-8 TXT resume.';
  } else if (!guidedChecks.candidate_facts_available) {
    nextStep.textContent = 'Next: review the local resume and available Profile facts.';
  } else if (!guidedChecks.candidate_facts_confirmed) {
    nextStep.textContent = 'Next: review and approve your AI Profile.';
  } else if (!guidedChecks.search_goal_configured) {
    nextStep.textContent = 'Next: create your first Job Search.';
  } else {
    nextStep.textContent = `Setup complete. ${Number(readiness.confirmed_answer_count || 0)} confirmed answers can be reused.`;
  }
}

function calculateUxState() {
  const workflowState = settingsData?.workflow_state;
  const legacyUnlocked = new Set(Array.isArray(workflowState?.unlocked_views) ? workflowState.unlocked_views : ['home', 'resume']);
  unlockedViews = new Set(['career-brain', 'ai-settings', 'interview-preparation']);
  if (legacyUnlocked.has('job-search')) unlockedViews.add('job-discovery');
  if (legacyUnlocked.has('job-matches')) unlockedViews.add('job-matches');
  if (legacyUnlocked.has('applications')) unlockedViews.add('applications');
  return workflowState?.current_step || {
    number: 1,
    key: 'resume_uploaded',
    title: 'Upload your resume',
    detail: 'Add one PDF, DOCX, or UTF-8 TXT file to start.',
    action: 'Upload Resume',
    view: 'resume',
    complete: false
  };
}

function updateUxState() {
  currentUxStep = calculateUxState();
  const currentIndex = currentUxStep.number;
  const workflow = $('workflowProgress');
  if (workflow) {
    workflow.querySelectorAll('[data-workflow-step]').forEach(item => {
      const number = Number(item.dataset.workflowStep);
      item.classList.toggle('complete', number < currentIndex || (number === 10 && currentUxStep.complete));
      item.classList.toggle('current', number === currentIndex);
      item.classList.toggle('future', number > currentIndex);
    });
  }
  if ($('workflowCurrentLabel')) $('workflowCurrentLabel').textContent = `Step ${currentUxStep.number} · ${currentUxStep.title}`;
  if ($('workflowNextLabel')) $('workflowNextLabel').textContent = currentUxStep.detail;
  if ($('globalNextStepBtn')) $('globalNextStepBtn').textContent = currentUxStep.action;
  if ($('onboardingTitle')) $('onboardingTitle').textContent = currentUxStep.title;
  if ($('onboardingDescription')) $('onboardingDescription').textContent = currentUxStep.detail;
  if ($('startSetupBtn')) $('startSetupBtn').textContent = currentUxStep.action;

  const tabMap = {
    'career-brain': 'homeTabBtn',
    'job-discovery': 'jobSearchTabBtn',
    'job-matches': 'jobMatchesTabBtn',
    applications: 'applicationsTabBtn',
    'interview-preparation': 'interviewPrepTabBtn',
    'ai-settings': 'settingsTabBtn'
  };
  Object.entries(tabMap).forEach(([view, id]) => {
    const button = $(id);
    const unlocked = unlockedViews.has(view);
    button.disabled = !unlocked;
    button.classList.toggle('locked', !unlocked);
    button.setAttribute('aria-disabled', String(!unlocked));
    button.title = unlocked ? '' : lockedViewMessage(view);
  });
  renderHomeDashboard();
  if (!unlockedViews.has(activeView)) switchView('career-brain');
}

function lockedViewMessage(view) {
  const messages = {
    'job-discovery': 'Review and approve your Career Brain first.',
    'job-matches': 'Create a Job Search first.',
    applications: 'Approve at least one Job Match first.',
    'ai-settings': 'AI settings are always available.'
  };
  return messages[view] || 'Complete the previous step first.';
}

function goToCurrentUxStep() {
  switchView(currentUxStep.view);
}

function normalizeSettingsForUi(data) {
  const search = data.search_preferences || {};
  const resumes = data.resume_profiles || { active_resume_profile_id: '', items: [] };
  search.search_profiles = Array.isArray(search.search_profiles) ? search.search_profiles : [];
  search.active_search_profile_id = search.active_search_profile_id || search.search_profiles[0]?.id || '';
  search.search_profiles.forEach(profile => {
    profile.target_roles = Array.isArray(profile.target_roles) ? profile.target_roles : [];
    profile.preferred_locations = Array.isArray(profile.preferred_locations) ? profile.preferred_locations : [];
    profile.excluded_keywords = Array.isArray(profile.excluded_keywords) ? profile.excluded_keywords : [];
    profile.required_skills = Array.isArray(profile.required_skills) ? profile.required_skills : [];
    profile.preferred_skills = Array.isArray(profile.preferred_skills) ? profile.preferred_skills : [];
    profile.excluded_companies = Array.isArray(profile.excluded_companies) ? profile.excluded_companies : [];
  });
  search.preferred_companies = Array.isArray(search.preferred_companies) ? search.preferred_companies : [];
  search.safety = {
    ...(search.safety || {}),
    auto_approve: false,
    auto_submit: false,
    auto_upload_resume: false,
    require_manual_review_before_application: true
  };
  resumes.active_resume_profile_id = resumes.active_resume_profile_id || '';
  resumes.items = Array.isArray(resumes.items) ? resumes.items : [];
  resumes.items.forEach(profile => {
    profile.skills = Array.isArray(profile.skills) ? profile.skills : [];
    profile.target_roles = Array.isArray(profile.target_roles) ? profile.target_roles : [];
  });
  resumes.items.forEach(lockResumeProfileSafety);
  return { ...data, search_preferences: search, resume_profiles: resumes };
}

function lockResumeProfileSafety(profile) {
  profile.allow_resume_attach = false;
  profile.allow_final_submit = false;
  return profile;
}

function renderSettings() {
  if (!settingsData) return;
  renderSearchProfile();
  renderSimpleSearchForm();
  renderWeightedSettingList('targetRolesSettings', 'target_roles');
  renderWeightedSettingList('preferredLocationsSettings', 'preferred_locations');
  renderExcludedSettings();
  renderWeightedSettingList('preferredCompaniesSettings', 'preferred_companies');
  renderCandidateFacts();
  renderCandidateProfileVersions();
  renderResumeProfiles();
  renderJobSearchSources();
  renderSourceCatalog();
  renderJobSearchPlan();
  renderAIProvider();
  renderCareerBrain();
  renderInterviewPreparation();
  renderSafetySettings();
  updateProviderSetupGuide(settingsData.job_search_sources);
}

function renderSourceCatalog() {
  const container = $('sourceCatalogContainer');
  if (!container) return;
  const catalog = settingsData?.job_search_sources?.source_catalog || {
    china: [
      { name: 'Company careers' },
      { name: 'Public job pages' },
      { name: 'User-imported links' },
      { name: 'Assisted browsing' }
    ],
    global: [
      { name: 'Company careers' },
      { name: 'Public application forms' },
      { name: 'User-imported links' },
      { name: 'Assisted browsing' }
    ]
  };
  const regionCard = (title, items) => `<article class="source-region-card">
    <h4>${escapeHtml(title)}</h4>
    <ul>${(items || []).map(item => `<li><strong>${escapeHtml(item.name || item.category || 'Public source')}</strong>${Array.isArray(item.examples) && item.examples.length ? `<span>${escapeHtml(item.examples.join(' · '))}</span>` : ''}</li>`).join('')}</ul>
  </article>`;
  container.innerHTML = regionCard('China', catalog.china) + regionCard('Global', catalog.global);
}

function publicSourceLabel(value) {
  const labels = {
    ats: 'Public application forms',
    career_pages: 'Company careers',
    company_career: 'Company careers',
    public_job_pages: 'Public job pages',
    user_imported_urls: 'User-imported links',
    assisted_browsing: 'Assisted browsing',
    public_source: 'Public sources'
  };
  return labels[String(value || '').toLowerCase()] || humanizeToken(value || 'public_source');
}

function renderJobSearchPlan() {
  const summary = $('searchPlanSummary');
  const queriesContainer = $('searchPlanQueries');
  if (!summary || !queriesContainer) return;
  const plan = settingsData?.job_search_plan || {};
  const targetRoles = Array.isArray(plan.target_roles) ? plan.target_roles : [];
  const adjacentRoles = Array.isArray(plan.adjacent_roles) ? plan.adjacent_roles : [];
  const locations = Array.isArray(plan.locations) ? plan.locations : [];
  const keywords = Array.isArray(plan.keywords) ? plan.keywords : [];
  const sources = Array.isArray(plan.sources) ? plan.sources : [];
  const queries = Array.isArray(plan.queries) ? plan.queries : [];
  const roleGroups = plan.role_groups && typeof plan.role_groups === 'object' ? plan.role_groups : {};
  const roleTags = items => items.length
    ? items.map(item => `<span title="${escapeAttrValue(item.reason || '')}">${escapeHtml(item.role || item)}</span>`).join('')
    : '<span>None yet</span>';
  summary.innerHTML = `
    <article><h4>Target roles</h4><div class="tag-list">${roleTags(targetRoles)}</div></article>
    <article><h4>Adjacent roles</h4><div class="tag-list caution">${roleTags(adjacentRoles)}</div></article>
    <article class="search-plan-role-groups"><h4>Role strategy</h4><div class="role-group-list">${['technical', 'product', 'business', 'data', 'other'].map(category => {
      const items = Array.isArray(roleGroups[category]) ? roleGroups[category] : [];
      return items.length ? `<div><strong>${escapeHtml(humanizeToken(category))}</strong><span>${escapeHtml(items.map(item => item.role || item).join(' · '))}</span></div>` : '';
    }).join('') || '<p>Add Career Brain skills to generate adjacent role categories.</p>'}</div></article>
    <article><h4>Locations</h4><div class="tag-list">${locations.length ? locations.map(item => `<span>${escapeHtml(item)}</span>`).join('') : '<span>Remote</span>'}</div></article>
    <article><h4>Keywords</h4><div class="tag-list">${keywords.length ? keywords.map(item => `<span>${escapeHtml(item)}</span>`).join('') : '<span>Add required or preferred skills</span>'}</div></article>
    <article class="search-plan-sources"><h4>Public sources</h4><ul>${sources.length
      ? sources.map(item => `<li><strong>${escapeHtml(publicSourceLabel(item.source))}</strong><span>${escapeHtml(item.reason || '')}</span></li>`).join('')
      : '<li><strong>No source selected</strong><span>Save a target role and location first.</span></li>'}</ul></article>`;
  queriesContainer.innerHTML = queries.length
    ? `<ol>${queries.map(item => `<li><strong>${escapeHtml(item.query)}</strong><span>${escapeHtml(publicSourceLabel(item.source || item.preferred_source_types?.[0] || 'public_source'))} · ${escapeHtml(item.reason || item.role_reason || 'Generated from the active search configuration.')} · ${escapeHtml(formatSearchTime(item.time || plan.generated_at))}</span></li>`).join('')}</ol>`
    : '<p>No queries are planned yet. Add and save a target role.</p>';
  if ($('searchPlanGeneratedAt')) {
    $('searchPlanGeneratedAt').textContent = queries.length ? `${queries.length} QUERIES` : 'DRAFT';
    $('searchPlanGeneratedAt').className = `provider-state state-${queries.length ? 'ready' : 'draft'}`;
  }
}

function activeCareerProfile() {
  const brain = settingsData?.career_brain || {};
  return brain.active_profile || (brain.profiles || []).find(profile => profile.id === brain.active_profile_id) || null;
}

function careerJsonEditor(label, id, value, hint) {
  return `<label class="settings-field career-json-field"><span>${escapeHtml(label)}</span>
    <textarea id="${escapeAttr(id)}" spellcheck="false" aria-describedby="${escapeAttr(id)}Hint">${escapeHtml(JSON.stringify(value, null, 2))}</textarea>
    <small id="${escapeAttr(id)}Hint">${escapeHtml(hint)}</small>
  </label>`;
}

const CAREER_EDITOR_SCHEMAS = {
  education: {
    label: 'Education', itemLabel: 'Education record',
    fields: [
      ['institution', 'Institution'], ['degree', 'Degree'], ['field_of_study', 'Field of study'],
      ['start_date', 'Start date'], ['end_date', 'End date'], ['location', 'Location'],
      ['achievements', 'Achievements', 'lines'], ['coursework', 'Coursework', 'tags']
    ]
  },
  experience: {
    label: 'Experience', itemLabel: 'Experience record',
    fields: [
      ['company', 'Company'], ['role', 'Role'], ['start_date', 'Start date'], ['end_date', 'End date'],
      ['dates', 'Dates'], ['location', 'Location'], ['responsibilities', 'Responsibilities', 'lines'],
      ['achievements', 'Achievements', 'lines'], ['technologies', 'Technologies', 'tags']
    ]
  },
  projects: {
    label: 'Projects', itemLabel: 'Project',
    fields: [
      ['name', 'Project name'], ['dates', 'Dates'], ['url', 'URL', 'url'],
      ['description', 'Description', 'textarea'], ['technologies', 'Technologies', 'tags'], ['results', 'Results', 'lines']
    ]
  },
  certifications: {
    label: 'Certifications', itemLabel: 'Certification',
    fields: [
      ['name', 'Name'], ['issuer', 'Issuer'], ['issued_date', 'Issued date'], ['expiration_date', 'Expiration date'],
      ['credential_id', 'Credential ID'], ['url', 'Credential URL', 'url']
    ]
  },
  languages: {
    label: 'Languages', itemLabel: 'Language',
    fields: [['name', 'Language'], ['proficiency', 'Proficiency']]
  },
  interview_stories: {
    label: 'Interview stories', itemLabel: 'STAR story',
    fields: [
      ['title', 'Story title'], ['situation', 'Situation', 'textarea'], ['task', 'Task', 'textarea'],
      ['action', 'Action', 'textarea'], ['result', 'Result', 'textarea'], ['skills', 'Skills demonstrated', 'tags'],
      ['user_confirmed', 'I have reviewed and confirmed this story', 'checkbox']
    ]
  }
};

const CAREER_SKILL_GROUPS = [
  ['programming', 'Programming'], ['ai_tools', 'AI Tools'], ['frameworks', 'Frameworks'],
  ['cloud', 'Cloud'], ['data', 'Data'], ['business', 'Business']
];

function careerEditorValue(value, type = 'text') {
  if (Array.isArray(value)) return value.join(type === 'lines' ? '\n' : ', ');
  if (value === null || value === undefined) return '';
  return String(value);
}

function careerFormControl(section, field, label, value, type = 'text') {
  const data = `data-career-field="${escapeAttr(field)}" data-value-type="${escapeAttr(type)}"`;
  if (type === 'checkbox') {
    return `<label class="career-check career-field-wide"><input type="checkbox" ${data} ${value === true ? 'checked' : ''}> ${escapeHtml(label)}</label>`;
  }
  if (['lines', 'tags', 'textarea'].includes(type)) {
    const hint = type === 'lines' ? 'One item per line' : type === 'tags' ? 'Separate items with commas or new lines' : '';
    return `<label class="settings-field career-field-wide">${escapeHtml(label)}<textarea ${data} rows="${type === 'textarea' ? 3 : 2}">${escapeHtml(careerEditorValue(value, type))}</textarea>${hint ? `<small>${hint}</small>` : ''}</label>`;
  }
  return `<label class="settings-field">${escapeHtml(label)}<input type="${type === 'url' ? 'url' : 'text'}" ${data} value="${escapeAttrValue(careerEditorValue(value, type))}"></label>`;
}

function careerItemEditor(section, item = {}, index = 0) {
  const schema = CAREER_EDITOR_SCHEMAS[section];
  const normalized = typeof item === 'object' && item !== null ? item : { name: String(item) };
  return `<article class="career-item-card" data-career-item="${escapeAttr(section)}" data-item-id="${escapeAttrValue(normalized.id || '')}">
    <div class="career-item-heading"><strong>${escapeHtml(schema.itemLabel)} ${Number(index) + 1}</strong><button class="btn-danger btn-small" type="button" data-career-remove>Delete</button></div>
    <div class="career-item-grid">${schema.fields.map(([field, label, type]) => careerFormControl(section, field, label, normalized[field], type)).join('')}</div>
  </article>`;
}

function careerListEditor(section, items) {
  const schema = CAREER_EDITOR_SCHEMAS[section];
  const values = Array.isArray(items) ? items : [];
  return `<section class="career-form-section" data-career-section="${escapeAttr(section)}">
    <div class="career-section-heading"><div><h3>${escapeHtml(schema.label)}</h3><p>Edit the information people should see and use.</p></div><button class="btn-secondary btn-small" type="button" data-career-add="${escapeAttr(section)}">Add ${escapeHtml(schema.itemLabel)}</button></div>
    <div class="career-item-list" data-career-list="${escapeAttr(section)}">${values.length ? values.map((item, index) => careerItemEditor(section, item, index)).join('') : '<div class="career-empty-item">Nothing added yet.</div>'}</div>
  </section>`;
}

function careerSkillsEditor(skills = {}) {
  return `<section class="career-form-section"><div class="career-section-heading"><div><h3>Skills</h3><p>Skills are grouped so they are easy to scan and maintain.</p></div></div>
    <div class="career-skill-grid">${CAREER_SKILL_GROUPS.map(([key, label]) => `<label class="settings-field"><span>${escapeHtml(label)}</span><textarea rows="3" data-career-skill="${escapeAttr(key)}">${escapeHtml(careerEditorValue(skills[key], 'tags'))}</textarea><small>Separate items with commas or new lines</small></label>`).join('')}</div>
  </section>`;
}

function careerPreferencesEditor(preferences = {}, goals = []) {
  return `<section class="career-form-section"><div class="career-section-heading"><div><h3>Job preferences</h3><p>Used by discovery and matching. Sensitive facts still require confirmation.</p></div></div>
    <div class="career-item-grid">
      ${careerFormControl('job_preferences', 'countries', 'Countries', preferences.countries, 'tags')}
      ${careerFormControl('job_preferences', 'cities', 'Cities', preferences.cities, 'tags')}
      ${careerFormControl('job_preferences', 'industries', 'Industries', preferences.industries, 'tags')}
      ${careerFormControl('job_preferences', 'blocked_industries', 'Blocked industries', preferences.blocked_industries, 'tags')}
      ${careerFormControl('job_preferences', 'remote', 'Remote preference', preferences.remote)}
      ${careerFormControl('job_preferences', 'salary', 'Salary preference', preferences.salary)}
      ${careerFormControl('job_preferences', 'work_authorization', 'Work authorization', preferences.work_authorization)}
      ${careerFormControl('job_preferences', 'sponsorship', 'Sponsorship', preferences.sponsorship)}
      ${careerFormControl('job_preferences', 'relocation_ok', 'Open to relocation', preferences.relocation_ok === true, 'checkbox')}
      <label class="settings-field career-field-wide">Career goals<textarea id="careerGoalsForm" rows="3">${escapeHtml(careerEditorValue(goals, 'lines'))}</textarea><small>One target role or direction per line</small></label>
    </div>
  </section>`;
}

function splitCareerValues(value, type) {
  if (!['lines', 'tags'].includes(type)) return String(value || '').trim();
  const separator = type === 'lines' ? /\r?\n/ : /[,\r\n]+/;
  return String(value || '').split(separator).map(item => item.trim()).filter(Boolean);
}

function readCareerList(section) {
  return [...document.querySelectorAll(`[data-career-item="${section}"]`)].map(card => {
    const item = {};
    if (card.dataset.itemId) item.id = card.dataset.itemId;
    card.querySelectorAll('[data-career-field]').forEach(input => {
      const type = input.dataset.valueType || 'text';
      item[input.dataset.careerField] = type === 'checkbox' ? input.checked : splitCareerValues(input.value, type);
    });
    return item;
  });
}

function readCareerSkills() {
  return Object.fromEntries(CAREER_SKILL_GROUPS.map(([key]) => [key, splitCareerValues(document.querySelector(`[data-career-skill="${key}"]`)?.value, 'tags')]));
}

function readCareerPreferences() {
  const result = {};
  document.querySelectorAll('[data-career-section="job_preferences"] [data-career-field], .career-form-section [data-career-field]').forEach(input => {
    if (!['countries', 'cities', 'industries', 'blocked_industries', 'remote', 'salary', 'work_authorization', 'sponsorship', 'relocation_ok'].includes(input.dataset.careerField)) return;
    const type = input.dataset.valueType || 'text';
    result[input.dataset.careerField] = type === 'checkbox' ? input.checked : splitCareerValues(input.value, type);
  });
  return result;
}

function addCareerItem(section) {
  const list = document.querySelector(`[data-career-list="${section}"]`);
  if (!list || !CAREER_EDITOR_SCHEMAS[section]) return;
  list.querySelector('.career-empty-item')?.remove();
  const index = list.querySelectorAll('[data-career-item]').length;
  list.insertAdjacentHTML('beforeend', careerItemEditor(section, {}, index));
  list.lastElementChild?.querySelector('input, textarea')?.focus();
}

function meaningfulCareerValues(value) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map(item => String(item ?? '').trim()).filter(item => item && !/^(?:-|\u2013|\u2014)+$/.test(item));
}

function careerProfileCoverage(profile = {}) {
  const identityReady = Boolean(profile.identity?.full_name || profile.identity?.email || profile.identity?.phone);
  const skillsReady = Object.values(profile.skills || {}).some(values => meaningfulCareerValues(values).length);
  const sections = [
    identityReady,
    Array.isArray(profile.education) && profile.education.length > 0,
    Array.isArray(profile.experience) && profile.experience.length > 0,
    Array.isArray(profile.projects) && profile.projects.length > 0,
    skillsReady,
    Array.isArray(profile.languages) && profile.languages.length > 0
  ];
  return Math.round((sections.filter(Boolean).length / sections.length) * 100);
}

function renderCareerApprovalBar(profile) {
  const bar = $('careerBrainApprovalBar');
  if (!bar) return;
  if (!profile) {
    bar.innerHTML = '<div><span>Facts detected</span><strong>0</strong></div><div><span>Coverage</span><strong>0%</strong></div><p>Create a Career Profile before approval.</p><button class="btn-primary" type="button" disabled>Approve Profile</button>';
    return;
  }
  bar.innerHTML = `
    <div><span>Facts detected</span><strong>${careerProfileFactCount(profile)}</strong></div>
    <div><span>Coverage</span><strong>${careerProfileCoverage(profile)}%</strong></div>
    <div class="career-approval-state"><span>Current version</span><strong>v${Number(profile.version || 1)} · ${profile.user_approved ? 'Approved' : 'Review required'}</strong></div>
    <button id="${careerBrainEditMode ? 'stickySaveCareerProfileBtn' : 'stickyEditCareerProfileBtn'}" class="btn-secondary" type="button">${careerBrainEditMode ? 'Save New Draft' : 'Edit / Save New Draft'}</button>
    <button id="stickyApproveCareerProfileBtn" class="btn-primary" type="button" ${profile.user_approved ? 'disabled' : ''}>${profile.user_approved ? 'Profile Approved' : 'Approve Profile'}</button>`;
}

function careerBulletSection(label, values) {
  const items = meaningfulCareerValues(values);
  return `<section><h5>${escapeHtml(label)}</h5>${items.length ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p class="career-not-recorded">Not recorded</p>'}</section>`;
}

function renderCareerBrainReview(profile = {}) {
  const experiences = Array.isArray(profile.experience) ? profile.experience : [];
  const projects = Array.isArray(profile.projects) ? profile.projects : [];
  const education = Array.isArray(profile.education) ? profile.education : [];
  const languages = Array.isArray(profile.languages) ? profile.languages : [];
  const allSkills = CAREER_SKILL_GROUPS.flatMap(([key]) => meaningfulCareerValues(profile.skills?.[key]));
  const strongestSkills = [...new Set(allSkills)].slice(0, 8);
  const recordedRoles = experiences.map(item => item?.role).filter(Boolean);
  const goalRoles = meaningfulCareerValues(profile.career_goals);
  const recommendedRoles = [...new Set(goalRoles.length ? goalRoles : recordedRoles)].slice(0, 5);
  const summaryRoles = [...new Set(recordedRoles)].slice(0, 3);
  const summary = summaryRoles.length || strongestSkills.length
    ? `${profile.identity?.full_name || profile.name || 'This candidate'} brings experience in ${summaryRoles.join(', ') || 'recorded career areas'}, supported by ${strongestSkills.slice(0, 5).join(', ') || 'the verified skills below'}.`
    : 'Add reviewed experience and skills to create an evidence-based career summary.';
  const careerDirection = goalRoles.length
    ? goalRoles.join(' · ')
    : 'Add a career goal to make direction and recommendations more specific.';

  return `<div class="career-review-surface">
    <section class="career-ai-summary" aria-label="AI Career Summary">
      <div class="section-heading"><div><p class="eyebrow">CAREER BRAIN DERIVED</p><h3>AI Career Summary</h3></div><span class="provider-state state-ready">EVIDENCE-BASED</span></div>
      <p class="career-summary-copy">${escapeHtml(summary)}</p>
      <div class="career-summary-grid">
        <article><h4>Strongest skills</h4><div class="tag-list">${strongestSkills.length ? strongestSkills.map(item => `<span>${escapeHtml(item)}</span>`).join('') : '<span>Add verified skills</span>'}</div></article>
        <article><h4>Recommended roles</h4><div class="tag-list">${recommendedRoles.length ? recommendedRoles.map(item => `<span>${escapeHtml(item)}</span>`).join('') : '<span>Add career goals</span>'}</div></article>
        <article><h4>Career direction</h4><p>${escapeHtml(careerDirection)}</p></article>
      </div>
      <p class="settings-help">Derived only from the current Career Brain. No new facts are invented and no provider call is required.</p>
    </section>
    <section class="career-review-section"><div class="career-section-heading"><div><h3>Experience</h3><p>Roles, evidence, and tools at a glance.</p></div></div>
      <div class="career-review-list">${experiences.length ? experiences.map(item => {
        const dates = item.dates || [item.start_date, item.end_date].filter(Boolean).join(' – ');
        return `<article class="career-experience-card"><header><div><h4>${escapeHtml(item.role || 'Role not recorded')}</h4><p>${escapeHtml(item.company || 'Company not recorded')}</p></div><span>${escapeHtml(dates || 'Dates not recorded')}</span></header>
          <div class="career-evidence-grid">${careerBulletSection('Responsibilities', item.responsibilities)}${careerBulletSection('Achievements', item.achievements)}<section><h5>Technologies</h5><div class="tag-list">${meaningfulCareerValues(item.technologies).length ? meaningfulCareerValues(item.technologies).map(value => `<span>${escapeHtml(value)}</span>`).join('') : '<span>Not recorded</span>'}</div></section></div>
        </article>`;
      }).join('') : '<div class="career-empty-item">No experience added yet.</div>'}</div>
    </section>
    <section class="career-review-section"><div class="career-section-heading"><div><h3>Projects</h3><p>What you built and the results.</p></div></div>
      <div class="career-review-list">${projects.length ? projects.map(item => `<article class="career-project-card"><header><h4>${escapeHtml(item.name || 'Project not named')}</h4><span>${escapeHtml(item.dates || '')}</span></header><p>${escapeHtml(item.description || 'Description not recorded')}</p><div class="career-evidence-grid"><section><h5>Technology</h5><div class="tag-list">${meaningfulCareerValues(item.technologies).length ? meaningfulCareerValues(item.technologies).map(value => `<span>${escapeHtml(value)}</span>`).join('') : '<span>Not recorded</span>'}</div></section>${careerBulletSection('Result', item.results)}</div></article>`).join('') : '<div class="career-empty-item">No projects added yet.</div>'}</div>
    </section>
    <section class="career-review-section"><div class="career-section-heading"><div><h3>Skills</h3><p>Grouped by how you use them.</p></div></div><div class="career-skill-review-grid">${CAREER_SKILL_GROUPS.map(([key, label]) => `<article><h4>${escapeHtml(label)}</h4><div class="tag-list">${meaningfulCareerValues(profile.skills?.[key]).length ? meaningfulCareerValues(profile.skills[key]).map(value => `<span>${escapeHtml(value)}</span>`).join('') : '<span>Not recorded</span>'}</div></article>`).join('')}</div></section>
    <section class="career-review-section career-supporting-facts"><article><h3>Education</h3>${education.length ? education.map(item => `<p><strong>${escapeHtml(item.degree || item.field_of_study || 'Education')}</strong><span>${escapeHtml(item.institution || '')} · ${escapeHtml([item.start_date, item.end_date].filter(Boolean).join(' – '))}</span></p>`).join('') : '<p>Not recorded</p>'}</article><article><h3>Languages</h3>${languages.length ? languages.map(item => `<p><strong>${escapeHtml(item.name || 'Language')}</strong><span>${escapeHtml(item.proficiency || 'Proficiency not recorded')}</span></p>`).join('') : '<p>Not recorded</p>'}</article></section>
  </div>`;
}

function renderCareerBrain() {
  const container = $('careerBrainEditor');
  if (!container || !settingsData) return;
  const brain = settingsData.career_brain || { profiles: [] };
  const profiles = Array.isArray(brain.profiles) ? brain.profiles : [];
  const profile = activeCareerProfile();
  if ($('careerBrainState')) {
    $('careerBrainState').textContent = profile?.state?.toUpperCase() || 'NOT CREATED';
    $('careerBrainState').className = `provider-state state-${escapeAttr(profile?.state || 'disabled')}`;
  }
  renderCareerApprovalBar(profile);
  if (!profile) {
    container.innerHTML = `<div class="empty-state">
      <strong>Create your Personal Career Brain</strong>
      <p>Upload a resume to create a draft automatically, create an empty profile, or import a Resume Jobs Career Profile JSON file.</p>
      <div class="inline-actions">
        <button id="createCareerProfileBtn" class="btn-primary" type="button">Create Empty Profile</button>
        <label class="btn-secondary file-button">Import Profile<input id="careerProfileImportFile" type="file" accept="application/json,.json"></label>
        <button id="importCareerProfileBtn" class="btn-secondary" type="button">Import Selected File</button>
      </div>
    </div>`;
    return;
  }
  const identity = profile.identity || {};
  container.innerHTML = `
    <div class="career-profile-toolbar">
      <label class="settings-field">Active profile
        <select id="careerBrainProfileSelect">${profiles.map((item, index) => `<option value="${escapeAttrValue(item.id)}" ${item.id === brain.active_profile_id ? 'selected' : ''}>${escapeHtml(item.name || `Career Profile ${index + 1}`)} · v${Number(item.version || 1)} · ${escapeHtml(item.state || 'draft')}</option>`).join('')}</select>
      </label>
      <div class="inline-actions">
        <button id="activateCareerProfileBtn" class="btn-secondary" type="button">Set Active</button>
        <button id="toggleCareerBrainEditBtn" class="btn-primary" type="button">${careerBrainEditMode ? 'Cancel Editing' : 'Edit Career Brain'}</button>
        <button id="createCareerProfileBtn" class="btn-secondary" type="button">New Profile</button>
        <button id="duplicateCareerProfileBtn" class="btn-secondary" type="button">Duplicate</button>
      </div>
    </div>
    <div id="careerBrainReviewSurface" class="${careerBrainEditMode ? 'hidden' : ''}">${renderCareerBrainReview(profile)}</div>
    <div id="careerBrainEditSurface" class="${careerBrainEditMode ? '' : 'hidden'}">
    <div class="settings-grid career-identity-grid">
      <label class="settings-field">Profile name<input id="careerProfileName" type="text" value="${escapeAttrValue(profile.name || '')}"></label>
      <label class="settings-field">Full name<input id="careerIdentityFullName" type="text" value="${escapeAttrValue(identity.full_name || '')}"></label>
      <label class="settings-field">First name<input id="careerIdentityFirstName" type="text" value="${escapeAttrValue(identity.first_name || '')}"></label>
      <label class="settings-field">Last name<input id="careerIdentityLastName" type="text" value="${escapeAttrValue(identity.last_name || '')}"></label>
      <label class="settings-field">Email<input id="careerIdentityEmail" type="email" value="${escapeAttrValue(identity.email || '')}"></label>
      <label class="settings-field">Phone<input id="careerIdentityPhone" type="text" value="${escapeAttrValue(identity.phone || '')}"></label>
      <label class="settings-field">Current location<input id="careerIdentityLocation" type="text" value="${escapeAttrValue(identity.current_location || '')}"></label>
      <label class="settings-field">City<input id="careerIdentityCity" type="text" value="${escapeAttrValue(identity.city || '')}"></label>
      <label class="settings-field">State / region<input id="careerIdentityState" type="text" value="${escapeAttrValue(identity.state || '')}"></label>
      <label class="settings-field">Country<input id="careerIdentityCountry" type="text" value="${escapeAttrValue(identity.country || '')}"></label>
      <label class="settings-field">LinkedIn<input id="careerIdentityLinkedIn" type="url" value="${escapeAttrValue(identity.links?.linkedin || '')}"></label>
      <label class="settings-field">GitHub<input id="careerIdentityGitHub" type="url" value="${escapeAttrValue(identity.links?.github || '')}"></label>
      <label class="settings-field">Portfolio<input id="careerIdentityPortfolio" type="url" value="${escapeAttrValue(identity.links?.portfolio || '')}"></label>
    </div>
    <div class="career-friendly-editors">
      ${careerListEditor('education', profile.education)}
      ${careerListEditor('experience', profile.experience)}
      ${careerListEditor('projects', profile.projects)}
      ${careerSkillsEditor(profile.skills || {})}
      ${careerListEditor('certifications', profile.certifications)}
      ${careerListEditor('languages', profile.languages)}
      ${careerListEditor('interview_stories', profile.interview_stories)}
      ${careerPreferencesEditor(profile.job_preferences || {}, profile.career_goals || [])}
    </div>
    <details class="advanced-disclosure career-json-advanced">
      <summary>Advanced · JSON editor</summary>
      <div class="inline-warning">JSON is intended for advanced import and repair only. Check “Use JSON values” before saving if these values should replace the form data.</div>
      <label class="selection-choice"><input id="careerUseAdvancedJson" type="checkbox"> Use JSON values when saving</label>
      <div class="career-json-grid">
        ${careerJsonEditor('Education', 'careerEducationJson', profile.education || [], 'JSON array of education records.')}
        ${careerJsonEditor('Experience', 'careerExperienceJson', profile.experience || [], 'JSON array of experience records.')}
        ${careerJsonEditor('Projects', 'careerProjectsJson', profile.projects || [], 'JSON array of project records.')}
        ${careerJsonEditor('Skills', 'careerSkillsJson', profile.skills || {}, 'JSON object with programming, ai_tools, frameworks, cloud, data, and business arrays.')}
        ${careerJsonEditor('Certifications', 'careerCertificationsJson', profile.certifications || [], 'JSON array of certification records.')}
        ${careerJsonEditor('Languages', 'careerLanguagesJson', profile.languages || [], 'JSON array of language records.')}
        ${careerJsonEditor('Interview stories', 'careerStoriesJson', profile.interview_stories || [], 'JSON array of reviewed STAR stories.')}
        ${careerJsonEditor('Job preferences', 'careerPreferencesJson', profile.job_preferences || {}, 'JSON job-preference object.')}
        ${careerJsonEditor('Career goals', 'careerGoalsJson', profile.career_goals || [], 'JSON array of target roles or directions.')}
      </div>
    </details>
    <div class="inline-actions career-profile-actions">
      <button id="saveCareerProfileBtn" class="btn-primary" type="button">Save New Version</button>
      <button id="approveCareerProfileBtn" class="btn-secondary" type="button" ${profile.user_approved ? 'disabled' : ''}>Approve This Version</button>
      <button id="exportCareerProfileBtn" class="btn-secondary" type="button">Export JSON</button>
      <button id="archiveCareerProfileBtn" class="btn-danger" type="button">Archive</button>
      <label class="btn-secondary file-button">Import Profile<input id="careerProfileImportFile" type="file" accept="application/json,.json"></label>
      <button id="importCareerProfileBtn" class="btn-secondary" type="button">Import Selected File</button>
    </div>
    <p class="settings-help">Saving creates a new draft version and never changes the approved ancestor. Imported and AI-generated profiles always require approval.</p>
    </div>`;
}

function showCareerBrainStatus(type, message) {
  const box = $('careerBrainStatus');
  if (!box) return;
  box.className = `settings-status ${type}`;
  box.textContent = message;
  if (type === 'ok') showProductToast('ok', message);
}

function parseCareerEditorJson(id, label) {
  try {
    return JSON.parse(String($(id)?.value || '').trim() || (id === 'careerSkillsJson' || id === 'careerPreferencesJson' ? '{}' : '[]'));
  } catch {
    const error = new Error(`${label} must be valid JSON.`);
    error.code = 'CAREER_PROFILE_JSON_INVALID';
    throw error;
  }
}

function careerProfileFromEditor() {
  const current = activeCareerProfile();
  if (!current) throw new Error('Create or import a Career Profile first.');
  const useAdvancedJson = $('careerUseAdvancedJson')?.checked === true;
  const friendlyProfile = {
    education: readCareerList('education'),
    experience: readCareerList('experience'),
    projects: readCareerList('projects'),
    skills: readCareerSkills(),
    certifications: readCareerList('certifications'),
    languages: readCareerList('languages'),
    interview_stories: readCareerList('interview_stories'),
    job_preferences: readCareerPreferences(),
    career_goals: splitCareerValues($('careerGoalsForm')?.value, 'lines')
  };
  const advancedProfile = useAdvancedJson ? {
    education: parseCareerEditorJson('careerEducationJson', 'Education'),
    experience: parseCareerEditorJson('careerExperienceJson', 'Experience'),
    projects: parseCareerEditorJson('careerProjectsJson', 'Projects'),
    skills: parseCareerEditorJson('careerSkillsJson', 'Skills'),
    certifications: parseCareerEditorJson('careerCertificationsJson', 'Certifications'),
    languages: parseCareerEditorJson('careerLanguagesJson', 'Languages'),
    interview_stories: parseCareerEditorJson('careerStoriesJson', 'Interview stories'),
    job_preferences: parseCareerEditorJson('careerPreferencesJson', 'Job preferences'),
    career_goals: parseCareerEditorJson('careerGoalsJson', 'Career goals')
  } : friendlyProfile;
  return {
    ...current,
    name: String($('careerProfileName')?.value || '').trim(),
    identity: {
      ...(current.identity || {}),
      full_name: String($('careerIdentityFullName')?.value || '').trim(),
      first_name: String($('careerIdentityFirstName')?.value || '').trim(),
      last_name: String($('careerIdentityLastName')?.value || '').trim(),
      email: String($('careerIdentityEmail')?.value || '').trim(),
      phone: String($('careerIdentityPhone')?.value || '').trim(),
      current_location: String($('careerIdentityLocation')?.value || '').trim(),
      city: String($('careerIdentityCity')?.value || '').trim(),
      state: String($('careerIdentityState')?.value || '').trim(),
      country: String($('careerIdentityCountry')?.value || '').trim(),
      links: {
        ...(current.identity?.links || {}),
        linkedin: String($('careerIdentityLinkedIn')?.value || '').trim(),
        github: String($('careerIdentityGitHub')?.value || '').trim(),
        portfolio: String($('careerIdentityPortfolio')?.value || '').trim()
      }
    },
    ...advancedProfile
  };
}

async function runCareerProfileAction(payload, successMessage) {
  try {
    const result = await fetchJSON('/api/career-brain/profiles', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    await loadSettings();
    switchView('career-brain');
    showCareerBrainStatus('ok', successMessage || 'Career Profile updated.');
    return result;
  } catch (error) {
    showCareerBrainStatus('error', error.details?.message || error.message);
    return null;
  }
}

async function approveActiveCareerProfile() {
  const profile = activeCareerProfile();
  if (!profile || profile.user_approved) return;
  if (!await confirmProductAction({
    title: 'Approve this Career Profile version?',
    message: 'Approve only after checking identity, education, experience, projects, skills, languages, preferences, and interview stories. Future edits create a new unapproved version.',
    confirmLabel: 'Approve Career Profile'
  })) return;
  const result = await runCareerProfileAction({ action: 'approve', profile_id: profile.id, confirmed: true }, 'Career Profile approved. Job Search and Application Package gates now use this version.');
  if (result) {
    careerBrainEditMode = false;
    renderCareerBrain();
  }
}

async function importSelectedCareerProfile() {
  const file = $('careerProfileImportFile')?.files?.[0];
  if (!file) return showCareerBrainStatus('error', 'Choose a Career Profile JSON file first.');
  try {
    const parsed = JSON.parse(await file.text());
    const profile = parsed.profile || parsed;
    await runCareerProfileAction({ action: 'import', profile, confirmed: true }, 'Career Profile imported as an unapproved draft.');
  } catch (error) {
    showCareerBrainStatus('error', error instanceof SyntaxError ? 'The selected file is not valid JSON.' : error.message);
  }
}

function exportActiveCareerProfile() {
  const profile = activeCareerProfile();
  if (!profile) return showCareerBrainStatus('error', 'No active Career Profile to export.');
  const link = document.createElement('a');
  link.href = `/api/career-brain/profiles/${encodeURIComponent(profile.id)}/export`;
  link.download = `career-profile-${profile.id}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  showCareerBrainStatus('ok', 'Career Profile export started. The file contains personal data; store it securely.');
}

function renderInterviewPreparation() {
  const container = $('interviewPreparationContainer');
  if (!container) return;
  const profile = activeCareerProfile();
  const stories = profile?.interview_stories || [];
  const approvedJobs = allJobs.filter(job => job.approval_status === 'approved');
  if (!profile && !approvedJobs.length) {
    container.innerHTML = '<div class="empty-state"><strong>No interview plan yet.</strong><p>Create a Career Brain and approve a Job Match. Preparation will appear here automatically.</p><button class="btn-primary" type="button" onclick="switchView(\'career-brain\')">Open Career Brain</button></div>';
    return;
  }
  const storyList = stories.length
    ? stories.map(story => `<article class="journey-card"><div class="section-heading"><h3>${escapeHtml(story.title || 'Interview story')}</h3><span class="provider-state state-${story.user_confirmed ? 'ready' : 'draft'}">${story.user_confirmed ? 'CONFIRMED' : 'REVIEW'}</span></div><p>${escapeHtml(story.result || story.action || story.situation || 'Add STAR details in Career Brain.')}</p></article>`).join('')
    : '<div class="empty-state"><strong>No STAR stories yet.</strong><p>Add interview stories in Career Brain so each package can recommend verified examples.</p></div>';
  const jobPlans = approvedJobs.length
    ? approvedJobs.map(job => {
        const match = job.hybrid_match || {};
        const gaps = [...(match.weaknesses || []), ...(match.missing || [])].slice(0, 5);
        return `<article class="journey-card"><p class="eyebrow">${escapeHtml(job.company || 'COMPANY')}</p><h3>${escapeHtml(job.title || 'Approved opportunity')}</h3><p>${escapeHtml(match.career_reason || 'Build an Application Package to generate a role-specific preparation plan.')}</p><h4>Prepare for</h4><ul>${gaps.length ? gaps.map(item => `<li>${escapeHtml(item)}</li>`).join('') : '<li>Role motivation and evidence from your verified experience.</li>'}</ul></article>`;
      }).join('')
    : '<div class="empty-state"><strong>No approved opportunities.</strong><p>Approve a Job Match to create role-specific questions and gap preparation.</p></div>';
  container.innerHTML = `<div class="interview-grid"><section><h2>Your verified stories</h2>${storyList}</section><section><h2>Opportunity plans</h2>${jobPlans}</section></div>`;
}

function renderAIProvider() {
  const container = $('aiProviderContainer');
  if (!container || !settingsData) return;
  const ai = settingsData.ai_provider || settingsData.job_search_sources?.ai_enrichment || {};
  const type = ai.type || 'local_openai_compatible';
  const usage = settingsData.ai_usage?.totals || {};
  const defaultEndpoints = {
    local_openai_compatible: 'http://127.0.0.1:1234/v1',
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com/v1',
    openai_compatible: 'https://your-provider.example/v1'
  };
  container.innerHTML = `
    <article class="provider-config-card">
      <div class="section-heading">
        <div>
          <h4>Advisory model assistance</h4>
          <p>${escapeHtml(ai.message || 'AI assistance is disabled.')}</p>
        </div>
        <span class="provider-state state-${escapeAttr(String(ai.status || 'DISABLED').toLowerCase())}">${escapeHtml(ai.status || 'DISABLED')}</span>
      </div>
      <label class="choice-row">
        <input id="aiProviderEnabled" type="checkbox" ${ai.enabled ? 'checked' : ''}>
        Enable optional AI assistance
      </label>
      <label class="settings-field">Provider
        <select id="aiProviderType">
          <option value="local_openai_compatible" ${type === 'local_openai_compatible' ? 'selected' : ''}>Local OpenAI-compatible (LM Studio / vLLM)</option>
          <option value="openai" ${type === 'openai' ? 'selected' : ''}>OpenAI</option>
          <option value="anthropic" ${type === 'anthropic' ? 'selected' : ''}>Anthropic Claude</option>
          <option value="openai_compatible" ${type === 'openai_compatible' ? 'selected' : ''}>Other OpenAI-compatible cloud</option>
        </select>
      </label>
      <label class="settings-field">Endpoint
        <input id="aiProviderEndpoint" type="url" value="${escapeAttrValue(ai.base_url || '')}" placeholder="${escapeAttrValue(defaultEndpoints[type] || '')}">
      </label>
      <div class="settings-grid provider-limit-grid">
        <label class="settings-field">Model
          <input id="aiProviderModel" type="text" list="aiProviderModelOptions" value="${escapeAttrValue(ai.model || '')}" placeholder="Provider model ID">
          <datalist id="aiProviderModelOptions"></datalist>
        </label>
        <label class="settings-field">Timeout (ms)
          <input id="aiProviderTimeout" type="number" min="100" max="120000" value="${escapeAttrValue(ai.timeout_ms || 15000)}">
        </label>
      </div>
      <div class="settings-grid provider-limit-grid">
        <label class="settings-field">Input cost / 1M tokens (USD)
          <input id="aiProviderInputCost" type="number" min="0" step="0.000001" value="${escapeAttrValue(ai.input_cost_per_million || 0)}">
        </label>
        <label class="settings-field">Output cost / 1M tokens (USD)
          <input id="aiProviderOutputCost" type="number" min="0" step="0.000001" value="${escapeAttrValue(ai.output_cost_per_million || 0)}">
        </label>
      </div>
      <label class="settings-field">API key
        <input id="aiProviderApiKey" type="password" value="" autocomplete="new-password" placeholder="${ai.credential_configured ? 'Configured — leave blank to keep it' : 'Optional for local providers'}">
      </label>
      <label class="choice-row">
        <input id="aiProviderClearKey" type="checkbox">
        Remove the saved API key (disable the provider first)
      </label>
      <p class="settings-help">The key is stored only in ignored local data, is never returned by the API, and is never bundled into the browser extension. Environment variables can be used instead.</p>
      <div class="preference-row"><span>Credential</span><strong>${ai.credential_configured ? 'Configured locally' : 'Not configured'}</strong></div>
      <div class="preference-row"><span>Configuration source</span><strong>${escapeHtml(ai.source || 'environment')}</strong></div>
      <div class="preference-row"><span>Recorded AI calls</span><strong>${Number(usage.calls || 0)}</strong></div>
      <div class="preference-row"><span>Recorded tokens</span><strong>${Number(usage.total_tokens || 0).toLocaleString()}</strong></div>
      <div class="preference-row"><span>Estimated cost</span><strong>$${Number(usage.estimated_cost_usd || 0).toFixed(4)}</strong></div>
      <p class="settings-help">Cost is an estimate based on the rates above. Usage records contain task/model/token metadata only, never candidate field values.</p>
      <div class="inline-actions">
        <button id="saveAIProviderBtn" class="btn-primary" type="button">Save AI Provider</button>
        <button id="testAIProviderBtn" class="btn-secondary" type="button">Test Connection</button>
      </div>
    </article>`;
}

function aiProviderPayload() {
  const apiKey = String($('aiProviderApiKey')?.value || '').trim();
  return {
    enabled: Boolean($('aiProviderEnabled')?.checked),
    type: String($('aiProviderType')?.value || 'local_openai_compatible'),
    base_url: String($('aiProviderEndpoint')?.value || '').trim(),
    model: String($('aiProviderModel')?.value || '').trim(),
    timeout_ms: Number($('aiProviderTimeout')?.value || 15000),
    input_cost_per_million: Number($('aiProviderInputCost')?.value || 0),
    output_cost_per_million: Number($('aiProviderOutputCost')?.value || 0),
    ...(apiKey ? { api_key: apiKey } : {}),
    clear_api_key: Boolean($('aiProviderClearKey')?.checked)
  };
}

function showAIProviderStatus(type, message) {
  const box = $('aiProviderStatus');
  if (!box) return;
  box.className = `settings-status ${type}`;
  box.textContent = message;
  if (type === 'ok') showProductToast('ok', message);
}

async function saveAIProvider() {
  try {
    const result = await fetchJSON('/api/settings/ai-provider', {
      method: 'POST',
      body: JSON.stringify({ ai_provider: aiProviderPayload() })
    });
    settingsData.ai_provider = result.ai_provider;
    settingsData.job_search_sources = {
      ...(settingsData.job_search_sources || {}),
      ai_enrichment: result.ai_provider
    };
    renderAIProvider();
    renderJobSearchSources();
    renderSafetySettings();
    showAIProviderStatus('ok', 'AI Provider saved locally. Use Test Connection before AI enrichment.');
    await loadProviderHealth();
    return true;
  } catch (error) {
    showAIProviderStatus('error', error.details?.message || error.message);
    return false;
  }
}

async function testAIProvider() {
  const button = $('testAIProviderBtn');
  if (button) button.disabled = true;
  showAIProviderStatus('dirty', 'Testing the saved AI provider connection…');
  try {
    const result = await fetchJSON('/api/settings/ai-provider/test', { method: 'POST', body: '{}' });
    const modelIds = Array.isArray(result.health?.model_ids) ? result.health.model_ids : [];
    const modelOptions = $('aiProviderModelOptions');
    if (modelOptions) modelOptions.innerHTML = modelIds.map(id => `<option value="${escapeAttrValue(id)}"></option>`).join('');
    showAIProviderStatus('ok', `AI Provider READY. ${Number(result.health?.model_count || 0)} model(s) reported.${modelIds.length ? ' Choose one from the Model field, then Save.' : ''}`);
    await loadProviderHealth();
    return true;
  } catch (error) {
    showAIProviderStatus('error', error.details?.message || error.message);
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

function renderJobSearchSources() {
  const container = $('jobSearchSourcesContainer');
  if (!container || !settingsData) return;
  const sources = settingsData.job_search_sources || {};
  const provider = Array.isArray(sources.providers)
    ? sources.providers.find(item => item.id === 'searxng_search')
    : null;
  if (!provider) {
    container.innerHTML = '<p class="error">SearXNG provider configuration is unavailable.</p>';
    return;
  }
  const adapters = Array.isArray(sources.downstream_adapters) ? sources.downstream_adapters : [];
  const ai = sources.ai_enrichment || {};
  const localSearxngUnavailable = provider.status === 'UNREACHABLE'
    && /(?:127\.0\.0\.1|localhost|\[::1\])/.test(provider.endpoint || provider.saved_endpoint || '');
  container.innerHTML = `
    <article class="provider-config-card">
      <div class="section-heading">
        <div>
          <h4>${escapeHtml(provider.name || 'SearXNG')}</h4>
          <p>${escapeHtml(provider.description || '')}</p>
        </div>
        <span class="provider-state state-${escapeAttr(String(provider.status || 'ERROR').toLowerCase())}">${escapeHtml(provider.status || 'ERROR')}</span>
      </div>
      <label class="choice-row">
        <input id="searxngEnabled" type="checkbox" ${provider.saved_enabled ? 'checked' : ''}>
        Enable Live Search
      </label>
      <label class="settings-field">Endpoint
        <input id="searxngEndpoint" type="url" value="${escapeAttrValue(provider.saved_endpoint || '')}" placeholder="${escapeAttrValue(sources.suggested_searxng_url || 'http://127.0.0.1:8888/search')}">
      </label>
      <div class="settings-grid provider-limit-grid">
        <label class="settings-field">Timeout (ms)
          <input id="searxngTimeout" type="number" min="500" max="120000" value="${escapeAttrValue(provider.timeout_ms || 12000)}">
        </label>
        <label class="settings-field">Maximum results per query
          <input id="searxngMaxResults" type="number" min="1" max="50" value="${escapeAttrValue(provider.max_results_per_query || 5)}">
        </label>
      </div>
      <p class="settings-help">Suggested local endpoint: <code>${escapeHtml(sources.suggested_searxng_url || '')}</code>. It is not saved until you enter it and choose Save.</p>
      <div class="preference-row"><span>Configuration source</span><strong>${escapeHtml(provider.endpoint_source || 'job_sources.json')}</strong></div>
      <div class="preference-row"><span>Last health check</span><strong>${escapeHtml(provider.last_health_check || 'Never')}</strong></div>
      ${provider.last_error ? `<p class="inline-provider-error">${escapeHtml(provider.last_error)}</p>` : ''}
      ${localSearxngUnavailable ? `<div class="settings-warning">
        <strong>SearXNG is not running.</strong>
        <p>Use the existing local setup when you are ready; Resume Jobs will not start or modify Docker automatically.</p>
        <code>cd /path/to/searxng; docker compose up -d</code>
      </div>` : ''}
      <div class="inline-actions">
        <button id="saveJobSearchSourcesBtn" class="btn-primary" type="button">Save</button>
        <button id="testJobSearchSourceBtn" class="btn-secondary" type="button">Test Connection</button>
      </div>
    </article>
    <article class="provider-config-card provider-readonly-card">
      <h4>Downstream public job adapters</h4>
      <p>${escapeHtml(adapters.join(', ') || 'No adapters registered')}</p>
      <p class="settings-help">These adapters normalize discovered public job pages. They are not separate search engines and do not require AI.</p>
    </article>
    <article class="provider-config-card provider-readonly-card">
      <div class="section-heading"><h4>Offline Demo</h4><span class="provider-state state-ready">READY</span></div>
      <p>Creates one synthetic localhost-only job. It never searches the web and is not a real vacancy source.</p>
    </article>
    <article class="provider-config-card provider-readonly-card">
      <div class="section-heading"><h4>AI Provider</h4><span class="provider-state">${escapeHtml(ai.status || 'DISABLED')}</span></div>
      <p>${escapeHtml(ai.message || 'AI enrichment is optional.')}</p>
    </article>`;
}

function sourceProviderPayload() {
  return {
    id: 'searxng_search',
    enabled: Boolean($('searxngEnabled')?.checked),
    endpoint: String($('searxngEndpoint')?.value || '').trim(),
    timeout_ms: Number($('searxngTimeout')?.value || 12000),
    max_results_per_query: Number($('searxngMaxResults')?.value || 5)
  };
}

function showJobSearchSourceStatus(type, message) {
  const box = $('jobSearchSourceStatus');
  if (!box) return;
  box.className = `settings-status ${type}`;
  box.textContent = message;
  if (type === 'ok') showProductToast('ok', message);
}

async function saveJobSearchSources() {
  try {
    const result = await fetchJSON('/api/settings/job-search-sources', {
      method: 'POST',
      body: JSON.stringify({ providers: [sourceProviderPayload()] })
    });
    settingsData.job_search_sources = result.job_search_sources;
    renderJobSearchSources();
    updateProviderSetupGuide(result.job_search_sources);
    showJobSearchSourceStatus('ok', 'Job Search Source saved. Test the connection before running Live Search.');
    await loadProviderHealth();
    return true;
  } catch (error) {
    showJobSearchSourceStatus('error', error.details?.message || error.message);
    return false;
  }
}

async function testJobSearchSource() {
  const button = $('testJobSearchSourceBtn');
  if (button) button.disabled = true;
  showJobSearchSourceStatus('dirty', 'Testing one small provider health query…');
  try {
    const result = await fetchJSON('/api/settings/job-search-sources/test', {
      method: 'POST',
      body: JSON.stringify({ provider: sourceProviderPayload() })
    });
    if (result.job_search_sources) settingsData.job_search_sources = result.job_search_sources;
    if (result.saved_health_updated) {
      await loadProviderHealth();
    } else {
      const tested = sourceProviderPayload();
      const provider = settingsData?.job_search_sources?.providers?.find(item => item.id === 'searxng_search');
      if (provider) {
        provider.enabled = tested.enabled;
        provider.saved_enabled = tested.enabled;
        provider.endpoint = tested.endpoint;
        provider.saved_endpoint = tested.endpoint;
        provider.status = result.status;
        provider.last_health_check = result.last_health_check;
        provider.last_error = '';
        renderJobSearchSources();
        updateProviderSetupGuide(settingsData.job_search_sources);
      }
    }
    showJobSearchSourceStatus('ok', `Connection READY. Provider returned ${Number(result.result_count || 0)} health-check result(s).`);
    return true;
  } catch (error) {
    const status = error.details?.status || 'ERROR';
    const tested = sourceProviderPayload();
    const provider = settingsData?.job_search_sources?.providers?.find(item => item.id === 'searxng_search');
    if (provider) {
      provider.enabled = tested.enabled;
      provider.saved_enabled = tested.enabled;
      provider.endpoint = tested.endpoint;
      provider.saved_endpoint = tested.endpoint;
      provider.status = status;
      provider.last_health_check = error.details?.last_health_check || '';
      provider.last_error = error.details?.last_error || error.details?.message || error.message;
      renderJobSearchSources();
      updateProviderSetupGuide(settingsData.job_search_sources);
    }
    showJobSearchSourceStatus('error', `${status}: ${error.details?.last_error || error.details?.message || error.message}`);
    return false;
  } finally {
    if (button) button.disabled = false;
  }
}

function editableSearchProfile() {
  const search = settingsData?.search_preferences;
  return search?.search_profiles?.find(profile => profile.id === search.active_search_profile_id) || null;
}

function renderSearchProfile() {
  const search = settingsData.search_preferences;
  const profile = editableSearchProfile();
  const select = $('searchProfileSelect');
  select.innerHTML = search.search_profiles.map(item => `<option value="${escapeAttrValue(item.id)}" ${item.id === search.active_search_profile_id ? 'selected' : ''}>${escapeHtml(item.name)}${item.enabled ? '' : ' (disabled)'}</option>`).join('');
  $('searchProfileName').value = profile?.name || '';
  $('searchProfileEnabled').checked = profile?.enabled !== false;
  document.querySelectorAll('[data-search-profile-field]').forEach(input => {
    const field = input.dataset.searchProfileField;
    if (!profile || field === 'name' || field === 'enabled') return;
    const value = profile[field];
    if (input.type === 'checkbox') input.checked = value === true;
    else input.value = Array.isArray(value) ? value.join(', ') : (value ?? '');
  });
}

function renderSimpleSearchForm() {
  const profile = editableSearchProfile();
  if (!profile) return;
  const firstEnabled = items => (items || []).find(item => item.enabled !== false) || (items || [])[0] || {};
  $('searchPrimaryRole').value = firstEnabled(profile.target_roles).keyword || '';
  $('searchPrimaryLocation').value = firstEnabled(profile.preferred_locations).keyword || '';
  $('searchExperienceLevel').value = profile.seniority_levels?.[0] || 'any';
  const workplace = profile.workplace_modes?.[0] || 'any';
  document.querySelectorAll('[data-simple-search-field="workplace_mode"]').forEach(input => {
    input.checked = input.value === workplace;
  });
}

function renderWeightedSettingList(containerId, key) {
  const owner = key === 'preferred_companies' ? settingsData.search_preferences : editableSearchProfile();
  const items = owner?.[key] || [];
  const container = $(containerId);
  container.innerHTML = `<div class="settings-grid weighted-grid settings-grid-head"><span>Enabled</span><span>Keyword</span><span>Weight</span><span>Aliases (comma separated)</span></div>` + items.map((item, index) => `
    <div class="settings-grid weighted-grid setting-row">
      <label class="check-label"><input type="checkbox" ${item.enabled !== false ? 'checked' : ''} data-setting-path="${escapeAttr(key)}.${index}.enabled" aria-label="${escapeAttrValue(`${humanizeToken(key)} item ${index + 1} enabled`)}"></label>
      <input type="text" value="${escapeAttrValue(item.keyword || '')}" data-setting-path="${escapeAttr(key)}.${index}.keyword" aria-label="${escapeAttrValue(`${humanizeToken(key)} item ${index + 1} keyword`)}" placeholder="keyword">
      <input type="number" value="${escapeAttrValue(item.weight ?? 50)}" data-setting-path="${escapeAttr(key)}.${index}.weight" aria-label="${escapeAttrValue(`${humanizeToken(key)} item ${index + 1} weight`)}" min="0" max="200">
      <textarea data-setting-path="${escapeAttr(key)}.${index}.aliases" aria-label="${escapeAttrValue(`${humanizeToken(key)} item ${index + 1} aliases`)}" placeholder="alias1, alias2">${escapeHtml((item.aliases || []).join(', '))}</textarea>
    </div>`).join('');
}

function renderExcludedSettings() {
  const items = editableSearchProfile()?.excluded_keywords || [];
  const container = $('excludedKeywordsSettings');
  container.innerHTML = `<div class="settings-grid excluded-grid settings-grid-head"><span>Enabled</span><span>Keyword</span><span>Reason</span></div>` + items.map((item, index) => `
    <div class="settings-grid excluded-grid setting-row">
      <label class="check-label"><input type="checkbox" ${item.enabled !== false ? 'checked' : ''} data-setting-path="excluded_keywords.${index}.enabled" aria-label="Excluded keyword item ${index + 1} enabled"></label>
      <input type="text" value="${escapeAttrValue(item.keyword || '')}" data-setting-path="excluded_keywords.${index}.keyword" aria-label="Excluded keyword item ${index + 1} keyword" placeholder="keyword">
      <input type="text" value="${escapeAttrValue(item.reason || '')}" data-setting-path="excluded_keywords.${index}.reason" aria-label="Excluded keyword item ${index + 1} reason" placeholder="reason">
    </div>`).join('');
}

function renderResumeProfiles() {
  const resumes = settingsData.resume_profiles;
  $('activeResumeProfileId').value = resumes.active_resume_profile_id || '';
  const container = $('resumeProfilesSettings');
  const items = resumes.items || [];
  $('registerResumeFileBtn').textContent = items.length ? 'Import Resume' : 'Upload Resume';
  const readinessChecks = settingsData?.product_readiness?.checks || {};
  const hasSelectedLocalResume = Boolean(
    items.length > 0
    && readinessChecks.resume_selected
    && readinessChecks.resume_file_available
  );
  $('resumeExistingSection').classList.toggle('hidden', !hasSelectedLocalResume);
  $('resumeUploadCard').classList.toggle('has-resume', hasSelectedLocalResume);
  $('resumeJourneyState').textContent = items.some(profile => profile.approved_at)
    ? 'A resume version is approved. Continue to Profile to review reusable facts.'
    : 'Review and approve the exact local version before building an application package.';
  container.innerHTML = items.map((profile, index) => {
    const isActive = profile.resume_id === resumes.active_resume_profile_id;
    const isArchived = Boolean(profile.archived_at);
    return `
    <div class="resume-profile-card">
      <div class="resume-card-main">
        <div>
          <div class="resume-profile-title">${escapeHtml(profile.name || `Resume ${index + 1}`)}</div>
          <p>Version ${escapeHtml(String(profile.version || 1))} · ${escapeHtml(profile.language || 'language not set')}</p>
          <div class="tag-list">${(profile.target_roles || []).length
            ? profile.target_roles.map(role => `<span>${escapeHtml(role)}</span>`).join('')
            : '<span>No target role added</span>'}</div>
          <div class="tag-list">
            ${isActive ? '<span>Active</span>' : ''}
            ${isArchived ? '<span>Archived</span>' : ''}
          </div>
        </div>
        <div class="resume-review-action">
          ${profile.approved_at && !isArchived
            ? '<span class="resume-approved-badge">✓ Version approved</span>'
            : isArchived
              ? '<span class="candidate-fact-status">Archived</span>'
              : `<button type="button" class="btn-primary" data-approve-resume-index="${index}" ${profile.resume_file_status !== 'exists' || !profile.content_hash ? 'disabled' : ''}>Review and Approve Version</button>`}
          <button type="button" class="btn-secondary" data-analyze-resume-index="${index}" ${isArchived || profile.resume_file_status !== 'exists' || !profile.content_hash ? 'disabled' : ''}>Analyze Local Copy</button>
        </div>
      </div>
      <p class="file-status">Local file: ${escapeHtml(profile.resume_file_status || 'not checked')} · ${profile.approved_at ? `approved ${escapeHtml(profile.approved_at)}` : 'approval still needed'}</p>
      <div class="resume-management-actions" aria-label="Resume management">
        <button type="button" class="btn-secondary" data-resume-rename-open="${index}">Rename</button>
        <button type="button" class="btn-secondary" data-manage-resume-index="${index}" data-resume-action="duplicate" ${profile.resume_file_status !== 'exists' ? 'disabled' : ''}>Duplicate</button>
        ${isArchived
          ? `<button type="button" class="btn-secondary" data-manage-resume-index="${index}" data-resume-action="restore">Restore</button>`
          : `<button type="button" class="btn-secondary" data-manage-resume-index="${index}" data-resume-action="archive">Archive</button>`}
        <button type="button" class="btn-secondary" data-manage-resume-index="${index}" data-resume-action="set_active" ${isActive || isArchived || profile.resume_file_status !== 'exists' ? 'disabled' : ''}>${isActive ? 'Active Resume' : 'Set Active'}</button>
        <a class="btn-secondary" href="/api/settings/resume-profiles/${encodeURIComponent(profile.resume_id)}/export" download>Export</a>
        <button type="button" class="btn-danger" data-manage-resume-index="${index}" data-resume-action="delete">Delete</button>
      </div>
      <div class="resume-rename-editor hidden" data-resume-rename-editor="${index}">
        <label>Resume name
          <input type="text" maxlength="120" value="${escapeAttrValue(profile.name || '')}" data-resume-rename-input="${index}">
        </label>
        <button type="button" class="btn-primary" data-resume-rename-save="${index}">Save Rename</button>
        <button type="button" class="btn-secondary" data-resume-rename-cancel="${index}">Cancel</button>
      </div>
      <details class="advanced-disclosure compact">
        <summary>Advanced resume details</summary>
        <div class="resume-grid">
          ${resumeInput(index, 'id', 'ID', profile.id)}
          ${resumeInput(index, 'name', 'Name', profile.name)}
          ${resumeInput(index, 'resume_file_path', 'Resume File Path', profile.resume_file_path)}
          ${resumeInput(index, 'profile_file_path', 'Profile File Path', profile.profile_file_path)}
          ${resumeInput(index, 'version', 'Version', profile.version)}
          ${resumeInput(index, 'target_roles', 'Target Roles (comma separated)', (profile.target_roles || []).join(', '))}
          ${resumeInput(index, 'skills', 'Skills (comma separated)', (profile.skills || []).join(', '))}
          ${resumeInput(index, 'experience_summary', 'Experience Summary', profile.experience_summary)}
          ${resumeInput(index, 'language', 'Language', profile.language)}
          ${resumeInput(index, 'content_hash', 'Content Hash', profile.content_hash, true)}
          ${resumeInput(index, 'approved_at', 'Approved At', profile.approved_at, true)}
          <label class="choice-row"><input type="checkbox" ${profile.enabled !== false ? 'checked' : ''} data-resume-path="${index}.enabled"> Enabled</label>
          <label class="choice-row safety-locked"><input type="checkbox" disabled data-safety-locked="allow_resume_attach"> Resume upload always asks first</label>
          <label class="choice-row safety-locked"><input type="checkbox" disabled data-safety-locked="allow_final_submit"> Final submit stays manual</label>
        </div>
      </details>
      ${resumeAnalysisHtml(profile)}
    </div>`;
  }).join('') || '<p class="empty">No resume profiles yet.</p>';
}

function structuredFactTitle(item, index) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return `Item ${index + 1}`;
  const roleCompany = [item.role || item.title, item.company || item.organization].filter(Boolean).join(' at ');
  return String(roleCompany || item.name || item.project || item.degree || item.institution || item.language || `Item ${index + 1}`);
}

function factValueHtml(value) {
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="fact-empty-value">Not provided</span>';
    if (value.every(item => item === null || typeof item !== 'object')) {
      return `<div class="tag-list">${value.map(item => `<span>${escapeHtml(String(item))}</span>`).join('')}</div>`;
    }
    return `<div class="fact-structured-list">${value.map((item, index) => `<article><b>${escapeHtml(structuredFactTitle(item, index))}</b>${factValueHtml(item)}</article>`).join('')}</div>`;
  }
  if (value && typeof value === 'object') {
    return `<dl class="fact-value-list">${Object.entries(value).filter(([, item]) => item !== '' && item !== null && item !== undefined).map(([key, item]) => `<div><dt>${escapeHtml(humanizeToken(key))}</dt><dd>${factValueHtml(item)}</dd></div>`).join('')}</dl>`;
  }
  return `<span>${escapeHtml(String(value ?? ''))}</span>`;
}

function candidateFactEditorHtml(fact, valueKind) {
  const textarea = `<textarea data-profile-fact-value="${escapeAttrValue(fact.fact_key)}" data-value-kind="${escapeAttrValue(valueKind)}">${escapeHtml(profileFactEditorValue(fact.value))}</textarea>`;
  if (valueKind === 'structured') {
    return `<p class="settings-help">Use the human-friendly Career Brain forms above for normal edits.</p><details class="advanced-disclosure compact"><summary>Advanced · structured fact JSON</summary><label>Edit ${escapeHtml(humanizeToken(fact.fact_key))}${textarea}</label></details>`;
  }
  return `<label>Edit ${escapeHtml(humanizeToken(fact.fact_key))}${textarea}</label>`;
}

function resumeAnalysisHtml(profile) {
  const result = resumeAnalysisById.get(profile.resume_id);
  if (!result || result.resume_profile?.content_hash !== profile.content_hash) return '';
  const analysis = result.analysis || {};
  const suggestions = Array.isArray(analysis.suggestions) ? analysis.suggestions : [];
  const warnings = Array.isArray(analysis.warnings) ? analysis.warnings : [];
  return `
    <section class="resume-analysis-preview" data-analysis-resume-id="${escapeAttrValue(profile.resume_id)}">
      <div class="resume-analysis-heading">
        <div>
          <strong>Local analysis preview</strong>
          <span>${escapeHtml(String(analysis.format || '').toUpperCase())} · ${Number(analysis.extracted_character_count || 0)} extracted characters · raw text not retained</span>
        </div>
        <span class="candidate-fact-status">Review required</span>
      </div>
      ${warnings.length ? `<div class="resume-analysis-warning">${warnings.map(escapeHtml).join(' ')}</div>` : ''}
      <div class="resume-analysis-summary">
        ${Number(analysis.summary?.suggestion_count || 0)} suggestion(s);
        ${Number(analysis.summary?.new_fact_suggestion_count || 0)} new;
        ${Number(analysis.summary?.existing_fact_conflict_count || 0)} overlap with existing facts;
        ${Number(analysis.summary?.applicable_suggestion_count || 0)} can update existing profile fields.
      </div>
      <div class="resume-analysis-suggestions">
        ${suggestions.map(item => `
          <article class="candidate-fact-card ${item.existing_fact_present ? 'existing' : ''}">
            <div class="candidate-fact-heading">
              <strong>${escapeHtml(item.fact_key || '')}</strong>
              <span class="candidate-fact-status">${item.existing_fact_present ? 'compare existing' : 'new suggestion'}</span>
            </div>
            <pre>${escapeHtml(factValueText(item.value))}</pre>
            <div class="candidate-fact-meta">
              source: local resume document · confidence: ${Math.round(Number(item.confidence || 0) * 100)}% ·
              evidence: ${escapeHtml(item.evidence || '')} · not confirmed or saved
            </div>
            <label class="resume-suggestion-choice">
              <input
                type="checkbox"
                data-analysis-suggestion="${escapeAttrValue(item.suggestion_id)}"
                ${item.can_apply_to_existing_profile ? '' : 'disabled'}
              >
              ${item.can_apply_to_existing_profile
                ? `Apply to existing field: ${escapeHtml(item.target_path || item.fact_key)}`
                : `Cannot apply automatically: ${escapeHtml(item.apply_blocked_reason || 'review manually')}`}
            </label>
          </article>`).join('') || '<p class="candidate-fact-empty">No high-confidence fact suggestions were found.</p>'}
      </div>
      <div class="resume-analysis-apply-row">
        <button
          type="button"
          class="btn-save"
          data-apply-resume-suggestions="${escapeAttrValue(profile.resume_id)}"
          disabled
        >Apply Selected Facts</button>
        <p class="settings-help">Applying writes only selected non-sensitive values into fields that already exist in Candidate Profile. It revokes profile approval and requires a full Candidate Facts review before package building.</p>
      </div>
    </section>`;
}

function renderCandidateFacts() {
  const intelligence = settingsData?.resume_intelligence;
  const facts = Array.isArray(intelligence?.facts) ? intelligence.facts : [];
  const summary = intelligence?.summary || {};
  const summaryContainer = $('candidateFactsSummary');
  const factsContainer = $('candidateFactsSettings');
  const confirmButton = $('confirmCandidateFactsBtn');
  if (!summaryContainer || !factsContainer || !confirmButton) return;

  const allConfirmed = Boolean(intelligence?.current_review_approved);
  summaryContainer.innerHTML = `
    <div><span>Facts found</span><strong>${Number(summary.available_fact_count || 0)}</strong></div>
    <div><span>Already confirmed</span><strong>${Number(summary.confirmed_fact_count || 0)}</strong></div>
    <div><span>Profile coverage</span><strong>${Number(summary.profile_section_coverage_percent ?? summary.core_fact_coverage_percent ?? 0)}%</strong></div>`;

  const sectionOrder = ['Basics', 'Education', 'Experience', 'Skills', 'Projects', 'Languages', 'Certifications', 'Additional'];
  const editableSections = new Set(sectionOrder);
  const preferredAddField = {
    Basics: 'full_name',
    Education: 'school',
    Experience: 'work_experience',
    Skills: 'skills',
    Projects: 'projects',
    Languages: 'languages'
  };
  const schema = Array.isArray(settingsData?.candidate_fact_schema) ? settingsData.candidate_fact_schema : [];
  const factsByKey = new Map(facts.map(fact => [fact.fact_key, fact]));
  const groups = new Map(sectionOrder.map(label => [label, []]));
  facts.forEach(fact => groups.get(profileSectionForFact(fact)).push(fact));
  factsContainer.innerHTML = sectionOrder.map(label => {
    const items = groups.get(label);
    const addOptions = schema
      .filter(item => item.section === label && !factsByKey.has(item.fact_key))
      .sort((left, right) =>
        Number(right.fact_key === preferredAddField[label])
        - Number(left.fact_key === preferredAddField[label])
      );
    return `
      <section class="profile-fact-section ${items.length ? '' : 'empty-section'}">
        <div class="profile-section-heading">
          <div>
            <h3>${escapeHtml(label)}</h3>
            <span>${items.length ? `${items.length} detected` : 'Not detected'}</span>
          </div>
          ${editableSections.has(label) && addOptions.length
            ? `<button class="btn-secondary" type="button" data-add-profile-section="${escapeAttrValue(label)}">Add</button>`
            : ''}
        </div>
        ${items.length ? items.map(fact => `
          <article class="candidate-fact-card ${fact.sensitive ? 'sensitive' : ''}">
            <div class="candidate-fact-heading">
              <div>
                <span class="fact-label">${escapeHtml(humanizeToken(fact.fact_key || 'Fact'))}</span>
                <div class="fact-readable-value">${factValueHtml(fact.value)}</div>
              </div>
              <span class="candidate-fact-status ${fact.user_confirmed ? 'confirmed' : ''}">${fact.user_confirmed ? 'Approved' : 'Review'}</span>
            </div>
            <div class="candidate-fact-actions">
                <button class="btn-secondary" type="button" data-edit-profile-fact="${escapeAttrValue(fact.fact_key)}">Edit</button>
                <button class="btn-secondary" type="button" data-approve-profile-fact="${escapeAttrValue(fact.fact_key)}" ${fact.user_confirmed ? 'disabled' : ''}>Approve</button>
                <button class="btn-secondary" type="button" data-reject-profile-fact="${escapeAttrValue(fact.fact_key)}">Reject</button>
                <button class="btn-danger" type="button" data-delete-profile-fact="${escapeAttrValue(fact.fact_key)}">Delete</button>
            </div>
            <div class="profile-fact-editor hidden" data-profile-fact-editor="${escapeAttrValue(fact.fact_key)}">
                ${candidateFactEditorHtml(fact, schema.find(item => item.fact_key === fact.fact_key)?.value_kind || 'text')}
                <button class="btn-primary" type="button" data-save-profile-fact="${escapeAttrValue(fact.fact_key)}">Save</button>
                <button class="btn-secondary" type="button" data-cancel-profile-fact="${escapeAttrValue(fact.fact_key)}">Cancel</button>
            </div>
            ${fact.sensitive ? '<p class="settings-help">Sensitive value: saving here does not authorize reuse. Resume Jobs will ask again for each application.</p>' : ''}
            <details class="fact-provenance">
              <summary>Source and confidence</summary>
              <p>${escapeHtml(fact.source || 'unknown source')} · ${Math.round(Number(fact.confidence || 0) * 100)}% confidence · ${fact.sensitive ? 'sensitive, asks every time' : 'reusable after Profile approval'}</p>
            </details>
          </article>`).join('') : '<p class="profile-empty-copy">Nothing was detected in this section. Resume Jobs will leave it blank rather than guess.</p>'}
        ${editableSections.has(label) && addOptions.length ? `
          <div class="profile-add-editor hidden" data-profile-add-editor="${escapeAttrValue(label)}">
            <label>Field
              <select data-profile-add-key="${escapeAttrValue(label)}">
                ${addOptions.map(item => `<option value="${escapeAttrValue(item.fact_key)}" data-value-kind="${escapeAttrValue(item.value_kind)}">${escapeHtml(humanizeToken(item.fact_key))}</option>`).join('')}
              </select>
            </label>
            <label>Value
              <textarea data-profile-add-value="${escapeAttrValue(label)}" placeholder="Enter the fact. Use JSON for structured experience or projects."></textarea>
            </label>
            <button class="btn-primary" type="button" data-save-new-profile-fact="${escapeAttrValue(label)}">Add Fact</button>
            <button class="btn-secondary" type="button" data-cancel-new-profile-fact="${escapeAttrValue(label)}">Cancel</button>
          </div>` : ''}
      </section>`;
  }).join('');
  confirmButton.disabled = !facts.length || !settingsData.candidate_profile?.can_confirm_snapshot;
  confirmButton.textContent = allConfirmed ? 'Profile Approved ✓' : 'Approve Profile';
}

function renderCandidateProfileVersions() {
  const container = $('candidateProfileVersions');
  if (!container) return;
  const versions = settingsData?.candidate_profile?.versions || { active_version_id: '', items: [] };
  const items = Array.isArray(versions.items) ? versions.items : [];
  container.innerHTML = items.length
    ? items.map(item => `
      <article class="provider-config-card">
        <div class="section-heading">
          <div>
            <h4>${escapeHtml(item.name || 'Untitled Profile')}</h4>
            <p>Saved ${escapeHtml(item.created_at || 'unknown')}${item.resume_id ? ' · Linked to a resume version' : ''}</p>
          </div>
          <span class="provider-state ${item.active ? 'state-ready' : ''}">${item.active ? 'ACTIVE' : 'SAVED'}</span>
        </div>
        <div class="inline-actions">
          <button class="btn-secondary" type="button" data-profile-version-activate="${escapeAttrValue(item.version_id)}" ${item.active ? 'disabled' : ''}>Restore</button>
          <button class="btn-danger" type="button" data-profile-version-delete="${escapeAttrValue(item.version_id)}">Delete</button>
        </div>
      </article>`).join('')
    : '<p class="empty">No saved Profile versions yet. Current edits are already saved locally; use Save New Version to create a named snapshot.</p>';
}

async function manageCandidateProfileVersion(action, options = {}) {
  try {
    const result = await fetchJSON('/api/settings/candidate-profile/versions', {
      method: 'POST',
      body: JSON.stringify({ action, ...options })
    });
    await loadSettings();
    switchView('profile');
    if ($('candidateProfileVersionName')) $('candidateProfileVersionName').value = '';
    showSettingsStatus('ok', action === 'create'
      ? `Profile version "${result.version?.name || ''}" saved locally.`
      : action === 'activate'
        ? 'Profile version restored. Review the facts and approve this snapshot before continuing.'
        : 'Profile version deleted.');
    return true;
  } catch (error) {
    showSettingsStatus('error', error.details?.message || error.message);
    return false;
  }
}

function profileFactEditorValue(value) {
  if (value && typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value ?? '');
}

function parseProfileFactValue(rawValue, valueKind) {
  const value = String(rawValue ?? '').trim();
  if (!value) throw new Error('Profile fact value cannot be empty.');
  if (valueKind === 'list') {
    if (value.startsWith('[')) {
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) throw new Error();
        const items = parsed.map(item => String(item ?? '').trim()).filter(Boolean);
        if (!items.length) throw new Error();
        return items;
      } catch {
        throw new Error('List values must be a JSON array or one item per line.');
      }
    }
    return value.split(/[\n,]+/).map(item => item.trim()).filter(Boolean);
  }
  if (valueKind === 'structured') {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error('Structured experience or project values must be valid JSON.');
    }
  }
  return value;
}

async function changeCandidateFact({ action, factKey, value, confirmed = false }) {
  try {
    const result = await fetchJSON('/api/settings/candidate-profile/facts', {
      method: 'POST',
      body: JSON.stringify({
        action,
        fact_key: factKey,
        value,
        confirmed
      })
    });
    await loadSettings();
    switchView('profile');
    showSettingsStatus('ok', `${humanizeToken(result.fact_key)} ${result.action} completed locally. Review and approve the current Profile snapshot before continuing.`);
    return true;
  } catch (error) {
    showSettingsStatus('error', `Profile fact ${action} failed: ${error.message}`);
    return false;
  }
}

async function handleCandidateFactAction(event) {
  const editButton = event.target.closest('[data-edit-profile-fact]');
  if (editButton) {
    const editor = document.querySelector(`[data-profile-fact-editor="${escapeAttr(editButton.dataset.editProfileFact)}"]`);
    if (editor) editor.classList.remove('hidden');
    return true;
  }
  const cancelButton = event.target.closest('[data-cancel-profile-fact]');
  if (cancelButton) {
    const editor = document.querySelector(`[data-profile-fact-editor="${escapeAttr(cancelButton.dataset.cancelProfileFact)}"]`);
    if (editor) editor.classList.add('hidden');
    return true;
  }
  const saveButton = event.target.closest('[data-save-profile-fact]');
  if (saveButton) {
    const factKey = saveButton.dataset.saveProfileFact;
    const input = document.querySelector(`[data-profile-fact-value="${escapeAttr(factKey)}"]`);
    if (!input) return true;
    try {
      await changeCandidateFact({
        action: 'edit',
        factKey,
        value: parseProfileFactValue(input.value, input.dataset.valueKind)
      });
    } catch (error) {
      showSettingsStatus('error', error.message);
    }
    return true;
  }
  const approveButton = event.target.closest('[data-approve-profile-fact]');
  if (approveButton) {
    await changeCandidateFact({
      action: 'approve',
      factKey: approveButton.dataset.approveProfileFact,
      confirmed: true
    });
    return true;
  }
  const deleteButton = event.target.closest('[data-delete-profile-fact]');
  if (deleteButton) {
    const factKey = deleteButton.dataset.deleteProfileFact;
    if (await confirmProductAction({
      title: `Delete ${humanizeToken(factKey)}?`,
      message: 'This removes the fact from the local Candidate Profile. Resume Jobs will not reuse the detected value unless you add it again.',
      confirmLabel: 'Delete Fact',
      tone: 'danger'
    })) {
      await changeCandidateFact({ action: 'delete', factKey, confirmed: true });
    }
    return true;
  }
  const rejectButton = event.target.closest('[data-reject-profile-fact]');
  if (rejectButton) {
    const factKey = rejectButton.dataset.rejectProfileFact;
    if (await confirmProductAction({
      title: `Reject ${humanizeToken(factKey)}?`,
      message: 'Resume Jobs will stop suggesting this detected value until you add a replacement.',
      confirmLabel: 'Reject Fact'
    })) {
      await changeCandidateFact({ action: 'reject', factKey, confirmed: true });
    }
    return true;
  }
  const addButton = event.target.closest('[data-add-profile-section]');
  if (addButton) {
    const editor = document.querySelector(`[data-profile-add-editor="${escapeAttr(addButton.dataset.addProfileSection)}"]`);
    if (editor) editor.classList.remove('hidden');
    return true;
  }
  const cancelAddButton = event.target.closest('[data-cancel-new-profile-fact]');
  if (cancelAddButton) {
    const editor = document.querySelector(`[data-profile-add-editor="${escapeAttr(cancelAddButton.dataset.cancelNewProfileFact)}"]`);
    if (editor) editor.classList.add('hidden');
    return true;
  }
  const saveNewButton = event.target.closest('[data-save-new-profile-fact]');
  if (saveNewButton) {
    const section = saveNewButton.dataset.saveNewProfileFact;
    const select = document.querySelector(`[data-profile-add-key="${escapeAttr(section)}"]`);
    const input = document.querySelector(`[data-profile-add-value="${escapeAttr(section)}"]`);
    if (!select || !input) return true;
    const selected = select.options[select.selectedIndex];
    try {
      await changeCandidateFact({
        action: 'add',
        factKey: select.value,
        value: parseProfileFactValue(input.value, selected?.dataset.valueKind || 'text')
      });
    } catch (error) {
      showSettingsStatus('error', error.message);
    }
    return true;
  }
  return false;
}

function profileSectionForFact(fact) {
  const key = `${fact.category || ''} ${fact.fact_key || ''}`.toLowerCase();
  if (/education|degree|school|university/.test(key)) return 'Education';
  if (/project|portfolio/.test(key)) return 'Projects';
  if (/language/.test(key)) return 'Languages';
  if (/certificate|certification|license/.test(key)) return 'Certifications';
  if (/skill|technology|tool/.test(key)) return 'Skills';
  if (/experience|employment|company|job_title/.test(key)) return 'Experience';
  if (/identity|contact|location|name|email|phone|city|country/.test(key)) return 'Basics';
  return 'Additional';
}

async function confirmCandidateFacts() {
  const intelligence = settingsData?.resume_intelligence;
  const facts = Array.isArray(intelligence?.facts) ? intelligence.facts : [];
  if (!facts.length || !intelligence.snapshot_token) {
    showSettingsStatus('error', 'No current candidate-fact snapshot is available to confirm.');
    return;
  }
  const accepted = await confirmProductAction({
    title: 'Approve this Profile snapshot?',
    message: `Confirm that you reviewed ${facts.length} candidate facts shown here.\n\n`
      + 'This also approves the current verified local Resume Version for Application Packages. '
      + 'This does not enable real-site autofill, resume upload, or final submission. '
      + 'Sensitive facts still require confirmation for each application.',
    confirmLabel: 'Approve Profile'
  });
  if (!accepted) return;
  try {
    const result = await fetchJSON('/api/settings/candidate-profile/confirm', {
      method: 'POST',
      body: JSON.stringify({
        confirmed: true,
        snapshot_token: intelligence.snapshot_token
      })
    });
    showSettingsStatus('ok', `candidate facts confirmed at ${result.confirmed_at}. Backup: ${result.backup || 'n/a'}`);
    await loadSettings();
  } catch (error) {
    showSettingsStatus('error', `Candidate fact confirmation failed: ${error.message}`);
  }
}

function resumeInput(index, field, label, value, readOnly = false) {
  const binding = readOnly ? 'readonly' : `data-resume-path="${index}.${escapeAttr(field)}"`;
  return `<label class="settings-field">${escapeHtml(label)} <input type="text" value="${escapeAttrValue(value || '')}" ${binding}></label>`;
}

function renderSafetySettings() {
  const safety = settingsData.search_preferences.safety || {};
  const profile = editableSearchProfile() || {};
  $('safetySettings').innerHTML = `
    <section class="settings-group">
      <div><p class="eyebrow">GENERAL</p><h3>Appearance and local behavior</h3></div>
      <div class="preference-row"><span>Language</span><strong>English</strong></div>
      <div class="preference-row"><span>Theme</span><strong>System</strong></div>
      <div class="preference-row"><span>Local state</span><strong>Saved automatically</strong></div>
    </section>
    <section class="settings-group">
      <div><p class="eyebrow">AI</p><h3>Optional model assistance</h3></div>
      <div class="preference-row"><span>Provider</span><strong>${escapeHtml(settingsData.ai_provider?.type || 'Disabled')}</strong></div>
      <div class="preference-row"><span>Model changes</span><strong>Advisory only</strong></div>
      <p class="settings-help">Deterministic product rules control state changes even when a local model is enabled.</p>
    </section>
    <section class="settings-group">
      <div><p class="eyebrow">BROWSER</p><h3>Safe form assistance</h3></div>
      <div class="preference-row"><span>Supported browser</span><strong>Chrome or Edge</strong></div>
      <div class="preference-row"><span>Open automatically</span><strong>Only after Start AI Fill Assistant</strong></div>
      <div class="preference-row"><span>Headless mode</span><strong>Off for supervised use</strong></div>
    </section>
    <section class="settings-group">
      <div><p class="eyebrow">SEARCH</p><h3>Current defaults</h3></div>
      <div class="preference-row"><span>Maximum results</span><strong>${escapeHtml(String(profile.maximum_search_results || 20))}</strong></div>
      <div class="preference-row"><span>Maximum jobs per batch</span><strong>${escapeHtml(String(profile.maximum_jobs_to_open || 5))}</strong></div>
      <button class="btn-secondary" type="button" onclick="switchView('job-search')">Edit in Job Search</button>
    </section>
    <section class="settings-group">
      <div><p class="eyebrow">APPLICATION</p><h3>Human-control rules</h3></div>
      <div class="preference-row"><span>Pause on unknown question</span><strong class="success-text">Always</strong></div>
      <div class="preference-row"><span>Ask before sensitive questions</span><strong class="success-text">Always</strong></div>
      <div class="preference-row"><span>Auto upload resume</span><strong>${safety.auto_upload_resume ? 'Enabled' : 'Off'}</strong></div>
      <div class="preference-row"><span>Final submit</span><strong>${safety.auto_submit ? 'Enabled' : 'You submit yourself'}</strong></div>
    </section>`;
}

function markSettingsDirty() {
  settingsDirty = true;
  showSettingsStatus('dirty', 'unsaved settings edits');
}

function updateResumeSuggestionApplyButton(panel) {
  const button = panel?.querySelector('[data-apply-resume-suggestions]');
  if (!button) return;
  button.disabled = !panel.querySelector('[data-analysis-suggestion]:checked');
}

function handleSettingsInput(event) {
  if (!settingsData) return;
  const target = event.target;
  if (target.closest('#jobSearchSourcesContainer')) {
    showJobSearchSourceStatus('dirty', 'Unsaved Job Search Source changes.');
    return;
  }
  if (target.closest('#aiProviderContainer')) {
    if (target.id === 'aiProviderType') {
      const defaults = {
        local_openai_compatible: 'http://127.0.0.1:1234/v1',
        openai: 'https://api.openai.com/v1',
        anthropic: 'https://api.anthropic.com/v1',
        openai_compatible: 'https://your-provider.example/v1'
      };
      $('aiProviderEndpoint').placeholder = defaults[target.value] || '';
    }
    showAIProviderStatus('dirty', 'Unsaved AI Provider changes.');
    return;
  }
  if (target.closest('.profile-fact-editor, .profile-add-editor')) return;
  if (target.dataset.analysisSuggestion) {
    updateResumeSuggestionApplyButton(target.closest('.resume-analysis-preview'));
    return;
  }
  if (target.dataset.safetyLocked) {
    target.checked = false;
    showSettingsStatus('warning', 'safety locked: this field cannot be enabled');
    return;
  }
  const settingPath = target.dataset.settingPath;
  const searchProfileField = target.dataset.searchProfileField;
  const simpleSearchField = target.dataset.simpleSearchField;
  const resumePath = target.dataset.resumePath;
  let changed = false;
  if (target.id === 'searchProfileSelect') {
    settingsData.search_preferences.active_search_profile_id = target.value;
    renderSettings();
    changed = true;
  }
  if (simpleSearchField) {
    updateSimpleSearchField(simpleSearchField, target);
    changed = true;
  }
  if (searchProfileField) {
    updateSearchProfile(searchProfileField, target);
    changed = true;
  }
  if (settingPath) {
    updateSearchPreference(settingPath, target);
    changed = true;
  }
  if (resumePath) {
    updateResumeProfile(resumePath, target);
    changed = true;
  }
  if (target.id === 'activeResumeProfileId') {
    settingsData.resume_profiles.active_resume_profile_id = target.value.trim();
    changed = true;
  }
  if (!changed) return;
  markSettingsDirty();
}

function updateSimpleSearchField(field, target) {
  const profile = editableSearchProfile();
  if (!profile) return;
  if (field === 'workplace_mode') {
    if (target.checked) profile.workplace_modes = [target.value];
    return;
  }
  if (field === 'seniority') {
    profile.seniority_levels = [target.value || 'any'];
    return;
  }
  const key = field === 'target_role' ? 'target_roles' : 'preferred_locations';
  const defaultWeight = field === 'target_role' ? 100 : 80;
  const value = target.value.trim();
  const items = profile[key] || (profile[key] = []);
  const firstIndex = Math.max(0, items.findIndex(item => item.enabled !== false));
  if (!items.length) items.push({ keyword: value, weight: defaultWeight, enabled: true, aliases: [] });
  else items[firstIndex] = { ...items[firstIndex], keyword: value, weight: items[firstIndex].weight ?? defaultWeight, enabled: true, aliases: items[firstIndex].aliases || [] };
}

function updateSearchProfile(field, target) {
  const profile = editableSearchProfile();
  if (!profile) return;
  if (target.dataset.valueType === 'csv') profile[field] = splitCsv(target.value);
  else if (target.dataset.valueType === 'number') profile[field] = Number(target.value);
  else if (target.dataset.valueType === 'optional-number') profile[field] = target.value === '' ? null : Number(target.value);
  else if (target.type === 'checkbox') {
    profile[field] = target.checked;
    if (field === 'show_unseen_only' && target.checked) profile.include_previously_seen = false;
    if (field === 'include_previously_seen' && target.checked) profile.show_unseen_only = false;
    renderSearchProfile();
  }
  else profile[field] = target.value;
}

function updateSearchPreference(path, target) {
  const [key, indexText, field] = path.split('.');
  const owner = key === 'preferred_companies' ? settingsData.search_preferences : editableSearchProfile();
  const item = owner?.[key]?.[Number(indexText)];
  if (!item) return;
  if (field === 'enabled') item.enabled = target.checked;
  else if (field === 'weight') item.weight = Number(target.value) || 0;
  else if (field === 'aliases') item.aliases = splitCsv(target.value);
  else item[field] = target.value;
}

function updateResumeProfile(path, target) {
  const [indexText, field] = path.split('.');
  const item = settingsData.resume_profiles.items[Number(indexText)];
  if (!item) return;
  if (field === 'enabled') item.enabled = target.checked;
  else if (field === 'target_roles' || field === 'skills') item[field] = splitCsv(target.value);
  else if (field === 'version') item.version = Number(target.value) || 1;
  else item[field] = target.value;
  lockResumeProfileSafety(item);
}

function addSettingItem(key) {
  if (!settingsData) return;
  const profile = editableSearchProfile();
  if (!profile) return;
  const owner = key === 'preferred_companies' ? settingsData.search_preferences : profile;
  if (key === 'excluded_keywords') owner[key].push({ keyword: '', reason: '', enabled: true });
  else owner[key].push({ keyword: '', weight: key === 'target_roles' ? 100 : 80, enabled: true, aliases: [] });
  renderSettings();
  markSettingsDirty();
}

function createSearchProfile(copyCurrent = false) {
  const search = settingsData.search_preferences;
  const current = editableSearchProfile();
  const suffix = Date.now().toString(36);
  const profile = copyCurrent && current
    ? structuredClone(current)
    : {
        target_roles: [{ keyword: '', weight: 100, enabled: true, aliases: [] }],
        preferred_locations: [],
        workplace_modes: ['any'],
        seniority_levels: ['any'],
        required_skills: [],
        preferred_skills: [],
        excluded_keywords: [],
        excluded_companies: [],
        posted_within_days: 30,
        job_types: ['any'],
        minimum_salary: null,
        maximum_search_results: 50,
        maximum_jobs_to_open: 5,
        show_unseen_only: false,
        include_previously_seen: true,
        do_not_repeat_rejected: true,
        do_not_repeat_approved: true,
        do_not_repeat_applied: true,
        repeat_after_days: 14,
        maximum_results_per_company: 3,
        minimum_source_diversity: 2
      };
  profile.id = `search_${suffix}`;
  profile.name = copyCurrent && current ? `${current.name} Copy` : 'New Search';
  profile.enabled = true;
  search.search_profiles.push(profile);
  search.active_search_profile_id = profile.id;
  renderSettings();
  markSettingsDirty();
}

function addResumeProfile() {
  if (!settingsData) return;
  settingsData.resume_profiles.items.push(lockResumeProfileSafety({
    id: `profile_${settingsData.resume_profiles.items.length + 1}`,
    name: 'New Resume Profile',
    resume_file_path: '',
    profile_file_path: '',
    target_roles: [],
    skills: [],
    experience_summary: '',
    language: 'zh-CN',
    version: 1,
    content_hash: '',
    approved_at: null,
    enabled: true,
    allow_resume_attach: false,
    allow_final_submit: false
  }));
  renderSettings();
  markSettingsDirty();
}

async function saveSearchPreferences() {
  if (!settingsData) return;
  settingsData.search_preferences.safety = {
    ...(settingsData.search_preferences.safety || {}),
    auto_approve: false,
    auto_submit: false,
    auto_upload_resume: false,
    require_manual_review_before_application: true
  };
  return saveSettings('/api/settings/search-preferences', { search_preferences: settingsData.search_preferences }, 'search preferences saved');
}

async function saveResumeProfiles() {
  if (!settingsData) return;
  settingsData.resume_profiles.items.forEach(lockResumeProfileSafety);
  return saveSettings('/api/settings/resume-profiles', { resume_profiles: settingsData.resume_profiles }, 'resume profiles saved');
}

async function findMatchingJobs() {
  const mode = $('searchModeSelect')?.value || 'live';
  resetSearchProgress();
  setSearchStage('save', 'active', 'Saving the current Search Configuration…');
  const saved = await saveSearchPreferences();
  if (!saved) {
    setSearchStage('save', 'error', 'Search Configuration could not be saved.');
    return;
  }
  setSearchStage('save', 'done');
  if (mode === 'offline_demo') {
    setSearchStage('health', 'done', 'Offline Demo uses no provider or network.');
    return runOfflineDemoSearch({ preferencesAlreadySaved: true });
  }
  const ai = settingsData?.job_search_sources?.ai_enrichment || providerHealthData?.ai_enrichment || {};
  if (mode === 'live_ai' && ai.status !== 'READY') {
    showRunStatus('warning', 'AI enrichment is unavailable, so this search will continue with Live Search and deterministic scoring.');
  }
  setSearchStage('health', 'active', 'Checking the configured provider, then searching public job pages…');
  const discovered = await runPipeline('discovery');
  if (!discovered) {
    setSearchStage('health', 'error', 'Provider check or Live Search failed. Open Settings to review Job Search Sources.');
    return;
  }
  setSearchStage('health', 'done');
  setSearchStage('search', 'done');
  setSearchStage('normalize', 'done');
  setSearchStage('dedupe', 'done');
  setSearchStage('score', 'active', 'Deduplicating, filtering, and applying deterministic scoring…');
  const scored = await runPipeline('scoring');
  if (!scored) {
    setSearchStage('score', 'error', 'Scoring did not complete.');
    return;
  }
  setSearchStage('score', 'done');
  if (mode === 'live_ai' && ai.status === 'READY') {
    setSearchStage('ai', 'active', 'Adding optional local AI explanations without changing deterministic scores…');
    const enriched = await runPipeline('ai-enrichment');
    if (enriched) {
      setSearchStage('ai', 'done');
    } else {
      setSearchStage('ai', 'error');
      showRunStatus('warning', 'Live Search and deterministic scoring completed, but optional AI enrichment failed. Job Matches remain available.');
    }
  } else {
    setSearchStage('ai', 'done', mode === 'live_ai'
      ? 'AI enrichment is disabled; deterministic results are complete.'
      : 'AI enrichment skipped by the selected mode.');
  }
  setSearchStage('complete', 'active', 'Refreshing Job Matches…');
  await loadSettings();
  await refreshAll();
  renderSearchResultSummary(discovered);
  if (!switchView('job-matches')) {
    setSearchStage('complete', 'error', 'No current scored matches are available.');
    showRunStatus('error', 'Search completed but no current scored matches are available. Review the search result and provider status before trying again.');
  } else {
    setSearchStage('complete', 'done', 'Search complete. Job Matches is ready.');
  }
}

function showJobUrlImportStatus(type, message) {
  const box = $('jobUrlImportStatus');
  if (!box) return;
  box.className = `settings-status ${type}`;
  box.textContent = message;
}

async function importJobUrl() {
  const input = $('jobUrlImportInput');
  const value = String(input?.value || '').trim();
  if (!value) return showJobUrlImportStatus('error', 'Enter a public job or career page URL first.');
  let hostname = 'this public job site';
  try { hostname = new URL(value).hostname || hostname; }
  catch { return showJobUrlImportStatus('error', 'Enter a valid HTTP or HTTPS job URL.'); }
  const saved = await saveSearchPreferences();
  if (!saved) return showJobUrlImportStatus('error', 'Save the current Search Configuration before importing a job.');
  if (!await confirmProductAction({
    title: 'Read public job metadata?',
    message: `Resume Jobs will contact ${hostname} once and read public job metadata or listing links. It will not log in, open an application in your browser, upload a resume, or submit an application.`,
    confirmLabel: 'Import Public Job'
  })) return;
  try {
    setRunning(true, { type: 'public job URL import', started_at: new Date().toISOString() });
    showJobUrlImportStatus('warning', `Reading public metadata from ${hostname}…`);
    const imported = await fetchJSON('/api/jobs/import-url', {
      method: 'POST',
      body: JSON.stringify({ url: value, confirmed_public_fetch: true })
    });
    const importedCount = Number(imported.discovered_urls_count || imported.jobs?.length || 1);
    showJobUrlImportStatus('ok', `${importedCount} public job record${importedCount === 1 ? '' : 's'} imported. Applying deterministic matching…`);
    const scored = await runPipeline('scoring');
    if (!scored) return showJobUrlImportStatus('error', 'The job was imported, but scoring did not complete. Use Score Jobs to retry.');
    await loadSettings();
    await refreshAll();
    input.value = '';
    showJobUrlImportStatus('ok', `${importedCount} imported job record${importedCount === 1 ? ' is' : 's are'} ready in Job Matches.`);
    switchView('job-matches');
  } catch (error) {
    showJobUrlImportStatus('error', error.details?.message || error.message);
  } finally {
    setRunning(false);
  }
}

async function runOfflineDemoSearch({ preferencesAlreadySaved = false } = {}) {
  if (!preferencesAlreadySaved && !await confirmProductAction({
    title: 'Continue with a synthetic demo job?',
    message: 'Resume Jobs will add one clearly labeled synthetic job that opens only the localhost Mock ATS. It will not use the network, contact an employer, upload a resume, or submit an application.',
    confirmLabel: 'Use Offline Demo Job'
  })) return;
  if (!preferencesAlreadySaved) {
    const saved = await saveSearchPreferences();
    if (!saved) return;
  }
  try {
    resetSearchProgress();
    setSearchStage('save', 'done', 'Search Configuration saved.');
    setSearchStage('health', 'done', 'Offline Demo is synthetic and uses no provider or network.');
    setSearchStage('search', 'active', 'Creating one localhost-only synthetic job…');
    setRunning(true, { type: 'offline demo discovery', started_at: new Date().toISOString() });
    const result = await fetchJSON('/api/run/offline-demo-discovery', {
      method: 'POST',
      body: JSON.stringify({})
    });
    setSearchStage('search', 'done');
    setSearchStage('normalize', 'done');
    setSearchStage('dedupe', 'done');
    $('offlineDemoOption')?.classList.add('hidden');
    showRunStatus('ok', formatRunResult(result));
    setSearchStage('score', 'active', 'Applying deterministic scoring…');
    const scored = await runPipeline('scoring');
    if (!scored) return;
    setSearchStage('score', 'done');
    setSearchStage('ai', 'done', 'Offline Demo uses deterministic scoring only.');
    setSearchStage('complete', 'active', 'Opening the synthetic Job Match…');
    await loadSettings();
    await refreshAll();
    renderSearchResultSummary(result, { offlineDemo: true });
    if (!switchView('job-matches')) {
      setSearchStage('complete', 'error');
      showRunStatus('error', 'The synthetic demo job was created but no scored match is available.');
    } else {
      setSearchStage('complete', 'done', 'Offline Demo Job is ready.');
    }
  } catch (err) {
    showRunStatus('error', err.details?.message || err.message);
  } finally {
    setRunning(false);
  }
}

function resetSearchProgress() {
  $('searchProgressPanel')?.classList.remove('hidden');
  $('searchResultSummary')?.classList.add('hidden');
  document.querySelectorAll('[data-search-stage]').forEach(item => {
    item.classList.remove('active', 'done', 'error');
  });
}

function setSearchStage(stage, state, message = '') {
  const item = document.querySelector(`[data-search-stage="${stage}"]`);
  if (item) {
    item.classList.remove('active', 'done', 'error');
    if (state) item.classList.add(state);
  }
  if (message && $('searchProgressTitle')) $('searchProgressTitle').textContent = message;
}

function renderSearchResultSummary(result, { offlineDemo = false } = {}) {
  const box = $('searchResultSummary');
  if (!box) return;
  const domain = result?.domain_result || result || {};
  const breakdown = domain.detected_provider_breakdown || {};
  const raw = Number(domain.discovered_urls_count || (offlineDemo ? 1 : 0));
  const deduped = Number(domain.deduped_jobs_count || 0);
  const current = Number(domain.current_result_count ?? deduped);
  const newCount = Number(domain.new_result_count ?? current);
  const seenCount = Number(domain.previously_seen_result_count || 0);
  const deferred = Number(domain.deferred_count || 0);
  const diversity = Number(domain.discovery_quality?.source_diversity_count || 0);
  const shortlist = allJobs.length;
  const filteredOut = Math.max(0, deduped - shortlist);
  const queryResults = Array.isArray(domain.query_results) ? domain.query_results : [];
  box.innerHTML = `
    <h3>${offlineDemo ? 'Offline Demo Result' : 'Live Search Result'}</h3>
    <div class="search-metrics">
      <span><strong>${raw}</strong> raw URLs</span>
      <span><strong>${deduped}</strong> normalized / deduplicated</span>
      <span><strong>${newCount}</strong> new</span>
      <span><strong>${seenCount}</strong> previously seen</span>
      <span><strong>${deferred}</strong> kept in history</span>
      <span><strong>${diversity}</strong> source categories</span>
      <span><strong>${filteredOut}</strong> filtered out</span>
      <span><strong>${shortlist}</strong> shortlisted matches</span>
    </div>
    <p>By source: ${escapeHtml(Object.entries(breakdown).map(([name, count]) => `${name} ${count}`).join(', ') || (offlineDemo ? 'offline_demo 1' : 'none'))}</p>
    ${queryResults.length ? `<details class="executed-query-details"><summary>Executed queries, sources, times, and reasons</summary><ol>${queryResults.slice(0, 10).map(item => `<li><strong>${escapeHtml(item.query || 'Unnamed query')}</strong><span>${escapeHtml(item.source || item.provider || 'public source')} · ${escapeHtml(formatSearchTime(item.searched_at))} · ${escapeHtml(item.reason || 'Generated from the active search configuration.')} · ${escapeHtml(item.status || 'completed')}</span></li>`).join('')}</ol></details>` : ''}
    ${shortlist === 0 ? `<div class="inline-provider-error">
      <p>No matches passed the current filters. Broaden the target role or location, increase maximum results, or test the provider connection.</p>
      <div class="inline-actions">
        <button type="button" class="btn-secondary" data-zero-search-action="edit">Edit Search</button>
        <button type="button" class="btn-secondary" data-zero-search-action="provider">Check Provider</button>
        <button type="button" class="btn-secondary" data-zero-search-action="import">Import Job URL</button>
        <button type="button" class="btn-secondary" data-zero-search-action="demo">Offline Demo</button>
        <button type="button" class="btn-primary" data-zero-search-action="retry">Retry Search</button>
      </div>
    </div>` : ''}
  `;
  box.classList.remove('hidden');
}

function showResumeUploadStatus(type, message) {
  const box = $('resumeUploadStatus');
  if (!box) return;
  box.className = `settings-status ${type}`;
  box.textContent = message;
  if (type === 'ok') showProductToast('ok', message);
}

function resumeBytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
  }
  return btoa(chunks.join(''));
}

function updateResumeFileHint() {
  const file = $('resumeUploadFile').files?.[0];
  const hint = $('resumeUploadFileHint');
  if (!file) {
    hint.textContent = 'PDF, DOCX, or UTF-8 TXT, up to 10 MB.';
    return;
  }
  hint.textContent = `${file.name} · ${(file.size / 1024).toFixed(1)} KB · stays on this computer`;
  if (!$('resumeUploadName').value.trim()) {
    $('resumeUploadName').value = file.name.replace(/\.(pdf|docx|txt)$/i, '');
  }
}

async function registerResumeFile() {
  const file = $('resumeUploadFile').files?.[0];
  if (!file) return showResumeUploadStatus('error', 'Choose a PDF, DOCX, or TXT resume first.');
  if (!/\.(pdf|docx|txt)$/i.test(file.name)) {
    return showResumeUploadStatus('error', 'Only PDF, DOCX, and UTF-8 TXT files are supported.');
  }
  if (file.size <= 0 || file.size > 10 * 1024 * 1024) {
    return showResumeUploadStatus('error', 'The resume must be between 1 byte and 10 MB.');
  }
  if (settingsDirty && !await confirmProductAction({
    title: 'Discard unsaved Settings edits?',
    message: 'Adding the resume reloads Settings from local storage. Your unsaved Settings edits will be lost.',
    confirmLabel: 'Discard and Continue',
    tone: 'danger'
  })) return;
  const aiProviderEnabled = settingsData?.ai_provider?.enabled === true;
  const aiProviderName = settingsData?.ai_provider?.type || 'configured AI provider';
  if (!await confirmProductAction({
    title: 'Add this resume locally?',
    message: aiProviderEnabled
      ? `Resume Jobs will copy this file into the local Resume Library, extract its text, and send the extracted text to your configured ${aiProviderName} to create an unconfirmed Career Brain draft.\n\nIt will not open a job site, attach the resume to an application, or submit anything. Extracted resume text is not saved by Resume Jobs.`
      : 'Resume Jobs will copy this file into the local Resume Library, calculate a hash, and create an unconfirmed Career Brain draft using local deterministic extraction.\n\nNo model or job site will be contacted. It will not attach the resume to an application or submit anything.',
    confirmLabel: 'Add Local Resume'
  })) return;

  const button = $('registerResumeFileBtn');
  button.disabled = true;
  button.textContent = 'Adding locally…';
  showResumeUploadStatus('warning', 'Reading the selected file locally…');
  try {
    const contentBase64 = resumeBytesToBase64(await file.arrayBuffer());
    const result = await fetchJSON('/api/settings/resume-upload', {
      method: 'POST',
      body: JSON.stringify({
        file_name: file.name,
        content_base64: contentBase64,
        display_name: $('resumeUploadName').value.trim(),
        target_roles: splitCsv($('resumeUploadRoles').value),
        language: $('resumeUploadLanguage').value.trim(),
        activate: $('resumeUploadActivate').checked,
        confirmed_local_copy: true,
        allow_ai_analysis: aiProviderEnabled
      })
    });
    if (result.analysis) resumeAnalysisById.set(result.resume_profile.resume_id, result);
    await loadSettings();
    $('resumeUploadFile').value = '';
    updateResumeFileHint();
    showResumeUploadStatus(
      result.intake.analysis_error || result.career_brain_error || (aiProviderEnabled && result.career_brain_ai?.model_used !== true) ? 'warning' : 'ok',
      result.intake.analysis_error
        ? `${result.resume_profile.name} v${result.resume_profile.version} was added, but local analysis needs attention: ${result.intake.analysis_error.message}`
        : result.career_brain_error
          ? `${result.resume_profile.name} v${result.resume_profile.version} was parsed, but Career Brain needs attention: ${result.career_brain_error.message}`
          : aiProviderEnabled && result.career_brain_ai?.model_used !== true
            ? `${result.resume_profile.name} v${result.resume_profile.version} was parsed locally and ${result.intake.candidate_facts_persisted} fact(s) are ready for review. AI enrichment did not complete: ${result.career_brain_ai?.error || humanizeToken(result.career_brain_ai?.status || 'provider fallback')}. Increase the local model timeout or retry analysis.`
            : `${result.resume_profile.name} v${result.resume_profile.version} added and analyzed locally${result.career_brain_ai?.model_used ? ` with ${result.career_brain_ai.model || 'the configured AI model'}` : ''}. ${result.intake.candidate_facts_persisted} new fact(s) are ready for review.`
    );
    switchView(result.next_view || 'career-brain');
    showSettingsStatus('ok', 'Resume added locally. Next: review the Career Brain facts that are available, then approve the Profile.');
  } catch (err) {
    showResumeUploadStatus('error', err.message);
  } finally {
    button.disabled = false;
    button.textContent = settingsData?.resume_profiles?.items?.length ? 'Import Resume' : 'Upload Resume';
  }
}

async function manageResumeVersion(index, action, options = {}) {
  const profile = settingsData?.resume_profiles?.items?.[Number(index)];
  if (!profile) return showResumeUploadStatus('error', 'Reload Resume Library and try again.');
  if (settingsDirty && !await confirmProductAction({
    title: 'Discard unsaved Settings edits?',
    message: 'This Resume Library action reloads Settings from local storage. Your unsaved Settings edits will be lost.',
    confirmLabel: 'Discard and Continue',
    tone: 'danger'
  })) return;

  const payload = { action };
  if (action === 'rename') {
    const name = String(options.name || '').trim();
    if (!name) return showResumeUploadStatus('error', 'Resume name cannot be empty.');
    payload.name = name;
  }
  if (action === 'archive') {
    if (!await confirmProductAction({
      title: `Archive ${profile.name}?`,
      message: 'The local copy will be kept. This resume will stop being active and can be restored later.',
      confirmLabel: 'Archive Resume'
    })) return;
    payload.confirmed = true;
  }
  if (action === 'delete') {
    if (!await confirmProductAction({
      title: `Delete ${profile.name}?`,
      message: 'This removes the Resume Library record and its managed local copy. This action cannot be undone.',
      confirmLabel: 'Delete Resume',
      tone: 'danger'
    })) return;
    payload.confirmed = true;
    payload.content_hash = profile.content_hash;
  }

  const labels = {
    rename: 'renamed',
    duplicate: 'duplicated as an unapproved version',
    archive: 'archived',
    restore: 'restored',
    set_active: 'set as the active resume',
    delete: 'deleted'
  };
  try {
    const result = await fetchJSON(
      `/api/settings/resume-profiles/${encodeURIComponent(profile.resume_id)}/manage`,
      { method: 'POST', body: JSON.stringify(payload) }
    );
    resumeAnalysisById.delete(profile.resume_id);
    await loadSettings();
    showResumeUploadStatus('ok', `${profile.name} ${labels[action] || action}.`);
    if (result.action === 'set_active') switchView('profile');
  } catch (err) {
    showResumeUploadStatus('error', err.message);
  }
}

async function approveResumeVersion(index) {
  const profile = settingsData?.resume_profiles?.items?.[Number(index)];
  if (!profile || !profile.content_hash || profile.resume_file_status !== 'exists') {
    return showResumeUploadStatus('error', 'Reload Settings and verify the local file before approval.');
  }
  if (settingsDirty && !await confirmProductAction({
    title: 'Discard unsaved Settings edits?',
    message: 'Approving this Resume Version reloads Settings from local storage. Your unsaved Settings edits will be lost.',
    confirmLabel: 'Discard and Continue',
    tone: 'danger'
  })) return;
  if (!await confirmProductAction({
    title: `Approve ${profile.name} v${profile.version}?`,
    message: 'This approves the exact local Resume Version currently shown. It does not attach, upload, or submit the resume.',
    confirmLabel: 'Approve Version'
  })) return;
  try {
    const result = await fetchJSON(`/api/settings/resume-profiles/${encodeURIComponent(profile.resume_id)}/approve`, {
      method: 'POST',
      body: JSON.stringify({
        confirmed: true,
        content_hash: profile.content_hash
      })
    });
    await loadSettings();
    showResumeUploadStatus(
      'ok',
      `${result.resume_profile.name} v${result.resume_profile.version} approved locally. Resume attach and Final Submit remain disabled.`
    );
  } catch (err) {
    showResumeUploadStatus('error', err.message);
  }
}

async function analyzeResumeVersion(index) {
  const profile = settingsData?.resume_profiles?.items?.[Number(index)];
  if (!profile || !profile.content_hash || profile.resume_file_status !== 'exists') {
    return showResumeUploadStatus('error', 'Reload Settings and verify the local Resume Library file before analysis.');
  }
  showResumeUploadStatus('warning', `Analyzing ${profile.name} locally…`);
  try {
    const result = await fetchJSON(`/api/settings/resume-profiles/${encodeURIComponent(profile.resume_id)}/analyze`, {
      method: 'POST',
      body: JSON.stringify({
        confirmed_local_analysis: true,
        content_hash: profile.content_hash
      })
    });
    resumeAnalysisById.set(profile.resume_id, result);
    renderResumeProfiles();
    showResumeUploadStatus(
      'ok',
      `${result.analysis.summary.suggestion_count} unconfirmed suggestion(s) shown. Nothing was saved to Candidate Profile or Resume Library metadata.`
    );
  } catch (err) {
    showResumeUploadStatus('error', `Local analysis failed: ${err.message}`);
  }
}

async function applySelectedResumeSuggestions(resumeId) {
  const result = resumeAnalysisById.get(String(resumeId));
  const profile = settingsData?.resume_profiles?.items?.find(item => item.resume_id === String(resumeId));
  if (!result || !profile || result.resume_profile?.content_hash !== profile.content_hash) {
    return showResumeUploadStatus('error', 'The analysis preview is stale. Analyze the current local copy again.');
  }
  const panel = [...document.querySelectorAll('.resume-analysis-preview')]
    .find(item => item.dataset.analysisResumeId === String(resumeId));
  const selectedIds = [...(panel?.querySelectorAll('[data-analysis-suggestion]:checked') || [])]
    .map(item => item.dataset.analysisSuggestion);
  if (!selectedIds.length) {
    return showResumeUploadStatus('error', 'Select at least one applicable fact suggestion first.');
  }
  showResumeUploadStatus('warning', `Applying ${selectedIds.length} selected fact suggestion(s)…`);
  try {
    const applied = await fetchJSON(
      `/api/settings/resume-profiles/${encodeURIComponent(profile.resume_id)}/apply-suggestions`,
      {
        method: 'POST',
        body: JSON.stringify({
          confirmed_local_analysis: true,
          confirmed_apply: true,
          content_hash: profile.content_hash,
          analysis_snapshot_token: result.analysis.snapshot_token,
          selected_suggestion_ids: selectedIds
        })
      }
    );
    resumeAnalysisById.delete(profile.resume_id);
    await loadSettings();
    showResumeUploadStatus(
      'ok',
      `${applied.applied.length} Candidate Profile field(s) updated. Profile approval was revoked; review all Candidate Facts and confirm the new snapshot.`
    );
  } catch (err) {
    showResumeUploadStatus('error', `Applying resume facts failed: ${err.message}`);
  }
}

async function saveAnswerMemory() {
  const source = $('answerMemorySource').value;
  const userConfirmed = $('answerMemoryConfirmed').checked;
  try {
    const result = await fetchJSON('/api/settings/question-answer', {
      method: 'POST',
      body: JSON.stringify({
        answer: {
          original_question: $('answerMemoryQuestion').value,
          answer: $('answerMemoryAnswer').value,
          source,
          scope: $('answerMemoryScope').value || 'global',
          sensitive_category: $('answerMemorySensitive').value || 'none',
          user_confirmed: userConfirmed
        }
      })
    });
    const reusable = result.approved_for_real_applications === true
      ? 'ready for reuse in applications'
      : 'saved, but held back from auto-fill (unconfirmed, sensitive, or high-risk)';
    showSettingsStatus('ok', `answer version saved: ${result.question_id} v${result.version}; ${reusable}`);
    await loadAnswerMemoryList();
  } catch (err) {
    showSettingsStatus('error', `answer save failed: ${err.message}`);
  }
}

async function loadAnswerMemoryList() {
  const box = $('answerMemoryList');
  if (!box) return;
  try {
    const result = await fetchJSON('/api/answers');
    renderAnswerMemoryList(result.answers || []);
  } catch (err) {
    box.innerHTML = `<p class="settings-help">Saved answers could not be loaded: ${escapeHtml(err.message)}</p>`;
  }
}

function renderAnswerMemoryList(answers) {
  const box = $('answerMemoryList');
  if (!box) return;
  if (!answers.length) {
    box.innerHTML = '<p class="settings-help">No saved answers yet.</p>';
    return;
  }
  box.innerHTML = `
    <h4>Saved answers (${answers.length})</h4>
    ${answers.map(item => {
      const badge = item.approved_for_real_applications
        ? '<span class="badge badge-ok">reusable</span>'
        : item.user_confirmed
          ? '<span class="badge badge-warning">needs per-use confirmation</span>'
          : '<span class="badge">not confirmed</span>';
      const scope = item.scope && item.scope !== 'global'
        ? ` · ${escapeHtml(item.scope)}: ${escapeHtml(item.scope_key || '')}`
        : '';
      return `
        <div class="settings-subcard" data-answer-id="${escapeHtml(item.question_id)}">
          <div><strong>${escapeHtml(item.original_question)}</strong>${scope}</div>
          <div>${escapeHtml(item.answer)}</div>
          <div>${badge} <span class="settings-help">v${item.version} · ${escapeHtml(item.source)}${item.last_used ? ` · last used ${escapeHtml(item.last_used)}` : ''}</span>
            <button class="btn-secondary" type="button" data-delete-answer="${escapeHtml(item.question_id)}">Delete</button>
          </div>
        </div>`;
    }).join('')}`;
  box.querySelectorAll('[data-delete-answer]').forEach(button => {
    button.addEventListener('click', () => deleteAnswerMemory(button.dataset.deleteAnswer));
  });
}

async function deleteAnswerMemory(questionId) {
  try {
    await fetchJSON(`/api/answers/${encodeURIComponent(questionId)}`, { method: 'DELETE' });
    showSettingsStatus('ok', 'answer deleted');
    await loadAnswerMemoryList();
  } catch (err) {
    showSettingsStatus('error', `answer delete failed: ${err.message}`);
  }
}

async function saveSettings(url, payload, success) {
  try {
    const result = await fetchJSON(url, { method: 'POST', body: JSON.stringify(payload) });
    if (result.search_preferences) settingsData.search_preferences = result.search_preferences;
    if (result.resume_profiles) settingsData.resume_profiles = result.resume_profiles;
    settingsDirty = false;
    const warnings = (result.warnings || []).length ? ` Warnings: ${result.warnings.join('; ')}` : '';
    await loadSettings();
    showSettingsStatus('ok', `${success}. Backup: ${result.backup || 'n/a'}.${warnings}`);
    return true;
  } catch (err) {
    showSettingsStatus('error', `${url} failed: ${err.message}`);
    return false;
  }
}

function showSettingsStatus(type, message) {
  const box = $('settingsStatus');
  if (!box) return;
  box.className = `settings-status ${type}`;
  box.textContent = message;
  if (type === 'ok') showProductToast('ok', message);
}


function switchView(view, { preserveScroll = false, persist = true } = {}) {
  const aliases = {
    home: 'career-brain',
    resume: 'career-brain',
    profile: 'career-brain',
    'job-search': 'job-discovery',
    settings: 'ai-settings'
  };
  view = aliases[view] || view;
  if (!unlockedViews.has(view)) return false;
  activeView = view;
  document.querySelectorAll('[data-product-view]').forEach(element => {
    const views = String(element.dataset.productView || '').split(/\s+/).filter(Boolean);
    element.classList.toggle('hidden', !views.includes(view));
  });
  for (const shellId of ['jobsView', 'settingsView']) {
    const shell = $(shellId);
    const hasVisibleContent = [...shell.querySelectorAll('[data-product-view]')]
      .some(element => !element.classList.contains('hidden'));
    shell.classList.toggle('hidden', !hasVisibleContent);
  }
  const tabs = {
    'career-brain': 'homeTabBtn',
    'job-discovery': 'jobSearchTabBtn',
    'job-matches': 'jobMatchesTabBtn',
    applications: 'applicationsTabBtn',
    'interview-preparation': 'interviewPrepTabBtn',
    'ai-settings': 'settingsTabBtn'
  };
  Object.entries(tabs).forEach(([name, id]) => {
    $(id).classList.toggle('active', name === view);
    $(id).setAttribute('aria-current', name === view ? 'page' : 'false');
  });
  if (['career-brain', 'job-discovery', 'ai-settings', 'interview-preparation'].includes(view) && !settingsData) loadSettings();
  updateExtensionDiagnosticsPolling(view);
  if (!preserveScroll) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (persist) persistUiContext();
  return true;
}

function reviewCareerBrainFromHome() {
  switchView('career-brain');
  $('careerBrainEditor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function splitCsv(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function updateResetLocalDataButton() {
  const input = $('resetLocalDataConfirmation');
  const button = $('resetLocalDataBtn');
  if (button) button.disabled = String(input?.value || '') !== 'RESET LOCAL DATA';
}

function showResetLocalDataStatus(type, message) {
  const box = $('resetLocalDataStatus');
  if (!box) return;
  box.className = `settings-status ${type}`;
  box.textContent = message;
}

async function resetAllLocalData() {
  const confirmationText = String($('resetLocalDataConfirmation')?.value || '');
  if (confirmationText !== 'RESET LOCAL DATA') {
    showResetLocalDataStatus('error', 'Type RESET LOCAL DATA exactly before continuing.');
    return false;
  }
  const accepted = await confirmProductAction({
    title: 'Permanently reset all local product data?',
    message: 'This removes resumes, Candidate Profiles and versions, jobs, applications, provider settings, reports, and product-owned browser state. It cannot be undone. Source code is not changed.',
    confirmLabel: 'Reset Local Data',
    tone: 'danger'
  });
  if (!accepted) return false;
  const button = $('resetLocalDataBtn');
  if (button) button.disabled = true;
  showResetLocalDataStatus('warning', 'Resetting local data…');
  try {
    const result = await fetchJSON('/api/settings/reset-local-data', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true, confirmation_text: confirmationText })
    });
    resumeAnalysisById.clear();
    allJobs = [];
    filteredJobs = [];
    selectedJobIds = new Set();
    if ($('resetLocalDataConfirmation')) $('resetLocalDataConfirmation').value = '';
    await loadSettings();
    await refreshAll();
    switchView(result.next_view || 'resume');
    showResumeUploadStatus('ok', 'Local data reset complete. Start again by uploading a resume. Browser extension cache will clear the next time its popup opens.');
    showProductToast('ok', 'Local data reset complete.');
    return true;
  } catch (error) {
    showResetLocalDataStatus('error', error.details?.message || error.message);
    updateResetLocalDataButton();
    return false;
  }
}

function escapeAttrValue(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
    .replaceAll('`', '&#096;');
}

$('productModalCancelBtn').addEventListener('click', () => closeProductModal(false));
$('productModalConfirmBtn').addEventListener('click', () => closeProductModal(true));
$('productModalBackdrop').addEventListener('click', event => {
  if (event.target === $('productModalBackdrop')) closeProductModal(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && productModalResolver) closeProductModal(false);
});

$('runDiscoveryBtn').addEventListener('click', () => runPipeline('discovery'));
$('runScoringBtn').addEventListener('click', () => runPipeline('scoring'));
$('runApprovalQueueBtn').addEventListener('click', () => runPipeline('approval-queue'));
$('buildSelectedPackagesBtn').addEventListener('click', buildSelectedPackages);
$('loadMoreJobsBtn').addEventListener('click', () => {
  visibleJobLimit += JOB_PAGE_SIZE;
  renderJobsTable();
  persistUiContext();
});
$('closePackageReviewBtn').addEventListener('click', closeApplicationPackagePanel);
$('rebuildPackageResumeBtn').addEventListener('click', rebuildPackageWithSelectedResume);
$('recoverApplicationSessionBtn').addEventListener('click', () => {
  if (packageReviewJobId) recoverApplicationExecution(packageReviewJobId);
});
$('restartFillSetupBtn').addEventListener('click', () => {
  if (packageReviewJobId) restartFillSetup(packageReviewJobId);
});
$('approveFillFromPackageBtn').addEventListener('click', () => {
  if (packageReviewJobId) approveFill(packageReviewJobId);
});
$('startFillFromPackageBtn').addEventListener('click', () => {
  if (packageReviewJobId) startFill(packageReviewJobId);
});
$('openApplicationPageBtn')?.addEventListener('click', openCurrentApplicationPage);
$('reviewSkippedFieldsBtn')?.addEventListener('click', toggleSkippedFieldSummary);
$('reviewRescanBtn')?.addEventListener('click', requestApplicationReviewRescan);
$('markReviewCompleteBtn')?.addEventListener('click', markApplicationReviewComplete);
$('markSubmittedFromPackageBtn')?.addEventListener('click', () => {
  if (packageReviewJobId) markSubmittedManually(packageReviewJobId);
});
$('applicationExecutorMode')?.addEventListener('change', saveExecutorSelection);
$('refreshBtn').addEventListener('click', refreshAll);
$('homeTabBtn').addEventListener('click', () => switchView('career-brain'));
$('homeCareerBrainAction').addEventListener('click', reviewCareerBrainFromHome);
$('homeNextActionBtn').addEventListener('click', goToCurrentUxStep);
$('jobSearchTabBtn').addEventListener('click', () => switchView('job-discovery'));
$('jobMatchesTabBtn').addEventListener('click', () => switchView('job-matches'));
$('applicationsTabBtn').addEventListener('click', () => switchView('applications'));
$('interviewPrepTabBtn').addEventListener('click', () => switchView('interview-preparation'));
$('settingsTabBtn').addEventListener('click', () => switchView('ai-settings'));
$('startSetupBtn').addEventListener('click', goToCurrentUxStep);
$('globalNextStepBtn').addEventListener('click', goToCurrentUxStep);
$('onboardingSearchBtn').addEventListener('click', () => $('workflowProgress').scrollIntoView({ behavior: 'smooth', block: 'center' }));
$('findMatchingJobsBtn').addEventListener('click', findMatchingJobs);
$('importJobUrlBtn').addEventListener('click', importJobUrl);
$('runOfflineDemoSearchBtn').addEventListener('click', runOfflineDemoSearch);
$('guideOfflineDemoBtn').addEventListener('click', runOfflineDemoSearch);
$('configureJobSourcesBtn').addEventListener('click', () => {
  if (!switchView('settings')) {
    showRunStatus('warning', 'Complete the current Resume and Profile step before configuring Live Search.');
    return;
  }
  $('jobSearchSourcesSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('searchModeSelect').addEventListener('change', event => {
  const messages = {
    live: 'Live Search discovers public job pages and uses deterministic scoring. AI is not required.',
    live_ai: 'Live Search remains independent. Optional local AI enrichment runs only when its provider is configured and READY.',
    offline_demo: 'Offline Demo creates one clearly labeled synthetic localhost job and uses no network.'
  };
  $('searchModeHelp').textContent = messages[event.target.value] || messages.live;
});
$('reloadSettingsBtn').addEventListener('click', loadSettings);
$('refreshExtensionDiagnosticsBtn')?.addEventListener('click', loadExtensionDiagnostics);
$('resetLocalDataConfirmation').addEventListener('input', updateResetLocalDataButton);
$('resetLocalDataBtn').addEventListener('click', resetAllLocalData);
$('saveSearchPreferencesBtn').addEventListener('click', saveSearchPreferences);
$('createSearchProfileBtn').addEventListener('click', () => createSearchProfile(false));
$('copySearchProfileBtn').addEventListener('click', () => createSearchProfile(true));
$('saveResumeProfilesBtn').addEventListener('click', saveResumeProfiles);
$('registerResumeFileBtn').addEventListener('click', registerResumeFile);
$('resumeUploadFile').addEventListener('change', updateResumeFileHint);
$('saveAnswerMemoryBtn').addEventListener('click', saveAnswerMemory);
$('confirmCandidateFactsBtn').addEventListener('click', confirmCandidateFacts);
$('addResumeProfileBtn').addEventListener('click', addResumeProfile);
document.querySelectorAll('[data-add-setting]').forEach(btn => btn.addEventListener('click', () => addSettingItem(btn.dataset.addSetting)));
$('settingsView').addEventListener('input', handleSettingsInput);
$('settingsView').addEventListener('change', handleSettingsInput);
$('settingsView').addEventListener('click', async event => {
  if (event.target.closest('#toggleCareerBrainEditBtn') || event.target.closest('#stickyEditCareerProfileBtn')) {
    careerBrainEditMode = !careerBrainEditMode;
    renderCareerBrain();
    return;
  }
  const addCareerButton = event.target.closest('[data-career-add]');
  if (addCareerButton) {
    addCareerItem(addCareerButton.dataset.careerAdd);
    return;
  }
  const removeCareerButton = event.target.closest('[data-career-remove]');
  if (removeCareerButton) {
    const card = removeCareerButton.closest('[data-career-item]');
    const list = card?.parentElement;
    card?.remove();
    if (list && !list.querySelector('[data-career-item]')) list.innerHTML = '<div class="career-empty-item">Nothing added yet.</div>';
    showCareerBrainStatus('warning', 'Removed from this draft. Save New Version to keep the change.');
    return;
  }
  if (event.target.closest('#createCareerProfileBtn')) {
    await runCareerProfileAction({ action: 'create', name: 'New Career Profile' }, 'New Career Profile created.');
    return;
  }
  if (event.target.closest('#activateCareerProfileBtn')) {
    await runCareerProfileAction({ action: 'activate', profile_id: $('careerBrainProfileSelect')?.value }, 'Active Career Profile changed.');
    return;
  }
  if (event.target.closest('#duplicateCareerProfileBtn')) {
    const profile = activeCareerProfile();
    if (profile) await runCareerProfileAction({ action: 'duplicate', profile_id: profile.id }, 'Career Profile duplicated as a draft.');
    return;
  }
  if (event.target.closest('#saveCareerProfileBtn') || event.target.closest('#stickySaveCareerProfileBtn')) {
    try {
      const profile = careerProfileFromEditor();
      const result = await runCareerProfileAction({ action: 'save_version', profile_id: profile.id, profile }, 'Career Profile saved as a new draft version.');
      if (result) {
        careerBrainEditMode = false;
        renderCareerBrain();
      }
    } catch (error) {
      showCareerBrainStatus('error', error.message);
    }
    return;
  }
  if (event.target.closest('#approveCareerProfileBtn') || event.target.closest('#stickyApproveCareerProfileBtn')) {
    await approveActiveCareerProfile();
    return;
  }
  if (event.target.closest('#archiveCareerProfileBtn')) {
    const profile = activeCareerProfile();
    if (profile && await confirmProductAction({
      title: `Archive ${profile.name}?`,
      message: 'The profile remains in local history but cannot stay active. Other Career Profiles and resume files are not changed.',
      confirmLabel: 'Archive Career Profile',
      tone: 'danger'
    })) {
      await runCareerProfileAction({ action: 'archive', profile_id: profile.id, confirmed: true }, 'Career Profile archived.');
    }
    return;
  }
  if (event.target.closest('#exportCareerProfileBtn')) {
    exportActiveCareerProfile();
    return;
  }
  if (event.target.closest('#importCareerProfileBtn')) {
    await importSelectedCareerProfile();
    return;
  }
  if (event.target.closest('#saveCandidateProfileVersionBtn')) {
    const name = String($('candidateProfileVersionName')?.value || '').trim();
    if (!name) {
      showSettingsStatus('error', 'Enter a name for the new Profile version.');
      return;
    }
    await manageCandidateProfileVersion('create', { name });
    return;
  }
  const activateProfileVersion = event.target.closest('[data-profile-version-activate]');
  if (activateProfileVersion) {
    if (await confirmProductAction({
      title: 'Restore this Profile version?',
      message: 'Current saved facts will be replaced by this snapshot. Profile approval will be revoked until you review the restored facts.',
      confirmLabel: 'Restore Version'
    })) {
      await manageCandidateProfileVersion('activate', {
        version_id: activateProfileVersion.dataset.profileVersionActivate,
        confirmed: true
      });
    }
    return;
  }
  const deleteProfileVersion = event.target.closest('[data-profile-version-delete]');
  if (deleteProfileVersion) {
    if (await confirmProductAction({
      title: 'Delete this saved Profile version?',
      message: 'The saved snapshot will be removed. The current Profile facts are not deleted.',
      confirmLabel: 'Delete Version',
      tone: 'danger'
    })) {
      await manageCandidateProfileVersion('delete', {
        version_id: deleteProfileVersion.dataset.profileVersionDelete,
        confirmed: true
      });
    }
    return;
  }
  if (event.target.closest('#saveAIProviderBtn')) {
    await saveAIProvider();
    return;
  }
  if (event.target.closest('#testAIProviderBtn')) {
    await testAIProvider();
    return;
  }
  if (event.target.closest('#saveJobSearchSourcesBtn')) {
    await saveJobSearchSources();
    return;
  }
  if (event.target.closest('#testJobSearchSourceBtn')) {
    await testJobSearchSource();
    return;
  }
  if (await handleCandidateFactAction(event)) return;
  const renameOpenButton = event.target.closest('[data-resume-rename-open]');
  if (renameOpenButton) {
    const index = renameOpenButton.dataset.resumeRenameOpen;
    const editor = document.querySelector(`[data-resume-rename-editor="${index}"]`);
    editor?.classList.remove('hidden');
    editor?.querySelector('input')?.focus();
    return;
  }
  const renameCancelButton = event.target.closest('[data-resume-rename-cancel]');
  if (renameCancelButton) {
    document.querySelector(`[data-resume-rename-editor="${renameCancelButton.dataset.resumeRenameCancel}"]`)
      ?.classList.add('hidden');
    return;
  }
  const renameSaveButton = event.target.closest('[data-resume-rename-save]');
  if (renameSaveButton) {
    const index = renameSaveButton.dataset.resumeRenameSave;
    const input = document.querySelector(`[data-resume-rename-input="${index}"]`);
    await manageResumeVersion(index, 'rename', { name: input?.value || '' });
    return;
  }
  const manageButton = event.target.closest('[data-manage-resume-index]');
  if (manageButton) {
    await manageResumeVersion(manageButton.dataset.manageResumeIndex, manageButton.dataset.resumeAction);
    return;
  }
  const approveButton = event.target.closest('[data-approve-resume-index]');
  if (approveButton) approveResumeVersion(approveButton.dataset.approveResumeIndex);
  const analyzeButton = event.target.closest('[data-analyze-resume-index]');
  if (analyzeButton) analyzeResumeVersion(analyzeButton.dataset.analyzeResumeIndex);
  const applyButton = event.target.closest('[data-apply-resume-suggestions]');
  if (applyButton) applySelectedResumeSuggestions(applyButton.dataset.applyResumeSuggestions);
});
document.addEventListener('click', async event => {
  const zeroAction = event.target.closest('[data-zero-search-action]');
  if (zeroAction) {
    const action = zeroAction.dataset.zeroSearchAction;
    if (action === 'provider') {
      switchView('settings');
      $('jobSearchSourcesSection')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else if (action === 'demo') {
      switchView('job-search');
      await runOfflineDemoSearch();
    } else if (action === 'import') {
      switchView('job-search');
      $('jobUrlImportInput')?.focus();
    } else if (action === 'retry') {
      switchView('job-search');
      await findMatchingJobs();
    } else {
      switchView('job-search');
      $('searchPrimaryRole')?.focus();
    }
    return;
  }
  const helpButton = event.target.closest('[data-help-toggle]');
  if (!helpButton) return;
  const panel = $(helpButton.dataset.helpToggle);
  if (!panel) return;
  const willOpen = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !willOpen);
  helpButton.textContent = willOpen ? 'Hide help' : 'What is this?';
});

document.querySelectorAll('[data-job-inventory]').forEach(button => button.addEventListener('click', () => {
  jobInventoryMode = button.dataset.jobInventory;
  const lifecycleFilters = new Set(['saved', 'rejected', 'approved', 'applied', 'manual_only', 'unsupported']);
  $('filterApprovalStatus').value = lifecycleFilters.has(jobInventoryMode) ? jobInventoryMode : '';
  visibleJobLimit = JOB_PAGE_SIZE;
  applyFilters();
  persistUiContext();
}));

[
  'filterApprovalStatus',
  'filterApplicationStatus',
  'filterProvider',
  'filterPageType',
  'filterScore',
  'sortJobs',
  'filterLocation',
  'filterText'
].forEach(id => $(id).addEventListener(id.startsWith('filterLocation') || id === 'filterText' ? 'input' : 'change', () => {
  if (id === 'filterApprovalStatus') {
    const value = $('filterApprovalStatus').value;
    jobInventoryMode = ['saved', 'rejected', 'approved', 'applied', 'archived', 'manual_only', 'unsupported'].includes(value) ? value : value ? 'custom' : 'current';
  }
  visibleJobLimit = JOB_PAGE_SIZE;
  applyFilters();
  scheduleUiContextPersistence();
}));

document.addEventListener('toggle', event => {
  if (event.target.closest?.('#jobsTableBody')) scheduleUiContextPersistence();
}, true);
window.addEventListener('scroll', scheduleUiContextPersistence, { passive: true });
window.addEventListener('beforeunload', () => persistUiContext());

async function initializeDashboard() {
  const storedContext = readStoredUiContext();
  switchView('career-brain', { preserveScroll: true, persist: false });
  await loadSettings();
  await refreshAll({ context: storedContext, restorePanel: true });
  startDashboardEventStream();
  persistUiContext();
}

void initializeDashboard().catch(error => {
  const message = error?.message || 'The Dashboard could not load local product data. Reload and try again.';
  showRunStatus('error', message);
  showProductToast(message, { tone: 'error', key: 'dashboard-initialization-failed' });
});
