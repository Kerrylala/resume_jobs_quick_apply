# Resume Jobs Application Assistant

The browser extension of Resume Jobs. It is a thin view over the local app:

- On a real application page it binds to the application you started in
  Resume Jobs and shows the live status (正在扫描 / 正在填写 / 发现新问题 /
  需要你处理 N 项 / 等待登录、验证码 / 准备提交 / 已完成).
- When the fill is owned by the extension it fills ONLY the fields the
  reviewed Package's approved safe-field mappings authorize, verifies every
  write, and reports honestly. When the Local Browser Agent owns the fill
  it observes.
- Newly discovered ordinary questions can be answered right in the popup;
  confirmed answers enter the local knowledge base and are reused on every
  site that asks the same question in any wording.

It stores no personal data in the browser, never uploads files, never logs
in, never touches verifications, and never submits — those stay yours.

## Install (load unpacked)

1. Open `chrome://extensions`, enable Developer mode.
2. "Load unpacked" → select this folder
   (`resume_jobs_quick_apply/extensions/application_assistant`).
3. Keep the Resume Jobs app running (`http://127.0.0.1:8767`).

After pulling new code, click "Reload" on the extension card.
