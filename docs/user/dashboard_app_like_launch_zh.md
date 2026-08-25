# Dashboard Windows 启动说明

普通用户请优先阅读 [中文用户指南](USER_GUIDE_CN.md)。本文只说明 Windows 启动器的行为和维护命令。

## 推荐启动方式

双击可随项目目录移动的：

```text
dist\ResumeJobs Launcher.cmd
```

如需桌面图标，为当前电脑生成快捷方式：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/create_resume_jobs_shortcut.ps1
```

添加 `-InstallDesktop` 会把快捷方式复制到当前 Windows 用户的桌面；默认命令只写入项目的 `dist` 目录。仓库不发布 `.lnk`，因为其中包含当前电脑的绝对路径。

## 启动器做什么

`scripts/start_dashboard_windows.bat` 调用原生 PowerShell 启动器 `scripts/start_dashboard_windows.ps1`。启动器：

1. 检查 Node.js 18+、npm、依赖和必要项目文件。
2. 检查搜索配置和私人资料；缺失时只给出安全提示。
3. 检查端口 8767。若已有可确认的 Resume Jobs Dashboard，则直接复用；若被其他程序占用，则友好报错。
4. 调用项目统一入口 `npm run app`，即 `node dashboard/server.mjs`。
5. 等待 `/api/summary` 健康检查通过，再打开默认浏览器。
6. 保持窗口运行；按 Enter 或 Q 时只停止本次启动的进程树。

启动器不运行职位搜索、不打开招聘网站、不加载浏览器扩展、不上传简历，也不触发真实申请。

## 维护与测试命令

只检查环境：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start_dashboard_windows.ps1 -CheckOnly -NoBrowser
```

启动并立即安全停止：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/start_dashboard_windows.ps1 -SmokeTest -NoBrowser
```

运行自动化测试：

```powershell
npm run test:launcher
```

在启动器窗口丢失时，安全识别并停止默认端口上的 Dashboard：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/stop_dashboard_windows.ps1
```

停止脚本只有在 API 和进程命令行都能确认属于 Resume Jobs 时才会执行；它不会停止其他未知进程，也不会删除数据。
