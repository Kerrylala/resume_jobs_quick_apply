# Answer Memory 与 Form Field Memory 中文指南

## 学习必须经过确认

AI Fill Assistant 填完安全字段后，用户可以手工完成更多字段并点击 Re-scan。
系统比较填写前后的页面，只生成 **New information found** 候选项，不会自动
保存。每项都可以编辑、选择范围、保存或 Do not save。

## Career Brain Facts

稳定职业事实（例如当前城市、公开职业链接）保存后会创建新的 Career Brain
Draft，保留已批准祖先。Draft 必须重新审核并批准，不能静默替换活动版本。

## Answer Memory

Answer Memory 记录标准化问题、原始措辞、确认答案、类型、风险、范围、来源
职位/申请/页面、确认状态、创建/更新时间和 provenance。范围可以是：

- global；
- country；
- employer；
- role；
- portal。

只有 `user_confirmed=true` 的答案才能在等价措辞中被建议或复用。

工作许可、担保、薪资、法律声明、搬迁、通知期等高风险答案默认 Do not save；
即使历史答案存在，也必须再次确认。密码、证件、护照、财务、EEO/人口统计、
医疗、CAPTCHA、认证 token、隐藏字段和文件内容永不保存。

## Form Field Memory

Form Field Memory 只保存“页面字段 → Career Brain key / Answer Memory key”的
映射、置信度、确认和使用次数，绝不保存候选人答案值。未知字段由用户手工
映射并确认后，未来相同字段才能采用该映射。

如果不希望复用，选择 Do not save；拒绝的候选不会进入任何 Memory。
