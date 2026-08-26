# GitHub Topics 建议

Topics 是 GitHub 站内搜索与 Explore 推荐的主要信号,也是陌生人判断仓库领域的
第一眼。设置路径:仓库首页 → About 区域右上角齿轮 → Topics(上限 20 个,
建议 10–15 个,全小写,用连字符)。

## 推荐列表(按优先级)

第一梯队——领域大词,搜索量最大:

```
ai
job-search
job-application
resume
autofill
```

第二梯队——精准区分定位:

```
local-ai
local-first
llm
job-agent
career
```

第三梯队——技术栈与长尾发现:

```
automation
playwright
chrome-extension
nodejs
cover-letter
```

一次性粘贴(GitHub 的 Topics 输入框支持逗号分隔):

```
ai, job-search, job-application, resume, autofill, local-ai, local-first, llm, job-agent, career, automation, playwright, chrome-extension, nodejs, cover-letter
```

## 取舍说明

- `local-first` 与 `local-ai` 都保留:前者是架构社区的身份词,后者是
  LM Studio / Ollama 用户的搜索词,受众不同。
- 不放 `machine-learning` / `deep-learning`:项目不训练模型,放了会吸引错的
  受众并稀释相关性。
- 不放 `job-board` / `web-scraping`:前者不是本项目,后者容易引来 ToS 质疑,
  而本项目只访问公开页面且不绕过任何验证。
- `resume-builder` 可作为替补:若某梯队词效果不佳可轮换,但当前 15 个已够。

## 配套的 About 描述(同一处设置)

英文(GitHub description 只有一行,建议 ≤ 150 字符):

```
Local-first AI job assistant: web-wide job discovery, explainable matching, facts-only resume tailoring, autofill — you always click Submit.
```

Website 栏可留空,或指向 README 的中文版链接。
