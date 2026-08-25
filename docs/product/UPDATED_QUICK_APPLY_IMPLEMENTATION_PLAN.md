# Quick Apply 实施计划（更新版）

日期：2026-08-17
状态：**计划。本轮未修改任何产品源码，未执行任何 Git 操作。**

配套：`UPDATED_QUICK_APPLY_PRODUCT_PLAN.md`（产品定义）、`QUICK_APPLY_UI_INFORMATION_ARCHITECTURE.md`（界面结构）。
基线：`BACKEND_TRUST_ACCEPTANCE_REPORT.md`（2026-08-15，声称 274/274 离线测试通过）。

> **基线实测（2026-08-17）：272 通过 / 2 失败。**「274/274」在今天已经复现不了。两条失败都不是产品缺陷，但都必须在 Phase 1 开始前修掉，否则后面无法判断新改动有没有引入回归。详见 §2.3。

策略不变：**在现有后端之上新建 Quick Apply 前端**，旧 Dashboard 保留为高级模式。不建第二套后端、第二套状态机、第二套数据存储。

---

## 1. 后端已经可以直接复用

以下能力已经存在、已有测试覆盖，**不要重写**。

### 1.1 Quick Apply 编排层（关键：已经建好了）

上一轮 Backend Trust 工作已经把三个编排端点做完了：

| 端点 | 实现 | 作用 |
|---|---|---|
| `POST /api/jobs/:id/quick-apply` | `handleQuickApply` `dashboard/server.mjs:4999` | 内部串 `handleDecision(approved)` → `handleBuildPackagePreview`，返回预备快照 |
| `POST /api/jobs/:id/quick-apply/start` | `handleQuickApplyStart` `dashboard/server.mjs:5041` | 保存确认答案 → 重建包 → approve-fill → start-fill |
| `GET /api/applications/:id/checklist` | `handleApplicationChecklist` `dashboard/server.mjs:5130` | 「还差 N 项」清单 |

三者都通过 `internalCall`（`dashboard/server.mjs:4936`）在进程内复用既有 handler —— **没有第二套工作流引擎，所有安全门原样生效**。

预备快照 `quickApplyPreflightSnapshot`（`dashboard/server.mjs:4967`）返回：
```
{ package_id, package_status, selected_resume, safe_answers_count,
  needs_user[], profile_ready, ready_for_start }
```

清单返回：
```
{ application_status, scan_state: 'fresh'|'missing'|'stale_<reason>',
  items[], things_left, can_mark_review_complete, can_mark_submitted }
```
清单项模板见 `dashboard/server.mjs:5120-5128`，全部由 `computeReviewBlockers`（`scripts/lib/application_state.mjs:1135`）派生 —— 与「标记审核完成」的判定共用同一计算，两者不可能不一致。

契约测试：`tests/quick_apply_api.test.mjs`（预备步骤、确认门、答案保存、清单 blocked→clean→ready 全流程）。

### 1.2 唯一就绪投影

`buildApplicationProfileView`（`scripts/lib/application_profile_view.mjs:24`）走的是和执行器**同一个** `profileValue` 解析器，所以界面不可能声称「档案就绪」而执行器看不到可用值。

服务端出口：`GET /api/application-profile`（`dashboard/server.mjs:882`）、`PUT /api/application-profile`（`:898`）。

返回：
```
{ approved, profile, readiness: {
    basic_fields: { total, filled, missing[] },
    fields[], saved_answers, safe_reusable_answers,
    ready_for_safe_fill, needs_user[] } }
```

### 1.3 其它可直接用的能力

| 能力 | 位置 | 说明 |
|---|---|---|
| 答案 CRUD | `/api/answers` GET/POST，`/api/answers/:id` GET/PUT/DELETE | `approved_for_real_applications` 现为派生值（`scripts/lib/candidate_records.mjs:418`），存储不可信任 |
| 执行器能力查询 | `GET /api/executor-capabilities`（`dashboard/server.mjs:4791`） | 推荐 `local_browser_agent`；扩展 `experimental:true, supports_rescan:false` |
| SSE 事件流 | `GET /api/events`（`dashboard/server.mjs:219`） | 带单调 `sequence`，20 秒心跳 |
| 岗位链接导入 | `POST /api/jobs/import-url` → `ingestPublicJobUrl`（`scripts/lib/job_url_ingestion.mjs:107`） | SSRF 加固：拒重定向、DNS 私网黑名单、1 MiB 上限、12 秒超时。零 AI |
| 公司 careers 页抓取 | `extractPublicCareerJobsFromHtml`（`providers/generic_company_careers/index.mjs:159`） | 一个 careers 页最多抓 100 条职位链接 |
| 无 AI 规则匹配 | `scripts/score_jobs.mjs` + `scripts/lib/candidate_matching.mjs` | 完全确定性、证据可审计 |
| 分数语义 | `canonicalMatchScores`（`scripts/lib/hybrid_matching.mjs:58`） | 无 AI 时 `semantic_score` 为 `null`，绝不伪造；`combined_score` 是唯一排序键 |
| 状态机 | `scripts/lib/application_state.mjs` | 17 状态 + 转移表；rescan 带新鲜度证明（attempt_id + target_digest + 24h TTL） |
| 简历解析 | `scripts/lib/resume_document_intelligence.mjs` | PDF（pdfjs-dist）+ DOCX（自带 ZIP 读取器）+ 中英文段落分组；**原文从不落盘** |
| 档案版本化 | `scripts/lib/career_brain.mjs:363` `saveCareerProfileVersion` | append-only，`family_id` 串血缘，编辑即撤销审批 |
| 学习闭环 | `scripts/lib/learning_candidates.mjs` | 值脱敏、逐条确认、高风险二次确认、字段签名记忆 |
| 会话存活判定 | `scripts/lib/session_liveness.mjs` | 每次请求派生，不持久化，PID + 状态文件双重确认 |
| 浏览器代理 | `browser_agent/run.mjs` | 可见窗口、脱敏截图、崩溃恢复、`retry-command.json` 轮询长驻 |
| AI Provider | `scripts/lib/ai_provider.mjs` | OpenAI / Anthropic / OpenAI 兼容 / 本地 loopback；`/models` 健康检查；Key 永不回传（`publicAIProviderConfig:139`） |
| 全量数据重置 | `POST /api/settings/reset-local-data` → `resetLocalData`（`dashboard/server.mjs:499`） | 清空六个目录；四道安全断言拒绝根目录/项目根/家目录 |

---

## 2. 仍需修复的后端问题

### 2.1 P0 — 阻塞可用闭环

#### P0-A · 手输答案仍然填不进表单

**这是上一轮 P0-1 修了一半的问题。**

答案确实存下来了，`approved_for_real_applications` 也正确派生成 `true`，但是：

```js
// application_executor/execution_session.mjs:149-152
for (const answer of applicationPackage.application_answers ?? []) {
  const canonicalKey = text(answer?.canonical_key);
  const value = text(answer?.value);
  if (!canonicalKey || !value || answer?.user_confirmed !== true) continue;   // ← 这里丢弃
```

写入侧从不发 `canonical_key`（`dashboard/public/app.js:4629-4638` 只发 `original_question / answer / source / scope / sensitive_category / user_confirmed`），所以手输答案的 `canonical_key` 恒为空字符串，**在到达执行器之前就被扔掉了**。

只有学习闭环产生的答案能用，因为 `dashboard/server.mjs:6106` 会写 `canonical_key: candidate.executor_key`。

**修法**：在服务端保存答案时派生 `canonical_key` ——
1. 先用 `canonicalCareerDestination`（`scripts/lib/learning_candidates.mjs:34`）的双语模式匹配，命中就用它的 `executor_key`
2. 未命中则 `answer_<sha256(normalized_question).slice(0,12)>`
3. 写一次性回填脚本，复用 `scripts/migrate_answer_memory.mjs` 的 dry-run 默认 + 时间戳备份 + 幂等 + 仅 ID 报告模式

**回归测试**：申请 N 保存的答案，在申请 N+1 的 `approved_field_mappings` 里出现。这是验收标准第 15 条真正的测试点。

#### P0-B · 首次运行第一步就撞墙

```js
// dashboard/server.mjs:3307-3314
if (!configured) {
  return sendJSON(res, { status: 'blocked', code: 'SEARCH_CONFIGURATION_REQUIRED',
    message: 'Save a target role in Job Search before importing a job URL.' }, 409);
}
```

粘贴岗位链接被「必须先保存搜索配置」挡住 —— 和「URL 导入优先、搜索可选」的目标顺序完全相反。

**修法**：无搜索配置时允许导入，只跳过基于偏好的评分，在返回值里标 `scored_against_preferences: false`，界面上显示「已导入。设置求职意向后可以看到匹配度」。

#### P0-C · 没有 Quick Apply 静态路由

```js
// dashboard/server.mjs:6553-6555 —— 硬编码三个文件
if (pathname === '/' || pathname === '/index.html') return sendFile(res, path.join(__dirname, 'public/index.html'), ...);
if (pathname === '/app.js')   return sendFile(res, ...);
if (pathname === '/style.css') return sendFile(res, ...);
```

**修法**：加一个安全的目录静态服务（`path.resolve` 后断言前缀在允许目录内，拒绝 `..`），映射：

```
/            → dashboard/quick/index.html
/quick/*     → dashboard/quick/*
/advanced    → dashboard/public/index.html
/advanced/*  → dashboard/public/*
```

旧 Dashboard 的 `app.js` / `style.css` 需要保留兼容路径，因为它的 HTML 里是绝对引用。

**注意同源约束**：任何带 `Origin` 的非 GET 请求，如果来源不在信任列表里会被 `dashboard/server.mjs:6371-6378` 返回 403。新界面必须从同一个 `http://127.0.0.1:8767` 提供，不能另起端口。

#### P0-D · 缺「清除求职资料」

现在只有 `resetLocalData`（`dashboard/server.mjs:499`）这一个全清操作。

**修法**：新增 `POST /api/data/clear-job-materials`

| 删除 | 保留 |
|---|---|
| `data/career_profiles.local.json` | `data/job_reviews.json`（决策历史） |
| `data/candidate_profile.local.json` | `dashboard_state.json` 中 `MANUALLY_SUBMITTED` / `SUBMITTED` / `READY_FOR_MANUAL_SUBMIT` 的 `application_status_overrides` |
| `data/resume_profiles.json` + `documents/resumes/*` | `dashboard_state.json` 的 `audit_events` |
| `data/question_bank.json` | `data/job_leads.json` / `jobs_shortlist.json`（岗位本身不是个人资料） |
| `data/form_field_memory.local.json` | |
| `data/learning_candidates.local.json` | |
| `applications/*` | |
| `data/resume_drafts/` + `documents/resume_drafts/`（新增） | |

同样要求 `confirmed: true` + 确认文本，先写 `archive/` 备份，bump `local_reset_epoch` 让扩展级联自清。

#### P0-E · 自动上传 / 自动提交在架构上被禁死

见 §5，这是最集中的一处改动。

### 2.2 P1

| 问题 | 位置 | 影响 |
|---|---|---|
| `last_used` 全仓库只读不写 | `candidate_records.mjs:412`、`execution_session.mjs:146/161/180`、`application_package_2.mjs:156` 等 7 处全是透传 | 「查看使用记录」无数据可显示 |
| 档案投影丢字段 | `careerProfileToApplicationProfile`（`career_brain.mjs:519-624`） | 丢 `education[1..]`、`identity.chinese_name`/`english_name`、`field_provenance{}`、`job_preferences.blocked_industries`；`languages[].proficiency` 被压成字符串 |
| 无 LM Studio 自动探测 | `127.0.0.1:1234` 只是 `ai_provider.mjs:13` 的默认值，从不主动探测 | 用户必须手填 |
| 模型下拉只在点「测试连接」后填充 | `dashboard/public/app.js:3168-3171` | 首次配置体验差 |
| 无 Gemini | `ai_provider.mjs:1-7` 只有 5 种类型 | 用户要求的提供方缺失 |
| SSE 重连不 resync | 无 `Last-Event-ID`、无快照事件 | 断线后界面可能停在旧状态 |
| 404 manifest 过期 | `dashboard/server.mjs:577-633` | 漏掉 quick-apply / checklist / answers / application-profile / executor-capabilities / events |
| legacy 候选人档案四路径回退 | `dashboard/server.mjs:708-735` | 五个档案表示中最后一个未退役的 |

### 2.3 基线测试实测结果（2026-08-17）

`npm test` 实测：**272 通过 / 2 失败**（`BACKEND_TRUST_ACCEPTANCE_REPORT.md` 记录的 274/274 是 2026-08-15 的结果，今天复现不了）。

两条失败都**不是产品缺陷**，但都会让「现有测试保持绿」这条验收标准失效，必须在 Phase 1 动手之前先修。

#### T-1 · 定时炸弹测试（`tests/rescan_freshness.test.mjs:55`）

```
Error: The last review scan no longer matches the current fill attempt.
code: 'APPLICATION_REVIEW_RESCAN_STALE', reason: 'scan_expired'
```

`stateWithCleanRescan` 用硬编码时间 `now = '2026-08-15T00:00:00.000Z'`（`:30`）创建扫描，但第 61 行调用 `completeApplicationReview` 时**不传 `now`**，于是用了真实时钟。`REVIEW_RESCAN_TTL_MS` 是 24 小时，所以这个测试在 2026-08-15 当天通过，之后一天就开始失败。

**产品行为是正确的**（拒绝一个两天前的扫描正是这个功能的设计意图），错的是测试：它把注入时钟和真实时钟混用了。

**修法**：给 `completeApplicationReview` 传同一个 `now`。同时全仓库扫一遍是否还有其它测试混用注入时钟与真实时钟。

#### T-2 · 「离线」套件里跑真实 Chrome（`tests/product_workflow_e2e.test.mjs:916`）

```
AssertionError: 3221226505 !== 0
```

`3221226505` = `0xC0000409`（Windows `STATUS_STACK_BUFFER_OVERRUN`）—— 被 `spawnSync` 拉起的 Chromium 崩溃了。

这个测试只在**找不到** Chrome/Edge 时才跳过（`:135`），所以在任何装了浏览器的机器上，所谓的「离线套件」都会真的启动一个 Chromium。这有两个问题：

1. `npm test` 的结果依赖本机浏览器版本，不同机器结果不同，不是一个可靠的回归门
2. 一个纯逻辑套件不应该有 2.5 秒的浏览器启动开销和崩溃风险

**修法**：把浏览器阶段从 `test:offline` 里拆出去，归到已有的 `test:browser` 脚本；`npm test` 只留确定性断言。这样「274 个测试保持绿」才是一个真正可执行的验收条件。

---

## 3. API 变更

### 3.1 新增

| 端点 | 用途 |
|---|---|
| `GET /api/ai/detect-local` | 2 秒超时探测 `127.0.0.1:1234/v1/models` 与 `11434/v1/models`，返回发现的模型列表；失败返回空数组而非错误 |
| `POST /api/data/clear-job-materials` | 清除求职资料，保留申请记录（§2.1 P0-D） |
| `GET /api/profile/full` | 完整档案读取（不只 9 个执行键），供「我的资料」页渲染。基于扩展后的 `buildApplicationProfileView` |
| `PUT /api/profile/section/:section` | 分区保存（identity / job_preferences / work_situation / education / experience / projects / skills / certifications / languages），内部走 Career Brain 版本化 |
| `POST /api/profile/undo` | 回到上一个档案版本（`activateCareerProfile`） |
| `POST /api/jobs/import-company-careers` | 给 careers 页 URL，返回可勾选的职位链接列表 |
| `POST /api/jobs/:id/resume-draft` | 生成岗位定制简历（AI） |
| `GET /api/jobs/:id/resume-draft` | 读取草稿 + diff |
| `POST /api/jobs/:id/resume-draft/approve` | 接受草稿，导出 DOCX + PDF，登记为岗位专属简历版本 |
| `DELETE /api/jobs/:id/resume-draft` | 删除草稿 |
| `POST /api/jobs/:id/cover-letter` | 生成求职信（AI） |
| `PUT /api/jobs/:id/cover-letter` | 编辑求职信 |
| `POST /api/jobs/:id/attach-file` | 按上传策略附加文件到当前会话页面（受授权保护） |
| `POST /api/jobs/:id/auto-submit` | 逐岗位授权后执行自动提交（受 8 条硬停约束） |
| `GET /api/jobs/:id/apply-state` | 聚合读：合并 `/api/executor/status` + `/api/applications/:id/checklist`，一次拿到申请卡片需要的全部状态 |

### 3.2 修改

| 端点 | 改动 |
|---|---|
| `POST /api/jobs/import-url` | 去掉 `SEARCH_CONFIGURATION_REQUIRED` 阻塞，改为标记未评分 |
| `POST /api/answers`、`POST /api/settings/question-answer` | 保存时派生 `canonical_key`；写入 `last_used` 更新钩子 |
| `POST /api/settings/search-preferences` | 接受 `resume_upload_policy` / `final_submit_policy` 两个新枚举 |
| `POST /api/settings/ai-provider` | 接受 Gemini 预设（走 `openai_compatible` 路径，端点白名单加 `generativelanguage.googleapis.com`） |
| `GET /api/events` | 支持 `Last-Event-ID`；`onopen` 时下发一次全量快照事件 |
| 404 manifest | 改为从路由表自动生成，不再手写 |

### 3.3 静态路由

见 §2.1 P0-C。

---

## 4. 数据结构与迁移

### 4.1 在线求职档案 = Career Brain 活动档案

**不新建存储。** `data/career_profiles.local.json` 是唯一写入面。UI 上只出现「我的资料」，Career Brain / Candidate Profile / Application Profile 三个内部名字全部不露出。

```
上传 PDF/DOCX
   ↓ resume_document_intelligence 解析（原文不落盘）
   ↓ buildResumeFactSuggestions → 逐条建议
用户确认（一屏「确认这些基本信息」）
   ↓ saveCareerProfileVersion  → 新版本，append-only，撤销审批
   ↓ approveCareerProfile(confirmed:true)
在线求职档案（活动版本）= 唯一数据源
   ↓ careerProfileToApplicationProfile（唯一投影）
   ├─ 岗位匹配   candidate_matching
   ├─ 网页填写   9 个执行键 + 已确认答案
   ├─ 定制简历   事实接地的唯一来源
   ├─ 求职信
   └─ 常见申请答案
```

**「可撤销」如何实现**：`profiles[]` 本来就是 append-only 数组，`family_id` 串起血缘，`parent_version_id` 指父版本。撤销 = `activateCareerProfile(上一个 version)`。界面呈现为「已用新简历更新 · [撤销，回到 8月10日 的版本]」。**不需要新数据结构。**

### 4.2 新增存储

| 路径 | 内容 |
|---|---|
| `data/resume_drafts/index.json` | 岗位定制简历索引：`{job_id, draft_id, created_at, status, source_profile_version, fact_refs[]}` |
| `documents/resume_drafts/<job_id>/<draft_id>.json` | 结构化草稿 + 每条内容的 `fact_ref` |
| `documents/resume_drafts/<job_id>/<draft_id>.docx` / `.pdf` | 导出文件 |
| `documents/cover_letters/<job_id>/<letter_id>.json` | 求职信正文 + 编辑历史 |

### 4.3 迁移

| 迁移 | 类型 | 风险 |
|---|---|---|
| 回填 `question_bank.json` 中缺失的 `canonical_key` | 一次性脚本 + 时间戳备份 + dry-run 默认 | 低。未命中模式的答案退化为 `answer_<hash>`，与今天行为等价（不会更差） |
| `search_preferences.json` 的 `safety.auto_*` 三个布尔 → 两个策略枚举 | 读边界转换，schema 升到 6.2 | 低。旧值一律映射到最保守档（`ask_each_time` / `always_manual`） |
| 档案投影补齐丢失字段 | 代码 + normalizer 默认值 | 低。新增字段，不改已有语义 |
| `application_state.mjs` 新增 `SUBMITTED` 终态 | 转移表新增边 | 中。需要新的转移测试；现有 `MANUALLY_SUBMITTED` 语义不变 |
| `last_used` 开始写入 | 增量写 | 低 |
| `playwright-core` 从 devDependencies 移到 dependencies | package.json | 低。修的是既有缺陷 —— `npm i --omit=dev` 今天会让浏览器代理直接坏掉 |

**回滚**：每个迁移脚本先写时间戳备份到 `archive/`（复用现有轮转）。Quick Apply UI 是新增的，回滚 = 把默认路由指回旧界面。

---

## 5. 自动上传与自动提交的实现

这是本轮唯一会降低安全余量的改动。产品定义见 `UPDATED_QUICK_APPLY_PRODUCT_PLAN.md` §8。

### 5.1 要改的代码

| 位置 | 现状 | 改成 |
|---|---|---|
| `scripts/lib/search_preferences.mjs:252-257` | 循环把 `auto_approve` / `auto_submit` / `auto_upload_resume` 强制 `false` 并加警告 | 换成两个枚举：`resume_upload_policy: never \| ask_each_time \| auto_on_supported`（默认 `ask_each_time`）、`final_submit_policy: always_manual \| ask_per_job`（默认 `always_manual`） |
| `application_executor/safety_policy.mjs:9-14` | `assertSafeExecutionRequest` 见到 `final_submit` / `submit` / `upload_resume` / `login` / `solve_challenge` 就抛 | 改为：`login` / `solve_challenge` **仍然无条件抛**；`upload_resume` / `final_submit` 需要携带本岗位的显式授权令牌，无令牌仍抛 |
| `application_executor/execution_session.mjs:331-337` | `resume_upload_allowed` / `final_submit_allowed` 建会话时硬 `false` | 由每岗位授权决定；`login_allowed` / `challenge_bypass_allowed` **保持硬 false** |
| `application_executor/shared_core.js:230` | `type === 'file'` → 无条件 `skipped_file_upload` | 已授权且文件已暂存时返回 `allow`，走 `attachFile` |
| `application_executor/shared_core.js:232-234` | submit 控件 → 无条件 `skipped_submit` | 已授权且 8 条硬停全部未命中时允许点击 |
| `application_executor/shared_core.js:471-479` | 报告 `safety` 块硬编码 `submitted:false` 等 6 个字段 | **改为如实记录。这一条最重要** —— 产品可以自动提交，但绝不能谎报做了什么 |
| `browser_agent/playwright_runtime.mjs:178-179` | `fillField` 对 `file` / `submit` / `button` 直接返回 `false` | 新增两个受授权保护的方法：`attachFile(ref, path)`（`setInputFiles`）和 `submitForm(ref)` |
| `scripts/score_jobs.mjs:471-473, 500-502` | 这三个标志为 `true` 就否决审批门（`gateReasons` + `approvalGatePass`） | 移除该否决 |
| `scripts/lib/application_state.mjs` | 无自动提交终态 | 新增 `SUBMITTED`，与 `MANUALLY_SUBMITTED` 并列，都是终态；转移表加边 |

**只用 Local Browser Agent 做自动化。** Chrome 扩展 `supports_rescan: false`，无法在提交前验证页面状态，因此不参与。

### 5.2 8 条硬停

在 `submitForm` 之前逐条检查，任一命中即中止、切回手动、写入原因：

1. CAPTCHA / 人机验证 —— `classifyPageSafety` 的 `challenge_scope`
2. 需要登录或 MFA —— `LOGIN_REQUIRES_USER` / `VERIFICATION_REQUIRES_USER`
3. 必填项仍为空 —— `computeReviewBlockers` 的 `REQUIRED_FIELDS_INCOMPLETE`
4. 未确认的敏感 / EEO 答案 —— `SENSITIVE_PATTERN`（`shared_core.js:241`）命中且无用户确认
5. 需要的文件缺失或附加失败 —— `FILE_UPLOAD_REQUIRED` 且 `file_upload_present === false`
6. 页面不受支持 / 表单不可访问 —— `UNSUPPORTED_FORM` / `FORM_NOT_ACCESSIBLE`
7. URL 与已批准 URL 不一致 —— `comparableExecutionUrl`（`shared_core.js:134-141`，已实现）
8. 该岗位已提交过 —— 按 `job_id` + `target_url` 幂等去重

### 5.3 三条不动的红线

| 红线 | 代码保证 |
|---|---|
| 不绕过 / 不代答人机验证 | `challenge_bypass_allowed` 保持硬 `false`；`CHALLENGE_CONTROL_PATTERN` 分类保持 `skip` |
| 不代替登录、不输入 MFA | `login_allowed` 保持硬 `false`；`assertSafeExecutionRequest` 对 `login` / `solve_challenge` 无条件抛 |
| 不代答 EEO / 身份 / 医疗 / 法律声明 | `SENSITIVE_PATTERN` 保持 `review` 分类；答案记忆的敏感项永远 `approved_for_real_applications: false` |

### 5.4 必须同步改写的文档与测试

**文档**：`SECURITY.md` · `README.md` · `AGENTS.md` · `CLAUDE.md` · `docs/product/PRODUCT_ROADMAP.md` · `docs/product/USER_CENTRIC_ACCEPTANCE_CRITERIA.md`（§A-10、§B-11、§C-16、§F）· `docs/product/QUICK_APPLY_TARGET_PRODUCT.md` §12

**测试**：`tests/approval_safety.test.mjs` · `tests/search_preferences.test.mjs:128-133`（现在断言三个标志被强制 false）· `tests/application_executor.test.mjs` · `tests/challenge_policy.test.mjs`

**新增测试**：8 条硬停各一例 · 授权令牌缺失时仍然拒绝 · 报告如实性（自动提交后 `submitted === true`）· 幂等（同一岗位第二次自动提交被拒）· 三条红线的回归断言

---

## 6. 定制简历与求职信的实现

### 6.1 AI 任务

在 `scripts/lib/ai_provider.mjs` 的 `taskOutputContract`（`:287-364`）新增两个任务的 schema：

- `resume_tailoring`
- `cover_letter_generation`

现有任务只有 3 个：`career_profile_extraction`、`semantic_job_match`、`job_match_enrichment`（后者只在测试里用）。

### 6.2 事实接地（防编造）

输出的每一条 bullet / 短语必须携带 `fact_ref`，指向档案中的具体路径，例如 `experience[2].achievements[0]`、`skills.programming[3]`。

服务端逐条校验：
1. `fact_ref` 指向的路径在当前活动档案里存在
2. 生成文本与源事实文本有足够的词元重叠（防止「引用了但内容不相干」）

任一条不通过 → **整批拒绝**，返回「AI 生成了无法核实的内容，已丢弃」，保留原简历。

这替换掉现在 `candidate_facts_invented` 那个硬编码的 `false` 字面量 —— 它今天不是一个校验，只是一个常量。

### 6.3 DOCX 导出

手写最小 OOXML，**零新依赖**：

```
[Content_Types].xml
_rels/.rels
word/document.xml
word/_rels/document.xml.rels
```

用 `node:zlib` 的 `deflateRaw` 写 ZIP（local file header + central directory + EOCD）。约 250 行。仓库已有 ZIP **读**取器（`resume_document_intelligence.mjs:60-161`）可作结构参考。

选这条路的理由：项目目前只有 1 个运行时依赖（`pdfjs-dist`），模板是固定的，不值得为此引入 `docx` 包。

### 6.4 PDF 导出

用 `playwright-core` 的 `page.pdf()` 渲染同一份 HTML 模板。需要把 `playwright-core` 从 `devDependencies` 移到 `dependencies` —— 这本来就是既有缺陷，`npm i --omit=dev` 今天会让浏览器代理直接坏掉。

### 6.5 Diff 视图

自研行级 LCS diff（约 80 行），呈现为人话：「改写了摘要 · 重排了 3 条要点 · 补充了关键词 X、Y」。三个动作：`接受` / `编辑` / `继续用原简历`。

### 6.6 求职信

同一框架。替换掉现在的确定性模板（`scripts/lib/application_package_2.mjs:33-69`）—— 它会把 `hybridMatch.career_growth_value` 里的负面评价直接写进信里（审计中实际观察到「这是合同职位，可能无法提供同样的长期职业发展」被贴进求职信正文）。

---

## 7. 前端方案

**零构建，原生 ES modules。** `npm start` 依然直接可跑，改代码不需要 build/watch，`node_modules` 不变大。

```
dashboard/quick/
  index.html                唯一 HTML，<script type="module">
  app.mjs                   路由 + 启动
  core/    api.mjs  events.mjs  store.mjs  router.mjs
  i18n/    index.mjs  zh-CN.mjs  en.mjs
  ui/      modal.mjs  toast.mjs  drawer.mjs  list.mjs  field.mjs  checklist.mjs
  views/   home.mjs  jobs.mjs  applications.mjs  profile.mjs  settings.mjs
           apply-drawer.mjs  resume-draft.mjs  first-run.mjs
  style.css
```

规则：
- 单文件不超过 ~300 行
- 不用 innerHTML 拼字符串（用 `document.createElement` 或 `<template>`）
- 状态集中在 `core/store.mjs`，不用散落的全局可变变量
- 禁用原生 `alert` / `confirm` / `prompt`（`tests/no_native_dialogs.test.mjs` 会拦）
- SSE 优先于轮询
- i18n 从第一天做，`zh-CN` 默认，`en` 并行维护，不做运行时字符串拼接

详见 `QUICK_APPLY_UI_INFORMATION_ARCHITECTURE.md`。

---

## 8. Phase 1 / 2 / 3

### Phase 1 — 能真正用起来（含定制简历、含自动化）

按依赖排序，每步可独立验收：

0. **先修基线** — T-1 定时炸弹测试 · T-2 从离线套件里拆出浏览器阶段（§2.3）。不先做这一步，后面所有「测试保持绿」的验收都没有意义
1. **后端 P0** — `canonical_key` 派生 + 回填脚本 · URL 导入去阻塞 · 目录静态路由 · 分级删除 API
2. **前端骨架** — 零构建 ES modules · i18n(zh 默认) · 5 导航 · SSE · 通用组件（Modal / Toast / Drawer / Checklist）
3. **我的资料** — 上传简历 → 一屏确认基本项 → 完整档案编辑 · 撤销到上一版本 · 我的答案 CRUD（范围、敏感徽标、使用记录）
4. **岗位** — 粘贴链接 · 公司 careers 页导入 · 5 桶列表 · 分页
5. **用 AI 申请** — 预备抽屉 → 打开并填 → 「还差 N 项」→ 我已提交
6. **定制简历** — AI 任务 + 事实接地校验 + diff + DOCX/PDF 导出 + 岗位版本存储
7. **自动化改造** — 上传策略三档 + 逐岗位自动提交 + 8 条硬停 + 报告如实化 + 文档/测试同步
8. **设置** — AI 配置（LM Studio 自动探测 + Gemini 预设）· 数据与隐私 · 首次运行向导
9. **切换默认路由** — `/` → Quick Apply，旧 Dashboard 落到 `/advanced`

#### Phase 1 验收标准

| # | 标准 | 验证方式 |
|---|---|---|
| 1 | 从 `npm install` 完成到第一个真实岗位页面被安全填好 ≤ 15 分钟，全程只看屏幕文字 | 一次录屏，无指导 |
| 2 | 点「用 AI 申请」到页面填好，主要决定 ≤ 3 个、总点击 ≤ 6 | E2E 断言点击预算，超了构建失败 |
| 3 | 全流程渲染 DOM 字符串扫描不出现 Package / Session / Executor / 状态机常量 / `package_id` / 原始 JSON | E2E 字符串扫描 |
| 4 | 申请 N 保存的答案在申请 N+1 预填生效 | 回归测试（今天是坏的，P0-A） |
| 5 | 第二次申请的预备问题数**严格少于**第一次 | 计数断言 |
| 6 | 定制简历：生成 → diff → 接受 → 导出 DOCX + PDF | 端到端 |
| 7 | 接地校验能挡住注入的假事实 | 注入一条档案里没有的技能，断言整批被拒 |
| 8 | 上传策略三档各走通一次 | 三个用例 |
| 9 | 8 条硬停各触发一次，且报告如实 | 8 个用例 |
| 10 | 三条红线的回归断言全绿 | 验证码 / 登录 / EEO |
| 11 | 「清除求职资料」后申请记录还在；「删除全部用户数据」后目录干净 | 两个用例 |
| 12 | 无 AI 配置时：搜索 / 导入 / 规则匹配 / 打开页面 / 填基本资料全部可用 | 离线模式跑一遍 |
| 13 | 任何被禁用的控件都在可见文字里说明原因 | 人工走查 + a11y 断言 |
| 14 | 离线套件全绿且**可重复**（修完 T-1/T-2 后，`npm test` 不再依赖本机浏览器，也不再随日期变化） | `npm test` 连跑两天各一次 |

### Phase 2 — 更省力

- 求职信生成 UI
- SearXNG 搜索 UI（可选、失败不阻塞、如实报告）
- 学习闭环 UI（填完页面后逐条问「要记住吗」）
- 答案使用记录（补 `last_used` 写入）
- 职业工具（面试题 / STAR / 技能差距）迁到二级入口
- SSE 重连 resync（`Last-Event-ID` + 快照事件）
- 会话 TTL 与卡死自动逃逸
- 档案投影补齐丢失字段（`education[1..]`、中英文名、`field_provenance`）
- 岗位发现调优（详情页抓取上限、提供方分页）

**验收**：求职信可生成 / 可编辑 / 可不用且不阻塞申请 · 搜索关掉时产品完全可用 · 崩溃重启后一个刷新周期内状态回到真实 · 「我的答案」能看到使用记录

### Phase 3 — 打磨与发布

- 英文补全
- 无障碍（禁用控件原因可见、焦点不丢失、状态不只靠颜色传达）
- 旧 Dashboard 逐屏退役（每退一屏，先确认其最后一个独有能力已在新界面覆盖）
- 404 manifest 改为从路由表自动生成
- legacy `candidate_profile` 四路径回退退役
- 扩展装载模式 E2E（通过才摘掉 Experimental 标签）
- CI（离线套件 + launcher 测试）
- GitHub 干净历史导出：**在导出树上 `git init` 全新历史，绝不发布现有 `.git`**（现有仓库唯一那个 commit 含个人数据）

**验收**：release 审计脚本零发现（含历史扫描）· CI 绿 · 英文首次运行路径可完成 · 现有仓库永久保持私有

---

## 9. 测试策略

- 先修复 §2.3 的 T-1 / T-2，让离线套件重新成为一个可靠的回归门：**不依赖本机浏览器、不依赖当天日期**
- 加一条元测试：扫描测试文件中同时使用注入时钟和真实时钟的调用（T-1 那类定时炸弹）
- 离线套件全程保持绿；每个新端点都加契约测试
- 点击预算断言进构建（happy path 超过 3 个决定就失败）
- 定制简历接地测试：每条生成内容都能映射到一个已批准的事实 ID
- 自动化边界测试：8 条硬停 + 授权缺失 + 幂等 + 报告如实性
- 三条红线的回归断言，任何一条失败视为验收失败
- 扩展装载模式 E2E（真实 `--load-extension`），通过前扩展保持 Experimental
- Windows 关机 / 孤儿进程断言（浏览器代理）
- 真实页面检查保持人工、脚本化、默认只读，沿用现有安全守卫

---

## 10. 旧功能去向

**移到 `/advanced`（代码不动）**：整个现有 Dashboard —— 诊断、原始 JSON、内部 ID 与摘要行、执行器手动选择、状态历史、Career Brain 原始编辑器、提供方健康检查、扩展诊断、审计事件。

**默认界面隐藏**：10 步流程条 · 12 标签岗位清单 + 6 个筛选器 · 完成度百分比 · 风险评分 · 简历「置信度 %」（本来就是 3 值查找表）· 门户名称 · SSE 诊断 · 面试题 / STAR / 技能差距（移到职业工具）。

**废弃删除**：

| 项 | 证据 |
|---|---|
| `renderJobsTableLegacy`（`dashboard/public/app.js:629`） | 死代码 |
| `data/jobs_approved.json` / `jobs_rejected.json` | 零读者零写者，boot seeding 已移除 |
| `planned_answers` / `cover_letter_draft` | 重复序列化，读兼容一个版本后删 |
| 双简历 ID 键 `active_resume_profile_id` / `active_resume_id` | 下次 schema 变更时收敛 |
| 简历「置信度 %」显示 | 硬编码 3 值查找表冒充概率 |

**保留兼容**：`normalizeApplicationStatus` 的读边界别名映射 · legacy `candidate_profile` 读回退（Phase 3 退役）· Chrome 扩展保持 Experimental（不做默认、不参与自动化）。

---

## 11. 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| **自动提交投错岗位 / 提交不完整的申请** | **高** | 8 条硬停 · 默认关闭 · 逐岗位授权 · 幂等去重 · 提交前必须有一次新鲜的页面扫描 · 如实记录进审计日志 |
| 定制简历编造事实 | 高 | 事实接地校验（整批拒绝）· 强制 diff 审阅 · 用户显式接受 · 「继续用原简历」永远一键可达 |
| 拆掉安全不变量时引入回归 | 中高 | 三条红线单独断言 · 274 个既有测试保持绿 · 授权令牌机制默认拒绝 · 分步实施（先上传后提交） |
| DOCX 手写实现的兼容性 | 中 | 用固定干净模板生成，不做原文件往返；产物在 Word / WPS / LibreOffice 各验一次 |
| 两套界面在迁移期漂移 | 中 | 共用同一 API 层；高级模式以只读为主；按屏退役有明确前置条件 |
| Windows 上浏览器代理留下孤儿进程 | 中 | 补 SIGTERM / Windows 关机测试；服务端启动时扫 PID |
| 前端从零写，工作量被低估 | 中 | 零构建 + 组件小文件 + 分步验收；Phase 1 的 9 步每步都可独立交付 |
