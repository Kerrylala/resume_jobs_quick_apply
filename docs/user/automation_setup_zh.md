# 每日自动化设置

本页说明如何在本机手动运行或使用 Windows 任务计划程序定时运行每日职位发现。自动化只做发现、分析和生成待审核内容，不会批准职位、打开申请页面、上传简历、登录或提交申请。

## 手动运行

在项目根目录执行：

```powershell
npm run daily
```

如需先检查环境：

```powershell
npm run validate
```

运行日志和报告均写入本地忽略目录，不应提交到 Git。

## Windows 任务计划程序

先确认 WSL 发行版名称：

```powershell
wsl -l -v
```

然后从项目根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\schedule_daily_automation_windows.ps1 -WslDistro Ubuntu
```

脚本默认使用当前项目目录，并创建名为 `ResumeJobsDailyAutomation`、每天 09:00 运行的任务。可以通过 `-TaskName`、`-TaskTime` 和 `-WorkingDirectory` 修改这些设置。

## 安全边界

每日自动化不会：

- 自动批准或拒绝职位；
- 自动打开浏览器申请页；
- 上传简历或其他文件；
- 登录、处理 CAPTCHA、OTP 或 MFA；
- 点击 Apply、Submit、Send、Confirm、Continue 或 Next；
- 自动提交任何申请。

每天运行后，请在 Dashboard 中查看新职位、来源和失败原因，再由用户决定是否保存、拒绝或批准。
