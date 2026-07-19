# HackVideo

黑客松作品提交与展示平台。选手提交一个 **GitHub 仓库 + 演示视频链接 + 产品截图**,官网自动抓取 GitHub 信息生成作品卡,评委在线打分。

A hackathon submission & showcase portal. Each team submits a **GitHub repo + a demo-video link + product screenshots**; the site auto-fetches GitHub info into a work card and judges score online.

**Live / 线上:** <https://hackvideo.jhfnetboy.workers.dev>

---

## 选手怎么交 / How teams submit

一个作品 = **产品名称** + **GitHub 仓库(必须 Public)** + **演示视频链接** + **1–4 张产品截图** + 每队专属**邀请码**。

A submission = **product name** + **GitHub repo (must be Public)** + **demo-video link** + **1–4 screenshots** + your team's **invite code**.

- **代码 / Code**:就是你的仓库本体。Your repo itself.
- **README.md**:项目介绍、队伍、技术栈 —— 评委第一眼看的。The first thing judges read: intro, team, tech stack.
- **PPT**:放仓库 `/docs` 里的 **PDF**(GitHub 能在线预览),别放 `.pptx`。Put a **PDF** in `/docs` (GitHub previews it); avoid `.pptx`.
- **视频 / Video**:**不要**塞进 GitHub(单文件 100MB 限制,会撑爆仓库)。传到 **B站 / YouTube**,贴链接。Don't commit video to Git (100MB/file limit). Host on **Bilibili / YouTube** and paste the link.
- **截图 / Screenshots**:提交时上传,浏览器自动压成 JPEG,作品卡做成可左右翻页的多图轮播。Uploaded at submit time, compressed to JPEG in-browser, shown as a swipeable carousel on the card.

**三条硬规则 / Three hard rules:**
1. 视频/大文件走外链,别进 Git(否则要用 Git LFS,麻烦)。Big files via external links, not Git (LFS is a pain).
2. 仓库必须 **Public**,否则官网和评委看不到(提交时自动校验)。Repo must be **Public** (validated at submit).
3. 截止后评委可一键**锁定评审版本**(记录 commit SHA),防赛后偷改。After the deadline judges can **lock the reviewed commit SHA** to prevent later edits.

---

## 邀请码 / Invite codes

选手侧**不是共享口令**——每队一个**专属邀请码,单次有效**。管理员批量生成(100/200 个)后分发,一个码交一次作品即作废。改稿用提交时返回的**编辑令牌**,不再消耗码。

Teams do **not** share one passcode. Each team gets a **unique, single-use invite code**. The admin batch-generates them and hands one per team; a code is consumed on first submission. Editing later uses the returned **edit token**, not a code.

评委共用一个评委口令(人少、可信),登录时各填姓名区分打分。

Judges share one judge passcode (few, trusted) and type their name at login to attribute scores.

---

## 官网怎么展示 / How the site shows it

- **作品墙 / Work wall**:读 D1 提交列表,每张卡异步调 GitHub API(经 Worker 代理 + 边缘缓存)显示 star / 语言 / 最后提交;主视觉是截图轮播。Cards async-load GitHub stars/language/last-push via a cached Worker proxy; the carousel is the hero.
- **作品详情 / Detail**:内嵌 B站/YouTube 视频 + 沙箱渲染 README + 截图画廊 + 「查看代码」跳转。Embedded video + sandboxed README + screenshot gallery + "view code".
- **打分台 / Scoring**:评委按 4 维度(创新 / 技术 / 完成度 / 展示,各 1–10)打分,排行榜按平均分排序,管理员可导出 CSV。Four dimensions (innovation / technical / completeness / presentation, 1–10 each); leaderboard by average; admin CSV export.

---

## 架构 / Architecture

纯 Cloudflare,单个 Worker 全包,**100 个选手在免费额度内**。All-Cloudflare, one Worker, **free tier covers 100 teams**.

- **Worker**(`src/index.ts`):UI + API + GitHub 代理。UI + API + GitHub proxy.
- **D1**:作品元数据 + 评分 + 邀请码。Submission metadata + scores + invite codes.
- **KV**(`SHOTS`):产品截图(小图,免费 1GB)。Screenshots (small images, 1GB free).
- **登录 / Auth**:口令 + 无状态 HMAC 签名 cookie,**不依赖邮件**。Passcodes + stateless HMAC-signed cookie, **no email**.
- GitHub API 走 Worker 代理带 token(5000 次/小时)+ `caches.default` 边缘缓存,避免前端直连被 60 次/小时限流。Proxied with a token (5000/hr) and edge-cached, avoiding the 60/hr unauthenticated limit.

> 视频存储 / Video storage:当前视频走外链,**不占存储**。若日后开放"直传视频到 R2",代码已保留(`VIDEO_UPLOAD` 开关),补上 R2 权限置 `on` 即可。Video is external today (zero storage). Direct-to-R2 upload code is preserved behind `VIDEO_UPLOAD`; flip it `on` once R2 access is added.

---

## 部署 / Deploy

```bash
npm install

# 建资源(需 Workers + D1 + KV 权限)/ Create resources (needs Workers + D1 + KV)
npx wrangler d1 create hackvideo-db          # 把 database_id 填进 wrangler.jsonc
npx wrangler kv namespace create SHOTS       # 把 id 填进 wrangler.jsonc
npx wrangler d1 migrations apply hackvideo-db --remote

# 设密钥 / Set secrets
npx wrangler secret put AUTH_SECRET          # 随机 32+ 字符 / random 32+ chars
npx wrangler secret put JUDGE_PASSCODE       # 发给评委 / for judges
npx wrangler secret put ADMIN_PASSCODE       # 管理员自留 / admin only
npx wrangler secret put SUBMIT_PASSCODE      # 主办方主控码(可选)/ organizer master (optional)
npx wrangler secret put GITHUB_TOKEN         # gh auth token,或只读 public_repo token

npx wrangler deploy
```

非文本 `vars`(APP_NAME / EVENT_NAME / VIDEO_UPLOAD / MAX_*)在 `wrangler.jsonc` 改。Non-secret `vars` live in `wrangler.jsonc`.

主办方运维见 [HANDOVER.md](HANDOVER.md),架构说明见 [CLAUDE.md](CLAUDE.md)。Organizer ops: [HANDOVER.md](HANDOVER.md); architecture notes: [CLAUDE.md](CLAUDE.md).

---

## 本地开发 / Local dev

```bash
cp .dev.vars.example .dev.vars     # 填口令和 GITHUB_TOKEN / fill passcodes + GITHUB_TOKEN
npm run db:migrate:local
npm run dev                        # http://localhost:8787
npm run typecheck                  # 唯一门禁,无测试套件 / the only gate, no test suite
```

---

## 成本 / Cost (100 teams)

视频走外链 → 无视频存储。截图 4×100≈几十 MB(KV 免费 1GB),D1 纯文本忽略,Workers 请求远低于 10 万/天免费额度。**免费。**

External video → no video storage. Screenshots ~tens of MB (KV free 1GB), D1 text negligible, requests far under 100k/day free. **Free.**
