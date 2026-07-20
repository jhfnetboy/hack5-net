# 首页三入口 + Mini 黑客松 — 产品 + 技术方案(设计稿)

> 两件事:①平台首页改成**三种黑客松入口**;②设计 **Mini 黑客松**(第三种模式)——
> 面向非专业 / 非开发者的轻量版,更简单、更快、内置更多工具辅助。
> 原则不变:**底层组件复用,业务按 `mode` 隔离**(已在 secret 模式验证可行)。

---

## 第一部分:平台首页三入口

hack5.net 落地页从"一个发起按钮"改为**三张并排入口卡**,一眼看清三种规模/场景:

| 入口 | 副标题 | 对应 mode | 定位 |
|---|---|---|---|
| **⚡ 常规黑客松** | 10 分钟启动 · 200 人以下规模 | `open`(现有) | 公开、报名、作品墙、评审——通用规模 |
| **🔒 企业私密黑客松** | 10 分钟启动 · 邀请制、不公开源码 | `secret`(已上线) | 门禁 + Demo 评审 + 私有仓库协作者,付费 |
| **✨ Mini 黑客松** | 5 分钟启动 · ≤5 队 ~20 人 · 面向非开发者 | `mini`(本方案设计) | 极简、极快、内置工具辅助,给非专业人群 |

- 每张卡:图标 + 标题 + 一句副标题 + 「启动 →」按钮 → 进对应的发起流程(mode 预置)。
- 三卡下方保留「👀 看 Demo 示例」。
- 移动端堆叠;深浅色自适应(复用现有 token)。
- 实现:改 `renderPlatformLanding`,发起页按入口的 mode 走不同表单(常规/私密已有,mini 见下)。

---

## 第二部分:Mini 黑客松

### 1. 定位
给**非专业 / 非开发者**的小型、快速、敏捷黑客松:课堂、社群、团队 offsite、工作坊。
关键词:**极简、极快、被工具托着走**。≤5 支队、每队 1–3 人(~20 人)。

### 2. 与常规/私密的核心差异

| 维度 | 常规 open | Mini |
|---|---|---|
| 发起 | 名称+子域名+简介+banner | **只填名称**(自动子域名、默认 banner、简介可选)→ 5 分钟 |
| 参赛门槛 | GitHub 公开仓库(强制) | **不需要 GitHub / 不需要代码**;交一个链接即可 |
| 提交内容 | 仓库+视频+截图+邀请码 | **作品链接(任意 URL)+ 一句话介绍 + 截图**;链接可以是 no-code 应用 / 网站 / Figma / 文档 / 视频 |
| 加入 | 每队邀请码 | **开放提交**(小规模可信),或一个共享口令 |
| 评审 | 四维 1–10 打分 | **极简**:一键点赞/星标 或 单项 1–5;瞬时出结果 |
| 工具辅助 | 无 | **内置**:创意提示、AI 起名/写简介、AI 海报、推荐工具清单 |
| 规模护栏 | 无 | 最多 5 队(超了提示升级到常规) |

### 3. 为非开发者"托着走"的工具辅助(Mini 的灵魂)
1. **创意提示 / 模板**:发起后给主办方几个赛题模板;参赛者提交时给"我可以做什么"的点子提示。
2. **AI 写简介**:参赛者填链接后,一键让 AI 根据链接主题**生成项目简介**(复用 OpenAI,轻量文本,便宜)。
3. **AI 起名**:给项目起名建议。
4. **AI 海报**:复用现有免费固定风格 AI 海报,一键出图。
5. **推荐工具清单**:一页"非开发者也能做出作品"的工具(no-code 建站、AI 建站、表单、设计),降低门槛。
6. **一步步引导**:发起和提交都是**向导式**(下一步、下一步),不堆字段。

### 4. 技术设计(复用 + 隔离)

**开关**:`tenants.mode` 增加 `'mini'`(现为 `open|secret`)。所有 mini 逻辑只在 `mode==='mini'` 生效,open/secret 不受影响。

**直接复用**:多租户/建站/子域名/D1/KV、submissions 表、scores 表(简化用法)、AI 海报、组织资料、深浅色、i18n、上传压缩管线。

**Mini 专属**:
| 能力 | 做法 |
|---|---|
| 5 分钟发起 | 发起向导只要 name;后端自动生成子域名(name→slug+随机后缀)、mode='mini'、默认 banner;简介可选 |
| 无代码提交 | `createMiniSubmission`:`link_url`(任意 http/https)+ 简介 + 截图(复用图片上传),**不要求 GitHub**;submissions 复用,repo 字段可空,新增 `link_url TEXT` |
| 开放提交 | 无邀请码;可选共享口令(简单);小规模够用 |
| 极简评审 | 复用 scores 表,但只用一个维度(或点赞计数);前端评审台简化成"点赞/1–5 星";排行榜按票数 |
| 5 队上限 | createMiniSubmission 校验该租户不同队数 ≤ 5,超出提示升级常规 |
| AI 写简介/起名 | 新增 `POST /api/tenant/mini/assist`(复用 OpenAI 文本,便宜,限流+每场配额,像 AI 海报那样)|
| 工具清单 | 静态一页(数据常量),导航「工具」 |

**数据模型(增量,open/secret 不受影响)**:
```sql
-- mode 已存在(open|secret),值域加 'mini'(无需改列)
ALTER TABLE submissions ADD COLUMN link_url TEXT;   -- mini:任意作品链接(no-code/网站/文档/视频)
-- 简介复用 description;截图复用现有 shots;评审复用 scores(单维度用法)
```

### 5. UX 流程
- **主办方**:首页点「Mini 5 分钟」→ 只填活动名 → 一键创建(自动子域名+默认款)→ 拿到分享链接,发群里。
- **参赛者**:打开链接 →「提交作品」向导:①贴作品链接 → ②(可选)AI 帮我写简介 → ③传 1–3 张截图 → 交。
- **评审/围观**:作品墙每张卡一键点赞;排行榜按赞数;主办方一键出结果。

### 6. 分期
- **Phase 1(MVP)**:mode='mini' + 极简发起向导 + 无代码提交(link+简介+截图)+ 点赞评审 + 5 队上限 + 首页三入口。
- **Phase 2**:AI 写简介/起名、推荐工具清单页、共享口令、更多模板。

### 7. 已确认决定(拍板)
1. **评审 = 一键点赞**:作品墙每张卡点赞,排行榜按赞数,瞬时出结果。复用 scores 表(或单独 likes 计数)。
2. **加入 = 完全开放**:无邀请码、无口令,拿到链接即可提交(小规模可信)。
3. **付费 = 后付费(需充值),每人 1 次免费**:每个用户可**免费办 1 场 mini**;之后需**充值后付费**;可由**赞助商代付**。→ 复用 users.quota 思路,给 mini 单独计免费额度 + 充值/赞助入口(计费细节 Phase 2)。
4. **规模 = 软建议 ~50 人以下**:5 队只是参考,不做硬上限;发起页/文档建议「50 人以下用 mini,更大用常规」,不强制拦截。

### 8. 对接 AuraAI WorkBench:非开发者"想法→自动建应用"(已调研)

**愿景**:mini 参赛者(非开发者)输入一句想法 → WorkBench 追问补全 → 生成规格 → 自动编码 → 部署成能跑的应用,每个 mini hackathon 一个代码子目录 / 子仓库。这让 mini 从"交个链接"升级为"**AI 帮你把想法直接做成应用**"——Mini「工具托着走」的终极形态。

**WorkBench 是什么**(`/Users/jason/Dev/auraai/Self-FDE-WorkBench`,线上 workbench.idoris.ai = 静态落地页):一条三段流水线,一个仓库三个子项目——
- `fde-copilot`(Next.js + Claude Agent SDK):**想法 → 规格**。数据模型 `clients/<client>/projects/<project>/`,天然多项目目录隔离。**有 HTTP API 且带 `x-workbench-token` 鉴权**。
- `loop-engineer`(TS CLI):**规格 → 代码**。planner(Claude 订阅)+ coder(GLM)+ 跨模型评审(Kimi/DeepSeek),worktree 隔离、质量闸全绿才合进 integration 分支、人守 main。**没有 HTTP API,靠文件驱动**:丢一个 `loop.json` 进 watchDirs,`pnpm run run` 触发。
- `capability-packs`:原子能力(生成/发布/研究)。
- **运行前提硬**:依赖常驻 Mac Mini(本地 claude login + `claude -p` 子进程 + 便宜模型 key),不能 serverless。

**契合点(现成的)**:
- fde-copilot 的 `clients/<hackathon>/projects/<idea>/` = **一场黑客松一个 client、每个想法一个 project**,目录级隔离,正好对上"每场一个子目录"。
- `POST /api/chat` 就是"非开发者输入想法 → 追问 → 生成规格",还自动区分"AI 能查的" vs "要问人的",非常适合黑客松模糊输入。
- 每 project 独立 token 账本(`state.json` / `GET /api/usage`)——天然能算"每支队伍用了多少 token"。

**缺口(hack5 要补的胶水,约 60%)**:
1. loop-engineer **无编排 API**——要么 hack5 在后端机上写 `loop.json` 到 watchDirs 再调 `pnpm run run`,要么给它加一层薄 HTTP wrapper。
2. **"每个想法建一个子仓库 + 部署上线"没有自动化**——loop-engineer 只做到合并 integration 分支 + 尽力 `gh pr create`,不含部署。要 `gh repo create` per idea + 跑完触发 `wrangler pages deploy`。这是双方对接工作量的大头。
3. **多租户鉴权隔离**是明确的"后续工程"(现在单个 `WORKBENCH_TOKEN`);D1 决策里"生成类可中心化多租户"没被否,方向对但未实现。
4. **并发**:v0 单 repo 串行一次一任务,几十个想法会排队(多 repo 并行是 v0.4)。
5. **计量已就位但没有出账单代码**——用量统计到位,结算/发账单未实现。

**建议对接路线(务实,先跑通 1 个想法)**:
- 入口选 **fde-copilot `/api/chat`**(唯一现成、带鉴权的编程面):每场黑客松 `POST /api/clients`,每个想法 `POST .../projects`,参赛者自然语言走 `/api/chat` 到 `readiness=loop-ready`,`POST /api/commit` 落库。
- **loop-engineer 走文件缝 + 调度**:hack5 后台在 Mac Mini 上为每个 loop-ready 项目跑 `pnpm plan <projectDir> --repo <为该idea新建的repo>`,再 `pnpm run run --drain`。
- **部署环 hack5 自建**:loop 跑完 → hack5 的 deploy hook 建子仓库 / CF 项目并 `wrangler deploy`。
- **计费**:复用 fde-copilot per-project token 用量 → hack5 按 hackathon/team 汇总,对齐 mini「每人 1 次免费、之后后付费、可赞助代付」。

### 9. 给 WorkBench 提的诉求清单(对接需要它补的)
1. **给 loop-engineer 一个薄 HTTP 编排 API**:`POST /plan`、`POST /run`、`GET /status`,复用 `WORKBENCH_TOKEN`——最小改动让 hack5 不碰文件系统就能触发编码循环。
2. **per-idea 建仓 + 部署的自动化 hook**:loop 跑完自动建子仓库 / CF 项目并部署(双方都缺的部署环)。
3. **多租户鉴权隔离**:per-hackathon / per-team 的 token 作用域 + 目录/仓库隔离(替代单一 `WORKBENCH_TOKEN`)。
4. **计量 → 出账单 API**:基于现有 per-project token 用量,提供"按 hackathon/team 出账单 + 后付费结算"接口,支持 mini 的免费额度 + 赞助代付。
5. **并发**:多 repo / 多 worktree 并行(黑客松几十个想法同时跑,v0.4)。
6. **回调 webhook**:项目 loop-ready / 编码完成 / 部署完成时回调 hack5,好更新参赛者作品状态。

**核心诉求(用户明确,B 的主线)—— 按参赛者开隔离实例 + 自动入库**:
> 每个参赛者(开发者)**按名字开一个实例**,拿到**专属 URL、互不干扰**,进入即可开始开发。
> 该参赛者与 WorkBench 的**全部对话内容 + 生成的规格文档 + loop-engineer 产出的代码**,
> **全部自动提交到一个新建的 GitHub 仓库**——仓库名由参赛者命名,建在**我方提供 PAT 的专用 GitHub 账户**下。
>
> **重要区分(已确认)**:
> - **Mini**:由**我方 PAT 账户建「公有」仓库**(不是私有),每个参赛者一个,帮非开发者把想法做成应用。
> - **企业私密(secret)**:参赛者用**自己账号下的私有仓库**,与我方无关(填 repo URL + 加评委为协作者,已实现)。我方**只**为 Mini 建仓。
> - PAT 需 **Repository access = All repositories** + Administration/Contents 写权限(实测建公有仓+推子目录文件均通过)。

拆成对 WorkBench 的具体要求:
- (a) **per-participant 实例/会话隔离**:按参赛者 slug 开 `clients/<hackathon>/projects/<participant>/`(fde-copilot 已有目录隔离),每人一个可访问 URL,鉴权 token 按参赛者作用域。
- (b) **自动建仓 + 全量入库**:实例创建时用**我方 PAT**在专用账户下 `gh repo create <participant-named-repo>`;`conversation.jsonl`、6 份规格 `.md`、loop 产出的代码**都 push 到这个仓库**(fde-copilot 的 commit + loop-engineer 的 `--repo` 指向同一个)。
- (c) **PAT 注入**:我方提供 GitHub PAT(专用账户),WorkBench 用它建仓 + push;权限最小化(仅该账户建仓/推送)。
- (d) 计费按参赛者/场次归集,后付费出账单(对齐 mini 免费额度 + 赞助代付)。

> 这份诉求先给你 review,确认后再正式提给 WorkBench 团队(goutou)。

---

*设计稿。首页三入口可先做(常规/私密已就绪,Mini 待建);Mini 待你在 §7 拍板后进入实现(照旧开 PR)。底层复用、逻辑隔离贯穿。hack5 · Mycelium。*
