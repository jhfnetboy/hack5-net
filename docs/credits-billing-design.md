# 积分 / Token 计费设计(mini「做成应用」)

> 目标:mini 参赛者用 `/make` 建应用会消耗 AI token。免费额度用完后,按 **token → 积分** 实时扣费继续。核心红线:**实时扣、防透支**。

## 0. 现阶段:本地积分(phase 1b,已实现)

**先不接外部积分 API,hack5 自己持有余额** —— 每个参赛者 email 一个本地积分账户(`participant_credits` 表,全局跨活动),**注册时默认发 `CREDITS_SIGNUP_GRANT`(默认 300)积分**,`INSERT OR IGNORE` 保证每 email 只发一次。`GET /api/tenant/mini/credits`(#47 验证会话)读本地余额。充值成本 / 充值入口待定。

> 下面第 2 节的**外部积分 API**是后续可选路径(若积分要跨系统流通再接);现阶段 hack5 本地库即权威。扣费(spending)待 WorkBench 回传每 job `costUsd` 后接(见 §5)。

## 1. 概念

| 概念 | 说明 |
|---|---|
| **token** | AI 工作量单位。`/make` 的 chat 每轮 + 建应用的 loop(拆规格/编码/评审)都消耗,由 **WorkBench 上报**。 |
| **积分(credit)** | 用户的钱。余额在**外部系统**,hack5 通过 email 查询/扣减。积分从哪来(充值/赞助)hack5 不管。 |
| **价格** | `CREDITS_PER_1K_TOKENS`(每 1000 token 折多少积分),可配置。`cost = ceil(tokens/1000 × rate)`。 |
| **身份** | 参赛者 **email**(#47 验证会话 / mini 提交 email)。**email ↔ 积分账户**一一绑定。 |
| **免费额度** | 现状保留:每 email 免费建 **1** 个应用(`FREE_LAUNCHES`),之后走积分。 |

## 2. 外部积分 API 契约(hack5 调用 → 你实现)

hack5 用 `CREDITS_API_SECRET` 做 HMAC 签名调用 `CREDITS_API_URL`。**你按这个契约实现你的 API 即可**(积分怎么来你自己管)。

| 端点 | 入参 | 出参 | 用途 |
|---|---|---|---|
| `POST /balance` | `{ email }` | `{ email, credits }` | **实时余额**(供「按 email 查积分」+ 门禁预检) |
| `POST /reserve` | `{ email, credits, ref }` | `{ ok, credits, holdId }` | **预扣/占用**(防透支:余额 < credits 时 `ok:false`) |
| `POST /settle` | `{ ref, actualCredits }` | `{ ok, credits }` | 结算实际用量,释放多占的 |
| `POST /release` | `{ ref }` | `{ ok }` | 任务失败,释放占用 |

- 全部 **按 `ref` 幂等**(ref 由 hack5 每次 build/turn 生成,重试不重复扣)。
- 若你只想给「余额查询 + 扣减」两个端点也行,hack5 可退化为**预扣估算 + 事后退差**;但 `reserve/settle` 是最干净的**防透支**路径,推荐。

## 3. 实时扣费 · 防透支流程(你强调的红线)

token 实际用量**跑完才知道**,所以要么预授权占用、要么每步小额实时扣:

- **chat 每轮**(小、可控):每轮**发起前**校验 `余额 ≥ 单轮估算`,不足 → `402`;跑完 `settle` 实际。单轮便宜,预占小额即防透支。
- **build / launch**(大、跑完才知):
  1. **发起前**估算本次上限 `maxCost` → `reserve(maxCost)`。**余额不足直接 402**(带充值入口),**不建仓、不跑 loop** → 从源头防透支。
  2. 建仓 + 跑 loop。
  3. WorkBench 回调/usage 报回**实际 token** → `settle(actual)`,释放多占。
  4. loop 失败 → `release`,不扣。
- **免费额度**:每 email 首次 build 免费,不走 reserve。

> 关键:**先 reserve 再干活**,任何真实消耗(建仓/跑 loop/调模型)之前余额已被占住,账户永远扣不到负。

## 4. hack5 侧结构(本 PR 初始化)

- **D1 `credit_ledger`**:本地流水(审计 + 幂等)。hack5 **不持有余额**(外部为准),但记录每笔 reserve/settle/release,用于对账 + 幂等 + 用量展示。
- **配置**:`CREDITS_API_URL` / `CREDITS_API_SECRET` / `CREDITS_PER_1K_TOKENS` / `CREDITS_ENABLED`(总开关,**关=现状不变**,免费额度逻辑照旧)。
- **`src/credits.ts`**:balance / reserve / settle / release 客户端(HMAC)+ 成本换算。
- **查询端点** `GET /api/tenant/mini/credits`:登录参赛者按自己 email 查余额(你要的「email 可查积分」)。未配置 → `{enabled:false}`。

## 5. token 成本来源(跨 WorkBench)—— ✅ 已就绪

WorkBench 侧已实现:`GET /api/usage`(可带 `?client=`)返回 **per-project + global 的真实 `costUsd`**(他们的 `estimateCost` + 价表,PR #50 补齐 glm-5.2/MiniMax 缺失价)。例:`{perProject:[{client,project,usage:{inputTokens,outputTokens,costUsd}}], global:{...}}`。

hack5 接入(本仓已实现):**build `deployed` 回调时,按 (client, project) 从 `/api/usage` 拉该 job 的实际 `costUsd`,`credits = ceil(costUsd × 2 / 0.02) = ceil(costUsd × 100)`,写进 `credit_ledger`(记账,一 submission 一行,幂等)。**

> 现阶段**只记账不扣余额**:扣余额必须绑定**已验证账户**(#47 验证会话),否则攻击者用 `email=victim` 建应用即可扣 victim 积分(court 明确的安全红线)。live 扣费 = 下一步,依赖参赛者**验证登录 UI**(#47 后端在、前端未接)+ launch 的 reserve/settle。

## 6. 分期

1. **本 PR(结构初始化)**:migration `credit_ledger` + config + `credits.ts` + 余额查询端点 + 本文档。**全程 feature-flag `CREDITS_ENABLED` 关闭,零行为改动**。
2. **接你的 API + 定价**:打开开关,launch 接 reserve/settle,超免费额度走积分。
3. **WorkBench 报 token**:精确 settle(协同任务)。

## 7. 定价(已定):按实际成本 × 2

规则:**1 积分 = $0.02**;**卖价 = 实际 token 成本 × 2**(2 倍加价)。

**不用平均估算,用真实模型价逐 job 算成本** —— 见 `docs/model-prices.csv`(34 个模型的输入/输出 $/1M,图像 $/次)。因为不同模型、输入 vs 输出价差很大(如 kimi-k3 输出 $13.97/1M vs deepseek-v4-flash 输出 $0.29/1M),平均会失真。

**由 WorkBench(实际跑模型的一方)算每 job 的实际 $ 成本**(它知道用了哪个模型、输入/输出各多少 token、价格),回传给 hack5;hack5 换算积分:

```
credits = ceil( 实际成本_usd × 2 / 0.02 ) = ceil( 实际成本_usd × 100 )
```

配置:`CREDIT_USD_VALUE = 0.02`(每积分 $)、`CREDITS_MARKUP = 2`(加价倍数)。

**参考量级**(用 deepseek-v4-pro 输入$0.44/输出$0.88 粗估):一次 build 若 ~50K 入 + ~150K 出 ≈ $0.022 + $0.132 = $0.154 成本 → ×2 = $0.31 → **~16 积分 ≈ $0.31**。chat 一轮很小,通常 1 积分(取整下限)。

> `CREDITS_PER_1K_TOKENS`(阶段 1 脚手架里的平均法)保留为 **fallback**:WorkBench 未回传实际成本时用它粗估;主路径是上面的实际成本 × 2。

## 8. 仍待你拍板

- 外部 API:确认第 2 节契约(4 端点,或退化为 balance+deduct 我做退差),给我 `CREDITS_API_URL` + 带外 `CREDITS_API_SECRET`。
- build 的 `reserve` 预扣口径(实际成本跑完才知 → reserve 用固定上限如 20 积分/次封顶,settle 时退差)。
- WorkBench 按 `model-prices.csv` 算成本并回传(协同任务已发 repo:workbench)。
