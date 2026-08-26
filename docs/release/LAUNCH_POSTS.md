# Launch post drafts

> Ready-to-paste drafts for the initial promotion round. Each platform has its
> own culture — do not cross-post the same text. Post from your own account,
> stay in the thread for the first day, and treat every hard question as free
> product feedback. Never ask friends to upvote (Hacker News and Reddit both
> detect and punish this).
>
> Suggested order: Chinese launch (V2EX, or 掘金 if you have no V2EX invite)
> → Reddit r/localllama → Reddit r/SideProject →
> Hacker News Show HN. One platform every 1–2 days; fix anything the previous
> round surfaced before the next post.

---

## 1. V2EX —「分享创造」节点

> 定位:这不是产品发布,是**应届生拿作品求点评**。V2EX 对推广帖警惕,但对
> 认真做东西、诚实求反馈的人很友好——同样的项目,这个姿态收到的回复质量高
> 得多。全篇不吹,不喊口号,把做了什么、怎么做的、哪里还不行说清楚。

**标题(三选一):**

> 刚毕业还没找到工作,写了个本地优先的 AI 求职助手,想请大家点评一下

> 应届待业中,做了个开源的 AI 求职助手(本地跑、不编造简历),来求拍砖

> 求点评:一个本地优先的 AI 求职助手,应届生的第一个像样的项目

**正文:**

大家好,我是今年刚毕业的应届生,目前还没找到工作。

投简历投了一阵子,最烦的不是写简历,是重复劳动:每个公司一套申请表,同样的
问题答几十遍;想针对每个岗位改一版简历,手改太慢,交给 AI 又怕它瞎编——
你没做过的项目、没有的技能、不存在的数字,它写起来一点不含糊。

与其继续这么耗着,我想干脆自己做个东西,一边解决自己的问题,一边当作一个
正经项目练手。做了几个月,现在到了一个我自己敢拿出来给人看的状态,所以来
发个帖,想请各位帮忙看看、点评一下——不管是产品思路、代码质量还是哪里做得
不对,都想听。

## 它是什么

一个本地优先的求职助手,全部跑在自己电脑上:

- **全网找岗位**:搜公司招聘页和公开 ATS(Greenhouse / Lever / Ashby 等),
  也能直接粘贴岗位链接导入;
- **可解释匹配**:每个分数拆成技能、经验、学历、地点、资历五个维度,差距
  直接点名,而不是甩一个神秘的「93% 匹配」;
- **简历/求职信定制,句句有出处**:生成的每句话必须能追溯到你确认过的资料;
- **自动填表**:支持分步向导表单,可以用 Chrome 扩展在自己的浏览器里填,
  或者开一个可见的专用浏览器;答过的问题确认后会记住,下次自动复用;
- **本地优先**:简历、资料、申请历史全是本地文件。AI 可选,接 LM Studio /
  Ollama 本地模型或自己的 API Key;
- **红线**:绝不自动点提交,绝不碰登录、验证码、MFA。这是设计,不是没做完。

## 我自己觉得做得最有意思的一块

「AI 不编造简历」这件事,如果只在 prompt 里写一句「请勿虚构」,那是自律,
不是保证。我的做法是把它变成一道**校验关卡**:

1. 生成的每个句子被拆开,提取里面的事实性元素——数字、专有名词、技能词、
   雇主名;
2. 每个元素回到用户已批准的资料里做溯源匹配。数字要求整体边界匹配(避免
   「3 年」在「13 年」里蒙混过关),中文内容要求原文出现,还要处理全角数字、
   标点切断专名这些边界情况;
3. 只要有一个元素找不到出处,**整份输出作废**,回退到确定性模板版本——不是
   删掉那一句,是整份重来,避免「改一句留一堆」。

这套规则被离线测试钉死了。我还专门用多个 AI agent 对抗性地攻击过这套校验,
找出并修掉了十几个绕过方式。这块是我做下来最有成就感的部分,也最想听听
各位觉得思路有没有问题。

架构上是纯 Node.js,无构建步骤,状态全是带版本的 JSON 文件。匹配、解析、
定制、搜索规划都是确定性模块,AI 只是上面一层可选且被严格校验的增强——
不配 AI,产品本身也是完整可用的。约 460 条离线测试覆盖全部行为,包括每一条
安全规则。

## 想试的话

```
git clone https://github.com/Kerrylala/resume_jobs_quick_apply.git
cd resume_jobs_quick_apply
npm install && npm run demo
```

`npm run demo` 是完全合成、完全离线的演示:假候选人、假岗位、本机上的假申请
表单,不读取也不提交任何真实的东西。

仓库(MIT):https://github.com/Kerrylala/resume_jobs_quick_apply
README 顶部有 22 秒的 GIF 演示,中英文文档都有。

## 目前还不行的地方,如实说

- Workday 只能发现,不能填;
- 页面角标和扩展弹窗现在只有中文(控制台界面是中英双语的);
- 简历定制质量取决于你接的模型,确定性回退版本的文字会朴素一些;
- 主要在 Windows 上实测,macOS/Linux 跑同一套离线测试但实战里程少。

## 最后

我知道求职类工具这个赛道不缺东西,我做的也谈不上多新。但这是我第一个从头
设计、认真写测试、认真写文档做完的项目,想听听有经验的人怎么看:

- 产品思路上,有没有哪里是想当然了?
- 代码和架构上,有没有明显外行的地方?
- 如果你也在找工作,这东西对你有用吗,缺什么?

谢谢各位。有问题也欢迎直接在 GitHub 提 issue。

**发帖注意:**
- 节点选「分享创造」(v2ex.com/go/create);
- 首楼可以贴 GIF:直接贴 README 里那个 demo.gif 的 raw 链接;
- 别在标题里写「最强」「颠覆」这类词——和这个帖子的姿态完全不搭;
- 有人质疑「又一个 AI 套壳」时,把接地校验那套机制讲清楚(整体拒收 + 确定性
  回退 + 测试钉住),这是和套壳的本质区别;
- **求点评的帖子,回帖率高但也更容易挨批评**。挨批评是好事:V2EX 上愿意花
  时间指出问题的人,给的都是真反馈。全部当成产品输入,别辩解;
- 当天每条回复都回,第二天再回一轮。

---

## 1b. 掘金 / 知乎 —— 中文首发替代方案

> V2EX 现已要求邀请码激活新账号,拿不到码时用这一篇代替中文首发。掘金注册无
> 门槛、受众是开发者、文章有长尾搜索流量。同一篇稍作调整也可发知乎、CSDN、
> 少数派。发布时选「开源」「AI」「求职」相关标签。

**标题(掘金偏好带场景的标题):**

> 秋招网申填到麻,我开源了一个本地 AI 求职助手:可解释匹配 + 绝不编造的简历定制 + 自动填表

**正文:**

### 起因

秋招投简历最折磨的不是写简历,是**重复劳动**:每个公司一套申请表,同样的问题
答几十遍;每个岗位想改一版针对性的简历,但手改太慢,交给 AI 又怕它瞎编——
你没做过的项目、没有的技能、不存在的数字,它写起来一点不含糊。

市面上的自动投递工具大多是云服务:简历传到别人服务器上,替你发出你没看过的
申请。我想要的是反过来的东西,所以自己做了一个。

### 它是什么

**Resume Jobs AI**,一个本地优先的求职助手,全部跑在你自己电脑上:

- **全网岗位发现**:搜索公司招聘页和公开 ATS(Greenhouse / Lever / Ashby 等),
  也能直接粘贴岗位链接导入;
- **可解释匹配**:每个分数拆成技能、经验、学历、地点、资历五个维度,差距直接
  点名,而不是甩给你一个神秘的「93% 匹配」;
- **句句有出处的简历/求职信定制**:生成的每句话必须能追溯到你确认过的资料;
- **自动填表**:支持分步向导表单,可以用 Chrome 扩展在你自己的浏览器里填,
  或者开一个可见的专用浏览器;答过的问题确认后会记住,下次自动复用;
- **本地优先**:简历、资料、申请历史全是本地文件;AI 可选,接 LM Studio /
  Ollama 本地模型或自己的 API Key;
- **红线**:绝不自动点提交,绝不碰登录、验证码、MFA。

### 技术上比较有意思的一块:怎么让 AI「不能」编造

「不编造」如果只靠 prompt 里写一句「请勿虚构」,那是自律,不是保证。这个项目
的做法是把它变成一道**校验关卡**:

1. 生成的每个句子被拆解,提取其中的**事实性元素**——数字、专有名词、技能词、
   雇主名;
2. 每个元素回到用户已批准的资料里做溯源匹配。数字要求**整体边界匹配**(避免
   「3 年」在「13 年」里蒙混过关),中文内容要求**原文出现**,还要处理全角
   数字、标点分隔的专名子串等边界情况;
3. 只要有一个元素找不到出处,**整份输出作废**,回退到确定性模板版本——不是
   删掉那句话,是整份重来,避免「改一句留一堆」。

这套规则被离线测试钉死了。中英双语内容让边界情况变多不少:全角数字、CJK 连续
未溯源片段、专名在标点中间被切断……每一类都得单独处理。我还用多个 AI agent
对抗性地攻击过这套校验,找出并修掉了十几个绕过方式。

架构上是纯 Node.js,无构建步骤,全部状态是带版本的 JSON 文件。匹配、解析、
定制、搜索规划都是**确定性模块**,AI 只是上面一层可选且被严格校验的增强——
不配 AI,产品本身也是完整可用的。约 460 条离线测试覆盖全部行为,包括每一条
安全规则。

### 试一下

```bash
git clone https://github.com/Kerrylala/resume_jobs_quick_apply.git
cd resume_jobs_quick_apply
npm install && npm run demo
```

`npm run demo` 是完全合成、完全离线的演示:假候选人、假岗位、本机上的假申请
表单,不读取也不提交任何真实的东西。想正式用就 `npm start`,打开
127.0.0.1:8767 上传简历。

仓库(MIT):https://github.com/Kerrylala/resume_jobs_quick_apply
README 顶部有 22 秒 GIF 演示,中英文文档都全。

### 当前的坑,如实说

- Workday 只支持发现,不能填;
- 页面角标和扩展弹窗目前只有中文(控制台界面是中英双语的);
- 简历定制质量取决于你接的模型,确定性回退版本文字会朴素一些;
- 主要在 Windows 上实测,macOS/Linux 跑同一套离线测试但实战里程少。

欢迎试用拍砖。有问题直接提 issue,中英文都收。

**发帖注意:**
- 掘金标签选:开源、人工智能、Node.js、求职;
- 知乎可发到「开源项目」「求职」话题下,正文基本不用改;
- 少数派需要过编辑审核,可以在掘金反馈不错之后再投,通过率更高;
- 别在标题里写「最强」「颠覆」这类词,技术社区反感,而且和项目气质不符。

---

## 2. Reddit — r/localllama

**Title:**

> I built a local-first job application agent that runs on LM Studio/Ollama — and rejects any AI output that invents resume facts

**Body:**

Job hunting means answering the same questions on dozens of ATS portals, and I
didn't want to hand my resume and work history to yet another cloud service —
or let an LLM "improve" my resume by inventing skills I don't have.

So I built this: a local Node.js dashboard that finds jobs across public
career pages, scores each match with an explainable per-dimension breakdown,
tailors a resume/cover letter, and autofills applications — with a hard rule
that the final Submit click is always mine.

The parts this sub might care about:

- **Local models are first-class**: LM Studio and Ollama are auto-detected;
  any OpenAI-compatible endpoint works. No cloud account, no telemetry.
- **Grounding is enforced by code, not prompts**: every sentence in a
  generated resume/letter must trace to a fact in your approved profile. If
  the model invents a skill, number, or employer, the whole output is rejected
  and a deterministic fallback is used. This survived an adversarial review
  pass and is pinned by tests (including full-width digits and CJK edge
  cases, since the app is bilingual EN/中文).
- **AI is optional**: the deterministic product (search, matching, autofill,
  answer memory) is complete without any model. The LLM only adds fluency and
  a clearly-labeled semantic opinion on match scores — it can never push a job
  past a failed hard filter.
- **460+ offline tests** pin the behavior, including the safety rules (never
  clicks Submit, never touches login/CAPTCHA/MFA).

`npm run demo` runs a fully synthetic offline walkthrough (fake candidate,
fake jobs, fake form on localhost) so you can see the whole flow without
touching anything real.

Repo: https://github.com/Kerrylala/resume_jobs_quick_apply (MIT)

Honest limitations: Workday is discovery-only, the page-side helper chip is
Chinese-only for now, and tailoring quality depends on the model you bring.
Curious what local models people would reach for here — I've mostly tested
with mid-size instruct models.

**发帖注意:**
- Flair 选 "Resources" 或该 sub 当前的项目分享 flair;
- 结尾那个开放问题(哪个本地模型合适)是真问题,也让帖子不像纯广告;
- 有人问模型效果时,如实说测试过什么、没测过什么。

---

## 3. Reddit — r/SideProject

**Title:**

> I got tired of job application forms, so I built a local AI assistant that fills them — but never clicks Submit

**Body:**

Every job portal asks the same 30 questions. Every "AI resume tool" wants my
data on their server and happily invents skills I don't have. So I spent the
last months building the opposite:

**Resume Jobs AI** — a local-first job application assistant. Everything runs
on your machine:

- finds jobs on public career pages and ATS boards, or imports any job URL;
- explains every match score dimension by dimension, names the real gaps;
- tailors your resume and cover letter with a hard grounding rule: any AI
  output that invents a fact is rejected wholesale;
- autofills applications (multi-step wizards included) via a Chrome extension
  or a visible dedicated browser;
- remembers your confirmed answers and reuses them next time;
- **never** clicks Submit, never logs in, never touches CAPTCHAs. You stay
  the human in the loop.

AI is optional — plug in LM Studio/Ollama or your own API key, or run it
fully deterministic. MIT licensed, no cloud, no telemetry, 460+ offline
tests.

22-second demo GIF in the README, and `npm run demo` gives you a fully
synthetic offline walkthrough.

https://github.com/Kerrylala/resume_jobs_quick_apply

Would love feedback — especially from anyone mid-job-hunt right now.

**发帖注意:**
- r/SideProject 允许直接推广,但发布前看一眼当前置顶规则;
- 也可考虑 r/opensource(规则更严,标题要弱化推广感)。

---

## 4. Hacker News — Show HN

**Title(80 字符内,已核):**

> Show HN: A local-first job application agent that can't invent resume facts

**URL:** https://github.com/Kerrylala/resume_jobs_quick_apply

**首评(提交后立刻自己评论,这是 Show HN 的惯例):**

Hi HN — I built this while watching "AI job apply" tools do two things I
didn't want: hold my resume and history on their servers, and let an LLM
freely rewrite my resume, invented skills included.

Resume Jobs is a local Node.js app (no build step, MIT) that searches public
career pages and ATS boards, scores each job with an explainable
per-dimension breakdown, tailors a resume/cover letter, and autofills
applications — while the final Submit is always a human click.

The technically interesting part is the grounding layer: every sentence of
generated output must trace to a fact in the user's approved profile. A
claim that doesn't — an invented skill, a number that appears nowhere, an
employer never mentioned — rejects the entire output and falls back to a
deterministic version. "Can't invent" in the title means enforced by
validation code and ~460 offline tests, not by prompt engineering. Getting
this right for bilingual (English/Chinese) content was most of the fun:
full-width digits, CJK substring matching, and proper-noun edge cases all
needed their own rules.

Safety boundaries are hard-coded the same way: it never clicks Submit, never
logs in, never touches CAPTCHA/MFA, and the Chrome extension only ever talks
to 127.0.0.1 — page URLs leave a tab only for hosts with an active fill
session the user started.

Honest limitations: Workday is discovery-only; the page-side helper chip is
currently Chinese-only; tailoring quality depends on the model you bring
(local via LM Studio/Ollama, or your own API key — AI is optional and off by
default).

`npm run demo` runs a fully synthetic offline demo. I'd genuinely like to
hear where the grounding validation can be beaten — adversarial reviews
found and fixed several bypasses already, and I doubt they were the last.

**发帖注意:**
- 美东工作日早上 8–10 点提交(北京时间晚 8–10 点);
- 绝不拉人点赞,绝不用小号顶帖;
- HN 用户会真的去读 SECURITY.md 和代码,回答问题时指向具体文件和测试最有说服力;
- 没上首页很正常,可以在下一次大版本时再 Show HN 一次(HN 允许间隔后重发)。

---

## 通用红线

- 所有帖子由你本人的账号发布;
- 演示素材只用仓库里已有的合成截图/GIF,绝不现场用真实资料录屏;
- 不承诺没有的功能;被问到没做的就说在 Roadmap 或不在边界内;
- 发布首日守帖回复;所有质疑先当成产品反馈记 issue。
