# Chrome Extension 中文指南

## 安装

1. 启动 Resume Jobs。
2. 打开 `chrome://extensions` 或 `edge://extensions`。
3. 开启开发者模式，选择“加载已解压的扩展程序”。
4. 选择 `extensions/application_assistant`。
5. 固定 **Resume Jobs AI Fill Assistant**。代码更新后点击“重新加载”，并
   刷新已打开的申请页面。

扩展不需要 Native Messaging、注册表脚本或手工 Profile 文件。

## 日常使用

1. 在 Dashboard 审核 Application Package。
2. 点击 Approve AI Fill。
3. 选择 **Chrome Extension (recommended)**。
4. 点击 Start AI Fill Assistant。
5. 在自动打开的对应申请页确认 Popup 显示 Connected、Application found、
   Package ready。
6. 点击 Fill safe fields。
7. 查看 Detected、Filled、Skipped 和原因，本人完成剩余内容。

正常模式不会显示内部连接标识或底层通信细节。需要排查时再展开 Advanced
diagnostics。

## 权限与支持范围

Manifest 只使用 `activeTab`、`scripting`、`storage`，以及 localhost、
Greenhouse、Lever、Ashby 和 Workday 公共域名权限；没有 `<all_urls>` 和
`nativeMessaging`。其他公开页面只有在用户打开 Popup 后才能获得当前标签页
权限。

Workday 动态多步骤页面可能需要大量手工操作。登录、CAPTCHA/MFA、附件、
敏感/EEO 字段和最终 Submit 始终手工处理。

## 连接排查

- **Not connected**：确认 Dashboard 是 `http://127.0.0.1:8767`，刷新扩展和页面。
- **Application not found**：从正确职位的 Package 再次点击 Start AI Fill Assistant。
- **Package not ready**：批准 Profile/职位并重建 Package。
- **Receiving end does not exist**：扩展重新加载后刷新申请页面。
- **No mapping**：先留空并手工填写；如适合复用，在 Re-scan 后明确批准映射。

自动化 fixture 通过不等于本机安装实例已经连接。只有扩展实际向 Dashboard
报告连接后，才能把安装连接记为 PASS。
