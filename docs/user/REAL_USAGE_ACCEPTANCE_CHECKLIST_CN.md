# 真实日常使用验收清单

本清单由用户在已授权的公开职位页面上监督执行。不得上传简历、登录、回答
敏感/EEO 问题、绕过 CAPTCHA/MFA 或点击 Submit。

## 当前资料与职位

- [ ] Career Brain 活动版本已由用户批准，事实正确且无虚构。
- [ ] Resume Version 已批准，文件存在且 hash 未变化。
- [ ] 搜索结果显示来源、查询、时间和发现原因。
- [ ] 重复搜索优先新职位；已见/拒绝/批准/申请记录仍可查看。
- [ ] Warning-only 职位可由用户继续；硬阻断职位显示原因和替代操作。

## 多职位隔离

对至少三个职位逐项确认：

- [ ] Job、Package、Application Session 和 target URL 各自独立；
- [ ] Profile/Resume 绑定正确；
- [ ] attempt、报告、学习候选和状态没有串到其他职位；
- [ ] Reject 可恢复，Approve 可进入 Package；
- [ ] 页面不可用时保留失败记录并提供手工打开/导入链接选项。

## AI Fill Assistant

- [ ] 选择 Chrome Extension 时不显示 Browser Agent 要求；
- [ ] 选择 Local Browser Agent 时不显示 Extension 心跳/Popup 要求；
- [ ] Detected、Filled、Skipped 与原因可见；
- [ ] Retry 和 Re-scan 保留旧 attempt/报告；
- [ ] 页面刷新后仍保持当前职位、Package、筛选、滚动和焦点；
- [ ] 没有自动附件、敏感答案、挑战处理或提交。

## 学习与复用

- [ ] 手工变化只生成候选项，不自动保存；
- [ ] Career Brain 学习创建 Draft；
- [ ] Answer Memory 只保存明确确认答案，并记录范围/provenance；
- [ ] 高风险默认 Do not save；
- [ ] Form Field Memory 只有映射，没有候选人值；
- [ ] 另一个独立职位只能复用已确认且范围匹配的信息。

## 已知需要用户完成的检查

- [ ] 本机安装的 Chrome Extension 实例实际连接成功；
- [ ] 当前网络下 SearXNG 上游能返回真实结果，或改用公开 URL 导入；
- [ ] 最终表单、附件和声明由用户本人检查并提交。
