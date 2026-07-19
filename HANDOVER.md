# HackVideo 上线交接说明

> ⚠️ 本仓库是 **Public**。本文件**不写任何真实口令/密钥**(会被全网看到)。当前口令请在私下渠道保管;下面只给占位符和修改方法。

## 线上地址

<https://hackvideo.jhfnetboy.workers.dev>

Cloudflare Worker + D1 + KV,部署在账号 `jhfnetboy@gmail.com`(account `7bf2…a1f2`)。

## 三种角色 / 口令

| 用途 | 谁用 | 口令(占位符) | 说明 |
|---|---|---|---|
| 提交作品 | 各参赛队 | **每队一个邀请码** | 管理员批量生成后分发,单次有效 |
| 评委打分 | 评委 | `JUDGE_PASSCODE` | 所有评委共用,登录时填自己名字 |
| 管理 | 主办方 | `ADMIN_PASSCODE` | 生成邀请码、锁版本、隐藏作品、导出 CSV |

> 还有一个主办方主控 `SUBMIT_PASSCODE`,提交时填它可免邀请码(仅自留应急,别外发)。

## 主办方操作流程

1. **开赛前**:用管理口令登录 → 顶部「邀请码」→ 生成 100/200 个 → 复制,按队分发(每队一个)。
2. **比赛中**:选手在 `/submit` 填 产品名 + GitHub 仓库(必须 Public)+ B站/YouTube 视频链接 + 1–4 张截图 + 邀请码。作品自动上「作品墙」。
3. **评审**:评委在 `/judge` 用评委口令 + 姓名登录,进作品详情按 创新/技术/完成度/展示(各 1–10)打分。
4. **截止**:管理员在作品详情点「锁定评审版本」记录当前 commit,防赛后偷改。
5. **出结果**:`/leaderboard` 看排名,管理员导出 CSV。

## 改口令 / 轮换密钥

```bash
cd HackVideo
export CLOUDFLARE_API_TOKEN=$(grep -E '^oauth_token' ~/Library/Preferences/.wrangler/config/default.toml | head -1 | sed -E 's/.*=[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/')
export CLOUDFLARE_ACCOUNT_ID=7bf23342f21baa5ebfc7bc7b74f5a1f2

echo -n "新的评委口令" | npx wrangler secret put JUDGE_PASSCODE
echo -n "新的管理口令" | npx wrangler secret put ADMIN_PASSCODE
echo -n "新的主控口令" | npx wrangler secret put SUBMIT_PASSCODE
```

其它密钥同理:`AUTH_SECRET`(cookie 签名,轮换会让已登录评委掉线)、`GITHUB_TOKEN`(GitHub API 代理)。

## 常用运维命令

```bash
# 看所有提交
npx wrangler d1 execute hackvideo-db --remote --command "SELECT project_name, team_name, repo_owner, repo_name FROM submissions;"
# 看邀请码使用情况
npx wrangler d1 execute hackvideo-db --remote --command "SELECT COUNT(*) total, SUM(used_by IS NOT NULL) used FROM invite_codes;"
# 重新部署
npx wrangler deploy
```

## 成本

100 个选手 = **免费**。视频走外链不占存储;截图存 KV(几十 MB / 免费 1GB);D1 纯文本忽略;请求量远低于 10 万/天免费额度。

## 当前状态 / 待办

- ✅ 已上线:邀请码、产品名、作品墙(多图轮播卡)、GitHub 代理、README 渲染、评委打分、排行榜、CSV 导出、锁版本。
- ⏸️ 视频直传 R2:代码已保留但关闭(`VIDEO_UPLOAD=off`),当前视频用外链。要开需补 R2 权限 + 绑定,置 `on`。
- 详见 [README.md](README.md)(产品/开发文档)与 [CLAUDE.md](CLAUDE.md)(架构说明)。
