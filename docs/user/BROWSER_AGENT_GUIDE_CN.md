# Local Browser Agent 中文指南

Local Browser Agent 是高级可见执行方式，不是第二套产品。它和 Chrome
Extension 使用同一个已批准 Package、Application Session、字段映射、安全策略、
Answer Memory、Form Field Memory 和执行报告。

## 使用方法

1. 审核职位和 Application Package。
2. 批准安全填写，选择 **Local Browser Agent (advanced)**。
3. 阅读产品确认框并启动。
4. 专用 Chrome/Edge 窗口打开对应申请页并填写安全字段。
5. 在 Dashboard 查看 Detected、Filled、Skipped 和原因。
6. 手工补充后使用 Re-scan；需要时可 Retry Safe Fill。
7. 检查完成后由本人提交，或关闭受控浏览器结束会话。

## 本地文件

- `browser_profiles/resume-jobs-agent/`：专用持久浏览器 profile；
- `browser_sessions/<session>/status.json`：无候选人值的状态；
- `ApplicationExecution.json`：遮蔽后的执行报告；
- `screenshots/`：所有输入、文本域、选择器和可编辑内容均被遮蔽；
- `browser-agent.log`：本地运行日志。

这些路径全部被 Git 忽略。即使报告已遮蔽，也不要未经检查对外分享整个目录。

## 关闭与恢复

关闭正常 Launcher 会先请求 Dashboard 停止其拥有的 Browser Agent；Windows
会等待 Chromium 释放 profile 句柄。异常中断后可以重新打开 Dashboard，按
明确提示 Recover 或 Restart AI Fill Setup；旧 Session、attempt 和报告会保留。

## 安全边界

真实使用始终可见。Headless 只用于 localhost 合成测试。Agent 会拒绝上传、
登录、挑战绕过、敏感答案和提交请求，并跳过 file、password、CAPTCHA/OTP、
按钮、隐藏和低置信度字段。

验证命令：

```powershell
npm run test:browser-agent
npm run test:browser-agent-dashboard
npm run test:browser-agent-crash
```
