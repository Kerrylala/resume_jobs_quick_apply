# Resume Jobs 个人 AI Job Application Agent - 用户使用指南

## 1. 项目介绍

Resume Jobs 是一套在本机运行的个人 AI Job Application Agent。它把“设定目标、发现职位、评估匹配、人工筛选、准备材料、辅助填表、人工提交”放在同一条可追踪流程中，核心目标是提高用户已批准职位的 **Application Completion Rate（申请自动完成率）**。

它可以帮助你：

- 定义目标职位、地点、熟练度、技能和工作方式偏好。
- 收集并去重职位，识别列表页、详情页和异常来源。
- 查看匹配分数、优势、缺口和评分依据。
- 决定哪些职位继续，以及一次最多处理几个职位。
- 为单个职位准备简历选择、求职信草稿和问题答案。
- 在你明确批准后，使用浏览器扩展辅助填写已知且安全的字段。
- 保留申请状态和操作记录，方便暂停后继续。

Resume Jobs 不会代替你做最终决定。真实登录、验证码、MFA、简历上传、敏感问题和最终提交都由你处理。

## 2. 核心工作流程

### 步骤 1：创建求职目标

打开 Dashboard 的 **Job Search**，在 **Search Configuration** 中创建或选择 Search Profile，然后填写：

- 想找的职位和关键词。
- 国家、城市或远程地点。
- 熟练度、工作类型和办公方式。
- 必备技能与加分技能。
- 偏好公司、排除公司和排除关键词。
- 发布时间、最低薪资、最大搜索结果数。
- 一次最多打开的职位数 `maximum_jobs_to_open`。

保存后再开始搜索。建议先从少量结果开始，确认规则符合预期后再扩大范围。

### 步骤 2：搜索职位

点击 **Run Search**。系统会按搜索配置收集候选职位，并执行标准化、去重和基本质量检查。没有通过来源或质量验证的记录不会进入正常匹配列表，诊断信息会保留在本地运行结果中。

默认测试流程可以完全离线运行。访问真实公开职位页面属于受控操作，应先确认配置和授权范围。

### 步骤 3：查看评分

点击 **Score Jobs**。在 Jobs 表格和职位详情中查看：

- 匹配分数与等级。
- 与目标职位、地点和技能的匹配情况。
- 已识别的优势。
- 缺失技能、信息不足或其他风险。
- 原始职位链接和评分证据。

分数用于排序和辅助判断，不代表录用概率，也不应替代你对职位真实性和适合度的判断。

### 步骤 4：用户批准

点击 **Prepare Review Queue**，逐个选择：

- **Approve**：同意继续准备材料。
- **Reject**：不再处理。
- **Manual Review**：暂时保留，稍后人工复核。
- **Reset**：在流程允许时重置当前选择。

系统遵守 Search Profile 中的 `maximum_jobs_to_open`，避免一次打开过多职位。

### 步骤 5：生成申请材料

对已批准职位选择 **Build Package**。申请包可以包含：

- 选中的简历版本及其来源。
- 求职信草稿或待补充项。
- 常见问题答案和答案来源。
- 未回答问题、敏感问题与人工检查项。

在 **Application Package** 面板中完整检查材料。系统不会虚构工作经历；缺少事实时会保留为空或要求你确认。

### 步骤 6：自动填写

检查申请包后，先选择 **Approve AI Fill**，再明确选择 **Start AI Fill Assistant**。AI Fill Assistant 只填写已知、已批准且风险可控的字段，并暂停等待用户检查。

遇到下列情况会暂停并等待你：

- 网站登录。
- CAPTCHA 验证码。
- 短信、邮件或验证器 MFA。
- 简历或其他文件上传。
- 未知问题或缺少可靠答案。
- 薪资、工作许可、平等就业信息等敏感问题。
- 页面结构变化或系统无法确认下一步是否安全。

### 步骤 7：用户最终提交

当状态到达 `READY_FOR_MANUAL_SUBMIT` 时，请逐项检查表单、附件和声明。只有你本人可以点击网站的最终 **Submit / Send / Confirm**。提交后，可回到 Dashboard 选择 **Mark Submitted**，记录这次人工提交。

## 3. 安装要求

- Windows 11。
- Node.js 18 或更高版本，安装时保留 npm。
- 一个现代浏览器；浏览器填表功能使用项目现有的 Chrome 扩展。
- 可选：LM Studio 或其他兼容 OpenAI API 的本地模型服务，用于可回退的文本辅助能力。

项目依赖尚未安装时，在项目目录运行一次：

```powershell
npm install
```

启动器不会自动下载软件或修改系统配置。

## 4. 第一次启动

1. 打开项目的 `dist` 文件夹。
2. 双击 `ResumeJobs Launcher.cmd`。如需桌面图标，可按下文命令为当前电脑生成一次。
3. 启动器会检查 Node.js、npm、项目依赖、必要文件、配置状态和端口 8767。
4. 检查通过后，启动器调用项目统一入口 `npm run app`。
5. Dashboard 准备好后，默认浏览器会打开 `http://127.0.0.1:8767`。
6. 使用期间保持启动器窗口打开。按 Enter 或 Q 可以停止本次启动的后台进程。

没有私人资料或搜索配置时，Dashboard 仍可启动，启动器会给出友好提示。关闭启动器不会删除职位、申请记录或配置。

### 第一次登记简历

1. 打开 **Resume**。
2. 选择本机 PDF、DOCX 或 UTF-8 TXT，填写版本名称、目标职位和语言。
3. 点击 **Add Local Resume**，阅读确认提示后允许复制到本地 Resume Library。
4. 系统会检查文件类型和大小、计算 SHA-256 哈希，并创建一个未批准的新版本；相同内容不会重复登记。
5. 检查文件路径、版本、目标职位和 Content Hash，点击 **Review and Approve Version**。

本地导入不等于把简历上传到招聘网站。导入时会保存文件、本地路径、哈希和元数据，并在本机分析当前活动简历；新发现的非敏感事实会以“未确认、待审核”状态写入 Candidate Profile，已有事实不会被覆盖，简历原文不会被保存。需要时可点击 **Analyze Local Copy** 重新验证哈希并复核建议。写入建议会撤销资料批准状态，你必须重新检查全部 Candidate Facts 并确认新快照。未经明确批准的简历版本仍不能让 Application Package 进入 `PACKAGE_READY`，外部附件、登录和最终提交仍保持关闭。

如需把快捷方式安装到当前 Windows 桌面，可在项目目录运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/create_resume_jobs_shortcut.ps1 -InstallDesktop
```

## 5. Dashboard 使用说明

- **Home**：查看首次使用引导、产品状态和自动完成率概览。
- **Resume**：登记、审阅、分析和批准本地简历版本。
- **Profile**：维护 Candidate Facts 和可复用的 Answer Memory。
- **Job Search**：维护 Search Profile 并运行职位发现。
- **Job Matches**：查看匹配分数、证据、筛选器和审核操作。
- **Applications**：生成与审阅申请包，查看填表准备度和处理进度。
- **Settings**：配置 Job Search Sources、查看可选本地模型状态并维护安全配置；安全锁定项不能在这里绕过。
- **Application Completion**：已批准且已有申请包或填表报告的职位平均自动完成率。
- **Fields Needing You**：仍需你处理的新问题、敏感问题、高风险问题或低置信度映射。
- **Make the next application faster**：汇总重复阻塞字段，并建议下一项最值得补充的事实、答案或字段映射。该反馈只使用字段名、状态和计数，不保存答案值。

如果页面没有更新，先点击刷新或重新打开 Dashboard；不要重复点击正在执行的操作。

确认 Candidate Facts 只表示“这些事实已由你审阅”。它不会开启真实网站自动填写、外部简历附件或最终提交；工作许可、薪资、EEO 等敏感事实仍需在每个职位中再次确认。

## 6. 搜索配置说明

每个 Search Profile 表示一种求职策略。建议为不同方向分别建立配置，例如“上海 AI 产品经理”和“远程数据分析”。

重点字段：

- `target_roles`：职位名称和关键词。
- `preferred_locations`：可接受地点。
- `workplace_modes`：remote、hybrid、onsite 或 any。
- `seniority_levels`：entry、junior、mid、senior 等。
- `required_skills` / `preferred_skills`：必备和加分技能。
- `excluded_keywords` / `excluded_companies`：明确不考虑的内容。
- `posted_within_days`：职位发布时间范围。
- `maximum_search_results`：单次候选上限。
- `maximum_jobs_to_open`：单次允许继续处理的职位上限。

第一次使用真实搜索前，打开 **Settings -> Job Search Sources**，填写
SearXNG Endpoint，启用并保存，然后点击 **Test Connection**。`READY`
表示可以搜索；`DISABLED`、`MISCONFIGURED`、`UNREACHABLE` 和 `ERROR`
都会显示可操作的原因。页面提供 localhost 建议值，但不会自动保存或启用。

三种模式彼此明确分开：

- **Offline Demo**：只创建一个 synthetic localhost 职位，不访问网络。
- **Live Search**：查找公开职位，并使用 deterministic scoring。
- **Live Search + AI Enrichment**：在相同的搜索和规则评分后，增加可选的
  本地模型解释。未配置 AI 不会阻止 Live Search。

如果已经知道某个公开职位详情页，可在 **Import one public job URL** 中粘贴
URL，点击 **Import and Score**，再在产品 Modal 中确认本次公开读取。系统会
拒绝账号密码、远程 HTTP、内网目标、重定向、非 HTML 和超大响应；该操作
不会打开申请表、登录、上传或提交。

## 7. 职位评分说明

评分会综合搜索目标、地点、熟练度、技能和职位信息质量。详情中的优势与缺口比单个数字更重要：

- 高分表示与当前配置较匹配，不保证职位真实、仍开放或一定适合。
- 缺少描述、来源不明或字段冲突会降低可信度。
- 分数变化通常来自搜索配置、职位详情或评分规则变化。
- 最终是否继续始终由你决定。

## 8. 申请包说明

申请包是某个职位在填表前的本地准备记录。它把简历版本、求职信、问题答案、来源、敏感项和缺失项集中展示。顶部摘要还会显示已有候选事实数、核心事实覆盖率、预计自动完成率和预计人工检查时间。

Resume Intelligence 会在用户明确执行本地导入时分析当前活动简历，也可以通过 **Analyze Local Copy** 重新运行。DOCX 使用文档 XML 提取，UTF-8 TXT 直接读取，文本型 PDF 使用 best-effort 文本流提取。扫描件、加密 PDF 或复杂字体可能无法分析。所有提取事实都以未确认状态开始，已有事实和敏感字段不会被自动覆盖，简历原文不会保存；缺失的核心事实会继续列出。

如果 Resume Library 中有多个已批准版本，系统会根据职位名称、目标角色和已登记技能计算推荐版本。Application Package 面板会显示推荐版本、置信度、候选版本分数和匹配依据。你可以在允许填表前选择其他版本并点击 **Use selected version** 重新构包；这不会改变 Resume Library 的 active 版本。填表开始后版本会锁定，避免申请运行中途替换材料。

使用前请确认：

- 简历版本确实适用于该职位。
- 推荐依据是否充分；如需覆盖，务必在 Approve AI Fill 前完成。
- 文件路径指向正确且已审核的材料。
- 求职信没有虚构经历或不真实承诺。
- 所有答案都能追溯到用户确认或可信资料。
- 未解决问题和敏感问题已明确处理。

生成申请包不等于上传文件，也不等于提交申请。

## 9. 答案记忆说明

**Answer Memory** 用于保存你明确确认过的常见问题答案。修改已保存答案会创建新版本，旧版本仍保留用于审计。

- 先填写问题原文和确认后的答案。
- 选择来源和适用范围。
- 只有经过你确认的答案才能用于后续匹配。
- 敏感答案不会被自动推断。
- 个人资料发生变化时，应更新答案，而不是继续使用旧版本。

### 字段记忆与完成率

**Form Field Memory** 记住的是“这个网站的这个字段对应哪个资料键”，不会保存该字段的个人答案值。扩展会把新映射显示在 **Learn questions** 区域：

- 只有你逐条选择 **Approve mapping** 的非敏感映射才会在以后复用。
- 重复成功使用会提高映射置信度。
- 拒绝的映射不会参与填写。
- 薪资、工作许可、身份、EEO 等敏感映射即使被识别，也不会由字段记忆自动放行。

申请包中的 Completion 是打开页面前的估算；扩展运行后的 Completion 是实际填表结果。两者都不表示申请已提交。

## 10. 浏览器自动化

浏览器辅助提供两种模式：推荐的 **Chrome Extension** 使用日常浏览器；高级的 **Local Browser Agent** 会打开一个可见的专用 Chrome/Edge 窗口。两种模式使用同一份已审核申请设置，不需要手工导入 Profile。Dashboard 启动时不会自动访问招聘网站。真实使用时，先检查某个职位的申请内容，选择 **Approve AI Fill**，再选择模式并点击 **Start AI Fill Assistant**。助手只能获得已审核的安全字段；它不会获得简历文件、敏感答案或提交权限。Workday 动态多步骤支持仍有限。

自动化的职责是“辅助填写”，不是“无人值守申请”。它不会绕过 CAPTCHA/MFA，不应代替用户登录，不会自动上传简历，也不会点击最终提交按钮。

## 11. 安全说明

- 不自动提交真实职位申请。
- 不绕过 CAPTCHA、MFA 或网站访问控制。
- 不生成虚假经历、学历、技能或身份信息。
- 不自动回答薪资、工作许可、政府身份号码、平等就业等敏感问题。
- 不在未经明确授权时登录、上传简历或访问真实招聘网站。
- 所有数据默认保留在项目本地目录；使用前仍应自行保护私人资料和备份。

### 完整离线演示

如果你想先了解完整产品流程而不配置真实资料，请打开项目的 `dist` 目录并双击：

```text
ResumeJobs Offline Demo.cmd
```

演示会自动使用合成候选人、合成简历引用、演示搜索、演示职位、模拟本地模型和本地假申请表，依次完成职位去重、评分、批准、申请准备、辅助填写、未知问题暂停、恢复、Completion 报告和字段记忆学习。

完成后会在默认浏览器中打开双语报告。成功演示必须显示：

- Pipeline 为 `10/10`。
- 最终状态为 `READY_FOR_MANUAL_SUBMIT`。
- Final Submit 为 `Not clicked`。
- 真实网站、真实资料、登录、简历上传和正式数据修改均为 `false`。

演示报告写入 `output/offline_demo/`。演示截图中的人物和答案全部是合成测试数据，不是你的个人资料。

## 12. 常见问题

**双击后提示缺少 Node.js。**  
安装 Node.js 18 或更高版本，并确认安装程序包含 npm。关闭旧启动窗口后重试。

**提示缺少依赖。**  
在项目目录运行 `npm install`，完成后重新双击启动器。

**提示端口 8767 被占用。**  
如果已有 Resume Jobs 正常运行，启动器会直接打开它；如果是其他程序，请关闭该程序。开发者也可用 `-Port` 指定其他端口。

**Dashboard 打开后没有职位。**  
先到 Job Search 保存一个启用的 Search Profile。若要查找真实公开职位，
再到 Settings -> Job Search Sources 配置并测试 SearXNG。Offline Demo
是 synthetic 演示，不代表真实职位。

**为什么无法开始填表？**  
检查职位是否已批准、申请包是否完成、是否执行了 Approve AI Fill，以及是否存在未处理的敏感或未知问题。

**为什么没有自动提交？**  
这是产品的硬性安全边界。最终提交必须由用户本人完成。

**如何停止？**  
在启动器窗口按 Enter 或 Q。若窗口已丢失，可运行 `scripts/stop_dashboard_windows.ps1`；脚本只会在确认进程属于 Resume Jobs 后停止它。

**快捷方式移动到别的电脑后失效。**  
仓库不发布包含本机绝对路径的 `.lnk`。请运行 `scripts/create_resume_jobs_shortcut.ps1 -InstallDesktop` 为当前电脑生成，或使用可随项目目录移动的 `dist/ResumeJobs Launcher.cmd`。
