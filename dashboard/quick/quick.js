// Quick Apply UI — renders backend state through the frozen API contract only.
// No JSON files, no runtime files, no internal state machine: everything comes
// from the routes in docs/developer/QUICK_APPLY_API_CONTRACT.md, and the only
// status vocabulary shown is the public one from /api/jobs/:id/apply-state.
(() => {
  const { t, setLanguage } = window.QuickI18n;
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const outlet = $('#mainOutlet');

  // --- tiny API client -------------------------------------------------------
  async function api(url, options = {}) {
    const response = await fetch(url, {
      headers: options.body ? { 'content-type': 'application/json' } : {},
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const value = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, value };
  }

  // --- toast / modal ---------------------------------------------------------
  function toast(message, kind = '') {
    const region = $('#toastRegion');
    const node = document.createElement('div');
    node.className = `toast ${kind}`;
    node.textContent = message;
    region.appendChild(node);
    setTimeout(() => node.remove(), 4200);
  }
  function apiError(result) {
    toast(result.value?.message || t('common.error'), 'error');
  }

  function confirmModal({ title, body, confirmLabel, danger = false, typedText = '', bullets = [] }) {
    return new Promise(resolve => {
      const backdrop = $('#modalBackdrop');
      $('#modalTitle').textContent = title;
      const bodyNode = $('#modalBody');
      bodyNode.textContent = body || '';
      if (Array.isArray(bullets) && bullets.length) {
        const ul = document.createElement('ul');
        ul.className = 'list-plain small';
        ul.style.margin = '8px 0 0';
        for (const line of bullets) { const li = document.createElement('li'); li.textContent = line; ul.appendChild(li); }
        bodyNode.appendChild(ul);
      }
      let input = null;
      if (typedText) {
        input = document.createElement('input');
        input.placeholder = t('common.type_to_confirm', { text: typedText });
        bodyNode.appendChild(input);
      }
      const actions = $('#modalActions');
      actions.innerHTML = '';
      const cancel = document.createElement('button');
      cancel.className = 'btn';
      cancel.textContent = t('common.cancel');
      const confirm = document.createElement('button');
      confirm.className = danger ? 'btn danger' : 'btn primary';
      confirm.textContent = confirmLabel || t('common.confirm');
      actions.append(cancel, confirm);
      const close = value => { backdrop.hidden = true; resolve(value); };
      cancel.onclick = () => close(null);
      confirm.onclick = () => {
        if (typedText && (input?.value || '').trim() !== typedText) { input?.focus(); return; }
        close({ typed: input?.value || '' });
      };
      backdrop.hidden = false;
      (input || confirm).focus();
    });
  }

  // --- drawer ----------------------------------------------------------------
  const drawer = {
    open(title, renderBody) {
      $('#drawerTitle').textContent = title;
      const body = $('#drawerBody');
      body.innerHTML = '';
      renderBody(body);
      $('#drawer').hidden = false;
      $('#drawerBackdrop').hidden = false;
    },
    close() {
      $('#drawer').hidden = true;
      $('#drawerBackdrop').hidden = true;
      stopApplyPolling();
    },
  };
  $('#drawerClose').onclick = () => drawer.close();
  $('#drawerBackdrop').onclick = () => drawer.close();

  // --- helpers ---------------------------------------------------------------
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === 'class') node.className = value;
      else if (key === 'html') node.innerHTML = value;
      else if (key.startsWith('on')) node[key] = value;
      else if (value !== undefined && value !== null) node.setAttribute(key, value);
    }
    for (const child of children.flat()) {
      if (child == null) continue;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
    return node;
  }
  const uiState = {
    get(key, fallback) {
      try { return JSON.parse(sessionStorage.getItem(`qa_${key}`)) ?? fallback; } catch { return fallback; }
    },
    set(key, value) { sessionStorage.setItem(`qa_${key}`, JSON.stringify(value)); },
  };
  function combinedScore(job) {
    const value = Number(job.match_scores?.combined_score ?? job.match_score);
    return Number.isFinite(value) ? Math.round(value) : null;
  }
  function matchReason(job) {
    const reason = (Array.isArray(job.match_reasons) ? job.match_reasons : [])
      .map(item => (typeof item === 'string' ? item : item?.reason || item?.label || '')).find(Boolean);
    return reason || t('jobs.match_reason.default');
  }
  // Translate an internal blocker code / message to plain language; unknown
  // strings that already read as a sentence pass through, raw codes get a
  // generic fallback so the user never sees "approval_safety_invalid".
  function blockerMessage(code) {
    if (!code) return '';
    const key = `blocker.${code}`;
    const translated = t(key);
    if (translated !== key) return translated;
    // Looks like a raw snake_case code → generic wording; else it's a sentence.
    return /^[a-z0-9_]+$/.test(String(code)) ? t('blocker.generic') : String(code);
  }
  // Plain-language source label from provenance, never an internal id/JSON.
  function sourceLabel(job) {
    const by = String(job.discovery?.discovered_by || '').replace('global_search:', '');
    const map = {
      company_ats: t('src.company'), amazon_jobs: 'Amazon', apple_jobs: 'Apple', oracle_careers: 'Oracle',
      wellfound: 'Wellfound', remotive: 'Remotive', tencent_careers: '腾讯', nowcoder: '牛客',
      shixiseng: '实习僧', searxng_web: t('src.web'), searxng_ats: t('src.web'), assisted_browser: t('src.browser'),
    };
    if (map[by]) return map[by];
    if (by) return by;
    return job.source_category_label || '';
  }
  function publicStateWord(state, thingsLeft = 0) {
    if (state === 'needs_you') return t('st.needs_you', { n: thingsLeft });
    return t(`st.${state}`) === `st.${state}` ? state : t(`st.${state}`);
  }

  // --- router ----------------------------------------------------------------
  const routes = {
    home: renderHome, jobs: renderJobs, apps: renderApps,
    profile: renderProfile, settings: renderSettings, tools: renderTools,
  };
  function currentRoute() {
    const hash = location.hash.replace(/^#\//, '');
    return routes[hash.split('?')[0]] ? hash.split('?')[0] : 'home';
  }
  async function render() {
    const route = currentRoute();
    for (const link of document.querySelectorAll('#mainNav a')) {
      link.classList.toggle('active', link.dataset.route === route);
    }
    outlet.innerHTML = `<p class="muted">${t('common.loading')}</p>`;
    try { await routes[route](); }
    catch (error) { outlet.innerHTML = ''; outlet.append(el('p', { class: 'muted' }, t('common.error'), ' — ', String(error?.message || error))); }
    refreshAppsBadge();
  }
  window.addEventListener('hashchange', () => { drawer.close(); render(); });

  // Language toggle
  const langToggle = $('#langToggle');
  function syncLangToggle() { langToggle.textContent = window.QuickI18n.language === 'zh' ? 'EN' : '中文'; }
  langToggle.onclick = () => {
    setLanguage(window.QuickI18n.language === 'zh' ? 'en' : 'zh');
    syncLangToggle();
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
    render();
  };
  syncLangToggle();

  // --- shared data reads -----------------------------------------------------
  async function loadJobs() {
    const result = await api('/api/jobs');
    // Invalid non-job records (old "查看更多职位 / Zhipin / 0分" navigation
    // garbage) never surface anywhere in the UI.
    return (Array.isArray(result.value) ? result.value : []).filter(job => job.invalid_non_job !== true);
  }
  // ACTIVE = something is genuinely running or waiting on the user right now
  // (always session-backed on the server side). RESUMABLE additionally covers
  // 'ready_to_open': prepared work at rest the user can continue from
  // preflight. Only ACTIVE states may ever claim the home "continue" slot.
  const ACTIVE_STATES = new Set(['preparing', 'filling', 'needs_you', 'awaiting_verification', 'ready_to_submit']);
  const RESUMABLE_STATES = new Set([...ACTIVE_STATES, 'ready_to_open']);
  function jobHasApplicationActivity(job) {
    return RESUMABLE_STATES.has(job.public_state);
  }
  async function loadApplications(jobs) {
    const active = jobs.filter(jobHasApplicationActivity);
    const states = await Promise.all(active.map(job => api(`/api/jobs/${encodeURIComponent(job.job_id)}/apply-state`)));
    return states
      .map((result, index) => (result.ok ? { job: active[index], state: result.value } : null))
      .filter(Boolean);
  }
  async function refreshAppsBadge() {
    try {
      const jobs = await loadJobs();
      const applications = await loadApplications(jobs);
      const pending = applications.filter(app => RESUMABLE_STATES.has(app.state.state)).length;
      const badge = $('#appsBadge');
      badge.hidden = pending === 0;
      badge.textContent = String(pending);
    } catch { /* the badge is decoration; pages report errors themselves */ }
  }

  // ==========================================================================
  // Home
  // ==========================================================================
  async function renderHome() {
    const [profile, ai, jobs, history] = await Promise.all([
      api('/api/profile/full'), api('/api/ai/status'), loadJobs(), api('/api/applications/history'),
    ]);
    const applications = await loadApplications(jobs);
    // Only session-backed activity may put "continue" in the next-step slot.
    // A prepared package at rest (ready_to_open) is not an active task — it
    // shows in the recent list, never as a fake "正在准备".
    const inFlight = applications.filter(app => ACTIVE_STATES.has(app.state.state));
    const resumable = applications.filter(app => app.state.state === 'ready_to_open');

    const hasProfile = profile.value?.has_profile === true;
    const approved = profile.value?.approved === true;
    const aiReady = ai.value?.ready === true;

    // One recommended next step.
    let next;
    if (!hasProfile) next = { text: t('home.next.upload'), btn: t('home.next.upload.btn'), href: '#/profile' };
    else if (!approved) next = { text: t('home.next.approve'), btn: t('home.next.approve.btn'), href: '#/profile' };
    else if (inFlight.length) next = { text: t('home.next.continue'), btn: t('home.next.continue.btn'), href: '#/apps' };
    else if (!jobs.length) next = { text: t('home.next.job'), btn: t('home.next.job.btn'), href: '#/jobs' };
    else next = { text: t('home.next.apply'), btn: t('home.next.apply.btn'), href: '#/jobs' };

    const recent = [
      ...[...inFlight, ...resumable].map(app => ({
        company: app.state.company, title: app.state.title,
        word: publicStateWord(app.state.state, app.state.things_left), things: app.state.things_left,
      })),
      ...(Array.isArray(history.value?.applications) ? history.value.applications : []).slice(0, 5)
        .map(item => ({ company: item.company, title: item.title, word: publicStateWord(item.state || 'applied'), things: 0 })),
    ].slice(0, 5);

    outlet.innerHTML = '';
    outlet.append(
      el('div', { class: 'page-head' }, el('h1', {}, t('home.title'))),
      el('div', { class: 'next-step' },
        el('div', { class: 'grow' }, el('b', {}, t('home.next')), next.text),
        el('a', { class: 'btn primary', href: next.href }, next.btn)),
      el('div', { class: 'stack', style: 'margin-top:14px' },
        el('div', { class: 'card' },
          el('h3', {}, t('home.profile')),
          el('div', { class: 'row' },
            el('span', { class: `pill ${approved ? 'ok' : hasProfile ? 'warn' : ''}` },
              !hasProfile ? t('home.profile.none') : approved ? t('home.profile.ready') : t('home.profile.unapproved')),
            el('a', { class: 'btn small', href: '#/profile' }, t('nav.profile')))),
        el('div', { class: 'card' },
          el('h3', {}, t('home.ai')),
          el('div', { class: 'row' },
            el('span', { class: `pill ${aiReady ? 'ok' : ''}` },
              aiReady ? `${t('home.ai.ready')} · ${ai.value.provider_type || ''} ${ai.value.model || ''}` : t('home.ai.off')),
            el('a', { class: 'btn small', href: '#/settings' }, t('nav.settings')))),
        el('div', { class: 'card' },
          el('h3', {}, t('home.recent')),
          recent.length
            ? el('div', { class: 'stack' }, recent.map(item =>
              el('div', { class: 'row' },
                el('div', { class: 'grow' }, el('b', {}, item.company || '—'), ` · ${item.title || ''}`),
                el('span', { class: 'pill info' }, item.word),
                item.things > 0 ? el('span', { class: 'pill warn' }, t('apps.things', { n: item.things })) : null)))
            : el('p', { class: 'muted' }, t('home.no_recent')))));
  }

  // ==========================================================================
  // Jobs
  // ==========================================================================
  const JOBS_PAGE_SIZE = 12;
  async function renderJobs() {
    const jobs = await loadJobs();
    // The list is a cumulative INVENTORY (applications and history hang off
    // it, so a new search never deletes old jobs) — but the user must be able
    // to SEE what the latest run brought in, especially when those jobs score
    // low against their profile and sink to the bottom.
    const runStatus = await api('/api/search/run/status');
    const lastRun = runStatus.value?.run;
    const lastRunStartedAt = lastRun?.status === 'completed' ? String(lastRun.started_at || '') : '';
    const TABS = ['recommended', 'new_run', 'all', 'shortlist', 'saved', 'applied', 'rejected'];
    const storedTab = uiState.get('jobs_tab', 'recommended');
    const tab = TABS.includes(storedTab) ? storedTab : 'recommended';
    const search = uiState.get('jobs_search', '');
    const shown = uiState.get('jobs_shown', JOBS_PAGE_SIZE);

    // Buckets read the server projection only (lifecycle_status / saved /
    // shortlisted / public_state) — the UI never re-derives a job's state.
    const isRejected = job => job.lifecycle_status === 'rejected';
    const isSaved = job => job.saved === true;
    const isApplied = job => job.lifecycle_status === 'applied';
    const isOpen = job => !isRejected(job) && !isApplied(job) && job.suppressed_from_default !== true;
    const matchOf = job => job.search_match?.match_score ?? combinedScore(job) ?? 0;
    const buckets = {
      recommended: jobs.filter(job => isOpen(job) && matchOf(job) >= 60),
      new_run: lastRunStartedAt
        ? jobs.filter(job => isOpen(job) && String(job.first_seen || '') >= lastRunStartedAt)
        : [],
      all: jobs.filter(isOpen),
      shortlist: jobs.filter(job => job.shortlisted && job.ignored_forever !== true && !isRejected(job)),
      saved: jobs.filter(job => isSaved(job) && !isRejected(job)),
      applied: jobs.filter(isApplied),
      rejected: jobs.filter(job => isRejected(job) || job.ignored_forever === true),
    };
    const sortMode = uiState.get('jobs_sort', 'match');
    for (const key of Object.keys(buckets)) {
      buckets[key].sort(sortMode === 'new'
        ? (a, b) => String(b.first_seen || '').localeCompare(String(a.first_seen || ''))
        : (a, b) => (combinedScore(b) ?? -1) - (combinedScore(a) ?? -1));
    }
    // 本轮新增 always reads newest-first: it answers "这次搜到了什么".
    buckets.new_run.sort((a, b) => String(b.first_seen || '').localeCompare(String(a.first_seen || '')));

    const query = search.trim().toLowerCase();
    const visible = (buckets[tab] || [])
      .filter(job => !query || [job.title, job.company, job.location].join(' ').toLowerCase().includes(query));

    outlet.innerHTML = '';
    // Classification feedback line: what the input was recognized as, in plain
    // words — plus the assisted-browser action when a board needs one.
    const importFeedback = el('div', { class: 'small muted', id: 'importFeedback', style: 'min-height:18px' });
    async function pollAssistedDiscovery(sawRunning = false) {
      if (!importFeedback.isConnected) return; // page re-rendered; a fresh poller owns the new element
      const status = await api('/api/jobs/discover-in-browser/status');
      if (status.value?.status === 'running') {
        importFeedback.innerHTML = '';
        if (status.value.user_action?.waiting_for_user) {
          // Login/verification takeover: the watcher holds every page touch.
          const cont = el('button', { class: 'btn small primary' }, t('jobs.discover.continue'));
          cont.onclick = async () => {
            cont.disabled = true;
            await api('/api/jobs/discover-in-browser/continue', { method: 'POST', body: {} });
          };
          importFeedback.append(
            el('div', {}, t('jobs.discover.waiting_user')),
            el('div', { style: 'margin-top:6px' }, cont));
        } else {
          importFeedback.textContent = `${t('jobs.discover.running')} (${status.value.found || 0})`;
        }
        setTimeout(() => pollAssistedDiscovery(true), 2500);
        return;
      }
      if (!sawRunning) return; // mounted onto an old finished session: nothing to announce
      importFeedback.textContent = t('jobs.discover.done', { n: status.value?.found || 0, m: status.value?.imported || 0 });
      render();
    }
    pollAssistedDiscovery(); // a session may already be open (e.g. started from the search drawer)
    function showBrowserRequired(url) {
      importFeedback.innerHTML = '';
      const open = el('button', { class: 'btn small primary' }, t('jobs.open_in_browser'));
      open.onclick = async () => {
        open.disabled = true;
        const started = await api('/api/jobs/discover-in-browser', { method: 'POST', body: { url, confirmed: true } });
        if (!started.ok) { apiError(started); open.disabled = false; return; }
        importFeedback.textContent = t('jobs.discover.running');
        setTimeout(pollAssistedDiscovery, 2500);
      };
      importFeedback.append(
        el('div', {}, `${t('jobs.kind.job_board_url')} — ${t('jobs.browser_required')}`),
        el('div', { style: 'margin-top:6px' }, open));
    }
    const importForm = el('form', { class: 'inline-form grow' },
      el('input', { id: 'importUrl', placeholder: t('jobs.import.placeholder'), autocomplete: 'off' }),
      el('button', { class: 'btn primary', type: 'submit' }, t('jobs.import.btn')));
    importForm.onsubmit = async event => {
      event.preventDefault();
      const url = $('#importUrl', importForm).value.trim();
      if (!url) return;
      const button = importForm.querySelector('button');
      button.disabled = true;
      importFeedback.textContent = '…';
      const result = await api('/api/jobs/import', { method: 'POST', body: { input: url } });
      button.disabled = false;
      const kind = result.value?.classification?.kind || '';
      const kindLine = kind ? t(`jobs.kind.${kind}`) : '';
      if (result.value?.status === 'browser_required') {
        showBrowserRequired(url);
        return;
      }
      if (result.value?.status === 'not_a_url') {
        importFeedback.textContent = kindLine;
        return;
      }
      if (!result.ok) {
        importFeedback.textContent = [kindLine, t('jobs.import.failed')].filter(Boolean).join(' — ');
        return;
      }
      const count = Number(result.value?.imported_count ?? result.value?.jobs?.length ?? 1);
      importFeedback.textContent = `${kindLine} — ${count > 1 ? t('jobs.import.company_found', { n: count }) : t('jobs.import.one')}`;
      $('#importUrl', importForm).value = '';
      render();
    };

    // Keyword search — a REAL provider call, separate from the link box.
    const searchForm = el('form', { class: 'inline-form grow' },
      el('input', { id: 'searchKeywords', placeholder: t('jobs.search.placeholder'), autocomplete: 'off' }),
      el('button', { class: 'btn', type: 'submit' }, t('jobs.search.btn')));
    searchForm.onsubmit = async event => {
      event.preventDefault();
      const keywords = $('#searchKeywords', searchForm).value.trim();
      if (!keywords) return;
      const button = searchForm.querySelector('button');
      button.disabled = true;
      importFeedback.textContent = '…';
      const result = await api('/api/jobs/search', { method: 'POST', body: { query: keywords } });
      button.disabled = false;
      if (result.value?.status === 'no_sources') {
        importFeedback.textContent = t('jobs.search.no_sources');
        return;
      }
      if (!result.ok) { apiError(result); importFeedback.textContent = ''; return; }
      importFeedback.textContent = t('jobs.search.done', { q: keywords, n: result.value?.found || 0 });
      render();
    };

    // --- Global search: plans, run button, provider progress -----------------
    const gsProgress = el('div', { id: 'gsLive' });
    let gsTimer = null;
    async function pollGlobalSearch() {
      const status = await api('/api/search/run/status');
      const run = status.value?.run;
      if (!run) return;
      paintGlobalSearchRun(gsProgress, run);
      if (run.status === 'running') gsTimer = setTimeout(pollGlobalSearch, 1500);
      else { clearTimeout(gsTimer); render(); }
    }
    const runButton = el('button', { class: 'btn primary' }, t('gs.run'));
    runButton.onclick = async () => {
      runButton.disabled = true;
      const started = await api('/api/search/run', { method: 'POST', body: {} });
      if (!started.ok && started.value?.code === 'SEARCH_PLAN_NOT_FOUND') {
        openSearchPlanDrawer();
        runButton.disabled = false;
        return;
      }
      if (!started.ok && started.status !== 409) { apiError(started); runButton.disabled = false; return; }
      gsProgress.textContent = t('gs.running');
      pollGlobalSearch();
      runButton.disabled = false;
    };
    // Headline entry: search from the approved profile. Shows the derived
    // directions first so the user sees (and can edit) what we'll search for.
    const profileSearchButton = el('button', { class: 'btn primary big' }, `🎯 ${t('gs.from_profile')}`);
    profileSearchButton.onclick = () => openProfileSearchDrawer();

    const panelButton = el('button', { class: 'btn' }, t('gs.panel'));
    panelButton.onclick = () => openSearchPlanDrawer();
    const stopButton = el('button', { class: 'btn small' }, t('gs.stop'));
    stopButton.onclick = async () => {
      const result = await api('/api/search/run/stop', { method: 'POST', body: {} });
      if (result.ok) toast(t('gs.stopped'));
    };

    const sortSelect = el('select', {},
      el('option', { value: 'match' }, t('gs.sort.match')),
      el('option', { value: 'new' }, t('gs.sort.new')));
    sortSelect.value = sortMode;
    sortSelect.onchange = () => { uiState.set('jobs_sort', sortSelect.value); render(); };

    const searchInput = el('input', { placeholder: t('jobs.filter.placeholder'), value: search, style: 'max-width:180px' });
    searchInput.style.padding = '8px 11px'; searchInput.style.border = '1px solid var(--line)'; searchInput.style.borderRadius = '9px';
    searchInput.oninput = () => { uiState.set('jobs_search', searchInput.value); scheduleJobsRefilter(); };

    const tabsBar = el('div', { class: 'tabs' },
      [['recommended', 'jobs.tab.recommended'], ['new_run', 'jobs.tab.new_run'], ['all', 'jobs.tab.all'],
       ['shortlist', 'jobs.tab.shortlist'],
       ['saved', 'jobs.tab.saved'], ['applied', 'jobs.tab.applied'], ['rejected', 'jobs.tab.rejected']]
        // The 本轮新增 tab only exists while a completed run has something to show.
        .filter(([key]) => key !== 'new_run' || buckets.new_run.length > 0 || tab === 'new_run')
        .map(([key, label]) => {
          const button = el('button', { class: key === tab ? 'active' : '' },
            t(label), el('span', { class: 'count' }, String(buckets[key].length)));
          button.onclick = () => { uiState.set('jobs_tab', key); uiState.set('jobs_shown', JOBS_PAGE_SIZE); render(); };
          return button;
        }));

    const list = el('div', { class: 'stack' });
    if (!visible.length) {
      list.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '📭'), t('jobs.empty')));
    }
    for (const job of visible.slice(0, shown)) list.append(jobCard(job, tab));
    if (visible.length > shown) {
      const more = el('button', { class: 'btn' }, `${t('jobs.load_more')} (${visible.length - shown})`);
      more.onclick = () => { uiState.set('jobs_shown', shown + JOBS_PAGE_SIZE); render(); };
      list.append(el('div', { class: 'load-more' }, more));
    }

    // 清除搜索记录: sweep searched jobs + run history for a fresh hunt. Jobs
    // the user touched (applications, saved, shortlisted, hidden) survive;
    // this is deliberately narrower than the two Data-and-privacy buttons.
    const clearSearchButton = el('button', { class: 'btn danger small' }, t('jobs.clear_search'));
    clearSearchButton.onclick = async () => {
      const confirmed = await confirmModal({
        title: t('jobs.clear_search'), body: t('jobs.clear_search.body'), danger: true,
        bullets: [t('jobs.clear_search.b1'), t('jobs.clear_search.b2'), t('jobs.clear_search.b3')],
        confirmLabel: t('jobs.clear_search.confirm'),
      });
      if (!confirmed) return;
      clearSearchButton.disabled = true;
      const result = await api('/api/jobs/clear-search-records', { method: 'POST', body: { confirmed: true } });
      clearSearchButton.disabled = false;
      if (result.ok) {
        toast(t('jobs.clear_search.done', { n: result.value?.removed_jobs ?? 0 }));
        render();
      } else apiError(result);
    };

    outlet.append(
      el('div', { class: 'page-head' }, el('h1', {}, t('jobs.title'))),
      el('div', { class: 'stack', style: 'margin-bottom:14px' },
        el('div', { class: 'row' }, profileSearchButton, panelButton, stopButton, sortSelect, clearSearchButton),
        await profileSearchStatusBar(),
        el('details', { class: 'small' },
          el('summary', { class: 'muted' }, t('jobs.manual_add')),
          el('div', { class: 'stack', style: 'margin-top:8px' },
            el('div', { class: 'row' }, importForm, searchInput),
            el('div', { class: 'row' }, searchForm, runButton))),
        importFeedback,
        gsProgress),
      tabsBar, list);

    let refilterTimer = null;
    function scheduleJobsRefilter() {
      clearTimeout(refilterTimer);
      refilterTimer = setTimeout(render, 260);
    }
  }

  // Provider progress + run summary for the global search.
  function paintGlobalSearchRun(holder, run) {
    holder.innerHTML = '';
    const card = el('div', { class: 'card' });
    card.append(el('h3', {}, run.status === 'running' ? t('gs.running') : t('gs.summary')));
    card.append(el('div', { class: 'stack' },
      (run.providers || []).map(provider => el('div', { class: 'row small' },
        el('span', { class: 'grow' }, provider.label || provider.id),
        el('span', { class: `pill ${provider.status === 'ok' ? 'ok' : provider.status === 'user_action_required' ? 'info' : ''}` },
          t(`gs.status.${provider.status}`) === `gs.status.${provider.status}` ? provider.status : t(`gs.status.${provider.status}`)),
        el('span', { class: 'muted' }, String(provider.found ?? 0))))));
    if (run.summary) {
      card.append(el('p', { class: 'small', style: 'margin:8px 0 0' },
        t('gs.sum.line', {
          raw: run.summary.raw_found, unique: run.summary.unique_after_dedup,
          filtered: run.summary.filtered_out, accepted: run.summary.accepted,
        })),
        el('p', { class: 'small', style: 'margin:2px 0 0;font-weight:600' },
          t('gs.sum.recommended', { r: run.summary.recommended ?? 0 })));
      if ((run.filtered || []).length) {
        card.append(el('details', { class: 'small', style: 'margin-top:6px' },
          el('summary', {}, `${t('gs.filtered.title')} (${run.filtered.length})`),
          el('ul', { class: 'list-plain' }, run.filtered.slice(0, 12).map(item =>
            el('li', {}, `${item.title} @ ${item.company} — ${item.why_filtered.map(why => why.rule).join(', ')}`)))));
      }
    }
    if (run.error) card.append(el('p', { class: 'small', style: 'color:var(--danger)' }, run.error));
    holder.append(card);
  }

  // Status bar under the jobs controls: which profile version the active
  // profile-generated plan was based on, when it ran, and whether the profile
  // has since changed (stale) — with regenerate / keep actions.
  async function profileSearchStatusBar() {
    const res = await api('/api/search/plans');
    const store = res.value || {};
    const active = (store.plans || []).find(p => p.plan_id === store.active_plan_id);
    if (!active || active.generated_from_profile !== true) return el('span', { style: 'display:none' });
    const ranAt = String(active.last_run_at || active.generated_at || '').slice(0, 16).replace('T', ' ');
    const line = el('div', { class: 'small muted' },
      t('gs.status.based_on', { v: active.profile_version ?? '—' }),
      ranAt ? ` · ${t('gs.status.searched_at', { at: ranAt })}` : '');
    if (!active.stale) return line;
    // Stale: profile changed since this plan was generated. Two repairs:
    // regenerate the search directions, or just recompute the match scores of
    // the jobs already found against the NEW profile.
    const regen = el('button', { class: 'btn small primary' }, t('gs.stale.regen'));
    regen.onclick = async () => {
      regen.disabled = true;
      await regenerateProfilePlan(active.plan_id);
    };
    const rescore = el('button', { class: 'btn small' }, t('gs.stale.rescore'));
    rescore.onclick = async () => {
      rescore.disabled = true;
      rescore.textContent = t('gs.stale.rescoring');
      const result = await api('/api/run/scoring', { method: 'POST', body: {} });
      if (result.ok) { toast(t('gs.stale.rescored')); render(); }
      else { apiError(result); rescore.disabled = false; rescore.textContent = t('gs.stale.rescore'); }
    };
    const keep = el('button', { class: 'btn small' }, t('gs.stale.keep'));
    keep.onclick = () => { uiState.set('gs_stale_dismissed', active.profile_digest || '1'); render(); };
    if (uiState.get('gs_stale_dismissed', '') === (active.profile_digest || '1')) return line;
    return el('div', { class: 'card', style: 'border-color:var(--warn);background:var(--warn-soft)' },
      el('div', { class: 'small', style: 'font-weight:600' }, `⚠️ ${t('gs.stale.title')}`),
      el('div', { class: 'small', style: 'margin:4px 0 8px' }, t('gs.stale.body')),
      el('div', { class: 'row' }, regen, rescore, keep));
  }

  async function regenerateProfilePlan(planId) {
    const dir = await api('/api/search/profile-directions');
    const d = dir.value || {};
    if (d.status === 'no_profile') { toast(t('gs.fp.no_profile'), 'error'); return; }
    const criteria = {
      target_roles: d.roles || [], locations: (d.locations || []).slice(0, 4),
      keywords: (d.roles || []).slice(0, 4), minimum_match_score: 0,
    };
    const saved = await api('/api/search/plans', {
      method: 'POST', body: {
        plan_id: planId, name: t('gs.fp.plan_name'), criteria, activate: true,
        generated_from_profile: true, profile_version: d.profile_version, profile_digest: d.profile_digest,
        generated_at: new Date().toISOString(),
      },
    });
    if (!saved.ok) { apiError(saved); return; }
    uiState.set('gs_stale_dismissed', '');
    const started = await api('/api/search/run', { method: 'POST', body: { criteria } });
    if (!started.ok && started.status !== 409) { apiError(started); return; }
    toast(t('gs.running'));
    render();
    setTimeout(async function poll() {
      const status = await api('/api/search/run/status');
      const run = status.value?.run;
      const progress = document.querySelector('#gsLive');
      if (run && progress) paintGlobalSearchRun(progress, run);
      if (run && run.status === 'running') setTimeout(poll, 1500); else render();
    }, 800);
  }

  // "Find jobs from my profile": show the directions the system derived from
  // the approved Career Profile, let the user edit, then run a real search.
  async function openProfileSearchDrawer() {
    drawer.open(t('gs.from_profile'), async body => {
      body.append(el('p', { class: 'muted' }, t('common.loading')));
      const res = await api('/api/search/profile-directions');
      const d = res.value || {};
      body.innerHTML = '';
      if (d.status === 'no_profile' || d.available === false) {
        body.append(
          el('p', {}, t('gs.fp.no_profile')),
          el('a', { class: 'btn primary', href: '#/profile' }, t('nav.profile')));
        return;
      }
      const field = (labelKey, node) => el('div', { class: 'field' }, el('label', {}, t(labelKey)), node);
      const input = (value, ph = '') => el('input', { value: value ?? '', placeholder: ph });
      const roles = input((d.roles || []).join(', '));
      const locations = input((d.locations || []).filter(x => !/^[A-Za-z]/.test(x)).concat((d.locations || []).filter(x => /^[A-Za-z]/.test(x))).slice(0, 4).join(', '));
      const keywords = input((d.roles || []).slice(0, 4).join(', '));

      body.append(
        el('p', { class: 'small' }, t('gs.fp.intro')),
        // The plain-language "we will focus on these" panel (goal item 7).
        el('div', { class: 'card' },
          el('div', { class: 'small muted', style: 'margin-bottom:6px' }, t('gs.fp.focus')),
          el('div', { class: 'chips' }, (d.roles || []).map(r => el('span', { class: 'chip' }, r))),
          (d.adjacent_roles || []).length
            ? el('div', { style: 'margin-top:8px' },
                el('div', { class: 'small muted', style: 'margin-bottom:6px' }, t('gs.fp.adjacent')),
                el('div', { class: 'chips' }, d.adjacent_roles.map(r => el('span', { class: 'chip alt' }, r))))
            : null,
          (d.skills || []).length
            ? el('div', { style: 'margin-top:8px' },
                el('div', { class: 'small muted', style: 'margin-bottom:6px' }, t('gs.fp.skills')),
                el('div', { class: 'chips' }, d.skills.slice(0, 12).map(s => el('span', { class: 'chip alt' }, s))))
            : null,
          d.entry_level ? el('p', { class: 'small', style: 'margin:8px 0 0' }, `🎓 ${t('gs.fp.entry')}`) : null),
        el('p', { class: 'small muted', style: 'margin:12px 0 4px' }, t('gs.fp.editable')),
        field('gs.roles', roles),
        field('gs.locations', locations),
        field('gs.keywords', keywords));

      const start = el('button', { class: 'btn primary grow' }, t('gs.fp.start'));
      const openFilters = el('button', { class: 'btn' }, t('gs.fp.more_filters'));
      start.onclick = async () => {
        start.disabled = true;
        const criteria = {
          target_roles: roles.value.split(',').map(s => s.trim()).filter(Boolean),
          locations: locations.value.split(',').map(s => s.trim()).filter(Boolean),
          keywords: keywords.value.split(',').map(s => s.trim()).filter(Boolean),
          minimum_match_score: 0,
          // The detected new-grad flag must reach FILTERING too, not just the
          // query variants — otherwise the run says 校招 while ranking
          // Director postings.
          entry_level: d.entry_level === true,
        };
        const saved = await api('/api/search/plans', {
          method: 'POST', body: {
            name: t('gs.fp.plan_name'), criteria, activate: true,
            generated_from_profile: true, profile_version: d.profile_version, profile_digest: d.profile_digest,
            generated_at: new Date().toISOString(),
          },
        });
        if (!saved.ok) { apiError(saved); start.disabled = false; return; }
        const started = await api('/api/search/run', { method: 'POST', body: { criteria } });
        if (!started.ok && started.status !== 409) { apiError(started); start.disabled = false; return; }
        drawer.close();
        toast(t('gs.running'));
        render();
        // Kick the progress poller on the freshly rendered jobs page.
        setTimeout(async function poll() {
          const status = await api('/api/search/run/status');
          const run = status.value?.run;
          const progress = document.querySelector('#gsLive');
          if (run && progress) paintGlobalSearchRun(progress, run);
          if (run && run.status === 'running') setTimeout(poll, 1500); else render();
        }, 800);
      };
      openFilters.onclick = () => { drawer.close(); openSearchPlanDrawer(); };
      body.append(el('div', { class: 'row', style: 'margin-top:14px' }, start, openFilters));
    });
  }

  // The big-filter panel: criteria form + saved plans + browser search.
  async function openSearchPlanDrawer() {
    const plansResult = await api('/api/search/plans');
    const store = plansResult.value || { plans: [] };
    const active = (store.plans || []).find(plan => plan.plan_id === store.active_plan_id) || store.plans?.[0] || null;
    const criteria = active?.criteria || {};

    drawer.open(t('gs.panel'), async body => {
      const field = (labelKey, node) => el('div', { class: 'field' }, el('label', {}, t(labelKey)), node);
      const input = (value, placeholder = '') => el('input', { value: value ?? '', placeholder });
      const keywords = input((criteria.keywords || []).join(', '));
      const roles = input((criteria.target_roles || []).join(', '));
      const locations = input((criteria.locations || []).join(', '));
      const remote = el('select', {}, ['any', 'remote', 'hybrid', 'onsite'].map(mode => el('option', { value: mode }, t(`gs.remote.${mode}`))));
      remote.value = criteria.remote || 'any';
      const expMin = input(criteria.experience_min ?? '', 'min');
      const expMax = input(criteria.experience_max ?? '', 'max');
      const education = el('select', {}, ['any', 'high_school', 'associate', 'bachelor', 'master', 'phd'].map(level => el('option', { value: level }, t(`gs.edu.${level}`))));
      education.value = criteria.education || 'any';
      const salaryMin = input(criteria.salary_min ?? '', 'min');
      const salaryMax = input(criteria.salary_max ?? '', 'max');
      const currency = input(criteria.salary_currency || 'CNY');
      currency.style.maxWidth = '70px';
      const period = el('select', {}, ['year', 'month'].map(value => el('option', { value }, t(`gs.f.period.${value}`))));
      period.value = criteria.salary_period || 'year';
      const typeBoxes = ['full_time', 'part_time', 'contract', 'internship'].map(type => {
        const box = el('input', { type: 'checkbox' });
        box.checked = (criteria.employment_type || []).includes(type);
        return { type, box, node: el('label', { class: 'row small', style: 'gap:4px' }, box, t(`gs.type.${type}`)) };
      });
      const industries = input((criteria.industries || []).join(', '));
      const posted = input(criteria.posted_within_days ?? '');
      const excluded = input((criteria.excluded_keywords || []).join(', '));
      const blocked = input((criteria.blocked_companies || []).join(', '));
      const minMatch = input(criteria.minimum_match_score ?? '');
      const entry = el('input', { type: 'checkbox' });
      entry.checked = criteria.entry_level === true;
      const boards = el('textarea', { style: 'min-height:56px' });
      boards.value = (criteria.company_boards || []).join('\n');
      const planName = input(active?.name || '', t('gs.plan.name'));

      function collectCriteria() {
        return {
          keywords: keywords.value, target_roles: roles.value, locations: locations.value,
          remote: remote.value,
          experience_min: expMin.value === '' ? null : Number(expMin.value),
          experience_max: expMax.value === '' ? null : Number(expMax.value),
          education: education.value,
          salary_min: salaryMin.value === '' ? null : Number(salaryMin.value),
          salary_max: salaryMax.value === '' ? null : Number(salaryMax.value),
          salary_currency: currency.value, salary_period: period.value,
          employment_type: typeBoxes.filter(item => item.box.checked).map(item => item.type),
          industries: industries.value,
          posted_within_days: posted.value === '' ? null : Number(posted.value),
          excluded_keywords: excluded.value, blocked_companies: blocked.value,
          minimum_match_score: minMatch.value === '' ? null : Number(minMatch.value),
          entry_level: entry.checked,
          company_boards: boards.value.split('\n').map(line => line.trim()).filter(Boolean),
        };
      }

      const save = el('button', { class: 'btn primary' }, t('gs.plan.save'));
      save.onclick = async () => {
        save.disabled = true;
        const result = await api('/api/search/plans', {
          method: 'POST',
          body: {
            plan_id: active?.plan_id || '', name: planName.value.trim() || t('gs.plan.name'),
            criteria: collectCriteria(), activate: true,
          },
        });
        save.disabled = false;
        if (result.ok) { toast(t('settings.saved')); openSearchPlanDrawer(); } else apiError(result);
      };
      const runNow = el('button', { class: 'btn' }, t('gs.run'));
      runNow.onclick = async () => {
        runNow.disabled = true;
        const started = await api('/api/search/run', { method: 'POST', body: { criteria: collectCriteria() } });
        runNow.disabled = false;
        if (!started.ok && started.status !== 409) { apiError(started); return; }
        drawer.close();
        render();
        setTimeout(async function poll() {
          const status = await api('/api/search/run/status');
          const run = status.value?.run;
          const progress = document.querySelector('#gsLive');
          if (run && progress) paintGlobalSearchRun(progress, run);
          if (run?.status === 'running') setTimeout(poll, 1500); else render();
        }, 1200);
      };

      body.append(
        field('gs.plan.name', planName),
        field('gs.f.keywords', keywords), field('gs.f.roles', roles), field('gs.f.locations', locations),
        field('gs.f.remote', remote),
        el('div', { class: 'row' }, field('gs.f.exp', el('div', { class: 'row' }, expMin, expMax)), field('gs.f.edu', education)),
        field('gs.f.salary', el('div', { class: 'row' }, salaryMin, salaryMax, currency, period)),
        field('gs.f.type', el('div', { class: 'row' }, typeBoxes.map(item => item.node))),
        el('div', { class: 'row' }, field('gs.f.industries', industries), field('gs.f.posted', posted)),
        field('gs.f.excluded', excluded), field('gs.f.blocked', blocked),
        el('div', { class: 'row' }, field('gs.f.min_match', minMatch),
          el('label', { class: 'row small', style: 'gap:4px;margin-top:14px' }, entry, t('gs.f.entry'))),
        field('gs.f.boards', boards),
        el('div', { class: 'row', style: 'margin:8px 0 16px' }, save, runNow));

      // Saved plans
      body.append(el('h4', {}, t('gs.plans')));
      if (!(store.plans || []).length) body.append(el('p', { class: 'small muted' }, t('gs.plans.none')));
      for (const plan of store.plans || []) {
        const use = el('button', { class: 'btn small' }, t('gs.plan.use'));
        use.onclick = async () => {
          await api('/api/search/plans', { method: 'POST', body: { ...plan, activate: true } });
          openSearchPlanDrawer();
        };
        const remove = el('button', { class: 'btn small danger' }, t('gs.plan.delete'));
        remove.onclick = async () => {
          await api(`/api/search/plans/${encodeURIComponent(plan.plan_id)}`, { method: 'DELETE' });
          openSearchPlanDrawer();
        };
        body.append(el('div', { class: 'row small', style: 'margin-bottom:6px' },
          el('span', { class: `grow ${plan.plan_id === store.active_plan_id ? '' : 'muted'}` },
            `${plan.plan_id === store.active_plan_id ? '● ' : ''}${plan.name}`,
            plan.last_run_summary ? ` · ${plan.last_run_summary.accepted}↑` : ''),
          use, remove));
      }

      // Browser-driven board search (BOSS / LinkedIn windows) was removed
      // from this drawer at the user's request — the backend routes stay for
      // the advanced UI.
    });
  }

  function jobCard(job, tab) {
    const score = combinedScore(job);
    const actions = el('div', { class: 'job-actions' });
    const view = el('button', { class: 'btn small' }, t('jobs.view'));
    view.onclick = () => openJobDrawer(job);
    actions.append(view);
    if (tab === 'rejected') {
      const restore = el('button', { class: 'btn small' }, t('jobs.restore'));
      restore.onclick = async () => {
        restore.disabled = true;
        // 已排除 mixes two mechanisms: the ignored_forever job FLAG (永久忽略 /
        // 屏蔽该公司) and the application-level REJECTED state. Restore must
        // undo whichever ones actually apply — the restore route alone cannot
        // clear a flag, which is why company-blocked jobs looked unrestorable.
        let ok = true;
        if (job.ignored_forever === true) {
          const unignored = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/flag`, { method: 'POST', body: { action: 'unignore' } });
          if (!unignored.ok) { apiError(unignored); ok = false; }
        }
        if (ok && job.lifecycle_status === 'rejected') {
          const restored = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/restore`, { method: 'POST', body: {} });
          if (!restored.ok) { apiError(restored); ok = false; }
        }
        restore.disabled = false;
        if (ok) render();
      };
      actions.append(restore);
    } else if (tab !== 'applied') {
      const shortlistButton = el('button', { class: 'btn small' }, job.shortlisted ? t('jobs.unshortlist') : t('jobs.shortlist'));
      shortlistButton.onclick = async () => {
        const result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/flag`, {
          method: 'POST', body: { action: job.shortlisted ? 'unshortlist' : 'shortlist' },
        });
        if (result.ok) render(); else apiError(result);
      };
      actions.append(shortlistButton);
      if (tab === 'saved') {
        const unsaveButton = el('button', { class: 'btn small' }, t('jobs.unsave'));
        unsaveButton.onclick = async () => {
          const result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/flag`, {
            method: 'POST', body: { action: 'unsave' },
          });
          if (result.ok) render(); else apiError(result);
        };
        actions.append(unsaveButton);
      }
      const apply = el('button', { class: 'btn small primary' }, t('jobs.apply'));
      apply.onclick = () => openPreflight(job);
      actions.append(apply);
    }
    // Meta pills: only what the source actually provided (goal: 有则显示).
    const salaryText = typeof job.salary === 'string' ? job.salary : (job.salary?.text || '');
    const postedText = String(job.posted_date || '').slice(0, 10);
    const sourceText = sourceLabel(job);
    const meta = el('div', { class: 'job-meta' },
      el('span', {}, job.company || '—'),
      job.location ? el('span', {}, job.location) : null,
      salaryText ? el('span', { class: 'pill ok' }, salaryText) : null,
      postedText ? el('span', { class: 'muted' }, postedText) : null,
      sourceText ? el('span', { class: 'muted' }, sourceText) : null);
    const why = (job.search_match?.why_fit || [])[0];
    return el('div', { class: 'card job-card' },
      score != null
        ? el('div', { class: `match ${score >= 80 ? 'high' : score < 55 ? 'low' : ''}` }, `${score}`)
        : el('div', { class: 'match low' }, '—'),
      el('div', { class: 'job-main' },
        el('div', { class: 'job-title' }, job.title || '—'),
        meta,
        el('div', { class: 'job-reason' }, why || matchReason(job))),
      actions);
  }

  // Job detail drawer — also the per-job home of the career tools.
  function openJobDrawer(job) {
    drawer.open(`${job.company || ''} · ${job.title || ''}`, body => {
      const toolsSection = el('div', { class: 'drawer-section' },
        el('h4', {}, t('nav.tools')),
        el('div', { class: 'row' },
          el('button', { class: 'btn small', onclick: () => generateTailoredResume(job, body) }, t('pf.resume.make')),
          el('button', { class: 'btn small', onclick: () => generateCoverLetter(job, body) }, t('pf.letter.make'))),
        el('div', { class: 'small muted', id: 'jobToolsOut', style: 'margin-top:8px' }));
      body.append(
        el('div', { class: 'drawer-section' },
          el('div', { class: 'kv' },
            el('dt', {}, t('jobs.title')), el('dd', {}, job.title || '—'),
            el('dt', {}, ''), el('dd', {}, job.company || '—'),
            el('dt', {}, ''), el('dd', {}, job.location || '—')),
          job.url ? el('p', { class: 'small' }, el('a', { href: job.url, target: '_blank', rel: 'noopener' }, job.url)) : null),
        el('div', { class: 'drawer-section small muted' },
          String(job.description_text || '').slice(0, 800) || ''),
        // Match explanation from the last global search, when present.
        job.search_match ? el('div', { class: 'drawer-section' },
          el('h4', {}, `${t('gs.why_fit')} · ${job.search_match.match_score ?? '—'}`),
          el('ul', { class: 'list-plain small' }, (job.search_match.why_fit || []).map(line => el('li', {}, line))),
          (job.search_match.main_gaps || []).length
            ? el('p', { class: 'small muted', style: 'margin:6px 0 0' }, `${t('gs.gaps')}: ${job.search_match.main_gaps.join('; ')}`)
            : null) : null,
        // Where did this job come from? Always answerable.
        el('div', { class: 'drawer-section' },
          el('h4', {}, t('jobs.provenance')),
          el('dl', { class: 'kv small' },
            el('dt', {}, t('jobs.provenance')), el('dd', {}, sourceLabel(job) || '—'),
            el('dt', {}, t('jobs.provenance.query')), el('dd', {}, job.discovery?.query || '—'),
            el('dt', {}, t('jobs.provenance.at')), el('dd', {}, String(job.discovery?.discovered_at || job.first_seen || '').slice(0, 10) || '—'),
            el('dt', {}, t('jobs.provenance.url')), el('dd', {},
              job.discovery?.original_url
                ? el('a', { href: job.discovery.original_url, target: '_blank', rel: 'noopener' }, job.discovery.original_url.slice(0, 60))
                : '—'))),
        toolsSection,
        el('div', { class: 'drawer-section row' },
          el('button', { class: 'btn primary grow', onclick: () => { drawer.close(); openPreflight(job); } }, t('jobs.apply')),
          el('button', {
            // The durable saved flag: independent of application progress, so
            // saving works at every stage and applying never un-saves.
            class: 'btn', onclick: async event => {
              const wasSaved = job.saved === true;
              const result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/flag`, {
                method: 'POST', body: { action: wasSaved ? 'unsave' : 'save' },
              });
              if (result.ok) {
                job.saved = !wasSaved;
                event.target.textContent = job.saved ? t('jobs.unsave') : t('jobs.save');
                toast(job.saved ? t('st.saved') : t('jobs.unsaved'));
              } else apiError(result);
            }
          }, job.saved === true ? t('jobs.unsave') : t('jobs.save')),
          el('button', {
            class: 'btn danger', onclick: async () => {
              const result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/reject`, { method: 'POST', body: {} });
              if (result.ok) { drawer.close(); render(); } else apiError(result);
            }
          }, t('jobs.reject'))),
        el('div', { class: 'drawer-section row' },
          el('button', {
            class: 'btn small danger', onclick: async () => {
              const result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/flag`, { method: 'POST', body: { action: 'ignore_forever' } });
              if (result.ok) { drawer.close(); render(); } else apiError(result);
            }
          }, t('jobs.ignore')),
          el('button', {
            class: 'btn small danger', onclick: async () => {
              const confirmed = await confirmModal({ title: t('jobs.block_company'), body: job.company || '', danger: true });
              if (!confirmed) return;
              const result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/flag`, { method: 'POST', body: { action: 'block_company' } });
              if (result.ok) { drawer.close(); render(); } else apiError(result);
            }
          }, t('jobs.block_company'))));
    });
  }

  async function generateTailoredResume(job, scope) {
    const out = $('#jobToolsOut', scope) || scope;
    out.textContent = t('pf.resume.making');
    const generated = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/resume-draft`, { method: 'POST', body: {} });
    if (!generated.ok) {
      const message = generated.value?.message || t('common.error');
      toast(message);
      out.textContent = message;
      return null;
    }
    const exported = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/resume-draft/export`, { method: 'POST', body: {} });
    if (!exported.ok) {
      // The draft exists but could not become a file (e.g. the profile has
      // no name) — the reason must be impossible to miss.
      const message = exported.value?.message || t('common.error');
      toast(message);
      out.textContent = message;
      return generated.value?.draft || null;
    }
    // The user must know when the draft was NOT AI-tailored (provider off /
    // unreachable) instead of silently receiving the deterministic re-render.
    const aiStatus = String(generated.value?.ai?.status || '');
    const aiNote = aiStatus && !['ok'].includes(aiStatus) ? ` · ${t('pf.resume.no_ai')}` : '';
    if (aiNote) toast(t('pf.resume.no_ai'));
    out.textContent = `${t('pf.resume.tailored_ready')} · ${exported.value.files?.docx || ''}${aiNote}`;
    return generated.value?.draft || null;
  }
  async function generateCoverLetter(job, scope) {
    const out = $('#jobToolsOut', scope) || scope;
    out.textContent = t('pf.resume.making');
    const generated = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/cover-letter`, { method: 'POST', body: {} });
    if (!generated.ok) { out.textContent = generated.value?.message || t('common.error'); return null; }
    const paragraphs = (generated.value?.letter?.paragraphs || []).map(item => item.text || '').filter(Boolean);
    out.style.whiteSpace = 'pre-wrap';
    out.textContent = paragraphs.join('\n\n');
    return generated.value?.letter || null;
  }

  // ==========================================================================
  // Preflight drawer → apply progress (the core flow)
  // ==========================================================================
  let applyPollTimer = null;
  // Each self-rescheduling poll chain carries the generation it was born in;
  // bumping the generation orphans every older chain (a lone clearTimeout only
  // stops the LATEST scheduled tick, so switching drawers used to leave the
  // previous job's loop polling forever).
  let applyPollGeneration = 0;
  function stopApplyPolling() { applyPollGeneration += 1; clearTimeout(applyPollTimer); applyPollTimer = null; }

  async function openPreflight(job, extraBody = {}) {
    // The progress view's poll loop may still be alive (e.g. its ready_to_open
    // button leads here) — orphan it before this drawer takes over.
    stopApplyPolling();
    drawer.open(t('pf.title'), body => {
      body.append(el('p', { class: 'muted' }, t('common.loading')));
    });
    const preflight = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/quick-apply`, { method: 'POST', body: { ...extraBody } });
    if (!preflight.ok) {
      $('#drawerBody').innerHTML = '';
      // The application is already being filled (live session). Offer the two
      // real choices instead of a raw error: continue it, or restart it (which
      // safely discards the running attempt and rebuilds from the newest
      // profile/resume).
      if (preflight.value?.code === 'APPLICATION_ALREADY_ACTIVE') {
        const body = $('#drawerBody');
        const cont = el('button', { class: 'btn primary block' }, t('pf.active.continue'));
        cont.onclick = () => renderApplyProgress(job);
        const restart = el('button', { class: 'btn block', style: 'margin-top:8px' }, t('pf.active.restart'));
        restart.onclick = async () => {
          restart.disabled = true;
          const restarted = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/restart-fill-setup`, {
            method: 'POST',
            body: { confirmed: true, idempotency_key: `quick-restart:${job.job_id}:${Date.now().toString(36)}` },
          });
          if (!restarted.ok) { toast(restarted.value?.message || t('common.error'), 'error'); restart.disabled = false; return; }
          openPreflight(job);
        };
        body.append(
          el('h4', {}, t('pf.active.title')),
          el('p', { class: 'small' }, t('pf.active.body')),
          el('div', { style: 'margin-top:12px' }, cont, restart));
        return;
      }
      const blockerCodes = (Array.isArray(preflight.value?.blockers) ? preflight.value.blockers : [])
        .map(item => (typeof item === 'string' ? item : item.message || item.missing || ''));
      // Not a single application page (aggregator/board/careers-home). Explain
      // in plain language and give the real next step, never raw codes.
      const isDiscoveryLead = preflight.value?.code === 'JOB_NOT_APPLICATION_PAGE'
        || blockerCodes.some(code =>
          /not_single_application_page|approval_safety_invalid|page_type_.*_not_approvable|application_mode_not_review_only/.test(code));
      const body = $('#drawerBody');
      if (isDiscoveryLead) {
        body.append(
          el('h4', {}, t('pf.not_ready.title')),
          el('p', { class: 'small' }, t('pf.not_ready.body')));
        // One-click verification: the product fetches the REAL page itself
        // (the same pipeline the paste-link box uses) and, when it checks out
        // as an actual application page, continues straight into the apply
        // preflight — no manual copy-paste round-trip.
        const verifyUrl = job.canonical_url || job.url || '';
        if (verifyUrl) {
          const verify = el('button', { class: 'btn primary' }, t('pf.not_ready.verify'));
          verify.onclick = async () => {
            verify.disabled = true;
            verify.textContent = t('pf.not_ready.verifying');
            const imported = await api('/api/jobs/import', { method: 'POST', body: { input: verifyUrl } });
            const verifiedJob = imported.value?.jobs?.[0] || imported.value?.job || null;
            if (imported.ok && verifiedJob?.job_id) {
              toast(t('pf.not_ready.verified'));
              openPreflight(verifiedJob);
              return;
            }
            toast(blockerMessage(imported.value?.message) || t('jobs.import.failed'), 'error');
            verify.disabled = false;
            verify.textContent = t('pf.not_ready.verify');
          };
          body.append(el('div', { style: 'margin-top:10px' }, verify));
        }
        // "Just open it and fill": the user's confirmation stands in for the
        // machine check — the agent browser's FIRST SCAN then verifies the
        // live page, and a page without an application form gets nothing
        // filled, ever. This replaces the old dead-end paste-a-link advice.
        const direct = el('button', { class: 'btn' }, t('pf.not_ready.direct'));
        direct.onclick = () => openPreflight(job, { user_confirmed_job_detail: true });
        body.append(el('div', { style: 'margin-top:8px' }, direct));
        if (job.url) {
          const open = el('a', { class: 'btn', href: job.url, target: '_blank', rel: 'noopener' }, t('pf.not_ready.open'));
          body.append(el('div', { style: 'margin-top:8px' }, open));
        }
        body.append(el('p', { class: 'small muted', style: 'margin-top:10px' }, t('pf.not_ready.hint')));
        return;
      }
      // Any other block: show the human message, translating known codes.
      body.append(
        el('p', {}, blockerMessage(preflight.value?.message) || t('common.error')),
        ...blockerCodes.map(code => el('p', { class: 'small muted' }, blockerMessage(code))));
      return;
    }
    renderPreflight(job, preflight.value);
  }

  function renderPreflight(job, prepared) {
    const info = prepared.preflight || {};
    const tailored = info.tailored_resume || { available: false };
    const needsUser = Array.isArray(info.needs_user) ? info.needs_user : [];
    const answerInputs = new Map();

    drawer.open(t('pf.title'), body => {
      body.append(el('div', { class: 'drawer-section' },
        el('b', {}, job.title || ''), el('div', { class: 'muted small' }, job.company || '')));

      // Resume — every file the application will actually use, visible here:
      // the base resume, the job-tailored file (name + preview + download +
      // regenerate), and exactly what the browser step will upload.
      const resumeOut = el('div', { class: 'small muted', style: 'margin-top:6px' });
      const selectedResume = info.selected_resume || {};
      const regenerate = el('button', { class: 'btn small' }, tailored.available ? t('pf.resume.regen') : t('pf.resume.make'));
      regenerate.onclick = async () => {
        regenerate.disabled = true;
        resumeOut.textContent = t('pf.resume.making');
        const generated = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/resume-draft`, { method: 'POST', body: { use_ai: true } });
        if (generated.ok) {
          await api(`/api/jobs/${encodeURIComponent(job.job_id)}/resume-draft/export`, { method: 'POST', body: {} });
          const refreshed = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/quick-apply`, { method: 'POST', body: {} });
          if (refreshed.ok) { renderPreflight(job, refreshed.value); return; }
        }
        resumeOut.textContent = generated.value?.message || t('common.error');
        regenerate.disabled = false;
      };
      const previewResume = el('button', { class: 'btn small', hidden: !tailored.available }, t('pf.preview'));
      previewResume.onclick = async () => {
        previewResume.disabled = true;
        const draft = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/resume-draft`);
        previewResume.disabled = false;
        const blocks = draft.value?.draft?.blocks || [];
        resumeOut.innerHTML = '';
        if (!blocks.length) { resumeOut.textContent = t('common.error'); return; }
        for (const block of blocks.slice(0, 60)) {
          resumeOut.append(el('div', { style: block.origin === 'ai_rewritten' ? 'font-weight:600' : '' }, block.text || ''));
        }
      };
      // The MAIN uploaded resume is the default upload. The tailored draft is
      // experimental — it uploads only when the user explicitly selects it.
      const mainRadio = el('input', { type: 'radio', name: 'resumeChoice', checked: '' });
      const tailoredRadio = el('input', { type: 'radio', name: 'resumeChoice' });
      if (!tailored.available) tailoredRadio.disabled = true;
      const uploadNameOut = el('b', {}, selectedResume.name || selectedResume.file_name || selectedResume.resume_id || '—');
      const syncUploadLine = () => {
        uploadNameOut.textContent = tailoredRadio.checked
          ? (tailored.file_name || '')
          : (selectedResume.name || selectedResume.file_name || selectedResume.resume_id || '—');
      };
      mainRadio.onchange = syncUploadLine;
      tailoredRadio.onchange = syncUploadLine;
      const resumeRows = el('div', { class: 'stack', style: 'gap:6px' },
        el('label', { class: 'row small', style: 'gap:6px;align-items:center' },
          mainRadio,
          el('span', { class: 'grow' },
            `${t('pf.resume.base')}（${t('pf.resume.default')}）：`,
            el('b', {}, selectedResume.name || selectedResume.file_name || selectedResume.resume_id || '—'))),
        el('label', { class: 'row small', style: 'gap:6px;align-items:center;flex-wrap:wrap' },
          tailoredRadio,
          el('span', { class: 'grow' },
            `${t('pf.resume.tailored')}`,
            el('span', { class: 'pill warn', style: 'margin:0 6px' }, t('pf.resume.experimental')),
            '：',
            tailored.available
              ? el('b', {}, tailored.file_name || '')
              : el('span', { class: 'muted' }, t('pf.resume.none'))),
          previewResume,
          tailored.available
            ? el('a', { class: 'btn small', href: `/api/jobs/${encodeURIComponent(job.job_id)}/resume-draft/file?format=docx` }, t('pf.download.docx'))
            : null,
          tailored.available && tailored.has_pdf
            ? el('a', { class: 'btn small', href: `/api/jobs/${encodeURIComponent(job.job_id)}/resume-draft/file?format=pdf` }, t('pf.download.pdf'))
            : null,
          regenerate),
        tailored.available && tailored.stale_profile
          ? el('div', { class: 'small', style: 'color:var(--warn, #b45309)' }, t('pf.resume.stale'))
          : null,
        tailored.available && tailored.content_complete === false
          ? el('div', { class: 'small', style: 'color:var(--warn, #b45309)' }, t('pf.resume.incomplete'))
          : null,
        el('div', { class: 'small' }, `${t('pf.upload.will')}：`, uploadNameOut));
      body.append(el('div', { class: 'drawer-section' },
        el('h4', {}, t('pf.resume')), resumeRows, resumeOut));

      // Cover letter — generated / not generated, with preview + regenerate.
      const letterOut = el('div', { class: 'small muted', style: 'margin-top:6px;white-space:pre-wrap' });
      const letterState = el('span', { class: 'grow small muted' }, t('pf.letter.checking'));
      const makeLetter = el('button', { class: 'btn small' }, t('pf.letter.make'));
      const previewLetter = el('button', { class: 'btn small', hidden: '' }, t('pf.preview'));
      const paintLetter = letter => {
        const has = Boolean(letter && (letter.paragraphs || []).length);
        letterState.textContent = has ? t('pf.letter.ready') : t('pf.letter.none');
        letterState.className = has ? 'grow small' : 'grow small muted';
        makeLetter.textContent = has ? t('pf.letter.regen') : t('pf.letter.make');
        previewLetter.hidden = !has;
      };
      previewLetter.onclick = async () => {
        const existing = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/cover-letter`);
        const paragraphs = (existing.value?.letter?.paragraphs || []).map(item => item.text || '').filter(Boolean);
        letterOut.textContent = paragraphs.join('\n\n') || t('common.error');
      };
      makeLetter.onclick = async () => {
        makeLetter.disabled = true;
        letterOut.textContent = t('pf.resume.making');
        const generated = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/cover-letter`, { method: 'POST', body: {} });
        if (generated.ok) {
          paintLetter(generated.value?.letter);
          letterOut.textContent = (generated.value?.letter?.paragraphs || [])
            .map(item => item.text || '').filter(Boolean).join('\n\n');
        } else {
          letterOut.textContent = generated.value?.message || t('common.error');
        }
        makeLetter.disabled = false;
      };
      api(`/api/jobs/${encodeURIComponent(job.job_id)}/cover-letter`).then(existing => {
        paintLetter(existing.ok ? existing.value?.letter : null);
      });
      body.append(el('div', { class: 'drawer-section' },
        el('h4', {}, t('pf.letter')),
        el('div', { class: 'row' }, letterState, previewLetter, makeLetter),
        letterOut));

      // Auto-filled
      body.append(el('div', { class: 'drawer-section' },
        el('h4', {}, t('pf.autofill')),
        el('p', { class: 'small muted', style: 'margin:0' }, t('pf.autofill.items'))));

      // Fill mode — the product's own window (recommended: auto resume
      // upload, auto re-scan) or the user's own browser via the Assistant
      // extension (their sign-ins and cookies, but resume attaches manually).
      const agentModeRadio = el('input', { type: 'radio', name: 'fillMode', checked: '' });
      const extModeRadio = el('input', { type: 'radio', name: 'fillMode' });
      body.append(el('div', { class: 'drawer-section' },
        el('h4', {}, t('pf.exec')),
        el('label', { class: 'row small', style: 'gap:6px;align-items:center' },
          agentModeRadio, el('span', { class: 'grow' }, t('pf.exec.agent'))),
        el('label', { class: 'row small', style: 'gap:6px;align-items:center;margin-top:4px' },
          extModeRadio, el('span', { class: 'grow' }, t('pf.exec.ext'))),
        el('p', { class: 'tiny muted', style: 'margin:6px 0 0' }, t('pf.exec.ext.hint'))));

      // Missing questions
      const questions = el('div', {});
      if (!needsUser.length) questions.append(el('p', { class: 'small muted', style: 'margin:0' }, t('pf.questions.none')));
      for (const item of needsUser) {
        const input = el('input', { placeholder: t('answers.a') });
        answerInputs.set(item, input);
        questions.append(el('div', { class: 'field' }, el('label', {}, item.label || item.id || ''), input));
      }
      body.append(el('div', { class: 'drawer-section' }, el('h4', {}, t('pf.questions')), questions));

      // Go
      const go = el('button', { class: 'btn primary block' }, t('pf.go'));
      go.onclick = async () => {
        go.disabled = true;
        go.textContent = t('pf.starting');
        const confirmedAnswers = [...answerInputs.entries()]
          .filter(([, input]) => input.value.trim())
          .map(([item, input]) => ({
            question_id: String(item.id || '').replace(/^answer_/, '') || `q_${Date.now().toString(36)}`,
            original_question: String(item.label || '').replace(/^Confirm your answer for:\s*/i, ''),
            answer: input.value.trim(),
            source: 'user_confirmed', user_confirmed: true,
            sensitive_category: 'none', risk_level: 'normal',
          }));
        const started = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/quick-apply/start`, {
          method: 'POST',
          body: {
            confirmed: true,
            executor_type: extModeRadio.checked ? 'extension' : 'local_browser_agent',
            resume_choice: tailoredRadio.checked ? 'tailored' : 'main',
            idempotency_key: `quick-ui:${job.job_id}:${Date.now().toString(36)}`,
            ...(confirmedAnswers.length ? { confirmed_answers: confirmedAnswers } : {}),
          },
        });
        if (!started.ok) {
          go.disabled = false;
          go.textContent = t('pf.go');
          toast(started.value?.message || t('common.error'), 'error');
          return;
        }
        renderApplyProgress(job);
      };
      body.append(el('div', { class: 'drawer-footer' }, go));
    });
  }

  // Live progress: poll apply-state and translate into plain words.
  function renderApplyProgress(job) {
    stopApplyPolling();
    const generation = applyPollGeneration;
    drawer.open(`${job.company || ''} · ${job.title || ''}`, body => {
      const holder = el('div', {});
      body.append(holder);
      const update = async () => {
        if (generation !== applyPollGeneration) return;
        let result = null;
        // A rejected fetch (server restarting, the agent still launching)
        // must not kill the self-rescheduling chain — keep polling.
        try { result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/apply-state`); } catch { result = null; }
        if (generation !== applyPollGeneration) return;
        if (result && !result.ok) { holder.textContent = result.value?.message || t('common.error'); }
        else if (result) paintApplyState(holder, job, result.value, update);
        if (!$('#drawer').hidden && generation === applyPollGeneration) applyPollTimer = setTimeout(update, 1600);
      };
      holder.append(el('div', { class: 'apply-status' },
        el('div', { class: 'spinner' }), el('div', { class: 'status-line' }, t('pf.starting'))));
      update();
    });
  }

  // Server blocker messages arrive in English; the ones a normal flow can hit
  // get product wording in the user's language.
  function friendlyBlockerMessage(message) {
    const emptyMatch = String(message || '').match(/(\d+)\s+required field\(s\) are still empty/);
    if (emptyMatch) return t('blocker.required_empty', { n: emptyMatch[1] });
    return String(message || '') || t('common.error');
  }

  // --- learning candidates ---------------------------------------------------
  // How hand-typed answers enter the knowledge base: a re-scan diffs the live
  // page against what the fill wrote, and every value the USER typed shows up
  // here as a pending candidate. Nothing is stored until 保存 is pressed —
  // this panel is the entire entry path.
  const learnCaches = new Map();
  function paintLearningCandidates(container, job) {
    const jobId = String(job.job_id);
    if (!learnCaches.has(jobId)) learnCaches.set(jobId, { fetchedAt: 0, items: [], fetching: false, busy: new Set() });
    const learnCache = learnCaches.get(jobId);
    if (!learnCache.fetching && Date.now() - learnCache.fetchedAt > 6000) {
      learnCache.fetching = true;
      api(`/api/jobs/${encodeURIComponent(jobId)}/learning-candidates`).then(result => {
        if (result.ok) learnCache.items = (result.value?.candidates || []).filter(item => item.status === 'pending');
      }, () => {
        // Server briefly unreachable (agent launching, restart): the next
        // repaint retries — the flag must never stay stuck.
      }).finally(() => {
        learnCache.fetching = false;
        learnCache.fetchedAt = Date.now();
      });
    }
    if (!learnCache.items.length) return;
    const box = el('div', { class: 'card', style: 'margin-top:14px;padding:12px' });
    box.append(
      el('div', { style: 'font-weight:600' }, t('learn.title')),
      el('p', { class: 'small muted', style: 'margin:6px 0 2px' }, t('learn.hint')));
    for (const item of learnCache.items) {
      const row = el('div', { style: 'margin-top:10px' });
      const save = el('button', { class: 'btn small primary' }, t('learn.save'));
      const ignore = el('button', { class: 'btn small' }, t('learn.ignore'));
      // The drawer repaints every poll tick, replacing these nodes — the
      // in-flight marker must live in the cache, not on the buttons, or a
      // repainted row comes back clickable while the decision POST is running.
      if (learnCache.busy.has(item.candidate_id)) save.disabled = ignore.disabled = true;
      const decide = async (decision, confirmedHighRisk) => {
        if (learnCache.busy.has(item.candidate_id)) return;
        learnCache.busy.add(item.candidate_id);
        save.disabled = ignore.disabled = true;
        let result = null;
        try {
          result = await api(
            `/api/jobs/${encodeURIComponent(jobId)}/learning-candidates/${encodeURIComponent(item.candidate_id)}/decision`,
            {
              method: 'POST',
              body: {
                decision,
                destination: item.suggested_destination,
                scope: learnCache.scopeChoice?.[item.candidate_id]
                  || (item.suggested_scope === 'do_not_save' ? 'employer' : item.suggested_scope),
                ...(confirmedHighRisk ? { confirmed_high_risk: true } : {}),
              },
            });
        } catch {
          result = null;
        }
        learnCache.busy.delete(item.candidate_id);
        if (!result || !result.ok) {
          toast(result?.value?.message || t('common.error'), 'error');
          save.disabled = ignore.disabled = false;
          return;
        }
        learnCache.items = learnCache.items.filter(other => other.candidate_id !== item.candidate_id);
        // On an idempotent replay the FIRST decision stands — report what the
        // knowledge base actually did, not what this click asked for.
        const storedStatus = String(result.value?.candidate?.status || '');
        const effectiveSaved = storedStatus ? ['saved', 'confirmed'].includes(storedStatus) : decision === 'save';
        toast(effectiveSaved ? t('learn.saved') : t('learn.ignored'));
        row.remove();
        if (!learnCache.items.length) box.remove();
      };
      save.onclick = async () => {
        if (item.risk_level === 'high') {
          const confirmed = await confirmModal({
            title: t('learn.high_risk.title'), body: t('learn.high_risk.body'), confirmLabel: t('learn.save'),
          });
          if (!confirmed) return;
          decide('save', true);
        } else {
          decide('save', false);
        }
      };
      ignore.onclick = () => decide('reject', false);
      // Where the saved answer may be reused is the USER's choice — without
      // this selector every ordinary answer silently stayed employer-only and
      // never helped on the next company's form. The choice survives repaints
      // via the cache.
      const scopeSelect = el('select', { class: 'small', style: 'max-width:130px' },
        el('option', { value: 'global' }, t('learn.scope.global')),
        el('option', { value: 'employer' }, t('learn.scope.employer')),
        el('option', { value: 'role' }, t('learn.scope.role')));
      scopeSelect.value = learnCache.scopeChoice?.[item.candidate_id]
        || (item.suggested_scope === 'do_not_save' ? 'employer' : item.suggested_scope)
        || 'employer';
      scopeSelect.onchange = () => {
        learnCache.scopeChoice = learnCache.scopeChoice || {};
        learnCache.scopeChoice[item.candidate_id] = scopeSelect.value;
      };
      row.append(
        el('div', { class: 'small' }, item.label || item.original_question || '',
          item.risk_level === 'high' ? el('span', { class: 'pill warn', style: 'margin-left:6px' }, t('learn.high_risk')) : null),
        el('div', { class: 'small muted' }, String(item.value || '')),
        el('div', { class: 'row', style: 'margin-top:6px' }, save, ignore, scopeSelect));
      box.append(row);
    }
    container.append(box);
  }

  async function cancelApplication(job, button, afterCancel) {
    const confirmed = await confirmModal({
      title: t('st.cancel_confirm.title'), body: t('st.cancel_confirm.body'),
      confirmLabel: t('st.cancel_confirm.btn'), danger: true,
    });
    if (!confirmed) return;
    if (button) button.disabled = true;
    const result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/cancel-application`, {
      method: 'POST', body: { confirmed: true },
    });
    if (result.ok) { toast(t('st.cancelled')); afterCancel(); }
    else { toast(result.value?.message || t('common.error'), 'error'); if (button) button.disabled = false; }
  }

  function paintApplyState(holder, job, state, refresh) {
    holder.innerHTML = '';
    const word = state.state;
    const busy = ['preparing', 'filling'].includes(word);
    const status = el('div', { class: 'apply-status' });
    if (busy) status.append(el('div', { class: 'spinner' }));
    status.append(el('div', { class: 'status-line' },
      word === 'needs_you'
        ? t('st.needs_you', { n: state.things_left })
        : publicStateWord(word)));

    if (word === 'ready_to_open') {
      // Nothing is running: the preparation is done (or was interrupted) and
      // the user continues from preflight. Never a spinner.
      status.append(el('div', { class: 'status-sub' }, t('st.ready_to_open.hint')));
      const cont = el('button', { class: 'btn primary', style: 'margin-top:12px' }, t('apps.btn.continue'));
      cont.onclick = () => openPreflight(job);
      status.append(cont);
    }

    if (word === 'awaiting_verification') {
      status.append(el('div', { class: 'status-sub' }, t('st.verify.hint')));
      const cont = el('button', { class: 'btn primary', style: 'margin-top:12px' }, t('st.verify.btn'));
      cont.onclick = async () => {
        cont.disabled = true;
        const result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/continue-after-verification`, { method: 'POST', body: { confirmed: true } });
        if (!result.ok) {
          toast(result.value?.code === 'BROWSER_WINDOW_CLOSED' ? t('st.window_closed') : (result.value?.message || t('common.error')), 'error');
          cont.disabled = false;
        } else {
          status.querySelector('.status-line').textContent = t('st.continuing');
        }
      };
      if (state.can_continue_after_verification === false && state.browser_open === false) {
        status.append(el('div', { class: 'status-sub small', style: 'margin-top:8px' }, t('st.window_closed')));
      } else {
        status.append(cont);
      }
    }
    holder.append(status);

    // Extension flow: the page lives in the USER's own browser — hand them
    // the link and say what the Assistant will do there. (The product-window
    // flow never shows this; its window is already open.)
    if (state.executor === 'extension' && ['preparing', 'filling'].includes(word)) {
      holder.append(el('p', { class: 'small muted', style: 'text-align:center;margin-top:10px' }, t('st.ext.hint')));
      if (state.apply_url) {
        holder.append(el('a', { class: 'btn primary block', style: 'margin-top:8px', href: state.apply_url, target: '_blank', rel: 'noopener' }, t('st.open_page')));
      }
    }

    // Checklist ("almost done") — only unfinished items; disappears as things complete.
    const items = Array.isArray(state.checklist) ? state.checklist.filter(item => item.done !== true) : [];
    // Fixed checklist items get product wording; real form fields keep the
    // exact label scanned from the live page (手机号 / 验证码 / …).
    const itemLabel = item => ({
      reopen_page: t('chk.reopen'),
      review_rescan: t('chk.rescan'),
      review_confirm: t('chk.confirm'),
      resume_attach: t('chk.resume'),
      captcha: t('chk.captcha'),
      login: t('chk.login'),
      form_access: t('chk.form_access'),
      unknown_required_fields: t('chk.unknown_fields'),
      required_fields: t('chk.required_fields'),
    }[item.id] || item.label || item.id || '');
    if (['needs_you', 'ready_to_submit'].includes(word)) {
      // The page the user must act on is gone: the one real action is
      // reopening it. Same session, same saved browser profile — sign-ins and
      // the cleared verification are kept.
      if (word === 'needs_you' && state.browser_open === false) {
        holder.append(el('p', { class: 'small muted', style: 'text-align:center' }, t('st.page_closed')));
        const reopen = el('button', { class: 'btn primary block', style: 'margin-top:12px' }, t('st.reopen'));
        reopen.onclick = async () => {
          reopen.disabled = true;
          reopen.textContent = t('st.reopening');
          const started = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/quick-apply/start`, {
            method: 'POST',
            body: {
              confirmed: true, executor_type: 'local_browser_agent',
              idempotency_key: `reopen:${job.job_id}:${Date.now().toString(36)}`,
            },
          });
          if (!started.ok) {
            toast(started.value?.message || t('common.error'), 'error');
            reopen.disabled = false;
            reopen.textContent = t('st.reopen');
          }
          // The poll loop picks the new state up automatically.
        };
        holder.append(reopen);
        // Even with the page gone, the user may already have submitted there
        // or decided to walk away — both endings stay reachable.
        const endActions = el('div', { class: 'stack', style: 'margin-top:12px' });
        appendSubmittedButton(endActions, job, state);
        appendCancelButton(endActions, job);
        holder.append(endActions);
        paintLearningCandidates(holder, job);
        return;
      }
      // The last scan is stale or missing while the page is open: ask the live
      // page for the truth once, instead of showing the user a stale list.
      if (word === 'needs_you' && state.browser_open === true
        && String(state.scan_state || '').match(/^(missing|stale)/) && !holder.dataset.rescanRequested) {
        holder.dataset.rescanRequested = '1';
        api(`/api/jobs/${encodeURIComponent(job.job_id)}/review-rescan`, { method: 'POST', body: {} });
      }
      // The live watch line: while the agent window is open the page is
      // re-scanned automatically as the user edits — say so, passively.
      if (state.browser_open === true && state.monitoring?.page_state === 'left_page') {
        holder.append(el('p', { class: 'small', style: 'text-align:center;margin-top:6px' }, t('st.left_page.hint')));
      } else if (state.browser_open === true && state.monitoring?.active === true) {
        holder.append(el('p', { class: 'tiny muted', style: 'text-align:center;margin-top:6px' }, t('st.watching')));
      }
      holder.append(el('p', { class: 'small muted', style: 'text-align:center' },
        items.length ? t('st.almost', { n: state.things_left }) : t('st.all_done')));
      if (items.length) {
        holder.append(el('ul', { class: 'checklist' },
          items.map(item => el('li', {}, el('span', { class: 'dot' }), itemLabel(item),
            item.sensitive ? el('span', { class: 'pill warn', style: 'margin-left:6px' }, t('chk.sensitive')) : null))));
      }
      const actions = el('div', { class: 'stack', style: 'margin-top:12px' });
      // The open-page link belongs to flows where the USER's browser holds the
      // page (extension executor, or nothing open at all). While the product's
      // own window is alive it must not spawn a second copy of the page —
      // that was the "two tabs" complaint.
      if (state.apply_url && state.browser_open !== true) {
        actions.append(el('a', { class: 'btn block', href: state.apply_url, target: '_blank', rel: 'noopener' }, t('st.open_page')));
      }
      if (word === 'needs_you') {
        const done = el('button', { class: 'btn block' }, t('st.review_done'));
        done.onclick = async () => {
          done.disabled = true;
          // The re-scan runs in the open browser window and reports back
          // asynchronously; confirm the review as soon as it lands.
          await api(`/api/jobs/${encodeURIComponent(job.job_id)}/review-rescan`, { method: 'POST', body: {} });
          let completed = null;
          for (let attempt = 0; attempt < 10; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 1800));
            completed = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/review-complete`, { method: 'POST', body: { confirmed: true } });
            if (completed.ok || completed.value?.code !== 'APPLICATION_REVIEW_RESCAN_REQUIRED') break;
          }
          if (completed && !completed.ok) toast(friendlyBlockerMessage(completed.value?.message), 'error');
          done.disabled = false;
        };
        actions.append(done);
      }
      appendSubmittedButton(actions, job, state);
      appendCancelButton(actions, job);
      holder.append(actions);
      paintLearningCandidates(holder, job);
    }
    if (word === 'applied') {
      holder.append(el('p', { style: 'text-align:center' }, '🎉'));
      // Submitting must never bury pending hand-typed answers: the moment the
      // user is done with the site is exactly when they decide what enters the
      // knowledge base. Decisions still work — each candidate resolves its own
      // recorded session.
      paintLearningCandidates(holder, job);
    }
  }

  function appendSubmittedButton(actions, job, state) {
    if (state.state !== 'ready_to_submit' && !state.can_mark_submitted) return;
    const submitted = el('button', { class: 'btn primary block' }, t('st.i_submitted'));
    submitted.onclick = async () => {
      // MANUALLY_SUBMITTED is terminal, so the click gets one confirmation.
      const confirmed = await confirmModal({
        title: t('st.submit_confirm.title'), body: t('st.submit_confirm.body'),
        confirmLabel: t('st.submit_confirm.btn'),
      });
      if (!confirmed) return;
      submitted.disabled = true;
      submitted.textContent = t('st.submitting');
      // Last-chance capture: one re-scan picks up everything typed since the
      // previous one, so those answers surface as save/ignore candidates
      // instead of dying with the page. Fire-and-wait briefly; the submit
      // itself never blocks on it.
      if (state.browser_open === true) {
        await api(`/api/jobs/${encodeURIComponent(job.job_id)}/review-rescan`, { method: 'POST', body: {} }).catch(() => null);
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
      const result = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/submitted-manually`, { method: 'POST', body: { confirmed: true } });
      if (!result.ok) {
        toast(result.value?.message || t('common.error'), 'error');
        submitted.disabled = false;
        submitted.textContent = t('st.i_submitted');
        return;
      }
      // Pending hand-typed answers keep the drawer open (the 'applied' branch
      // shows them); with none, close as before.
      const candidates = await api(`/api/jobs/${encodeURIComponent(job.job_id)}/learning-candidates`).catch(() => null);
      const pendingCount = Number(candidates?.value?.pending_count || 0);
      const cache = learnCaches.get(String(job.job_id));
      if (cache) cache.fetchedAt = 0; // repaint with fresh candidates
      if (pendingCount > 0) {
        toast(t('st.applied.pending_answers', { n: pendingCount }));
        render();
      } else {
        toast(t('st.applied'));
        drawer.close();
        render();
      }
    };
    actions.append(submitted);
  }

  function appendCancelButton(actions, job) {
    const cancel = el('button', { class: 'btn danger block' }, t('st.cancel_app'));
    cancel.onclick = () => cancelApplication(job, cancel, () => { drawer.close(); render(); });
    actions.append(cancel);
  }

  // ==========================================================================
  // Applications
  // ==========================================================================
  async function renderApps() {
    const jobs = await loadJobs();
    const [applications, history] = await Promise.all([
      loadApplications(jobs), api('/api/applications/history'),
    ]);
    const open = applications.filter(app => RESUMABLE_STATES.has(app.state.state));
    const historyItems = Array.isArray(history.value?.applications) ? history.value.applications : [];

    outlet.innerHTML = '';
    outlet.append(el('div', { class: 'page-head' }, el('h1', {}, t('apps.title'))));
    if (open.length) outlet.append(el('h3', { style: 'margin:0 0 10px' }, t('apps.inprogress')));
    const list = el('div', { class: 'stack' });
    if (!open.length) list.append(el('div', { class: 'empty' }, el('div', { class: 'big' }, '🗂️'), t('apps.empty')));
    for (const app of open) {
      const word = app.state.state;
      const primary = el('button', { class: 'btn small primary' },
        word === 'ready_to_submit' ? t('st.open_page') : t('apps.btn.continue'));
      // A prepared-but-idle application continues from the preflight (which
      // rebuilds anything stale); only live/awaiting states open the progress
      // view — that is what polls apply-state.
      primary.onclick = () => word === 'ready_to_open'
        ? openPreflight(app.job)
        : renderApplyProgress(app.job);
      // 不投了: every in-flight application can be walked away from here.
      const abandon = el('button', { class: 'btn small danger' }, t('st.cancel_app'));
      abandon.onclick = () => cancelApplication(app.job, abandon, renderApps);
      list.append(el('div', { class: 'card job-card' },
        el('div', { class: 'job-main' },
          el('div', { class: 'job-title' }, `${app.state.company || app.job.company || ''} · ${app.state.title || app.job.title || ''}`),
          el('div', { class: 'job-meta' },
            el('span', { class: `pill ${word === 'awaiting_verification' ? 'warn' : 'info'}` }, publicStateWord(word, app.state.things_left)),
            el('span', { class: app.state.things_left > 0 ? 'pill warn' : 'pill ok' },
              app.state.things_left > 0 ? t('apps.things', { n: app.state.things_left }) : t('apps.things.none')))),
        el('div', { class: 'job-actions' }, primary, abandon)));
    }
    outlet.append(list);

    // 已提交岗位: the user's own tracking record — every application they
    // declared submitted, newest first, with the original posting link.
    const submittedItems = historyItems.filter(item => (item.state || '') === 'applied');
    // In-flight states (ready_to_submit …) are already listed above under
    // 进行中 — repeating them as "history" would show the same job twice.
    const otherHistory = historyItems.filter(item =>
      (item.state || '') !== 'applied' && !RESUMABLE_STATES.has(item.state || ''));
    if (submittedItems.length) {
      outlet.append(el('h3', { style: 'margin:20px 0 10px' }, t('apps.submitted')));
      outlet.append(el('div', { class: 'stack' }, submittedItems.slice(0, 50).map(item =>
        el('div', { class: 'card job-card' },
          el('div', { class: 'job-main' },
            el('div', { class: 'job-title' }, `${item.company || ''} · ${item.title || ''}`),
            el('div', { class: 'job-meta' }, el('span', { class: 'pill ok' }, publicStateWord('applied')),
              el('span', { class: 'tiny' }, (item.submitted_at || '').slice(0, 10)))),
          item.url ? el('div', { class: 'job-actions' },
            el('a', { class: 'btn small', href: item.url, target: '_blank', rel: 'noopener' }, t('st.open_page'))) : null))));
    }
    if (otherHistory.length) {
      outlet.append(el('h3', { style: 'margin:20px 0 10px' }, t('apps.history')));
      outlet.append(el('div', { class: 'stack' }, otherHistory.slice(0, 20).map(item =>
        el('div', { class: 'card job-card' },
          el('div', { class: 'job-main' },
            el('div', { class: 'job-title' }, `${item.company || ''} · ${item.title || ''}`),
            el('div', { class: 'job-meta' }, el('span', { class: 'pill ok' }, publicStateWord(item.state || 'applied')),
              el('span', { class: 'tiny' }, (item.submitted_at || item.completed_at || '').slice(0, 10))))))));
    }
  }

  // ==========================================================================
  // Profile
  // ==========================================================================
  // Display sections over the real profile schema. contact/links/work are
  // VIEWS into identity/experience — editing them edits the real section.
  function displaySections(sections) {
    const identity = sections.identity || {};
    const { email, phone, links, ...identityRest } = identity;
    const firstJob = Array.isArray(sections.experience) ? sections.experience[0] : null;
    return [
      { label: t('section.identity'), value: identityRest, editKey: 'identity', editValue: identity },
      { label: t('section.contact'), value: { email, phone }, editKey: 'identity', editValue: identity },
      { label: t('section.links'), value: links || {}, editKey: 'identity', editValue: identity },
      { label: t('section.education'), value: sections.education, editKey: 'education', editValue: sections.education || [] },
      { label: t('section.experience'), value: sections.experience, editKey: 'experience', editValue: sections.experience || [] },
      { label: t('section.projects'), value: sections.projects, editKey: 'projects', editValue: sections.projects || [] },
      { label: t('section.skills'), value: sections.skills, editKey: 'skills', editValue: sections.skills || {} },
      // Career direction feeds the resume summary ("Target role: …"), the
      // cover letter's fit paragraph, and the search planner's first-priority
      // role directions — without it all three fall back to weaker signals.
      { label: t('section.goals'), value: sections.career_goals, editKey: 'career_goals', editValue: sections.career_goals || [] },
      { label: t('section.work'), value: firstJob ? { company: firstJob.company, role: firstJob.role } : null, editKey: 'experience', editValue: sections.experience || [] },
      { label: t('section.preferences'), value: sections.job_preferences, editKey: 'job_preferences', editValue: sections.job_preferences || {} },
    ];
  }

  async function renderProfile() {
    const profile = await api('/api/profile/full');
    const snapshot = profile.value || {};
    const sections = snapshot.sections || {};
    outlet.innerHTML = '';
    outlet.append(el('div', { class: 'page-head' },
      el('h1', {}, t('profile.title')),
      el('div', { class: 'row' },
        el('span', { class: `pill ${snapshot.approved ? 'ok' : 'warn'}` },
          snapshot.approved ? t('profile.approved') : t('profile.unapproved')),
        snapshot.active_version ? el('span', { class: 'pill' }, t('profile.version', { n: snapshot.active_version })) : null)));

    // Upload + approve + undo row
    const fileInput = el('input', { type: 'file', accept: '.pdf,.docx,.txt', hidden: '' });
    fileInput.onchange = async () => {
      const file = fileInput.files[0];
      if (!file) return;
      const buffer = await file.arrayBuffer();
      let binary = '';
      const bytes = new Uint8Array(buffer);
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      const result = await api('/api/settings/resume-upload', {
        method: 'POST',
        body: { confirmed_local_copy: true, file_name: file.name, content_base64: btoa(binary) },
      });
      if (result.ok) { toast(t('settings.saved')); render(); } else apiError(result);
      fileInput.value = '';
    };
    const uploadButton = el('button', { class: 'btn' }, t('profile.upload'));
    uploadButton.onclick = () => fileInput.click();
    const approveButton = el('button', { class: 'btn primary', disabled: snapshot.approved ? '' : null }, t('profile.approve'));
    approveButton.onclick = async () => {
      // One confirmation covers the online profile AND its source resume
      // version — the user should never juggle two approvals.
      const result = await api('/api/application-profile', { method: 'PUT', body: { patch: {}, approve: true, confirmed: true } });
      if (!result.ok) { apiError(result); return; }
      await ensureResumeVersionApproved();
      toast(t('profile.approved'));
      render();
    };
    const undoButton = el('button', { class: 'btn', disabled: snapshot.can_undo ? null : '' }, t('profile.undo'));
    undoButton.onclick = async () => {
      const result = await api('/api/profile/undo', { method: 'POST', body: {} });
      if (result.ok) render(); else apiError(result);
    };
    outlet.append(el('div', { class: 'card' },
      el('div', { class: 'row' }, uploadButton, approveButton, undoButton, fileInput),
      el('p', { class: 'tiny', style: 'margin:8px 0 0' }, t('profile.upload.hint'))));

    // Sections
    const grid = el('div', { class: 'profile-grid', style: 'margin-top:12px' });
    for (const section of displaySections(sections)) {
      grid.append(profileSectionCard(section));
    }
    outlet.append(grid);

    // Answers
    outlet.append(el('h3', { style: 'margin:22px 0 10px' }, t('profile.answers')));
    outlet.append(await answersBlock());

    // Data & privacy
    outlet.append(el('h3', { style: 'margin:22px 0 10px' }, t('profile.danger')));
    const clearButton = el('button', { class: 'btn danger' }, t('profile.clear_materials'));
    clearButton.onclick = async () => {
      // Plain confirm — no typed phrase. The backend still receives the fixed
      // confirmation_text; the USER just clicks [取消] / [确认清除].
      const confirmed = await confirmModal({
        title: t('profile.clear_materials'), body: t('profile.clear_materials.body'), danger: true,
        bullets: [t('profile.clear.b1'), t('profile.clear.b2'), t('profile.clear.b3')],
        confirmLabel: t('profile.clear.confirm'),
      });
      if (!confirmed) return;
      // The confirmation_text must equal the server's CLEAR_JOB_MATERIALS_
      // CONFIRMATION_TEXT constant exactly — tests/quick_ui.test.mjs pins it.
      const result = await api('/api/data/clear-job-materials', {
        method: 'POST', body: { confirmed: true, confirmation_text: 'CLEAR JOB MATERIALS' },
      });
      if (result.ok) { toast(t('settings.saved')); render(); } else apiError(result);
    };
    const resetButton = el('button', { class: 'btn danger' }, t('profile.reset_all'));
    resetButton.onclick = async () => {
      const confirmed = await confirmModal({
        title: t('profile.reset_all'), body: t('profile.reset_all.body'), danger: true,
        bullets: [t('profile.reset.b1'), t('profile.reset.b2'), t('profile.reset.b3')],
        confirmLabel: t('profile.reset.confirm'),
      });
      if (!confirmed) return;
      // Must equal the server's RESET_CONFIRMATION_TEXT constant exactly —
      // tests/quick_ui.test.mjs pins it.
      const result = await api('/api/settings/reset-local-data', {
        method: 'POST', body: { confirmed: true, confirmation_text: 'RESET LOCAL DATA' },
      });
      if (result.ok) { toast(t('settings.saved')); render(); } else apiError(result);
    };
    outlet.append(el('div', { class: 'card row' }, clearButton, resetButton));
  }

  function profileSectionCard(section) {
    const card = el('div', { class: 'card' });
    const editButton = el('button', { class: 'btn small', style: 'margin-left:auto' }, t('profile.edit'));
    card.append(el('div', { class: 'row', style: 'margin-bottom:8px' }, el('h3', { style: 'margin:0' }, section.label), editButton));
    card.append(renderSectionValue(section.value));
    editButton.onclick = () => openSectionEditor(section.editKey, section.label, section.editValue);
    return card;
  }

  function renderSectionValue(value) {
    if (value == null || (Array.isArray(value) && !value.length)
      || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length)) {
      return el('p', { class: 'small muted', style: 'margin:0' }, '—');
    }
    if (Array.isArray(value)) {
      return el('ul', { class: 'list-plain' }, value.slice(0, 6).map(item =>
        el('li', {}, typeof item === 'string' ? item : summarizeObject(item))));
    }
    if (typeof value === 'object') {
      const flat = Object.entries(value).filter(([itemKey, itemValue]) =>
        itemValue != null && itemValue !== '' && itemKey !== 'id' && !itemKey.endsWith('_id') && itemKey !== 'field_provenance');
      if (flat.every(([, itemValue]) => Array.isArray(itemValue))) {
        return el('div', { class: 'chips' }, flat.flatMap(([, list]) => list.slice(0, 12)).map(chipValue =>
          el('span', { class: 'chip' }, String(chipValue))));
      }
      const kv = el('dl', { class: 'kv' });
      for (const [itemKey, itemValue] of flat.slice(0, 8)) {
        kv.append(el('dt', {}, itemKey.replaceAll('_', ' ')), el('dd', {}, summarizeObject(itemValue)));
      }
      return kv;
    }
    return el('p', { class: 'small', style: 'margin:0' }, String(value));
  }
  function summarizeObject(value) {
    if (value == null) return '—';
    if (typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return value.map(summarizeObject).join('、');
    // Named human fields first. Never fall back to raw values (that leaked
    // internal ids like "experience_xxx"): use real content fields instead.
    const named = [value.full_name, value.role, value.title, value.name, value.company, value.institution, value.degree, value.email, value.phone, value.city, value.dates]
      .filter(Boolean).join(' · ');
    if (named) return named;
    const content = [
      Array.isArray(value.responsibilities) ? value.responsibilities[0] : '',
      value.description,
      Array.isArray(value.results) ? value.results[0] : '',
      value.field_of_study,
    ].filter(Boolean)[0];
    return content ? String(content).slice(0, 80) : '—';
  }

  // The uploaded resume version follows the online profile's confirmation, so
  // the user never juggles two approvals.
  async function ensureResumeVersionApproved() {
    const settings = await api('/api/settings');
    const resumes = settings.value?.resume_profiles;
    const active = (resumes?.items || []).find(item =>
      item.resume_id === resumes?.active_resume_id || item.id === resumes?.active_resume_profile_id);
    if (active && !active.approved_at && active.content_hash) {
      await api(`/api/settings/resume-profiles/${encodeURIComponent(active.resume_id)}/approve`, {
        method: 'POST', body: { confirmed: true, content_hash: active.content_hash },
      });
    }
  }

  // --- Structured, JSON-free profile editors --------------------------------
  // Small field builders shared by the per-section forms. Raw JSON is confined
  // to the Advanced expander at the bottom of each editor.
  function fieldRow(labelText, node) {
    return el('div', { class: 'field' }, el('label', {}, labelText), node);
  }
  function textInput(value, placeholder = '') {
    return el('input', { value: value ?? '', placeholder });
  }
  function linesToArray(value) {
    return String(value || '').split('\n').map(s => s.trim()).filter(Boolean);
  }
  function commaToArray(value) {
    return String(value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  }
  function multiline(value, placeholder = '') {
    const ta = el('textarea', { placeholder, style: 'min-height:80px' });
    ta.value = Array.isArray(value) ? value.join('\n') : String(value || '');
    return ta;
  }

  // A repeatable list-of-entries editor (experience / projects / education).
  // `fields` describes each entry's inputs; add/delete/reorder are built in.
  function listEditor(body, key, label, entries, spec) {
    const list = Array.isArray(entries) ? entries.map(e => ({ ...e })) : [];
    const container = el('div', { class: 'stack' });
    function repaint() {
      container.innerHTML = '';
      if (!list.length) container.append(el('p', { class: 'muted small' }, t('profile.list.empty')));
      list.forEach((entry, index) => {
        const card = el('div', { class: 'card', style: 'position:relative' });
        const controls = el('div', { class: 'row', style: 'gap:6px;margin-bottom:8px' },
          el('strong', { class: 'grow small' }, `${label} ${index + 1}`),
          el('button', { class: 'btn small', disabled: index === 0 ? '' : null, onclick: () => { [list[index - 1], list[index]] = [list[index], list[index - 1]]; repaint(); } }, '↑'),
          el('button', { class: 'btn small', disabled: index === list.length - 1 ? '' : null, onclick: () => { [list[index + 1], list[index]] = [list[index], list[index + 1]]; repaint(); } }, '↓'),
          el('button', { class: 'btn small danger', onclick: () => { list.splice(index, 1); repaint(); } }, t('profile.list.delete')));
        card.append(controls);
        for (const f of spec.fields) {
          const node = f.build(entry);
          entry[`__node_${f.key}`] = node;
          card.append(fieldRow(f.label, node));
        }
        container.append(card);
      });
    }
    repaint();
    const addBtn = el('button', { class: 'btn', style: 'margin-top:8px' }, t('profile.list.add', { label }));
    addBtn.onclick = () => { list.push(spec.blank()); repaint(); };
    const save = el('button', { class: 'btn primary block', style: 'margin-top:12px' }, t('profile.save'));
    save.onclick = async () => {
      const payload = list.map(entry => spec.collect(entry));
      await saveProfilePatch(key, payload, save);
    };
    body.append(container, addBtn, save);
  }

  async function saveProfilePatch(key, value, button) {
    if (button) button.disabled = true;
    const result = await api('/api/application-profile', {
      method: 'PUT', body: { patch: { [key]: value }, approve: true, confirmed: true },
    });
    if (button) button.disabled = false;
    if (result.ok) { await ensureResumeVersionApproved(); toast(t('settings.saved')); drawer.close(); render(); }
    else apiError(result);
  }

  function openSectionEditor(key, label, value) {
    drawer.open(`${t('profile.edit')} · ${label}`, body => {
      if (key === 'experience') return editExperience(body, value);
      if (key === 'projects') return editProjects(body, value);
      if (key === 'education') return editEducation(body, value);
      if (key === 'skills') return editSkills(body, value);
      if (key === 'identity') return editIdentity(body, value);
      if (key === 'career_goals') return editCareerGoals(body, value);
      if (key === 'job_preferences') return editPreferences(body, value);
      // No structured editor for this section: raw editing lives in /advanced
      // only — the normal product never shows JSON.
      body.append(
        el('p', { class: 'small muted' }, t('profile.adv.hint')),
        el('a', { class: 'btn small', href: '/advanced', target: '_blank', rel: 'noopener' }, t('nav.advanced')));
    });
  }

  function editExperience(body, value) {
    listEditor(body, 'experience', t('exp.one'), value, {
      blank: () => ({ company: '', role: '', location: '', start_date: '', end_date: '', responsibilities: [], achievements: [], technologies: [] }),
      fields: [
        { key: 'company', label: t('exp.company'), build: e => textInput(e.company) },
        { key: 'role', label: t('exp.role'), build: e => textInput(e.role) },
        { key: 'location', label: t('exp.location'), build: e => textInput(e.location) },
        { key: 'start_date', label: t('exp.start'), build: e => textInput(e.start_date, '2024-06') },
        { key: 'end_date', label: t('exp.end'), build: e => textInput(e.end_date, '2024-08') },
        { key: 'current', label: t('exp.current'), build: e => { const c = el('input', { type: 'checkbox' }); if (/至今|present|现在/i.test(e.end_date || '')) c.checked = true; return c; } },
        { key: 'responsibilities', label: t('exp.duties'), build: e => multiline(e.responsibilities, t('exp.duties.ph')) },
        { key: 'achievements', label: t('exp.achievements'), build: e => multiline(e.achievements, t('exp.achievements.ph')) },
        { key: 'technologies', label: t('exp.tech'), build: e => textInput((e.technologies || []).join(', '), 'Java, Python') },
      ],
      collect: e => {
        const current = e.__node_current?.checked;
        return {
          ...stripNodes(e), // original fields (id etc.) first, inputs override
          company: e.__node_company.value.trim(), role: e.__node_role.value.trim(),
          location: e.__node_location.value.trim(),
          start_date: e.__node_start_date.value.trim(),
          end_date: current ? '至今' : e.__node_end_date.value.trim(),
          responsibilities: linesToArray(e.__node_responsibilities.value),
          achievements: linesToArray(e.__node_achievements.value),
          technologies: commaToArray(e.__node_technologies.value),
        };
      },
    });
  }

  function editProjects(body, value) {
    listEditor(body, 'projects', t('proj.one'), value, {
      blank: () => ({ name: '', role: '', dates: '', description: '', technologies: [], results: [], url: '' }),
      fields: [
        { key: 'name', label: t('proj.name'), build: e => textInput(e.name) },
        { key: 'role', label: t('proj.role'), build: e => textInput(e.role) },
        { key: 'dates', label: t('proj.dates'), build: e => textInput(e.dates, '2026-04 - 至今') },
        { key: 'description', label: t('proj.desc'), build: e => multiline(e.description) },
        { key: 'technologies', label: t('proj.tech'), build: e => textInput((e.technologies || []).join(', '), 'Python, Node.js') },
        { key: 'results', label: t('proj.results'), build: e => multiline(e.results) },
        { key: 'url', label: t('proj.url'), build: e => textInput(e.url) },
      ],
      collect: e => ({
        ...stripNodes(e),
        name: e.__node_name.value.trim(), role: e.__node_role.value.trim(), dates: e.__node_dates.value.trim(),
        description: e.__node_description.value.trim(), technologies: commaToArray(e.__node_technologies.value),
        results: linesToArray(e.__node_results.value), url: e.__node_url.value.trim(),
      }),
    });
  }

  function editEducation(body, value) {
    listEditor(body, 'education', t('edu.one'), value, {
      blank: () => ({ institution: '', degree: '', field_of_study: '', start_date: '', end_date: '', location: '' }),
      fields: [
        { key: 'institution', label: t('edu.school'), build: e => textInput(e.institution) },
        { key: 'degree', label: t('edu.degree'), build: e => textInput(e.degree, '本科 / Bachelor') },
        { key: 'field_of_study', label: t('edu.field'), build: e => textInput(e.field_of_study) },
        { key: 'start_date', label: t('exp.start'), build: e => textInput(e.start_date) },
        { key: 'end_date', label: t('exp.end'), build: e => textInput(e.end_date) },
        { key: 'location', label: t('exp.location'), build: e => textInput(e.location) },
      ],
      collect: e => ({
        ...stripNodes(e),
        institution: e.__node_institution.value.trim(), degree: e.__node_degree.value.trim(),
        field_of_study: e.__node_field_of_study.value.trim(), start_date: e.__node_start_date.value.trim(),
        end_date: e.__node_end_date.value.trim(), location: e.__node_location.value.trim(),
      }),
    });
  }

  function stripNodes(entry) {
    const clean = {};
    for (const [k, v] of Object.entries(entry)) if (!k.startsWith('__node_')) clean[k] = v;
    return clean;
  }

  function editSkills(body, value) {
    const cats = ['programming', 'ai_tools', 'frameworks', 'cloud', 'data', 'business'];
    const model = { ...(value || {}) };
    const inputs = {};
    const container = el('div', { class: 'stack' });
    for (const cat of cats) {
      const input = textInput((model[cat] || []).join(', '), t('skills.ph'));
      inputs[cat] = input;
      container.append(fieldRow(t(`skills.${cat}`), input));
    }
    const save = el('button', { class: 'btn primary block', style: 'margin-top:12px' }, t('profile.save'));
    save.onclick = async () => {
      const payload = {};
      for (const cat of cats) payload[cat] = commaToArray(inputs[cat].value);
      await saveProfilePatch('skills', payload, save);
    };
    body.append(el('p', { class: 'small muted' }, t('skills.hint')), container, save);
  }

  function editIdentity(body, value) {
    const v = { ...(value || {}) };
    const links = { ...(v.links || {}) };
    const fields = {
      full_name: textInput(v.full_name, ''), email: textInput(v.email, ''), phone: textInput(v.phone, ''),
      city: textInput(v.city, ''), country: textInput(v.country, ''),
    };
    const linkRows = [
      ['linkedin', textInput(links.linkedin, 'https://linkedin.com/in/…')],
      ['github', textInput(links.github, 'https://github.com/…')],
      ['website', textInput(links.website || links.portfolio, 'https://…')],
    ];
    const save = el('button', { class: 'btn primary block', style: 'margin-top:12px' }, t('profile.save'));
    save.onclick = async () => {
      const payload = {
        ...v,
        full_name: fields.full_name.value.trim(), email: fields.email.value.trim(), phone: fields.phone.value.trim(),
        city: fields.city.value.trim(), country: fields.country.value.trim(),
        links: { ...links, linkedin: linkRows[0][1].value.trim(), github: linkRows[1][1].value.trim(), website: linkRows[2][1].value.trim() },
      };
      await saveProfilePatch('identity', payload, save);
    };
    body.append(
      fieldRow(t('id.name'), fields.full_name), fieldRow(t('id.email'), fields.email), fieldRow(t('id.phone'), fields.phone),
      fieldRow(t('id.city'), fields.city), fieldRow(t('id.country'), fields.country),
      el('h4', { style: 'margin:12px 0 4px' }, t('id.links')),
      ...linkRows.map(([label, node]) => fieldRow(label, node)),
      save);
  }

  function editCareerGoals(body, value) {
    const goals = Array.isArray(value) ? value : [];
    const goalsInput = multiline(goals, t('goals.ph'));
    const save = el('button', { class: 'btn primary block', style: 'margin-top:12px' }, t('profile.save'));
    save.onclick = async () => {
      await saveProfilePatch('career_goals', linesToArray(goalsInput.value), save);
    };
    body.append(
      el('p', { class: 'small muted' }, t('goals.hint')),
      fieldRow(t('section.goals'), goalsInput),
      save);
  }

  function editPreferences(body, value) {
    const v = { ...(value || {}) };
    const cities = textInput((v.cities || []).join(', '), '上海, 深圳');
    const countries = textInput((v.countries || []).join(', '), '中国, 美国');
    const remote = el('select', {}, ['', 'remote', 'hybrid', 'onsite'].map(m => el('option', { value: m }, m || t('pref.any'))));
    remote.value = v.remote || '';
    const salary = textInput(v.salary, '');
    const industries = textInput((v.industries || []).join(', '), '');
    const sponsorship = textInput(v.sponsorship, '');
    // These feed the sensitive-question answers (asked or reused per your
    // settings) — they are ordinary profile facts here, filled by you.
    const workAuth = textInput(v.work_authorization, t('pref.work_auth.ph'));
    const relocation = textInput(v.relocation_ok, t('pref.relocation.ph'));
    const startDate = textInput(v.earliest_start_date, '2026-09');
    const notice = textInput(v.notice_period, t('pref.notice.ph'));
    const save = el('button', { class: 'btn primary block', style: 'margin-top:12px' }, t('profile.save'));
    save.onclick = async () => {
      await saveProfilePatch('job_preferences', {
        ...v, cities: commaToArray(cities.value), countries: commaToArray(countries.value),
        remote: remote.value, salary: salary.value.trim(), industries: commaToArray(industries.value),
        sponsorship: sponsorship.value.trim(),
        work_authorization: workAuth.value.trim(),
        relocation_ok: relocation.value.trim(),
        earliest_start_date: startDate.value.trim(),
        notice_period: notice.value.trim(),
      }, save);
    };
    body.append(
      fieldRow(t('pref.cities'), cities), fieldRow(t('pref.countries'), countries), fieldRow(t('pref.remote'), remote),
      fieldRow(t('pref.salary'), salary), fieldRow(t('pref.industries'), industries), fieldRow(t('pref.sponsorship'), sponsorship),
      fieldRow(t('pref.work_auth'), workAuth), fieldRow(t('pref.relocation'), relocation),
      fieldRow(t('pref.start_date'), startDate), fieldRow(t('pref.notice'), notice),
      save);
  }

  async function answersBlock() {
    const answers = await api('/api/answers');
    const items = Array.isArray(answers.value?.answers) ? answers.value.answers : [];
    const wrap = el('div', { class: 'stack' });
    const addButton = el('button', { class: 'btn small' }, t('answers.add'));
    addButton.onclick = () => {
      drawer.open(t('answers.add'), body => {
        const questionInput = el('input', { placeholder: t('answers.q') });
        const answerInput = el('textarea', {});
        const save = el('button', { class: 'btn primary block', style: 'margin-top:10px' }, t('profile.save'));
        save.onclick = async () => {
          if (!questionInput.value.trim() || !answerInput.value.trim()) return;
          save.disabled = true;
          const result = await api('/api/answers', {
            method: 'POST',
            body: {
              original_question: questionInput.value.trim(), answer: answerInput.value.trim(),
              source: 'user_confirmed', user_confirmed: true,
              sensitive_category: 'none', risk_level: 'normal',
            },
          });
          save.disabled = false;
          if (result.ok) { drawer.close(); render(); } else apiError(result);
        };
        body.append(
          el('div', { class: 'field' }, el('label', {}, t('answers.q')), questionInput),
          el('div', { class: 'field' }, el('label', {}, t('answers.a')), answerInput),
          save);
      });
    };
    wrap.append(el('div', { class: 'row' }, addButton));
    if (!items.length) wrap.append(el('p', { class: 'muted small' }, t('profile.answers.empty')));
    for (const item of items.slice(0, 30)) {
      const variantCount = (item.question_variants || []).length;
      const sites = (item.source_sites || []).slice(0, 3).join('、');
      const reuseSelect = el('select', { class: 'small', style: 'max-width:110px' },
        el('option', { value: 'auto' }, t('answers.reuse.auto')),
        el('option', { value: 'ask' }, t('answers.reuse.ask')),
        el('option', { value: 'never' }, t('answers.reuse.never')));
      reuseSelect.value = ['auto', 'ask', 'never'].includes(item.reuse_policy) ? item.reuse_policy : 'auto';
      reuseSelect.onchange = async () => {
        const result = await api(`/api/answers/${encodeURIComponent(item.question_id)}`, {
          method: 'PUT', body: { ...item, reuse_policy: reuseSelect.value, user_confirmed: true },
        });
        if (result.ok) toast(t('settings.saved')); else apiError(result);
      };
      const row = el('div', { class: 'card row' },
        el('div', { class: 'grow' },
          el('div', { class: 'small', style: 'font-weight:650' }, item.original_question || item.canonical_key || ''),
          el('div', { class: 'small muted' }, item.answer || ''),
          (variantCount > 1 || sites)
            ? el('div', { class: 'tiny muted' },
                variantCount > 1 ? t('answers.variants', { n: variantCount }) : '',
                variantCount > 1 && sites ? ' · ' : '',
                sites ? t('answers.sites', { s: sites }) : '')
            : null),
        reuseSelect,
        el('button', {
          class: 'btn small', onclick: () => {
            drawer.open(t('answers.edit'), body => {
              const input = el('textarea', {}, '');
              input.value = item.answer || '';
              const save = el('button', { class: 'btn primary block', style: 'margin-top:10px' }, t('profile.save'));
              save.onclick = async () => {
                const result = await api(`/api/answers/${encodeURIComponent(item.question_id)}`, {
                  method: 'PUT', body: { ...item, answer: input.value, user_confirmed: true },
                });
                if (result.ok) { drawer.close(); render(); } else apiError(result);
              };
              body.append(el('p', { class: 'small muted' }, item.original_question || ''), input, save);
            });
          }
        }, t('answers.edit')),
        el('button', {
          class: 'btn small danger', onclick: async () => {
            const confirmed = await confirmModal({ title: t('answers.delete'), body: item.original_question || '', danger: true });
            if (!confirmed) return;
            const result = await api(`/api/answers/${encodeURIComponent(item.question_id)}`, { method: 'DELETE' });
            if (result.ok) render(); else apiError(result);
          }
        }, t('answers.delete')));
      wrap.append(row);
    }
    return wrap;
  }

  // ==========================================================================
  // Settings
  // ==========================================================================
  async function renderSettings() {
    const [settings, ai, assistant] = await Promise.all([
      api('/api/settings'), api('/api/ai/status'), api('/api/extension/diagnostics'),
    ]);
    const preferences = settings.value?.search_preferences || {};
    const safety = preferences.safety || {};
    outlet.innerHTML = '';
    outlet.append(el('div', { class: 'page-head' }, el('h1', {}, t('settings.title'))));

    // Language
    const langSelect = el('select', {},
      el('option', { value: 'zh' }, t('settings.language.zh')),
      el('option', { value: 'en' }, t('settings.language.en')));
    langSelect.value = window.QuickI18n.language;
    langSelect.onchange = () => { setLanguage(langSelect.value); syncLangToggle(); render(); };
    outlet.append(el('div', { class: 'card' }, el('h3', {}, t('settings.language')), langSelect));

    // AI provider
    const aiCard = el('div', { class: 'card', style: 'margin-top:12px' }, el('h3', {}, t('settings.ai')));
    const status = ai.value || {};
    aiCard.append(el('div', { class: 'row', style: 'margin-bottom:10px' },
      el('span', { class: `pill ${status.ready ? 'ok' : ''}` },
        status.ready ? `${t('home.ai.ready')} · ${status.provider_type || ''} ${status.model || ''}` : t('home.ai.off'))));

    // Option values are the SERVER's canonical provider types (ai_provider.mjs
    // PROVIDER_TYPES) — anything else is silently unsavable. LM Studio and
    // Ollama are both local_openai_compatible; Gemini rides openai_compatible.
    const PROVIDER_DEFAULT_ENDPOINTS = {
      local_openai_compatible: 'http://127.0.0.1:1234/v1',
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com/v1',
      openai_compatible: '',
    };
    const providerSelect = el('select', {},
      ['local_openai_compatible', 'openai', 'anthropic', 'openai_compatible']
        .map(name => el('option', { value: name }, t(`settings.ai.type.${name}`))));
    const endpointInput = el('input', { placeholder: 'http://127.0.0.1:1234/v1' });
    const modelInput = el('input', { placeholder: 'model' });
    const keyInput = el('input', { type: 'password', placeholder: '••••' });
    const enabledInput = el('input', { type: 'checkbox' });
    providerSelect.value = Object.hasOwn(PROVIDER_DEFAULT_ENDPOINTS, status.provider_type)
      ? status.provider_type
      : 'local_openai_compatible';
    providerSelect.onchange = () => {
      endpointInput.placeholder = PROVIDER_DEFAULT_ENDPOINTS[providerSelect.value] || 'https://…/v1';
      if (!endpointInput.value.trim()) endpointInput.value = PROVIDER_DEFAULT_ENDPOINTS[providerSelect.value] || '';
    };
    endpointInput.value = status.endpoint || '';
    modelInput.value = status.model || '';
    enabledInput.checked = status.enabled === true;

    const detect = el('button', { class: 'btn small' }, t('settings.ai.detect'));
    const detectOut = el('div', { class: 'small muted' });
    detect.onclick = async () => {
      detect.disabled = true;
      const found = await api('/api/ai/detect-local');
      detect.disabled = false;
      const detected = Array.isArray(found.value?.detected) ? found.value.detected : [];
      if (!detected.length) { detectOut.textContent = t('home.ai.off'); return; }
      const first = detected[0];
      providerSelect.value = first.type || 'local_openai_compatible';
      endpointInput.value = first.base_url || '';
      if (first.models?.length) modelInput.value = first.models[0];
      enabledInput.checked = true;
      detectOut.textContent = `${first.label || first.type || ''} · ${endpointInput.value} · ${(first.models || []).slice(0, 3).join(', ')}`;
    };

    const testButton = el('button', { class: 'btn small' }, t('settings.ai.test'));
    const testOut = el('span', { class: 'small muted' });
    testButton.onclick = async () => {
      testButton.disabled = true;
      testOut.textContent = '…';
      const result = await api('/api/settings/ai-provider/test', { method: 'POST', body: {} });
      testOut.textContent = result.ok && (result.value?.reachable === true || result.value?.status === 'ok')
        ? '✓' : (result.value?.message || '✗');
      testButton.disabled = false;
    };
    const saveAi = el('button', { class: 'btn primary small' }, t('settings.ai.save'));
    saveAi.onclick = async () => {
      saveAi.disabled = true;
      // Field names must match normalizeAIProviderSettings exactly (type /
      // base_url) — the previous provider_type/endpoint names were silently
      // dropped, so the endpoint and provider choice never saved.
      const body = {
        enabled: enabledInput.checked,
        type: providerSelect.value,
        base_url: endpointInput.value.trim(),
        model: modelInput.value.trim(),
      };
      if (keyInput.value.trim()) body.api_key = keyInput.value.trim();
      const result = await api('/api/settings/ai-provider', { method: 'POST', body });
      saveAi.disabled = false;
      if (result.ok) { toast(t('settings.saved')); keyInput.value = ''; render(); }
      else apiError(result);
    };

    aiCard.append(
      el('div', { class: 'row', style: 'margin-bottom:10px' }, detect, detectOut),
      el('div', { class: 'field' }, el('label', {}, t('settings.ai.enabled')), enabledInput),
      el('div', { class: 'field' }, el('label', {}, t('settings.ai.provider')), providerSelect),
      el('div', { class: 'field' }, el('label', {}, t('settings.ai.endpoint')), endpointInput),
      el('div', { class: 'field' }, el('label', {}, t('settings.ai.model')), modelInput),
      el('div', { class: 'field' }, el('label', {}, t('settings.ai.key')), keyInput,
        el('span', { class: 'tiny' }, t('settings.ai.key.hint'))),
      el('div', { class: 'row' }, saveAi, testButton, testOut));
    outlet.append(aiCard);

    // Browser & filling (resume upload policy)
    const policySelect = el('select', {},
      el('option', { value: 'auto' }, t('settings.upload.auto')),
      el('option', { value: 'never' }, t('settings.upload.never')));
    policySelect.value = safety.resume_upload_policy || 'auto';
    const formatSelect = el('select', {},
      el('option', { value: 'auto' }, t('settings.format.auto')),
      el('option', { value: 'pdf' }, t('settings.format.pdf')),
      el('option', { value: 'docx' }, t('settings.format.docx')));
    formatSelect.value = safety.resume_format_preference || 'auto';
    const savePrefs = el('button', { class: 'btn primary small' }, t('settings.ai.save'));
    savePrefs.onclick = async () => {
      savePrefs.disabled = true;
      const result = await api('/api/settings/search-preferences', {
        method: 'POST',
        body: {
          ...preferences,
          safety: { ...safety, resume_upload_policy: policySelect.value, resume_format_preference: formatSelect.value },
        },
      });
      savePrefs.disabled = false;
      if (result.ok) toast(t('settings.saved')); else apiError(result);
    };
    outlet.append(el('div', { class: 'card', style: 'margin-top:12px' },
      el('h3', {}, t('settings.browser')),
      el('div', { class: 'field' }, el('label', {}, t('settings.upload.policy')), policySelect),
      el('div', { class: 'field' }, el('label', {}, t('settings.upload.format')), formatSelect),
      el('div', { class: 'row' }, savePrefs)));

    // Sensitive-question policy: per category — ask every time (default),
    // reuse a confirmed answer, or fully manual. CAPTCHA/login/submit are
    // hard-off regardless and have no setting on purpose.
    const SENSITIVE_CATEGORIES = ['work_authorization', 'sponsorship', 'eeo_demographics', 'salary', 'relocation', 'start_date', 'background_check', 'other_sensitive'];
    const policies = { ...(safety.sensitive_policies || {}) };
    const policyCard = el('div', { class: 'card', style: 'margin-top:12px' },
      el('h3', {}, t('settings.sensitive')),
      el('p', { class: 'small muted', style: 'margin:0 0 10px' }, t('settings.sensitive.hint')));
    const policySelects = {};
    for (const category of SENSITIVE_CATEGORIES) {
      const select = el('select', {},
        el('option', { value: 'ask' }, t('settings.sensitive.ask')),
        el('option', { value: 'reuse' }, t('settings.sensitive.reuse')),
        el('option', { value: 'manual' }, t('settings.sensitive.manual')));
      select.value = ['ask', 'reuse', 'manual'].includes(policies[category])
        ? policies[category]
        : (category === 'eeo_demographics' ? 'manual' : 'ask');
      policySelects[category] = select;
      policyCard.append(el('div', { class: 'field' },
        el('label', {}, t(`settings.sensitive.${category}`)), select));
    }
    const savePolicies = el('button', { class: 'btn primary small' }, t('settings.ai.save'));
    savePolicies.onclick = async () => {
      savePolicies.disabled = true;
      const nextPolicies = {};
      for (const category of SENSITIVE_CATEGORIES) nextPolicies[category] = policySelects[category].value;
      const result = await api('/api/settings/search-preferences', {
        method: 'POST',
        body: { ...preferences, safety: { ...safety, sensitive_policies: nextPolicies } },
      });
      savePolicies.disabled = false;
      if (result.ok) toast(t('settings.saved')); else apiError(result);
    };
    policyCard.append(el('div', { class: 'row' }, savePolicies));
    outlet.append(policyCard);

    // Application Assistant (browser extension) health
    const assistantInfo = assistant.value || {};
    const assistantStale = assistantInfo.extension_version_stale === true;
    outlet.append(el('div', { class: 'card', style: 'margin-top:12px' },
      el('h3', {}, t('settings.assistant')),
      el('div', { class: 'row' },
        el('span', { class: `pill ${assistantStale ? 'warn' : assistantInfo.extension_connected ? 'ok' : ''}` },
          assistantStale
            ? t('settings.assistant.stale')
            : assistantInfo.extension_connected
              ? t('settings.assistant.connected')
              : assistantInfo.extension_installed
                ? t('settings.assistant.idle')
                : t('settings.assistant.none'))),
      assistantStale
        ? el('p', { class: 'small', style: 'margin:8px 0 0;color:var(--warn, #b45309)' }, t('settings.assistant.stale.hint'))
        : el('p', { class: 'small muted', style: 'margin:8px 0 0' }, t('settings.assistant.hint'))));

    // Submit
    outlet.append(el('div', { class: 'card', style: 'margin-top:12px' },
      el('h3', {}, t('settings.submit')),
      el('p', { class: 'small muted', style: 'margin:0' }, t('settings.submit.manual'))));

    // Data & privacy pointer
    outlet.append(el('div', { class: 'card', style: 'margin-top:12px' },
      el('h3', {}, t('settings.data')),
      el('p', { class: 'small muted', style: 'margin:0 0 8px' }, t('settings.data.hint')),
      el('a', { class: 'btn small', href: '#/profile' }, t('nav.profile'))));
  }

  // ==========================================================================
  // Career tools (secondary entry)
  // ==========================================================================
  async function renderTools() {
    outlet.innerHTML = '';
    outlet.append(
      el('div', { class: 'page-head' }, el('h1', {}, t('tools.title'))),
      el('p', { class: 'muted' }, t('tools.hint')),
      el('div', { class: 'stack' },
        el('div', { class: 'card' }, el('h3', {}, t('tools.resume')), el('p', { class: 'small muted', style: 'margin:0' }, t('tools.resume.hint'))),
        el('div', { class: 'card' }, el('h3', {}, t('tools.letter')), el('p', { class: 'small muted', style: 'margin:0' }, t('tools.letter.hint'))),
        el('div', { class: 'card' },
          el('p', { class: 'small muted', style: 'margin:0 0 8px' }, t('tools.advanced')),
          el('a', { class: 'btn small', href: '/advanced', target: '_blank', rel: 'noopener' }, t('nav.advanced')))));
  }

  // ==========================================================================
  // Legacy-injection quarantine
  // ==========================================================================
  // Older builds of the browser extension injected a floating "AI Fill
  // Assistant" panel (Fill known fields / Review issues / Learn questions)
  // into every localhost page. The current extension refuses to touch the
  // app's own pages, but a stale unpacked copy the browser still has loaded
  // ignores that guard. The Quick UI owns its entire DOM: any element that
  // appears as a direct child of <html> or <body> and is not one of the
  // app's own top-level nodes is removed on sight, permanently.
  (function quarantineLegacyInjections() {
    const ownIds = new Set(['drawer', 'drawerBackdrop', 'modalBackdrop', 'toastRegion']);
    const isOwn = node => {
      if (node.nodeType !== Node.ELEMENT_NODE) return true;
      if (['SCRIPT', 'LINK', 'META', 'TITLE', 'HEAD', 'BODY'].includes(node.tagName)) return true;
      if (ownIds.has(node.id)) return true;
      return node.classList.contains('app') || node.classList.contains('toast-region');
    };
    const sweep = () => {
      const strays = [
        ...[...document.documentElement.children].filter(n => n !== document.head && n !== document.body),
        ...document.body.children,
      ].filter(n => !isOwn(n));
      for (const node of strays) node.remove();
    };
    new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: false });
    new MutationObserver(sweep).observe(document.body, { childList: true, subtree: false });
    sweep();
  })();

  // ==========================================================================
  // Live updates via SSE (refresh the visible page on backend events)
  // ==========================================================================
  try {
    const events = new EventSource('/api/events');
    let refreshTimer = null;
    events.addEventListener('dashboard-update', () => {
      clearTimeout(refreshTimer);
      // Only refresh list pages; the apply drawer polls on its own.
      refreshTimer = setTimeout(() => {
        if ($('#drawer').hidden && ['apps', 'home'].includes(currentRoute())) render();
        refreshAppsBadge();
      }, 800);
    });
  } catch { /* SSE is an enhancement; polling paths still work */ }

  render();
})();
