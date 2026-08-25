# 贡献指南

[English](CONTRIBUTING.md) · **简体中文**

感谢你愿意看看这个项目。这是一个本地优先的产品：它完全运行在用户自己的机器上，
持有他们真实的求职数据。所以一个改动首先会被这样评判——它有没有守住这个承诺。

## 环境准备

```bash
npm install
npm start
```

控制台运行在 <http://127.0.0.1:8767>。`npm run demo` 会启动一个完全合成的离线演示，
不需要任何真实账号。

## 提交 Pull Request 之前

```bash
npm test
```

离线测试套件必须保持全绿——它是这个产品的契约，不是走过场。任何行为改动都要带上
对应的测试；现有的不少测试之所以存在，正是因为某个缺陷真的上线过一次。

## 不可妥协的规则

这些规则由代码和测试强制执行，不是靠约定：

- **绝不提交申请。** 最终提交、登录、验证码、MFA 永远属于用户。
- **绝不编造候选人事实。** 生成的简历或求职信里说的每一句话，都必须能追溯到用户
  确认过的事实。无法接地的 AI 输出会被整体拒收。
- **绝不提交真实数据。** `data/`、`documents/`、`archive/`、`browser_profiles/`、
  `browser_sessions/` 都被忽略。测试固定数据一律使用合成人物。
- **发布 UI 里不使用原生弹窗**（`alert`、`confirm`、`prompt`）。
- API 改动必须在同一个改动里同步更新
  `docs/developer/QUICK_APPLY_API_CONTRACT.md` 和
  `tests/api_contract_freeze.test.mjs`。
- 修改 `application_executor/shared_core.js` 之后，运行
  `npm run executor:sync-extension-core`，保证扩展里的副本与它逐字节一致。

## 涉及安全的改动

任何触及真实网站、浏览器自动化、简历附件、登录或提交的改动，都需要在
[SECURITY.zh-CN.md](SECURITY.zh-CN.md) 里明确更新威胁模型，并且默认保持由人掌控。

## 报告问题

开一个 issue，写清楚你做了什么、期望是什么。永远不要粘贴真实个人数据——请打码
或改用合成示例。

更深入的开发说明见
[docs/developer/CONTRIBUTING.md](docs/developer/CONTRIBUTING.md) 和
[开发者指南](docs/developer/DEVELOPER_GUIDE.md)。
