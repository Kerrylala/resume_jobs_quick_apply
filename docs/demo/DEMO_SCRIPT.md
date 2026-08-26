# Demo GIF / 视频分镜脚本

目标:20–40 秒,让陌生人看完就明白「搜索 → 匹配 → 定制 → 自动填 → 我来提交」
这条完整链路。本文档给出分镜、时长、录制环境和技术参数。

**红线:绝不使用真实个人信息。** 全程使用合成人物(如 Jamie Rivera)、虚构公司、
`@example.invalid` 邮箱。录制前先执行下方「干净环境」步骤。

## 录制环境(先做这一步)

用隔离数据目录起一个干净实例,不碰你的真实数据:

```powershell
$ws = "$env:TEMP\rj_demo"
$env:PORT = "8791"
$env:RESUME_JOBS_DATA_DIR = "$ws\data"
$env:RESUME_JOBS_ARCHIVE_DIR = "$ws\archive"
$env:RESUME_JOBS_DOCUMENTS_DIR = "$ws\documents"
$env:RESUME_JOBS_BROWSER_PROFILES_DIR = "$ws\browser_profiles"
$env:RESUME_JOBS_BROWSER_SESSIONS_DIR = "$ws\browser_sessions"
node dashboard/server.mjs
```

- 准备一份**合成简历 PDF**(名字用 Jamie Rivera 之类,邮箱 `@example.invalid`)。
- 申请环节使用 `npm run demo` 的本机假 ATS,或 `mock_sites/` 里的表单——
  **不要对真实公司录制**,既避免隐私问题也避免真的发出申请。
- 界面语言:录**英文界面**(受众更广;GIF 里的文字本身就是说明)。
- 浏览器窗口 1440×900,系统缩放 100%,关掉多余书签栏。

## 分镜(共 ~36 秒)

| # | 时间 | 画面 | 要点 |
|---|---|---|---|
| 1 | 0–4s | My Profile 页,点 **Upload resume**,选合成 PDF,解析出的卡片(教育/经历/技能)浮现 | 开场即「喂简历」,无需解说 |
| 2 | 4–7s | 点 **Confirm profile**,右上角出现绿色 **Confirmed** | 强调「人批准资料」 |
| 3 | 7–12s | Jobs 页,点 **Find jobs from my profile**,结果流入,卡片带 91/86/78 分 | 核心卖点 1:自动发现+评分 |
| 4 | 12–16s | 点开 91 分岗位,右侧抽屉:分数解释 + Source/Query/原始链接 | 核心卖点 2:可解释、可溯源 |
| 5 | 16–21s | 抽屉里点 **Generate tailored resume**,切到生成的 PDF,镜头停在针对岗位的 Summary 段 | 核心卖点 3:接地定制 |
| 6 | 21–25s | 点 **Apply with AI**,申请准备抽屉(简历选择/求职信/会自动填写),点 **Open & fill** | 过渡到执行 |
| 7 | 25–32s | 假 ATS 页面:字段逐个被填上,页面角标显示 **Fill this step**;镜头扫过已填的姓名/邮箱 | 核心卖点 4:自动填写+页面内助手 |
| 8 | 32–36s | 右侧清单显示 **Needs you: 1 item**(某敏感问题),然后鼠标移到 ATS 的 Submit 按钮上**悬停不点**,定格 | 核心卖点 5:该你的还是你的;提交永远手动 |

结尾定格叠字(可选,加在 32–36s 画面上):**"You review. You submit."**

## 技术参数

- **录制工具**:Windows 用 [ScreenToGif](https://www.screentogif.com/)(免费,
  可逐帧删改)或 OBS;macOS 用 Kap。
- **导出**:优先 MP4(体积小、清晰);GitHub README 要自动播放则用 GIF。
  GIF 控制在 **≤ 10 MB**(GitHub 渲染上限宽松,但仓库体积要克制):
  15 fps、宽 1280、必要时砍到 2 倍速。
- **文件位置**:`docs/images/demo.gif`(或 `demo.mp4`)。
- **接入 README**:两份 README 首屏各有一行
  `<!-- demo-gif: ... -->` 注释,把注释上方的 `jobs.png` / `jobs.zh.png`
  图片行替换为:

  ```markdown
  ![Product demo](docs/images/demo.gif)
  ```

  MP4 则需要用 GitHub 的拖拽上传(在 Release 或 issue 里拖入生成 CDN 链接)
  或者保留 GIF 方案——README 内嵌本地 mp4 不会自动播放。

## 剪辑要点

- 每个镜头切换处停留 ≥0.8s,让眼睛跟得上;鼠标移动走直线、不绕圈。
- 第 5 镜的 PDF Summary 是全片信息密度最高的一帧,值得放大或高亮。
- 全片不出现:真实姓名、真实邮箱、手机号、真实公司申请页、API Key、
  你的系统用户名(注意窗口标题栏和任务栏)。
- 录完逐帧过一遍再发布。
