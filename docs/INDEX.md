# Documentation index

Resume Jobs AI documentation, organized by audience. If you are new, start
with the root [README.md](../README.md) and then the user guide for your
language.

## For normal users

Read these to install, start, and use the product safely:

- [user/PRODUCT_TOUR.md](user/PRODUCT_TOUR.md)
  ([中文](user/PRODUCT_TOUR.zh-CN.md)) — full first-use workflow, daily rhythm,
  executor modes, and project layout (the detail behind the README).
- [user/quick_start.md](user/quick_start.md) — install to first working Dashboard.
- [user/USER_GUIDE.md](user/USER_GUIDE.md) — full user guide
  ([EN](user/USER_GUIDE_EN.md), [中文](user/USER_GUIDE_CN.md), [中文用户指南](user/中文用户指南.md)).
- [user/中文快速开始.md](user/中文快速开始.md), [user/中文安装指南.md](user/中文安装指南.md),
  [user/中文运行指南.md](user/中文运行指南.md), [user/中文故障排查.md](user/中文故障排查.md) —
  Chinese install/run/troubleshooting guides.
- [user/EXTENSION_GUIDE.md](user/EXTENSION_GUIDE.md)
  ([中文](user/EXTENSION_GUIDE_CN.md)) — Chrome autofill extension.
- [user/BROWSER_AGENT_GUIDE.md](user/BROWSER_AGENT_GUIDE.md)
  ([中文](user/BROWSER_AGENT_GUIDE_CN.md)) — optional Local Browser Agent.
- [user/ANSWER_MEMORY_GUIDE_CN.md](user/ANSWER_MEMORY_GUIDE_CN.md) — answer memory (中文).
- [user/automation_setup_zh.md](user/automation_setup_zh.md),
  [user/dashboard_app_like_launch_zh.md](user/dashboard_app_like_launch_zh.md) —
  optional automation and app-like launch (中文).
- [user/REAL_USAGE_ACCEPTANCE_CHECKLIST_CN.md](user/REAL_USAGE_ACCEPTANCE_CHECKLIST_CN.md) —
  checklist before real usage (中文).

Launchers: normal users start the product from `dist/` (see
[../dist/README.md](../dist/README.md)). All launchers start the same product
in different modes.

## For developers

- [developer/DEVELOPER_GUIDE.md](developer/DEVELOPER_GUIDE.md) — setup, tests, conventions.
- [developer/CONTRIBUTING.md](developer/CONTRIBUTING.md) — contribution rules.
- [developer/AI_PROVIDER.md](developer/AI_PROVIDER.md) — optional AI provider configuration and limits.
- [developer/UX_DESIGN_RULES.md](developer/UX_DESIGN_RULES.md) — binding UI rules for release UI.
- Developer launcher: [../tools/launchers/README.md](../tools/launchers/README.md).

## Architecture

- [architecture/ARCHITECTURE.md](architecture/ARCHITECTURE.md) — canonical product architecture.
- [architecture/ARCHITECTURE_OVERVIEW.md](architecture/ARCHITECTURE_OVERVIEW.md) — one-page summary.
- [architecture/EXTENSION_ARCHITECTURE.md](architecture/EXTENSION_ARCHITECTURE.md) — browser extension boundary.
- [architecture/中文开发架构.md](architecture/中文开发架构.md) — architecture notes (中文).

## Current product plans

These define the next product phase (Quick Apply). They are plans, not shipped
behavior:

- [product/QUICK_APPLY_TARGET_PRODUCT.md](product/QUICK_APPLY_TARGET_PRODUCT.md) — target product definition.
- [product/QUICK_APPLY_IMPLEMENTATION_PLAN.md](product/QUICK_APPLY_IMPLEMENTATION_PLAN.md) — implementation plan.
- [product/USER_CENTRIC_ACCEPTANCE_CRITERIA.md](product/USER_CENTRIC_ACCEPTANCE_CRITERIA.md) — acceptance criteria.
- [product/PRODUCT_ROADMAP.md](product/PRODUCT_ROADMAP.md) — roadmap.

## Independent audits (current)

- [audits/2026-08-14-claude/CLAUDE_INDEPENDENT_PRODUCT_AUDIT.md](audits/2026-08-14-claude/CLAUDE_INDEPENDENT_PRODUCT_AUDIT.md) —
  independent read-only product audit, 2026-08-14, auditor: Claude.

## Release documentation

- [release/V1_RC1_RELEASE_NOTES.md](release/V1_RC1_RELEASE_NOTES.md) — draft
  GitHub Release notes for `v1.0.0-rc.1` (honest what-works / limitations).
- [release/GITHUB_TOPICS.md](release/GITHUB_TOPICS.md) — recommended GitHub
  topics and About description.
- [demo/DEMO_SCRIPT.md](demo/DEMO_SCRIPT.md) — demo GIF shot list, timings,
  and safe-recording setup.
- [release/RELEASE_CANDIDATE_HANDOFF.md](release/RELEASE_CANDIDATE_HANDOFF.md) — 1.0.0-rc.1 frozen handoff.
- [release/GITHUB_RELEASE_READINESS_REPORT.md](release/GITHUB_RELEASE_READINESS_REPORT.md) — release-tree readiness.
- [release/RELEASE_CHECKLIST.md](release/RELEASE_CHECKLIST.md),
  [release/GITHUB_RELEASE_CHECKLIST.md](release/GITHUB_RELEASE_CHECKLIST.md) — release checklists.

## Historical reports (not current documentation)

Everything under [history/](history/README.md) is a point-in-time development
record: old audits, acceptance runs, repair logs, migration plans, and test
reports. **Old PASS claims there may not describe the current product.** They
are retained for traceability only and are not user documentation. Start at
[history/README.md](history/README.md).
