// Application Assistant popup — a pure view over the backend state.
//
// It stores nothing, decides nothing, and shows ONLY the product vocabulary:
// 正在连接 / 正在扫描 / 正在填写 / 发现新问题 / 需要你处理 N 项 /
// 等待登录或验证码 / 准备提交 / 已完成. Everything it renders comes from the
// service-worker bridge (handoff + apply-state); every error is a plain
// sentence with one next step, never a developer status.
const ui = {
  job: document.getElementById('jobLine'),
  box: document.getElementById('statusBox'),
  icon: document.getElementById('statusIcon'),
  word: document.getElementById('statusWord'),
  detail: document.getElementById('detail'),
  questions: document.getElementById('questions'),
  questionList: document.getElementById('questionList'),
  saveAnswers: document.getElementById('saveAnswers'),
  action: document.getElementById('primaryAction'),
};

let pollTimer = null;
let connection = null;
let activeTabId = null;
let running = false;

function runtimeMessage(message) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(message, response => {
        if (chrome.runtime.lastError) resolve({ status: 'not_connected', message: chrome.runtime.lastError.message });
        else resolve(response || { status: 'not_connected' });
      });
    } catch (error) {
      resolve({ status: 'not_connected', message: String(error?.message || error) });
    }
  });
}

function tabMessage(tabId, message) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, response => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function activeTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => resolve(tabs?.[0] || null));
  });
}

function setStatus(word, tone, detail = '') {
  ui.word.textContent = word;
  ui.box.className = `status ${tone}`;
  ui.icon.className = tone === 'busy' ? 'spinner' : `dot ${tone === 'ok' ? 'ok' : 'attention'}`;
  ui.detail.textContent = detail;
}

function setAction(label, handler) {
  if (!label) {
    ui.action.hidden = true;
    ui.action.onclick = null;
    return;
  }
  ui.action.hidden = false;
  ui.action.disabled = false;
  ui.action.textContent = label;
  ui.action.onclick = handler;
}

// Open questions the backend asks the user to answer (WS5): plain label +
// input; saved answers go through the bridge and become reusable knowledge.
function renderQuestions(items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    ui.questions.classList.remove('visible');
    ui.questionList.innerHTML = '';
    return false;
  }
  ui.questions.classList.add('visible');
  ui.questionList.innerHTML = '';
  for (const item of list.slice(0, 6)) {
    const wrap = document.createElement('div');
    wrap.className = 'question';
    const label = document.createElement('label');
    label.textContent = item.label || '';
    let input;
    if (Array.isArray(item.options) && item.options.length) {
      input = document.createElement('select');
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = '请选择…';
      input.appendChild(blank);
      for (const option of item.options.slice(0, 60)) {
        const node = document.createElement('option');
        node.value = option.value || option.label || '';
        node.textContent = option.label || option.value || '';
        input.appendChild(node);
      }
    } else {
      input = document.createElement('input');
      input.placeholder = '你的答案';
    }
    input.dataset.questionLabel = item.label || '';
    input.dataset.fieldRef = item.field_ref || item.id || '';
    wrap.append(label, input);
    ui.questionList.appendChild(wrap);
  }
  ui.saveAnswers.onclick = async () => {
    ui.saveAnswers.disabled = true;
    const answers = [...ui.questionList.querySelectorAll('input, select')]
      .map(node => ({ question: node.dataset.questionLabel, field_ref: node.dataset.fieldRef, answer: String(node.value || '').trim() }))
      .filter(entry => entry.question && entry.answer);
    if (!answers.length) { ui.saveAnswers.disabled = false; return; }
    const saved = await runtimeMessage({
      type: 'SAVE_OPEN_ANSWERS',
      job_id: connection?.job_id || '',
      answers,
    });
    ui.saveAnswers.disabled = false;
    if (saved?.status === 'ok') {
      ui.detail.textContent = '已保存。正在把答案填入页面…';
      refresh();
    } else {
      ui.detail.textContent = saved?.message || '答案暂时没能保存，请稍后重试。';
    }
  };
  return true;
}

function paintApplyState(state) {
  const word = state?.state || '';
  const things = Number(state?.things_left || 0);
  const hasNewQuestions = renderQuestions(state?.open_questions);
  setAction('');

  if (word === 'awaiting_verification') {
    setStatus('等待登录 / 验证码', 'attention', '请在页面上完成登录或验证，完成后点击下面的按钮。');
    setAction('我已完成，继续填写', async () => {
      ui.action.disabled = true;
      const owner = connection?.fill_owner || 'local_browser_agent';
      const result = owner === 'extension' && activeTabId
        ? await tabMessage(activeTabId, { type: 'CONTINUE_AFTER_VERIFICATION' })
        : await runtimeMessage({ type: 'CONTINUE_AFTER_VERIFICATION_API', job_id: connection?.job_id || '' });
      if (result && (result.status === 'ok' || result.status === 'filled' || result.status === 'needs_verification')) {
        setStatus('正在填写', 'busy', '');
      } else {
        ui.action.disabled = false;
        ui.detail.textContent = result?.message || '还没能继续，请确认页面已完成验证。';
      }
    });
    return;
  }
  if (word === 'filling' || word === 'preparing') {
    setStatus(word === 'filling' ? '正在填写' : '正在扫描', 'busy', '');
    return;
  }
  if (word === 'needs_you') {
    if (hasNewQuestions) {
      setStatus('发现新问题', 'attention', '回答后会自动填入，并为下次申请记住答案。');
    } else {
      setStatus(`需要你处理 ${things} 项`, 'attention', '打开 Resume Jobs 查看清单，或直接在页面上完成剩余项。');
    }
    return;
  }
  if (word === 'ready_to_submit') {
    setStatus('准备提交', 'ok', '请自己检查每一项，确认后由你亲自点击提交。');
    return;
  }
  if (word === 'applied') {
    setStatus('已完成', 'ok', '');
    return;
  }
  // Prepared-but-idle or anything else: the page is bound, nothing is running.
  setStatus('正在扫描', 'busy', '');
}

async function refresh() {
  if (!connection?.job_id) return;
  const state = await runtimeMessage({ type: 'GET_APPLY_STATE', job_id: connection.job_id });
  if (state?.status === 'ok') paintApplyState(state);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 1600);
}

async function initialize() {
  const tab = await activeTab();
  activeTabId = tab?.id || null;
  if (!tab?.url) {
    setStatus('正在连接', 'busy', '没有找到当前页面。');
    return;
  }
  connection = await runtimeMessage({ type: 'CONNECT_CURRENT_APPLICATION', current_url: tab.url });
  if (connection?.status === 'ok' && connection.execution_session) {
    const display = connection.execution_session.display || {};
    ui.job.textContent = [display.company, display.role].filter(Boolean).join(' · ') || '当前申请';
    await refresh();
    startPolling();
    return;
  }
  ui.job.textContent = '—';
  if (connection?.code === 'DASHBOARD_UNAVAILABLE' || /unavailable/i.test(String(connection?.message || ''))) {
    setStatus('正在连接', 'attention', 'Resume Jobs 没有运行。先打开 Resume Jobs，再回到这里。');
  } else {
    setStatus('正在连接', 'attention', '这个页面没有进行中的申请。先在 Resume Jobs 里点「用 AI 申请」。');
  }
}

window.addEventListener('unload', () => clearInterval(pollTimer));
initialize();
