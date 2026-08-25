// Thin-bridge content script.
//
// This file holds NO state, NO personal data, NO mapping tables and NO safety
// rules of its own. Every decision comes from the shared Application Executor
// core (executor_core.js — byte-identical with the backend's copy) and from
// the ApplicationExecutionSession fetched fresh from the local Resume Jobs app
// on every run. Extension-local storage is never touched; the only network
// path is the service worker's loopback bridge.
//
// What it does: detect fields on the CURRENT tab, plan them with the shared
// planner, fill only what the plan approves, verify every write by reading the
// control back, and report the outcome — including challenges — honestly.
// What it never does: upload files, log in, touch verifications, or submit.
(() => {
  const core = globalThis.ResumeJobsApplicationExecutorCore || null;
  if (!core) return;

  const HIGHLIGHT_CLASS = 'job-apply-autofill-filled';
  const STYLE_ID = 'job-apply-autofill-style';
  const BADGE_ID = 'job-apply-autofill-auto-badge';
  const OBSERVER_ID = 'application-assistant-observer-chip';

  // The Resume Jobs app's own pages (Quick UI at /, the advanced dashboard at
  // /advanced) mark themselves with <meta name="resume-jobs-app">. They are
  // never application forms: scanning, filling, and the bottom-right badge
  // must stay off there — injecting them is how the old "AI Fill Assistant"
  // floater leaked into the new Quick UI. Only the nonce handshake below
  // remains, so the app can still verify the extension is installed.
  function isResumeJobsAppPage() {
    return /^(?:127\.0\.0\.1|localhost)$/i.test(location.hostname)
      && Boolean(document.querySelector('meta[name="resume-jobs-app"]'));
  }

  // --- Page reading ---------------------------------------------------------

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function labelFor(element) {
    const id = element.id || '';
    const explicit = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const wrapping = element.closest('label');
    let ancestorLabel = null;
    let ancestor = element.parentElement;
    for (let depth = 0; depth < 3 && ancestor && !ancestorLabel; depth += 1) {
      ancestorLabel = ancestor.querySelector('label, legend, [data-qa*="label"], [class*="label"]');
      ancestor = ancestor.parentElement;
    }
    const labelledBy = (element.getAttribute('aria-labelledby') || '')
      .split(/\s+/).filter(Boolean)
      .map(token => document.getElementById(token)?.textContent || '')
      .join(' ')
      .trim();
    return (explicit?.textContent
      || wrapping?.textContent
      || ancestorLabel?.textContent
      || element.getAttribute('aria-label')
      || labelledBy
      || '').trim();
  }

  // The same field schema the Browser Agent runtime produces, built from the
  // live DOM. Element handles are kept per collection so a fill acts on the
  // exact node it described — nothing is re-queried between plan and write.
  function collectFields() {
    const elements = Array.from(document.querySelectorAll('input, textarea, select'));
    const fields = elements.map((element, index) => {
      const tag = element.tagName.toLowerCase();
      const type = String(element.getAttribute('type') || (tag === 'textarea' ? 'textarea' : 'text')).toLowerCase();
      const ownLabel = labelFor(element);
      // A radio/checkbox usually carries only its option text; the question
      // lives in the group's <legend>. Both matter: the question for mapping,
      // the option text for value matching.
      const legend = ['radio', 'checkbox'].includes(type)
        ? (element.closest('fieldset')?.querySelector('legend')?.textContent || '').trim()
        : '';
      return {
        field_ref: `field-${index + 1}`,
        tag,
        type,
        name: element.getAttribute('name') || '',
        id: element.id || '',
        label: legend && legend !== ownLabel ? `${legend} ${ownLabel}`.trim() : ownLabel,
        placeholder: element.getAttribute('placeholder') || '',
        autocomplete: element.getAttribute('autocomplete') || '',
        role: element.getAttribute('role') || '',
        aria_autocomplete: element.getAttribute('aria-autocomplete') || '',
        aria_haspopup: element.getAttribute('aria-haspopup') || '',
        has_list: Boolean(element.getAttribute('list')),
        disabled: Boolean(element.disabled),
        read_only: Boolean(element.readOnly),
        required: Boolean(element.required || element.getAttribute('aria-required') === 'true'),
        visible: isVisible(element),
        options: tag === 'select'
          ? Array.from(element.options).map(option => ({
              value: option.value,
              label: (option.textContent || '').trim()
            })).slice(0, 200)
          : ['radio', 'checkbox'].includes(type)
            ? [{ value: element.value || '', label: ownLabel }]
            : [],
      };
    });
    return { elements, fields };
  }

  // The same page-state shape the Browser Agent runtime feeds into the shared
  // challenge classifier — one classifier, two executors.
  function pageStateSnapshot() {
    const controls = Array.from(document.querySelectorAll('input, textarea, select'));
    const accessible = controls.filter(element => {
      const type = String(element.getAttribute('type') || 'text').toLowerCase();
      // A visible file input IS the application form: resume-upload wizard
      // steps often hold nothing else. Password stays excluded — a login wall
      // is not an application form.
      return isVisible(element) && !element.disabled
        && !['hidden', 'submit', 'button', 'reset', 'image', 'password'].includes(type);
    });
    const form = document.querySelector('form');
    const challengeSelectors = [
      'iframe[src*="captcha" i]', 'iframe[src*="recaptcha" i]', 'iframe[src*="hcaptcha" i]',
      'iframe[src*="turnstile" i]', '[class*="captcha" i]', '[id*="captcha" i]', '[data-sitekey]',
      'textarea[name="g-recaptcha-response"]', 'textarea[name="h-captcha-response"]', 'input[name*="captcha" i]'
    ];
    const challengeNodes = [];
    const seen = new Set();
    for (const selector of challengeSelectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) continue;
        seen.add(element);
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = isVisible(element);
        const coverage = window.innerWidth && window.innerHeight
          ? (rect.width * rect.height) / (window.innerWidth * window.innerHeight)
          : 0;
        challengeNodes.push({
          classifier: `selector=${selector};tag=${element.tagName.toLowerCase()};visible=${visible};inside_form=${Boolean(form && form.contains(element))}`,
          visible,
          overlay: visible && ['fixed', 'sticky'].includes(style.position) && coverage >= 0.5,
        });
      }
    }
    const bodyText = String(document.body?.innerText || '');
    const applicationFormAccessible = Boolean(form && isVisible(form) && accessible.length > 0);
    const activeInterstitialText = /(?:checking your browser|verify you are human|security verification|complete the security check|cloudflare)/i.test(bodyText.slice(0, 3000));
    const activeBlocking = challengeNodes.some(item => item.overlay)
      || (challengeNodes.some(item => item.visible) && !applicationFormAccessible)
      || (activeInterstitialText && !applicationFormAccessible);
    const challengePresent = challengeNodes.length > 0 || (activeInterstitialText && !applicationFormAccessible);
    return {
      url: location.href,
      title: document.title || '',
      has_password: Boolean(document.querySelector('input[type="password"]')),
      has_otp: Boolean(document.querySelector('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]')),
      has_challenge: challengePresent,
      accessible_application_control_count: accessible.length,
      application_form_accessible: applicationFormAccessible,
      submit_control_detected: Boolean(document.querySelector('button[type="submit"], input[type="submit"], button:not([type])')),
      challenge_scope: challengePresent ? (activeBlocking ? 'active' : 'passive') : 'none',
      challenge: {
        present: challengePresent,
        active_blocking: activeBlocking,
        scope: challengePresent ? (activeBlocking ? 'active' : 'passive') : 'none',
        application_form_accessible: applicationFormAccessible,
        accessible_application_control_count: accessible.length,
        evidence: challengeNodes.map(item => item.classifier).slice(0, 20),
      },
    };
  }

  // --- Session → plan context ----------------------------------------------

  // Values come exclusively from the session's user-confirmed mappings. This
  // mirrors approvedFieldProfile on the backend.
  function profileFromSession(session) {
    const profile = {};
    for (const mapping of Array.isArray(session?.approved_field_mappings) ? session.approved_field_mappings : []) {
      const key = String(mapping?.canonical_key || '').trim();
      const value = String(mapping?.value || '').trim();
      if (!key || !value || mapping.user_confirmed !== true) continue;
      profile[key] = {
        value,
        source: mapping.source || 'application_execution_session',
        confidence: Number(mapping.confidence || 0),
        user_confirmed: true,
        last_used: mapping.last_used || null,
      };
    }
    return profile;
  }

  // Confirmed answers carry the question wording they were saved against;
  // those become site rules for the shared mapper — same idea as
  // confirmedSessionRules on the backend.
  function siteRulesFromSession(session) {
    const rules = [];
    for (const mapping of Array.isArray(session?.approved_field_mappings) ? session.approved_field_mappings : []) {
      if (mapping?.user_confirmed !== true) continue;
      const aliases = (Array.isArray(mapping.aliases) ? mapping.aliases : [])
        .map(value => String(value || '').trim()).filter(Boolean);
      if (!aliases.length) continue;
      rules.push({
        key: mapping.canonical_key,
        aliases,
        confidence: Number(mapping.confidence || 0.9),
        source: 'confirmed_answer_memory',
      });
    }
    // Confirmed field-memory records (learned on the backend, user-confirmed
    // there) arrive with the session; only active confirmed records become
    // rules, matched by the control identity in their signature.
    const memory = session?.confirmed_form_field_memory;
    for (const record of Array.isArray(memory?.records) ? memory.records : []) {
      if (record?.user_confirmed !== true || record?.status !== 'active') continue;
      const key = String(record.canonical_key || '').trim();
      const signatureName = String(record.field_signature || '').split('|').map(part => part.trim()).filter(Boolean).pop() || '';
      const aliases = [signatureName, ...(Array.isArray(record.aliases) ? record.aliases : [])]
        .map(value => String(value || '').trim()).filter(Boolean);
      if (!key || !aliases.length) continue;
      rules.push({ key, aliases, confidence: Number(record.confidence || 0.85), source: 'confirmed_form_field_memory' });
    }
    return rules;
  }

  // --- Filling with read-back verification ----------------------------------

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(element, value); else element.value = value;
    dispatchInputEvents(element);
  }

  // Returns true only when the control VERIFIABLY holds the planned value
  // afterwards; a string is an honest skip reason; false is a failure.
  function fillPlanned(element, plan) {
    const descriptor = plan.field;
    if (!element || element.disabled || element.readOnly) return false;
    const tag = element.tagName.toLowerCase();
    const type = String(element.getAttribute('type') || 'text').toLowerCase();
    if (type === 'file') return 'skipped_file_upload';
    if (tag === 'select') {
      const option = plan.option;
      if (!option) return false;
      const target = Array.from(element.options).find(item => (option.value && item.value === option.value)
        || (!option.value && (item.textContent || '').trim() === option.label));
      if (!target) return false;
      setNativeValue(element, target.value);
      return element.value === target.value;
    }
    if (type === 'radio' || type === 'checkbox') {
      if (!plan.option) return false;
      if (!element.checked) {
        element.click();
        if (!element.checked) { element.checked = true; dispatchInputEvents(element); }
      }
      return element.checked === true;
    }
    if (plan.combobox_commit_required) {
      // Interactive dropdown automation stays with the Browser Agent; the
      // bridge reports the truth instead of typing text that selects nothing.
      return 'skipped_requires_selection';
    }
    const target = String(plan.mapping?.value || '');
    setNativeValue(element, target);
    if (element.value !== target) setNativeValue(element, target);
    if (element.value !== target) return false;
    element.classList.add(HIGHLIGHT_CLASS);
    return true;
  }

  // --- Report ----------------------------------------------------------------

  function runtimeMessage(message) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage(message, response => {
          if (chrome.runtime.lastError) resolve({ status: 'not_connected', code: 'BRIDGE_UNAVAILABLE', message: chrome.runtime.lastError.message });
          else resolve(response || { status: 'not_connected', code: 'EMPTY_RESPONSE' });
        });
      } catch (error) {
        resolve({ status: 'not_connected', code: 'BRIDGE_UNAVAILABLE', message: String(error?.message || error) });
      }
    });
  }

  async function postReport(session, execution) {
    const payload = {
      application_session_id: session.session_id,
      attempt_id: execution.attempt_id || session.active_attempt_id || '',
      timestamp: execution.completed_at,
      total_fields_seen: execution.counts.detected,
      filled_fields_count: execution.counts.filled,
      skipped_fields_count: execution.counts.skipped,
      failed_fields_count: execution.counts.failed,
      hard_blocked_fields_count: execution.field_results.filter(item => /skipped_(?:file_upload|sensitive|captcha_control|submit|not_visible)/.test(item.reason)).length,
      fields_requiring_user_review_count: execution.counts.skipped + execution.counts.failed,
      suggested_questions_count: 0,
      blocked_page_state: execution.blocker?.blocked === true,
      blocked_reason: execution.blocker?.reason || '',
      challenge_scope: execution.challenge_scope || 'none',
      submission_blocker: execution.submission_blocker || '',
      final_submit_clicked: false,
      application_submitted: false,
      // The bridge has no upload path, so this is always honestly false.
      resume_upload_attempted: false,
      application_execution: execution,
    };
    return runtimeMessage({ type: 'POST_FILL_REPORT', job_id: session.job_id, payload });
  }

  // --- The one flow: connect → classify → plan → fill → verify → report -----

  async function runFill(trigger) {
    const connection = await runtimeMessage({ type: 'CONNECT_CURRENT_APPLICATION', current_url: location.href });
    if (connection.status !== 'ok' || !connection.execution_session) {
      return {
        status: 'not_connected',
        code: connection.code || 'ACTIVE_HANDOFF_NOT_FOUND',
        message: connection.message || 'Start the fill from Resume Jobs, then try again on this page.'
      };
    }
    const session = connection.execution_session;
    // A session owned by the Local Browser Agent is observed, never filled:
    // two executors typing into the same form would double-fill it. The popup
    // still shows the bound job and live status for this tab.
    if (connection.fill_owner && connection.fill_owner !== 'extension') {
      return {
        status: 'observer_only',
        message: 'Resume Jobs is filling this application with its own browser assistant. This popup shows status only.'
      };
    }
    if (!['EXTENSION_CONNECTED', 'NEEDS_REVIEW', 'FIELDS_DETECTED', 'FILLING'].includes(session.execution_status)) {
      return { status: 'not_ready', message: 'This application is not ready to fill. Return to Resume Jobs and start it there.' };
    }
    if (!core.withinApplicationScope(location.href, session.target_url)) {
      return { status: 'url_mismatch', message: 'This page is not the application Resume Jobs prepared. Open the right job page and try again.' };
    }

    const pageState = pageStateSnapshot();
    const pageSafety = core.classifyPageSafety(pageState, session.target_url);
    const { elements, fields } = collectFields();
    const context = {
      profile: profileFromSession(session),
      profile_confirmed: true,
      minimum_confidence: 0.8,
      site_rules: siteRulesFromSession(session),
      sensitive_reuse_categories: Array.isArray(session.sensitive_reuse_categories)
        ? session.sensitive_reuse_categories
        : [],
    };
    const plans = core.planFields(fields, context);

    let fieldResults;
    if (pageSafety.action !== 'allow') {
      // A verification or login wall: fill nothing, report the truth, and wait
      // for the user in this same tab. Nothing here bypasses anything.
      fieldResults = plans.map(plan => ({
        field: plan.field,
        outcome: 'skipped',
        reason: plan.action === 'fill' ? 'skipped_not_visible' : plan.reason,
      }));
    } else {
      fieldResults = plans.map(plan => {
        if (plan.action !== 'fill' || !plan.mapping) {
          return { field: plan.field, outcome: 'skipped', reason: plan.reason || 'not_approved_for_fill' };
        }
        const element = elements[Number(String(plan.field.field_ref).replace('field-', '')) - 1] || null;
        let filled;
        try { filled = fillPlanned(element, plan); }
        catch { filled = false; }
        if (typeof filled === 'string') {
          return { field: plan.field, mapping_key: plan.mapping.key, source: plan.mapping.source, confidence: plan.mapping.confidence, outcome: 'skipped', reason: filled };
        }
        return {
          field: plan.field,
          mapping_key: plan.mapping.key,
          source: plan.mapping.source,
          confidence: plan.mapping.confidence,
          outcome: filled === false ? 'failed' : 'filled',
          reason: filled === false ? 'failed_setter' : (plan.reason || 'filled_safe_field'),
        };
      });
    }

    const execution = core.createApplicationExecution({
      execution_id: session.session_id,
      run_id: session.session_id,
      attempt_id: session.active_attempt_id || '',
      application_id: session.application_id,
      job_id: session.job_id,
      package_id: session.package_id,
      executor: 'extension',
      url: location.href,
      started_at: new Date().toISOString(),
      status: pageSafety.action !== 'allow' ? 'needs_user_input' : 'paused_for_user_review',
      blocked_reason: pageSafety.action !== 'allow' ? pageSafety.reason : '',
      challenge_scope: pageSafety.challenge_scope,
      submission_blocker: pageSafety.submission_blocker,
      challenge_evidence: pageSafety.evidence,
      field_results: fieldResults,
      notes: [pageSafety.action !== 'allow'
        ? 'A verification or sign-in needs you. Complete it on this page, then choose Continue.'
        : 'Safe fields were filled. Review everything before you submit — submitting stays yours.'],
    });

    const reported = await postReport(session, execution);
    const needsYou = execution.counts.skipped + execution.counts.failed;
    const summary = {
      status: pageSafety.action !== 'allow' ? 'needs_verification' : 'filled',
      trigger: trigger || 'manual',
      company: session.display?.company || '',
      role: session.display?.role || '',
      detected: execution.counts.detected,
      filled: execution.counts.filled,
      needs_you: needsYou,
      challenge_scope: pageSafety.challenge_scope,
      report_recorded: reported.status === 'ok',
      report_message: reported.status === 'ok' ? '' : (reported.message || ''),
    };
    showBadge(summary);
    return summary;
  }

  // --- Minimal on-page badge (no internal vocabulary) ------------------------

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${HIGHLIGHT_CLASS} { outline: 2px solid #2f855a !important; outline-offset: 1px; }
      #${BADGE_ID} { position: fixed; right: 14px; bottom: 14px; z-index: 2147483646;
        background: #1a202c; color: #f7fafc; font: 12px/1.5 system-ui, sans-serif;
        padding: 8px 12px; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.35); max-width: 320px; }
      #${OBSERVER_ID} { position: fixed; right: 14px; bottom: 14px; z-index: 2147483646;
        background: #1a202c; color: #f7fafc; font: 12px/1.5 system-ui, sans-serif;
        padding: 8px 12px; border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,.35);
        max-width: 460px; display: flex; align-items: center; gap: 8px; }
      #${OBSERVER_ID} > span:not(.aa-dot):not(.aa-close) { flex: 1 1 auto; min-width: 0; }
      #${OBSERVER_ID} .aa-dot { width: 8px; height: 8px; border-radius: 50%; background: #48bb78; flex: none; }
      #${OBSERVER_ID} .aa-close { cursor: pointer; opacity: .6; padding: 0 2px; flex: none; }
      #${OBSERVER_ID} .aa-close:hover { opacity: 1; }
      #${OBSERVER_ID} .aa-fill-now { flex: none; cursor: pointer; border: 0; border-radius: 6px;
        background: #3182ce; color: #fff; font: 12px/1 system-ui, sans-serif; padding: 6px 10px; }
      #${OBSERVER_ID} .aa-fill-now:hover { background: #2b6cb0; }
      #${OBSERVER_ID} .aa-fill-now:disabled { background: #4a5568; cursor: default; }
      #${OBSERVER_ID} .aa-rescan { background: #38505f; }
      #${OBSERVER_ID} .aa-rescan:hover { background: #2c3f4c; }
    `;
    document.documentElement.appendChild(style);
  }

  function showBadge(summary) {
    ensureStyle();
    document.getElementById(BADGE_ID)?.remove();
    const badge = document.createElement('div');
    badge.id = BADGE_ID;
    // The on-page note speaks the Assistant's minimal vocabulary only.
    badge.textContent = summary.status === 'needs_verification'
      ? '等待登录 / 验证码 — 完成后在申请助手里点「继续」'
      : `已填写 ${summary.filled} 项 · 需要你处理 ${summary.needs_you} 项 · 提交由你完成`;
    document.documentElement.appendChild(badge);
    setTimeout(() => badge.remove(), 12_000);
  }

  function clearHighlights() {
    document.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach(element => element.classList.remove(HIGHLIGHT_CLASS));
    document.getElementById(BADGE_ID)?.remove();
    return { cleared: true };
  }

  // --- Observer presence -----------------------------------------------------
  // When the Local Browser Agent owns the fill, the Assistant must still be
  // VISIBLE: a persistent chip shows the live application state so the user
  // always knows the product is watching this page. It renders nothing but
  // the public status word, mutates no form fields, and can be dismissed.
  const OBSERVER_WORDS = {
    preparing: '正在扫描',
    filling: '正在填写',
    needs_you: '需要你处理',
    awaiting_verification: '等待登录、验证码',
    ready_to_submit: '准备提交（由你完成）',
    applied: '已完成',
  };
  let observerPollTimer = null;

  function stopObserverPresence() {
    if (observerPollTimer) { clearInterval(observerPollTimer); observerPollTimer = null; }
    document.getElementById(OBSERVER_ID)?.remove();
  }

  function showObserverPresence(connection) {
    const session = connection.execution_session || {};
    const jobId = String(session.job_id || '');
    if (!jobId) return;
    ensureStyle();
    stopObserverPresence();
    const chip = document.createElement('div');
    chip.id = OBSERVER_ID;
    const dot = document.createElement('span');
    dot.className = 'aa-dot';
    const text = document.createElement('span');
    const who = [session.display?.company, session.display?.role].filter(Boolean).join(' · ');
    text.textContent = `申请助手正在陪同${who ? `：${who}` : ''}`;
    const close = document.createElement('span');
    close.className = 'aa-close';
    close.textContent = '×';
    close.onclick = () => stopObserverPresence();
    // One-click "fill this step": the agent gets a retry command through the
    // local app and fills immediately — no waiting for the watch cycle. The
    // chip never fills anything itself.
    const fillNow = document.createElement('button');
    fillNow.className = 'aa-fill-now';
    fillNow.type = 'button';
    fillNow.textContent = '填写这一步';
    fillNow.onclick = async () => {
      fillNow.disabled = true;
      fillNow.textContent = '已请求…';
      try {
        const result = await runtimeMessage({ type: 'FILL_CURRENT_STEP', job_id: jobId });
        fillNow.textContent = result?.status === 'ok' ? '正在填写…' : (result?.message ? '暂不可用' : '重试');
      } catch {
        fillNow.textContent = '重试';
      }
      setTimeout(() => { fillNow.disabled = false; fillNow.textContent = '填写这一步'; }, 6_000);
    };
    // Manual re-scan: refresh the checklist and learning candidates NOW,
    // instead of waiting for the idle-detection cycle to notice hand-typed
    // changes. Read-only — the agent re-reads the page, fills nothing.
    const rescan = document.createElement('button');
    rescan.className = 'aa-fill-now aa-rescan';
    rescan.type = 'button';
    rescan.textContent = '重新扫描';
    rescan.onclick = async () => {
      rescan.disabled = true;
      rescan.textContent = '已请求…';
      try {
        const result = await runtimeMessage({ type: 'REVIEW_RESCAN_NOW', job_id: jobId });
        rescan.textContent = result?.status === 'ok' ? '扫描中…' : '暂不可用';
      } catch {
        rescan.textContent = '重试';
      }
      setTimeout(() => { rescan.disabled = false; rescan.textContent = '重新扫描'; }, 6_000);
    };
    chip.append(dot, text, fillNow, rescan, close);
    document.documentElement.appendChild(chip);
    const refresh = async () => {
      try {
        const state = await runtimeMessage({ type: 'GET_APPLY_STATE', job_id: jobId });
        const word = String(state?.state || '');
        if (['applied', 'manual_only', 'rejected'].includes(word)) {
          text.textContent = `申请助手：${OBSERVER_WORDS[word] || '已结束'}`;
          if (observerPollTimer) { clearInterval(observerPollTimer); observerPollTimer = null; }
          return;
        }
        const label = OBSERVER_WORDS[word] || '正在观察';
        const left = Number(state?.things_left || 0);
        text.textContent = word === 'needs_you' && left > 0
          ? `申请助手：需要你处理 ${left} 项 — 打开 Resume Jobs 查看`
          : `申请助手：${label}`;
      } catch {
        text.textContent = '申请助手：正在重新连接…';
      }
    };
    refresh();
    observerPollTimer = setInterval(refresh, 5_000);
  }

  // --- Wiring ----------------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) return false;
    if (message.type === 'PING_CONTENT_SCRIPT') {
      sendResponse({ ok: true, content_script_ready: true });
      return false;
    }
    if (isResumeJobsAppPage()) {
      sendResponse({
        status: 'skipped',
        code: 'RESUME_JOBS_APP_PAGE',
        message: 'This is the Resume Jobs app itself, not an application form.'
      });
      return false;
    }
    if (message.type === 'SCAN_PAGE') {
      const pageState = pageStateSnapshot();
      sendResponse({
        ok: true,
        url: location.href,
        field_count: collectFields().fields.length,
        challenge_scope: pageState.challenge_scope,
      });
      return false;
    }
    if (message.type === 'CLEAR_HIGHLIGHTS') {
      sendResponse(clearHighlights());
      return false;
    }
    if (message.type === 'RUN_AUTOFILL' || message.type === 'CONTINUE_AFTER_VERIFICATION') {
      runFill(message.type === 'CONTINUE_AFTER_VERIFICATION' ? 'continue_after_verification' : (message.trigger || 'manual_popup'))
        .then(sendResponse)
        .catch(error => sendResponse({ status: 'error', message: String(error?.message || error) }));
      return true;
    }
    return false;
  });

  // The local app's own pages verify the extension is alive with a nonce
  // handshake. Localhost only; no data beyond version and readiness.
  if (/^(?:127\.0\.0\.1|localhost)$/i.test(location.hostname)) {
    window.addEventListener('message', (event) => {
      const message = event?.data;
      if (event.source !== window || !message || message.source !== 'resume-jobs-dashboard') return;
      if (message.type !== 'RESUME_JOBS_EXTENSION_PING') return;
      const nonce = String(message.nonce || '').slice(0, 120);
      if (!nonce) return;
      window.postMessage({
        source: 'resume-jobs-extension',
        type: 'RESUME_JOBS_EXTENSION_PONG',
        nonce,
        extension_version: chrome.runtime.getManifest()?.version || '',
        content_script_ready: true
      }, location.origin);
    });
  }

  // On supported application pages, announce presence and — when the user has
  // already started this exact application from Resume Jobs — run one fill
  // automatically so opening the page is enough. When the Local Browser Agent
  // owns the fill, the Assistant stays a VISIBLE observer instead of vanishing.
  // Returns true once the page is bound (fill ran or observer chip shown).
  async function initializeApplicationPage() {
    if (isResumeJobsAppPage()) return true;
    const connection = await runtimeMessage({ type: 'CONNECT_CURRENT_APPLICATION', current_url: location.href });
    if (connection.status !== 'ok' || !connection.execution_session) return false;
    if (connection.fill_owner && connection.fill_owner !== 'extension') {
      // The agent owns this fill: never touch the form, but never disappear.
      showObserverPresence(connection);
      return true;
    }
    const session = connection.execution_session;
    // Scope, not equality: a multi-step wizard's later steps are the same
    // application on a different URL of the same host.
    if (!core.withinApplicationScope(location.href, session.target_url)) return false;
    if (session.execution_status !== 'EXTENSION_CONNECTED') return true; // bound; a fill already ran or is not ours to start
    await runFill('page_load');
    return true;
  }

  // One shot used to be the whole story: if the app was briefly unreachable or
  // the SPA routed to /application after the timer fired, the tab stayed
  // unbound forever. Now the CONNECT step retries (bounded) and rebinds on SPA
  // URL changes; runFill stays guarded by execution_status so it never reruns.
  let pageBound = false;
  let boundUrl = '';
  let connectAttempts = 0;
  let lastSeenUrl = location.href;
  const bindTimer = setInterval(() => {
    if (location.href !== lastSeenUrl) {
      // SPA routed somewhere new: the fresh URL earns its own bounded
      // attempts — bound or not (an unbound job-list page navigating to the
      // application page must get its chance).
      lastSeenUrl = location.href;
      if (pageBound) stopObserverPresence();
      pageBound = false;
      boundUrl = '';
      connectAttempts = 0;
    }
    if (pageBound) return;
    if (connectAttempts >= 20) return; // idle until the next SPA navigation
    connectAttempts += 1;
    initializeApplicationPage().then(bound => {
      if (bound) { pageBound = true; boundUrl = location.href; }
    }).catch(() => {
      // The page simply has no started application; the popup remains the way in.
    });
  }, 3_000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => { initializeApplicationPage().then(bound => {
        if (bound) { pageBound = true; boundUrl = location.href; }
      }).catch(() => {
        // The page simply has no started application; the popup remains the way in.
      }); }, 1200);
    }, { once: true });
  } else {
    setTimeout(() => { initializeApplicationPage().then(bound => {
        if (bound) { pageBound = true; boundUrl = location.href; }
      }).catch(() => {
        // The page simply has no started application; the popup remains the way in.
      }); }, 1200);
  }
})();
