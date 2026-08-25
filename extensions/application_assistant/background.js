// Thin-bridge service worker: the ONLY network path of the extension.
//
// Everything goes to the local Resume Jobs app on 127.0.0.1 — nothing is ever
// sent anywhere else, and nothing is stored in the extension. The content
// script and popup are pure views over this bridge.
const DASHBOARD_ORIGIN = 'http://127.0.0.1:8767';

async function dashboardRequest(path, options = {}) {
  const response = await fetch(`${DASHBOARD_ORIGIN}${path}`, {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      // A host-permitted MV3 service-worker fetch omits the Origin header, so
      // the extension identifies itself explicitly. Web pages cannot deliver
      // this header to the local app (it would need a CORS preflight the app
      // never grants).
      'X-Resume-Jobs-Extension-Id': chrome.runtime.id,
      ...(options.headers || {})
    }
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      status: 'not_connected',
      code: value.code || `dashboard_http_${response.status}`,
      message: value.message || 'Resume Jobs did not accept the connection.'
    };
  }
  return value;
}

// Privacy gate for the broad https://*/* injection: a page's URL leaves the
// tab ONLY when its host belongs to an active fill session. The active-hosts
// probe itself carries no page information at all, and its result is cached
// globally, so ordinary browsing produces zero per-page requests.
let activeHostsCache = { hosts: [], fetched_at: 0 };
async function activeSessionHosts() {
  if (Date.now() - activeHostsCache.fetched_at < 30_000) return activeHostsCache.hosts;
  let hosts = [];
  try {
    const value = await dashboardRequest('/api/extension/active-hosts');
    if (Array.isArray(value.hosts)) hosts = value.hosts.map(host => String(host).toLowerCase());
  } catch {
    hosts = [];
  }
  activeHostsCache = { hosts, fetched_at: Date.now() };
  return hosts;
}

async function connectCurrentApplication(currentUrl) {
  const url = String(currentUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { status: 'not_connected', code: 'UNSUPPORTED_PAGE', message: 'Open a supported public application page.' };
  }
  let pageHost = '';
  try { pageHost = new URL(url).hostname.toLowerCase(); } catch { pageHost = ''; }
  const sessionHosts = await activeSessionHosts();
  if (!pageHost || !sessionHosts.includes(pageHost)) {
    return { status: 'not_connected', code: 'NO_ACTIVE_SESSION_HOST', message: 'No Resume Jobs fill session is active for this site.' };
  }
  const handoff = await dashboardRequest(`/api/extension/active-handoff?url=${encodeURIComponent(url)}`);
  if (handoff.status !== 'ok') return handoff;
  const diagnostics = await dashboardRequest('/api/extension/diagnostics', {
    method: 'POST',
    body: JSON.stringify({
      current_url: url,
      content_script_connected: true,
      extension_version: chrome.runtime.getManifest()?.version || ''
    })
  });
  return { ...handoff, diagnostics };
}

// The fill report travels through the service worker so the request runs from
// the extension origin (no page-origin mixed-content or CORS surprises), and
// so the content script has no fetch path at all.
async function postFillReport(jobId, payload) {
  const safeJobId = String(jobId || '').trim();
  if (!safeJobId) return { status: 'error', code: 'JOB_ID_REQUIRED', message: 'A job id is required to report the fill.' };
  if (!payload || typeof payload !== 'object') {
    return { status: 'error', code: 'INVALID_REPORT', message: 'A report payload is required.' };
  }
  return dashboardRequest(`/api/jobs/${encodeURIComponent(safeJobId)}/fill-report`, {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

// Live application state for the popup — the same projection the Quick UI
// reads, so the Assistant can never disagree with the product.
async function getApplyState(jobId) {
  const safeJobId = String(jobId || '').trim();
  if (!safeJobId) return { status: 'error', code: 'JOB_ID_REQUIRED' };
  return dashboardRequest(`/api/jobs/${encodeURIComponent(safeJobId)}/apply-state`);
}

async function continueAfterVerification(jobId) {
  const safeJobId = String(jobId || '').trim();
  if (!safeJobId) return { status: 'error', code: 'JOB_ID_REQUIRED' };
  return dashboardRequest(`/api/jobs/${encodeURIComponent(safeJobId)}/continue-after-verification`, {
    method: 'POST',
    body: JSON.stringify({ confirmed: true })
  });
}

// "Fill this step now" from the observer chip: asks the app to deliver a
// retry command to the running Local Browser Agent. The extension itself
// never fills when the agent owns the session.
async function fillCurrentStep(jobId) {
  const safeJobId = String(jobId || '').trim();
  if (!safeJobId) return { status: 'error', code: 'JOB_ID_REQUIRED' };
  return dashboardRequest(`/api/jobs/${encodeURIComponent(safeJobId)}/fill-current-step`, {
    method: 'POST',
    body: JSON.stringify({ confirmed: true })
  });
}

// "Re-scan now" from the observer chip: the agent re-reads the page and
// refreshes the review checklist + learning candidates immediately, instead
// of waiting for the idle-detection cycle.
async function requestReviewRescan(jobId) {
  const safeJobId = String(jobId || '').trim();
  if (!safeJobId) return { status: 'error', code: 'JOB_ID_REQUIRED' };
  return dashboardRequest(`/api/jobs/${encodeURIComponent(safeJobId)}/review-rescan`, {
    method: 'POST',
    body: JSON.stringify({ scan_id: `chip_rescan_${Date.now()}` })
  });
}

// User-confirmed answers to newly discovered questions: saved into the local
// knowledge base and filled by the running session. Only what the user typed
// here is sent — nothing is guessed.
async function saveOpenAnswers(jobId, answers) {
  const safeJobId = String(jobId || '').trim();
  if (!safeJobId) return { status: 'error', code: 'JOB_ID_REQUIRED' };
  return dashboardRequest(`/api/jobs/${encodeURIComponent(safeJobId)}/open-answers`, {
    method: 'POST',
    body: JSON.stringify({ confirmed: true, answers: Array.isArray(answers) ? answers : [] })
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;
  if (message.type === 'GET_APPLY_STATE') {
    getApplyState(message.job_id)
      .then(sendResponse)
      .catch(() => sendResponse({ status: 'not_connected' }));
    return true;
  }
  if (message.type === 'FILL_CURRENT_STEP') {
    fillCurrentStep(message.job_id)
      .then(sendResponse)
      .catch(() => sendResponse({ status: 'error', message: 'Resume Jobs is unavailable.' }));
    return true;
  }
  if (message.type === 'REVIEW_RESCAN_NOW') {
    requestReviewRescan(message.job_id)
      .then(sendResponse)
      .catch(() => sendResponse({ status: 'error', message: 'Resume Jobs is unavailable.' }));
    return true;
  }
  if (message.type === 'CONTINUE_AFTER_VERIFICATION_API') {
    continueAfterVerification(message.job_id)
      .then(sendResponse)
      .catch(() => sendResponse({ status: 'error', message: 'Resume Jobs is unavailable.' }));
    return true;
  }
  if (message.type === 'SAVE_OPEN_ANSWERS') {
    saveOpenAnswers(message.job_id, message.answers)
      .then(sendResponse)
      .catch(() => sendResponse({ status: 'error', message: 'Resume Jobs is unavailable.' }));
    return true;
  }
  if (message.type === 'CONNECT_CURRENT_APPLICATION') {
    const currentUrl = String(message.current_url || sender?.tab?.url || '').trim();
    connectCurrentApplication(currentUrl)
      .then(sendResponse)
      .catch(error => sendResponse({
        status: 'not_connected', code: 'DASHBOARD_UNAVAILABLE',
        message: 'Resume Jobs is unavailable. Start it, then choose Check connection.',
        technical_error_code: String(error?.code || 'DASHBOARD_REQUEST_FAILED')
      }));
    return true;
  }
  if (message.type === 'POST_FILL_REPORT') {
    postFillReport(message.job_id, message.payload)
      .then(sendResponse)
      .catch(error => sendResponse({
        status: 'error', code: 'DASHBOARD_UNAVAILABLE',
        message: 'The fill finished but Resume Jobs could not record it. Start the app and fill again.',
        technical_error_code: String(error?.code || 'DASHBOARD_REQUEST_FAILED')
      }));
    return true;
  }
  return false;
});
