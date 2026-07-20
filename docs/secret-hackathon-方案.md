# hack5 Secret · 企业私密黑客松 — 产品 + 技术方案(设计稿)

> 目标:在现有开放式 hack5 之上,增加一种**私密 / 企业模式**——企业发布赛题与资料、邀请制参赛、
> 参赛者**不暴露源代码**地提交(在线 Demo + 凭据 + README + 文档 + 视频),评委通过 Demo 评审打分。
> 原则:**底层组件尽量复用,业务逻辑相互隔离**。本文只做设计,不含实现。

---

## 1. 两种模式的差异(Open vs Secret)

| 维度 | 开放式(现有) | 私密 / 企业(新) |
|---|---|---|
| 站点可见性 | 公开,任何人可浏览作品墙 | **门禁**:无访问码看不到任何内容 |
| 进入方式 | 直接进 | **访问码**(全场共享口令 或 每人一次性码) |
| 赛题 / 资料 | 首页简介 | 可**下载的赛题简报 + 资料**(PDF / Word / 链接) |
| 代码提交 | GitHub **Public** 仓库(强制公开,系统校验) | GitHub **Private** 仓库(只登记 URL,评委看不到) |
| 评委怎么看 | 仓库 + 视频 + 截图 | **在线 Demo + Demo 账号密码** + README 文本 + PDF/PPT + 视频 |
| 作品墙 | 公开 | 仅评委 / 管理员可见,不公开 |
| 海报 / 一键转发 | 有 | 关闭(私密不对外传播) |

---

## 2. 角色与流程

### 2.1 企业主办方(Enterprise organizer)
1. 邮箱登录 → 发起黑客松时**选择「私密 / 企业」模式**。
2. 写**赛题简报** + 上传**资料**(PDF / Word / 外链)。
3. 设置**访问码**:全场共享口令(必填)+ 可选每人一次性码。
4. 生成**评委码**(复用现有评委机制)。
5. 邀请参赛者(把访问码/一次性码发出去,系统不强制发信)。

### 2.2 参赛者(Participant)
1. 打开站点 → **门禁页**输入访问码 → 获得访问会话。
2. 查看赛题简报 + **下载资料**。
3. **提交作品**(强约束,不暴露源码):
   - 产品名称 *
   - **在线 Demo URL** *(评委据此评审)
   - **Demo 账号 + 密码** *(仅评委可见,评委用它登录体验)
   - **README(直接粘贴 Markdown 文本)** *(项目大概介绍,不从私有仓库抓)
   - **GitHub Private 仓库 URL**(登记备案,评委通常看不到)
   - PDF / PPT 项目介绍(可选,上传)
   - 演示视频链接(B站 / YouTube,可选)
4. 用返回的**编辑令牌**改稿(复用现有机制)。

### 2.3 评委(Judge)
1. 评委码登录(复用)。
2. 打开每个作品:**用提供的 Demo URL + 账号密码登录体验产品** → 读 README / PDF / 视频。
3. 按四维打分(创新 / 技术 / 完成度 / 展示)→ 私密排行榜 → 管理员导出 CSV。(全部复用)

---

## 3. 复用 vs 隔离(核心架构决策)

**结论:不另起一套代码库,而是给 tenant 加一个 `mode` 开关,同一套表/函数按 mode 分支。** 这样底层最大化复用,业务通过 `mode` 判断隔离。

### 3.1 直接复用(几乎 0 改动)
- 多租户解析 `resolveTenant` / 子域名 / D1 / KV / 无状态 HMAC cookie。
- **评委码 + 四维打分 + 排行榜 + CSV 导出**(scores / judges 表)——私密模式排行榜不公开即可。
- 邮箱登录 + 建站 + 配额(users / tenants)。
- **编辑令牌**改稿、图片上传到 KV 的压缩管线、README 沙箱渲染(现有 iframe sandbox)。
- 深色模式 / i18n / 组织资料 / 页脚。

### 3.2 需要隔离 / 新增的逻辑
| 能力 | 做法 |
|---|---|
| 模式开关 | `tenants.mode ∈ {open, secret}`;`resolveTenant`/`config` 带出 `mode` |
| **访问门禁** | secret 模式下,内容路由(config 详情 / 作品墙 / 资料下载 / 提交)需 `hv_access` 会话;无则返回门禁 |
| 访问码 | 全场口令 `tenants.access_pass_hash`(必填);可选每人一次性码(复用 `invite_codes` 作"入场码") |
| 私密提交字段 | `submissions` 加列:`demo_url` / `demo_user` / `demo_pass` / `readme_md` / `doc_key`(仅 secret 用,open 留空) |
| 不校验公开仓库 | open 模式会调 GitHub API 校验 repo 是 Public;secret **跳过**(私有仓库无法校验),只登记 URL |
| 敏感字段可见性 | `demo_user/demo_pass` 仅评委/管理员可见(复用现有 `includeContact` 门控思路) |
| 赛题资料 | 新增 `materials`(附件):PDF/Word 存 KV/R2,门禁后可下载 |
| 作品墙不公开 | secret 模式作品列表仅评委/管理员;公开访问返回门禁 |
| 关闭对外功能 | secret 模式隐藏 海报 / 一键转发 / 公开作品墙 导航 |

---

## 4. 数据模型改动

```sql
-- 模式 + 访问口令
ALTER TABLE tenants ADD COLUMN mode TEXT NOT NULL DEFAULT 'open';   -- 'open' | 'secret'
ALTER TABLE tenants ADD COLUMN access_pass_hash TEXT;              -- secret 全场访问口令(HMAC)

-- 私密提交(open 模式这些列留空)
ALTER TABLE submissions ADD COLUMN demo_url TEXT;
ALTER TABLE submissions ADD COLUMN demo_user TEXT;
ALTER TABLE submissions ADD COLUMN demo_pass TEXT;   -- 见 §6 安全:至少仅评委可见,建议 AUTH_SECRET 加密后存
ALTER TABLE submissions ADD COLUMN readme_md TEXT;   -- 参赛者粘贴的 Markdown
ALTER TABLE submissions ADD COLUMN doc_key TEXT;     -- PDF/PPT 在 KV 的 key

-- 赛题资料(主办方上传,门禁后可下载)
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
  name TEXT NOT NULL, kind TEXT NOT NULL,            -- 'file' | 'link'
  kv_key TEXT, url TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_tenant ON materials(tenant_id, created_at);
```

- 入场码复用 `invite_codes`(它已是"每码单次消费");可用途区分:secret 下既能当"入场"又能当"提交"码,或加一列 `purpose`。
- 文件存储:图片沿用 KV;**PDF/PPT/Word 体积大**,建议走 **R2**(现有 `VIDEO_UPLOAD` 已为 R2 预留开关,可复用 R2 绑定),KV 仅存小文件。

---

## 5. 访问门禁(私密模式的核心)

- 新增 `POST /api/tenant/access`:校验访问码(全场口令 或 一次性码)→ 下发 `hv_access` HMAC cookie(tenant 绑定,复用现有 cookie 签名工具)。
- Worker 入口中间件:若 `tenant.mode==='secret'` 且请求命中"受保护路由"(config-detail / 作品列表 / 详情 / 资料下载 / 提交),校验 `hv_access`;缺失 → 返回精简 config(只含名称 + `gated:true`),前端渲染**门禁页**要求输码。
- 管理员 / 评委的既有 `hv_auth` 会话可视为已通过门禁(他们本就有权限)。

---

## 6. 安全要点

- **Demo 账号密码**:属敏感凭据。MVP 至少做到"仅评委/管理员可见"(公开/未登录返回 null,复用 `publicSubmission` 门控);建议进一步用 `AUTH_SECRET` 做对称加密后落库(AES-GCM),评委查看时解密。
- **私有仓库 URL**:只登记、**不主动 fetch**(评委看不到也不需要);避免把 token 暴露给私有仓库。
- **README 文本**:参赛者粘贴,**沙箱 iframe 渲染**(复用现有 README 渲染的 `sandbox` + CSP),防注入。
- **资料 / 附件下载**:必须门禁后才可下;附件服务加 `nosniff` + CSP `sandbox`(复用 §已上线的上传服务加固)。
- **门禁绕过**:所有 secret 内容路由都要过 `hv_access`,别只在前端隐藏。
- **上传白名单**:PDF/PPT/Word 仅允许既定 MIME(application/pdf 等),拒可执行/SVG(复用 `isRasterImage` 的思路,扩一个文档白名单)。

---

## 7. UX / 页面

- **发起表单**:加「模式」选择(开放 / 私密);选私密时展开:访问口令、赛题简报、资料上传。
- **门禁页**(secret 未入场):居中一张卡「本黑客松为受邀私密活动,请输入访问码」。
- **参赛者提交页**(secret 版):Demo URL / Demo 账号密码 / README(Markdown 文本域)/ 私有仓库 URL / PDF/PPT 上传 / 视频链接。
- **评委详情页**(secret 版):醒目展示 **Demo 链接 + 账号密码(一键复制)**、README 渲染、附件下载、视频、评分面板。
- secret 模式**隐藏**:海报 / 一键转发 / 公开作品墙 / 组队墙(按需)。

---

## 8. 分期落地建议

**Phase 1(MVP,最大复用)**
- `tenants.mode` + `access_pass_hash` + 访问门禁 + 门禁页。
- secret 提交表单(demo_url / demo_user / demo_pass / readme_md / private repo URL)+ 敏感字段仅评委可见。
- 评委详情页(Demo 凭据 + README)+ 复用打分/排行榜/CSV。

**Phase 2**
- 赛题资料上传/下载(PDF/Word,R2)、PDF/PPT 作品附件、Demo 密码加密存储、每人一次性入场码、审计。

**Phase 3(可选)**
- 企业计费 / 独立品牌域名 / SSO / 更细的权限(观察员、多轮评审)。

---

## 9. 待你拍板的开放问题

1. **访问码粒度**:全场共享口令够用,还是必须每人一次性码?(建议 Phase 1 先做共享口令,一次性码放 Phase 2)
2. **代码可见性**:私有仓库 URL 是"必填登记"还是"可选"?评委是否需要某种受限只读(如让企业把评委 GitHub 账号加进私有仓库协作者,由企业自行操作,我们只展示 URL)?
3. **附件类型/大小**:PDF/PPT/Word 上限多大?走 R2 还是限制到 KV 能放的小文件?
4. **Demo 密码安全等级**:仅"评委可见"够,还是要落库加密?
5. **计费**:私密/企业模式是否即为付费档(对齐生态可持续文档的"消耗触发收费")?
6. **域名**:私密活动用普通 `<sub>.hack5.net` 子域(靠门禁)即可,还是要独立/不可枚举的域?

---

*设计稿,待你 review 后再进入实现。底层复用、逻辑隔离的原则贯穿全文。hack5 · Mycelium。*
