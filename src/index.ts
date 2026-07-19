interface Env {
  DB: D1Database;
  SHOTS: KVNamespace;
  VIDEO_BUCKET?: R2Bucket;
  APP_NAME: string;
  EVENT_NAME?: string;
  VIDEO_UPLOAD?: string; // "on" | "off"
  MAX_VIDEO_BYTES?: string;
  MAX_VIDEO_SECONDS?: string;
  MIN_SHOTS?: string;
  MAX_SHOTS?: string;
  MAX_SHOT_BYTES?: string;
  AUTH_SECRET: string;
  SUBMIT_PASSCODE: string;
  JUDGE_PASSCODE: string;
  ADMIN_PASSCODE: string;
  GITHUB_TOKEN?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  DEV_MODE?: string;
  CF_DNS_TOKEN?: string; // scoped to the hack5.net zone's DNS — used to auto-create <sub>.hack5.net
  CF_ZONE_ID?: string;
  ROOT_DOMAIN?: string; // e.g. "hack5.net"
  TURNSTILE_SITEKEY?: string; // public site key (anti-bot on email login)
  TURNSTILE_SECRET?: string;
  // R2 (only used when VIDEO_UPLOAD=on):
  R2_ACCOUNT_ID?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  OPENAI_API_KEY?: string; // premium: AI text-to-image poster (gpt-image-1)
  SIGNED_UPLOAD_EXPIRES_SECONDS?: string;
}

type Auth = { role: "judge" | "admin"; name: string; jid: string; tenant: string; exp: number };

const AUTH_COOKIE = "hv_auth";
const USER_COOKIE = "hv_user";
const RESERVED_SUBDOMAINS = new Set(["www", "api", "app", "admin", "demo", "mail", "static", "assets", "cdn", "hack5", "mycelium"]);
const DIMS = ["innovation", "technical", "completeness", "presentation"] as const;
type Dim = (typeof DIMS)[number];
const DEFAULT_MIN_SHOTS = 2;
const DEFAULT_MAX_SHOTS = 4;
const DEFAULT_MAX_SHOT_BYTES = 1_048_576;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      if (method === "OPTIONS") return noContent();

      // Canonical host: www -> apex.
      if (url.hostname.toLowerCase() === "www.hack5.net") {
        return Response.redirect(`https://hack5.net${path}${url.search}`, 301);
      }

      // Resolve the tenant (hackathon) for this request from the Host.
      const tctx = await resolveTenant(request, env);
      const tenant = tctx.tenant;
      const tid = tenant ? tenant.id : null;

      // ---- config & auth ----
      if (path === "/api/config" && method === "GET") return getConfig(request, env);
      if (path === "/api/auth/login" && method === "POST") return login(request, env, tenant);
      if (path === "/api/auth/logout" && method === "POST") return logout(request);
      if (path === "/api/auth/me" && method === "GET") return me(request, env, tid);

      // ---- platform user (email login) + hackathon creation (not tenant-scoped) ----
      if (path === "/api/platform/me" && method === "GET") return platformMe(request, env);
      if (path === "/api/platform/login/request" && method === "POST") return platformLoginRequest(request, env);
      if (path === "/api/platform/login/verify" && method === "POST") return platformLoginVerify(request, env);
      if (path === "/api/platform/logout" && method === "POST") return platformLogout(request);
      if (path === "/api/platform/hackathons" && method === "POST") return createHackathon(request, env);

      // ---- tenant homepage (admin) ----
      if (path === "/api/tenant/homepage" && method === "POST") return updateHomepage(request, env, tenant);

      // ---- participant registration ----
      if (path === "/api/tenant/register" && method === "POST") return registerParticipant(request, env, tenant);
      if (path === "/api/tenant/registrations" && method === "GET") return listRegistrations(request, env, tid);
      if (path === "/api/tenant/registrations/export" && method === "GET") return exportRegistrations(request, env, tid);

      // ---- premium: AI text-to-image poster background (admin, metered) ----
      if (path === "/api/tenant/poster/ai" && method === "POST") return generateAiPoster(request, env, tenant, tid);

      // ---- photo wall ----
      if (path === "/api/tenant/photos" && method === "GET") return listPhotos(env, tid);
      if (path === "/api/tenant/photos" && method === "POST") return uploadPhotos(request, env, tenant);
      const photoDel = path.match(/^\/api\/tenant\/photos\/([^/]+)$/);
      if (photoDel && method === "DELETE") return deletePhoto(request, env, tenant, photoDel[1]);
      const photoServe = path.match(/^\/photo\/([^/]+)\/([^/]+)$/);
      if (photoServe && method === "GET") return servePhoto(env, photoServe[1], photoServe[2]);

      // ---- submissions (tenant-scoped) ----
      if (path === "/api/submissions" && method === "GET") return listSubmissions(env, tid);
      if (path === "/api/submissions" && method === "POST") return createSubmission(request, env, tid);
      const subMatch = path.match(/^\/api\/submissions\/([^/]+)$/);
      if (subMatch && method === "GET") return getSubmission(request, env, tid, subMatch[1]);
      const lockMatch = path.match(/^\/api\/submissions\/([^/]+)\/lock$/);
      if (lockMatch && method === "POST") return lockSubmission(request, env, tid, lockMatch[1]);
      const hideMatch = path.match(/^\/api\/submissions\/([^/]+)\/hide$/);
      if (hideMatch && method === "POST") return hideSubmission(request, env, tid, hideMatch[1]);

      // ---- screenshots (KV, content-addressed by submission uuid) ----
      const shotMatch = path.match(/^\/shot\/([^/]+)\/(\d+)$/);
      if (shotMatch && method === "GET") return serveShot(env, shotMatch[1], Number(shotMatch[2]));

      // ---- static illustration assets (served from KV) ----
      const assetMatch = path.match(/^\/asset\/([a-z0-9-]+)$/);
      if (assetMatch && method === "GET") return serveAsset(env, assetMatch[1]);

      // ---- GitHub proxy (public data, not tenant-scoped) ----
      const readmeMatch = path.match(/^\/api\/gh\/([^/]+)\/([^/]+)\/readme$/);
      if (readmeMatch && method === "GET") return ghReadme(env, readmeMatch[1], readmeMatch[2]);
      const repoMatch = path.match(/^\/api\/gh\/([^/]+)\/([^/]+)$/);
      if (repoMatch && method === "GET") return ghRepo(env, repoMatch[1], repoMatch[2]);

      // ---- scoring (tenant-scoped) ----
      if (path === "/api/scores" && method === "GET") return listMyScores(request, env, tid);
      if (path === "/api/scores" && method === "POST") return upsertScore(request, env, tid);
      if (path === "/api/leaderboard" && method === "GET") return leaderboard(request, env, tid);
      if (path === "/api/scores/export" && method === "GET") return exportScores(request, env, tid);

      // ---- invite codes (admin, tenant-scoped) ----
      if (path === "/api/invites" && method === "GET") return listInvites(request, env, tid);
      if (path === "/api/invites" && method === "POST") return generateInvites(request, env, tid);

      // ---- judge codes (admin, tenant-scoped) ----
      if (path === "/api/judges" && method === "GET") return listJudges(request, env, tid);
      if (path === "/api/judges" && method === "POST") return createJudges(request, env, tid);

      // ---- reserved R2 upload (gated) ----
      if (path === "/api/uploads/start" && method === "POST") return startUpload(request, env);
      if (path === "/api/uploads/complete" && method === "POST") return completeUpload(request, env);
      const mediaMatch = path.match(/^\/media\/([^/]+)\/video$/);
      if (mediaMatch && method === "GET") return serveVideo(request, env, mediaMatch[1]);

      if (method === "GET") return html(APP_HTML);
      return json({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return json({ error: "Server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

// ============================ config & auth ============================

type Tenant = {
  id: string;
  subdomain: string;
  name: string;
  admin_pass_hash: string;
  intro?: string;
  event_time?: string;
  location?: string;
  duration?: string;
  address?: string;
  map_query?: string;
  agenda?: string;
};

// Resolve which hackathon (tenant) a request is for, from the Host.
// hack5.net / www -> platform landing; <sub>.hack5.net -> that tenant; workers.dev / localhost -> demo tenant.
async function resolveTenant(request: Request, env: Env): Promise<{ platform: boolean; tenant: Tenant | null; notFound?: string }> {
  const host = new URL(request.url).hostname.toLowerCase();
  if (host === "hack5.net" || host === "www.hack5.net") return { platform: true, tenant: null };
  let sub: string | null = null;
  const m = host.match(/^([a-z0-9-]+)\.hack5\.net$/);
  if (m) sub = m[1];
  // Local dev only: ?tenant=<sub> reaches a tenant for testing.
  else if (host === "localhost" || host === "127.0.0.1") {
    const q = new URL(request.url).searchParams.get("tenant");
    if (!q) return { platform: true, tenant: null };
    sub = q;
  }
  // Public preview host (workers.dev): platform landing only — never expose tenants via ?tenant.
  else if (host.endsWith(".workers.dev")) {
    return { platform: true, tenant: null };
  }
  if (!sub || sub === "www") return { platform: true, tenant: null };
  const tenant = await env.DB.prepare(
    "SELECT id, subdomain, name, admin_pass_hash, intro, event_time, location, duration, address, map_query, agenda FROM tenants WHERE subdomain = ? AND status = 'active'",
  )
    .bind(sub)
    .first<Tenant>();
  if (!tenant) return { platform: false, tenant: null, notFound: sub };
  return { platform: false, tenant };
}

async function getConfig(request: Request, env: Env): Promise<Response> {
  const tctx = await resolveTenant(request, env);
  return json({
    appName: env.APP_NAME || "hack5",
    country: request.cf?.country ?? null,
    turnstileSiteKey: env.TURNSTILE_SITEKEY ?? null,
    platform: tctx.platform,
    tenantNotFound: tctx.notFound ?? null,
    tenant: tctx.tenant
      ? {
          subdomain: tctx.tenant.subdomain,
          name: tctx.tenant.name,
          intro: tctx.tenant.intro ?? "",
          eventTime: tctx.tenant.event_time ?? "",
          location: tctx.tenant.location ?? "",
          duration: tctx.tenant.duration ?? "",
          address: tctx.tenant.address ?? "",
          mapQuery: tctx.tenant.map_query ?? "",
          agenda: parseAgenda(tctx.tenant.agenda),
        }
      : null,
    eventName: env.EVENT_NAME || "Hackathon",
    videoUpload: env.VIDEO_UPLOAD === "on",
    minShots: numberEnv(env.MIN_SHOTS, DEFAULT_MIN_SHOTS),
    maxShots: numberEnv(env.MAX_SHOTS, DEFAULT_MAX_SHOTS),
    maxShotBytes: numberEnv(env.MAX_SHOT_BYTES, DEFAULT_MAX_SHOT_BYTES),
    shotRatio: "16:9",
    maxVideoSeconds: numberEnv(env.MAX_VIDEO_SECONDS, 180),
    dims: DIMS,
  });
}

async function login(request: Request, env: Env, tenant: Tenant | null): Promise<Response> {
  if (!tenant) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
  const body = await request.json<{ code?: string; passcode?: string; name?: string }>().catch(() => null);
  const code = String(body?.code ?? body?.passcode ?? "").trim();
  if (!code) return json({ error: "请填写登录码 / Code required" }, 400);

  const exp = unixNow() + 7 * 24 * 60 * 60;
  let payload: Auth;
  // Admin: per-tenant hashed password. ONLY the seeded demo tenant (empty hash) may fall back
  // to the global ADMIN_PASSCODE — any other tenant with an empty hash fails closed.
  let isAdmin = false;
  if (tenant.admin_pass_hash) {
    isAdmin = timingSafeEqual(await hashSecret(env, code), tenant.admin_pass_hash);
  } else if (tenant.subdomain === "demo") {
    isAdmin = Boolean(env.ADMIN_PASSCODE) && code === env.ADMIN_PASSCODE;
  }
  if (isAdmin) {
    const name = String(body?.name ?? "").trim().slice(0, 40) || "管理员";
    payload = { role: "admin", name, jid: "admin", tenant: tenant.id, exp };
  } else {
    // Judge: per-judge login code, scoped to this tenant.
    const judge = await env.DB.prepare("SELECT name FROM judges WHERE code = ? AND tenant_id = ?")
      .bind(code, tenant.id)
      .first<{ name: string }>();
    if (!judge) return json({ error: "登录码无效 / Invalid code" }, 401);
    payload = { role: "judge", name: judge.name, jid: `j:${code}`, tenant: tenant.id, exp };
  }

  const token = await signAuth(env, payload);
  return json({ ok: true, role: payload.role, name: payload.name }, 200, {
    "Set-Cookie": sessionCookie(request, token, 7 * 24 * 60 * 60),
  });
}

function logout(request: Request): Response {
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(request, "", 0) });
}

function sessionCookie(request: Request, token: string, maxAge: number): string {
  // Omit Secure on http (local `wrangler dev`) so the cookie is actually stored there.
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `${AUTH_COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function me(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await getAuth(request, env, tid);
  if (!auth) return json({ role: null });
  return json({ role: auth.role, name: auth.name });
}

async function signAuth(env: Env, payload: Auth): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(utf8(env.AUTH_SECRET), body);
  return `${body}.${sig}`;
}

async function getAuth(request: Request, env: Env, tid: string | null): Promise<Auth | null> {
  const raw = parseCookies(request.headers.get("cookie"))[AUTH_COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = await hmacHex(utf8(env.AUTH_SECRET), body);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body)) as Auth;
    if (!payload || typeof payload.exp !== "number" || payload.exp < unixNow()) return null;
    // A cookie is only valid on the tenant it was issued for.
    if (!tid || payload.tenant !== tid) return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireRole(request: Request, env: Env, tid: string | null, need: "judge" | "admin"): Promise<Auth | null> {
  const auth = await getAuth(request, env, tid);
  if (!auth) return null;
  if (need === "admin") return auth.role === "admin" ? auth : null;
  return auth; // judge or admin
}

// ============================ platform users (email login) ============================

type UserAuth = { email: string; exp: number };

async function signUser(env: Env, payload: UserAuth): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(utf8(env.AUTH_SECRET), body);
  return `${body}.${sig}`;
}

async function getUser(request: Request, env: Env): Promise<UserAuth | null> {
  const raw = parseCookies(request.headers.get("cookie"))[USER_COOKIE];
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const expected = await hmacHex(utf8(env.AUTH_SECRET), body);
  if (!timingSafeEqual(raw.slice(dot + 1), expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body)) as UserAuth;
    if (!payload?.email || typeof payload.exp !== "number" || payload.exp < unixNow()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function platformMe(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  if (!user) return json({ email: null });
  const row = await env.DB.prepare("SELECT quota, plan FROM users WHERE email = ?").bind(user.email).first<{ quota: number; plan: string }>();
  const quota = row?.quota ?? 1;
  const list = await env.DB.prepare(
    "SELECT subdomain, name, created_at FROM tenants WHERE owner_email = ? AND status = 'active' ORDER BY created_at ASC",
  )
    .bind(user.email)
    .all<{ subdomain: string; name: string; created_at: number }>();
  return json({
    email: user.email,
    quota,
    plan: row?.plan ?? "free",
    used: list.results.length,
    hackathons: list.results.map((h) => ({ subdomain: h.subdomain, name: h.name, url: `https://${h.subdomain}.hack5.net` })),
  });
}

async function platformLoginRequest(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ email?: string; turnstileToken?: string }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return json({ error: "邮箱无效 / Invalid email" }, 400);
  const reqIp = request.headers.get("cf-connecting-ip") ?? "local";
  // Anti-bot: block automated email-code flooding (only enforced when a secret is configured).
  if (!(await verifyTurnstile(env, body?.turnstileToken, reqIp))) {
    return json({ error: "人机验证失败,请重试 / Verification failed" }, 403);
  }
  const now = unixNow();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS c FROM email_codes WHERE email = ? AND created_at > ?")
    .bind(email, now - 15 * 60)
    .first<{ c: number }>();
  if ((recent?.c ?? 0) >= 5) return json({ error: "请求过于频繁,请稍后再试 / Too many requests" }, 429);
  const code = generateCode();
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  await env.DB.prepare(
    "INSERT INTO email_codes (id, email, code_hash, request_ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), email, await hashSecret(env, `${email}:${code}`), ip, now, now + 10 * 60)
    .run();
  const sent = await sendEmailCode(env, email, code);
  if (!sent) {
    // No email provider: surface the code ONLY on dev/preview hosts, never on the real product domain.
    if (isDevHost(request)) return json({ ok: true, debugCode: code });
    return json({ error: "邮件服务暂未配置 / Email not configured" }, 503);
  }
  return json({ ok: true });
}

function isDevHost(request: Request): boolean {
  const h = new URL(request.url).hostname.toLowerCase();
  return h.endsWith(".workers.dev") || h === "localhost" || h === "127.0.0.1";
}

// Verify a Cloudflare Turnstile token. Returns true (skip) when no secret is configured.
async function verifyTurnstile(env: Env, token: string | undefined, ip: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET || !env.TURNSTILE_SITEKEY) return true; // off unless fully configured
  if (!token) return false;
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip && ip !== "local") form.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = await res.json<{ success?: boolean }>().catch(() => null);
  return Boolean(data?.success);
}

async function platformLoginVerify(request: Request, env: Env): Promise<Response> {
  const body = await request.json<{ email?: string; code?: string }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  const code = String(body?.code ?? "").replace(/\D/g, "");
  if (!email || code.length !== 6) return json({ error: "邮箱或验证码无效 / Invalid email or code" }, 400);
  const now = unixNow();
  const rows = await env.DB.prepare(
    "SELECT id, code_hash, attempts FROM email_codes WHERE email = ? AND used_at IS NULL AND expires_at >= ? ORDER BY created_at DESC LIMIT 5",
  )
    .bind(email, now)
    .all<{ id: string; code_hash: string; attempts: number }>();
  // Cap brute-force: too many wrong guesses against this email's live codes -> force a new code.
  const totalAttempts = rows.results.reduce((a, r) => a + Number(r.attempts || 0), 0);
  if (totalAttempts >= 10) return json({ error: "尝试过多,请重新获取验证码 / Too many attempts" }, 429);
  const expected = await hashSecret(env, `${email}:${code}`);
  const match = rows.results.find((r) => timingSafeEqual(r.code_hash, expected));
  if (!match) {
    if (rows.results[0]) {
      await env.DB.prepare("UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?").bind(rows.results[0].id).run();
    }
    return json({ error: "验证码错误或已过期 / Invalid or expired code" }, 401);
  }
  // Atomic single-use consume: only one concurrent verify can win.
  const consumed = await env.DB.prepare("UPDATE email_codes SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(now, match.id)
    .run();
  if (consumed.meta.changes !== 1) return json({ error: "验证码已被使用 / Code already used" }, 401);
  // Invalidate this email's other live codes on success.
  await env.DB.prepare("UPDATE email_codes SET used_at = ? WHERE email = ? AND used_at IS NULL").bind(now, email).run();
  await env.DB.prepare("INSERT OR IGNORE INTO users (email, quota, plan, created_at) VALUES (?, 1, 'free', ?)")
    .bind(email, now)
    .run();
  const token = await signUser(env, { email, exp: now + 30 * 24 * 60 * 60 });
  return json({ ok: true, email }, 200, { "Set-Cookie": userCookie(request, token, 30 * 24 * 60 * 60) });
}

function platformLogout(request: Request): Response {
  return json({ ok: true }, 200, { "Set-Cookie": userCookie(request, "", 0) });
}

function userCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `${USER_COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function createHackathon(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  if (!user) return json({ error: "请先登录 / Please log in" }, 401);
  const body = await request.json<{ name?: string; subdomain?: string }>().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 60);
  const subdomain = String(body?.subdomain ?? "").trim().toLowerCase();
  if (!name) return json({ error: "请填写黑客松名称 / Name required" }, 400);
  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(subdomain)) {
    return json({ error: "子域名需 3-30 位小写字母/数字/连字符 / Invalid subdomain" }, 400);
  }
  if (RESERVED_SUBDOMAINS.has(subdomain)) return json({ error: "该子域名被保留 / Reserved subdomain" }, 400);

  const taken = await env.DB.prepare("SELECT id FROM tenants WHERE subdomain = ?").bind(subdomain).first();
  if (taken) return json({ error: "子域名已被占用 / Subdomain taken" }, 409);

  const urow = await env.DB.prepare("SELECT quota FROM users WHERE email = ?").bind(user.email).first<{ quota: number }>();
  const quota = urow?.quota ?? 1;
  const used = await env.DB.prepare("SELECT COUNT(*) AS c FROM tenants WHERE owner_email = ? AND status = 'active'")
    .bind(user.email)
    .first<{ c: number }>();
  if ((used?.c ?? 0) >= quota) {
    return json({ error: `已达免费额度(${quota} 场)。充值 ¥99 可举办 100 场 / Quota reached — upgrade for 100`, upgrade: true }, 402);
  }

  const adminPass = `hack5-${randomCodeBody(8).toLowerCase()}`;
  const now = unixNow();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO tenants (id, subdomain, name, admin_pass_hash, creator_email, owner_email, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
  )
    .bind(id, subdomain, name, await hashSecret(env, adminPass), user.email, user.email, now, now)
    .run();

  // Close the quota race deterministically: keep the earliest `quota` tenants; if a concurrent
  // create pushed this one past the limit, roll it back.
  const owned = await env.DB.prepare(
    "SELECT id FROM tenants WHERE owner_email = ? AND status = 'active' ORDER BY created_at ASC, id ASC",
  )
    .bind(user.email)
    .all<{ id: string }>();
  if (owned.results.findIndex((r) => r.id === id) >= quota) {
    await env.DB.prepare("DELETE FROM tenants WHERE id = ?").bind(id).run();
    return json({ error: `已达免费额度(${quota} 场)。充值 ¥99 可举办 100 场 / Quota reached`, upgrade: true }, 402);
  }

  // Auto-provision the subdomain DNS so <sub>.hack5.net resolves. Roll back the tenant if it fails.
  const dnsErr = await createSubdomainDns(env, subdomain);
  if (dnsErr) {
    await env.DB.prepare("DELETE FROM tenants WHERE id = ?").bind(id).run();
    return json({ error: "子域名配置失败,请重试 / Subdomain setup failed", detail: dnsErr }, 502);
  }

  const root = env.ROOT_DOMAIN || "hack5.net";
  const url = `https://${subdomain}.${root}`;
  // Also email the creator their site link + admin password as a backup (non-fatal).
  await sendHackathonReadyEmail(env, user.email, name, url, adminPass).catch(() => {});
  return json({ ok: true, subdomain, name, url, adminPassword: adminPass });
}

async function sendHackathonReadyEmail(env: Env, email: string, name: string, url: string, adminPass: string): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  const text = `你的黑客松「${name}」已就绪!\n站点:${url}\n管理员密码:${adminPass}(请妥善保存)\n\n用管理员密码在站点登录即可管理:生成邀请码/评委码、编辑首页、上传照片、评审打分。\n\nYour hackathon "${name}" is live: ${url}\nAdmin password: ${adminPass}\n\n— hack5.net`;
  const html =
    `<div style="background:#f6f7fb;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="460" cellpadding="0" cellspacing="0" style="max-width:460px;width:100%">` +
    `<tr><td align="center" style="padding-bottom:20px"><span style="display:inline-block;width:40px;height:40px;line-height:40px;background:#0a0e0a;border-radius:11px;color:#25ff86;font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:800;font-size:18px;text-align:center;vertical-align:middle">&#8249;5&#8250;</span><span style="font-size:22px;font-weight:800;color:#14161c;vertical-align:middle;padding-left:10px">hack5</span></td></tr>` +
    `<tr><td style="background:#ffffff;border-radius:14px;padding:30px 28px;border:1px solid #e6e9f0">` +
    `<h1 style="font-size:20px;margin:0 0 6px;color:#14161c">${escapeHtml(name)} ` + `<span style="color:#0f9d6b">✓</span></h1>` +
    `<p style="color:#5f6675;font-size:15px;margin:0 0 16px">你的黑客松已就绪 · Your hackathon is live</p>` +
    `<p style="margin:0 0 6px;color:#5f6675;font-size:14px">站点 · Site</p>` +
    `<p style="margin:0 0 16px"><a href="${url}" style="font-size:16px;font-weight:700;color:#5b4be6">${url}</a></p>` +
    `<p style="margin:0 0 6px;color:#5f6675;font-size:14px">管理员密码 · Admin password</p>` +
    `<div style="font-size:20px;font-weight:800;letter-spacing:1px;color:#14161c;background:#f2f0fe;border-radius:8px;padding:12px 14px;font-family:ui-monospace,Menlo,monospace">${escapeHtml(adminPass)}</div>` +
    `<p style="color:#7a8090;font-size:13px;line-height:1.6;margin:14px 0 0">用这个密码登录站点即可管理:生成邀请码/评委码、编辑首页、上传照片、评审。请妥善保存。<br>Log in with this password to manage your event. Keep it safe.</p>` +
    `</td></tr>` +
    `<tr><td align="center" style="padding:18px 0 8px"><a href="${url}" style="display:inline-block;background:#5b4be6;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 22px;border-radius:9px">🚀 进入你的黑客松 →</a></td></tr>` +
    `<tr><td align="center" style="color:#9aa1ac;font-size:12px;line-height:1.7;padding-top:14px">Mycelium: Digital Public Goods 🚌 = 🪵 Infras | 🦠 Protocols | 🕸️ Networks</td></tr>` +
    `</table></td></tr></table></div>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM || "hack5 <no-reply@hack5.net>", to: [email], subject: `‹5› 你的黑客松「${name}」已就绪`, text, html }),
  });
}

// Create a proxied CNAME <sub>.hack5.net -> hack5.net so the wildcard Worker route serves it.
// Returns null on success (or when not configured, e.g. dev/preview), else an error message.
async function createSubdomainDns(env: Env, sub: string): Promise<string | null> {
  if (!env.CF_DNS_TOKEN || !env.CF_ZONE_ID) return null;
  const root = env.ROOT_DOMAIN || "hack5.net";
  const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_DNS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ type: "CNAME", name: sub, content: root, proxied: true, ttl: 1 }),
  });
  if (res.ok) return null;
  const body = await res.json<{ errors?: { code?: number; message?: string }[] }>().catch(() => null);
  if (body?.errors?.some((e) => e.code === 81053 || String(e.message ?? "").toLowerCase().includes("already exists"))) {
    return null; // idempotent: record already present
  }
  return body?.errors?.[0]?.message || `DNS error ${res.status}`;
}

async function sendEmailCode(env: Env, email: string, code: string): Promise<boolean> {
  const text = `hack5 登录验证码:${code}(10 分钟内有效)\nYour hack5 login code: ${code} (expires in 10 minutes)\n\n🚀 10 分钟发起你的黑客松 · Launch your hackathon in 10 minutes — https://hack5.net`;
  const html =
    `<div style="background:#f6f7fb;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">` +
    `<table role="presentation" width="440" cellpadding="0" cellspacing="0" style="max-width:440px;width:100%">` +
    `<tr><td align="center" style="padding-bottom:22px">` +
    `<span style="display:inline-block;width:40px;height:40px;line-height:40px;background:#0a0e0a;border-radius:11px;color:#25ff86;font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:800;font-size:18px;text-align:center;vertical-align:middle">&#8249;5&#8250;</span>` +
    `<span style="font-size:22px;font-weight:800;color:#14161c;vertical-align:middle;padding-left:10px">hack5</span>` +
    `</td></tr>` +
    `<tr><td style="background:#ffffff;border-radius:14px;padding:30px 28px;border:1px solid #e6e9f0">` +
    `<p style="color:#5f6675;font-size:15px;margin:0 0 10px">你的 hack5 登录验证码 · Your login code</p>` +
    `<div style="font-size:38px;font-weight:800;letter-spacing:10px;color:#14161c;background:#f2f0fe;border-radius:10px;padding:18px 0;text-align:center;margin:6px 0 14px">${code}</div>` +
    `<p style="color:#7a8090;font-size:13px;line-height:1.6;margin:0">10 分钟内有效。若非本人操作,请忽略此邮件。<br>Expires in 10 minutes. Ignore this email if it was not you.</p>` +
    `</td></tr>` +
    `<tr><td align="center" style="padding:22px 0 8px">` +
    `<a href="https://hack5.net" style="display:inline-block;background:#5b4be6;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:11px 20px;border-radius:9px">🚀 10 分钟发起你的黑客松 → hack5.net</a>` +
    `</td></tr>` +
    `<tr><td align="center" style="color:#9aa1ac;font-size:12px;line-height:1.7;padding-top:16px">Mycelium: Digital Public Goods 🚌 = 🪵 Infras | 🦠 Protocols | 🕸️ Networks</td></tr>` +
    `</table></td></tr></table></div>`;
  if (env.RESEND_API_KEY) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM || "hack5 <no-reply@hack5.net>", to: [email], subject: "‹5› hack5 登录验证码 · 10 分钟发起你的黑客松", text, html }),
    });
    if (!res.ok) throw new Error(`email send failed: ${res.status}`);
    return true;
  }
  if (env.DEV_MODE === "true") console.log(`hack5 login code for ${email}: ${code}`);
  return false; // no provider -> caller returns debugCode
}

function normalizeEmail(input: unknown): string | null {
  const email = String(input ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return null;
  return email;
}

function generateCode(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return String(new DataView(bytes.buffer).getUint32(0) % 1_000_000).padStart(6, "0");
}

// ============================ tenant homepage (admin) ============================

async function updateHomepage(request: Request, env: Env, tenant: Tenant | null): Promise<Response> {
  if (!tenant) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
  const auth = await requireRole(request, env, tenant.id, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const body = await request
    .json<{ intro?: string; eventTime?: string; location?: string; duration?: string; address?: string; mapQuery?: string; agenda?: string }>()
    .catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n) || null;
  await env.DB.prepare(
    "UPDATE tenants SET intro = ?, event_time = ?, location = ?, duration = ?, address = ?, map_query = ?, agenda = ?, updated_at = ? WHERE id = ?",
  )
    .bind(
      clip(body.intro, 2000),
      clip(body.eventTime, 120),
      clip(body.location, 120),
      clip(body.duration, 120),
      clip(body.address, 200),
      clip(body.mapQuery, 200),
      clip(body.agenda, 2000),
      unixNow(),
      tenant.id,
    )
    .run();
  return json({ ok: true });
}

// Agenda is stored as raw text, one "time | title" per line.
function parseAgenda(raw: string | null | undefined): { time: string; title: string }[] {
  if (!raw) return [];
  return String(raw)
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("|");
      // "time | title"; a line without a separator is treated as a title-only entry.
      if (idx < 0) return { time: "", title: line.trim().slice(0, 120) };
      return { time: line.slice(0, idx).trim().slice(0, 40), title: line.slice(idx + 1).trim().slice(0, 120) };
    })
    .filter((r) => r.time || r.title)
    .slice(0, 40);
}

async function registerParticipant(request: Request, env: Env, tenant: Tenant | null): Promise<Response> {
  if (!tenant) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
  const body = await request.json<{ name?: string; email?: string; note?: string }>().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 60);
  const email = normalizeEmail(body?.email);
  const note = String(body?.note ?? "").trim().slice(0, 300) || null;
  if (!name) return json({ error: "请填写姓名 / Name required" }, 400);
  if (!email) return json({ error: "邮箱无效 / Invalid email" }, 400);

  const now = unixNow();
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  // Per-tenant capacity cap: stop unbounded DB growth from a single event.
  const total = await env.DB.prepare("SELECT COUNT(*) AS c FROM registrations WHERE tenant_id = ?")
    .bind(tenant.id)
    .first<{ c: number }>();
  if ((total?.c ?? 0) >= 5000) return json({ error: "报名已满 / Registration full" }, 403);
  // Per-IP rate limit: block scripted floods with many distinct emails from one source.
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM registrations WHERE tenant_id = ? AND request_ip = ? AND created_at > ?",
  )
    .bind(tenant.id, ip, now - 60 * 60)
    .first<{ c: number }>();
  if ((recent?.c ?? 0) >= 20) return json({ error: "报名过于频繁,请稍后再试 / Too many requests" }, 429);

  const res = await env.DB.prepare(
    "INSERT OR IGNORE INTO registrations (id, tenant_id, name, email, note, created_at, request_ip) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), tenant.id, name, email, note, now, ip)
    .run();
  if (res.meta.changes !== 1) return json({ ok: true, already: true }); // idempotent: already registered
  return json({ ok: true });
}

async function listRegistrations(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const rows = await env.DB.prepare(
    "SELECT name, email, note, created_at FROM registrations WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 2000",
  )
    .bind(tid)
    .all<{ name: string; email: string; note: string | null; created_at: number }>();
  // Total count is separate from the (capped) list so a >2000-row event still reports the true number.
  const total = await env.DB.prepare("SELECT COUNT(*) AS c FROM registrations WHERE tenant_id = ?")
    .bind(tid)
    .first<{ c: number }>();
  return json({ count: total?.c ?? rows.results.length, registrations: rows.results });
}

async function exportRegistrations(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const rows = await env.DB.prepare(
    "SELECT name, email, note, created_at FROM registrations WHERE tenant_id = ? ORDER BY created_at ASC",
  )
    .bind(tid)
    .all<{ name: string; email: string; note: string | null; created_at: number }>();
  const lines = ["name,email,note,registered_at"];
  for (const r of rows.results) {
    lines.push([r.name, r.email, r.note ?? "", new Date(r.created_at * 1000).toISOString()].map(csvCell).join(","));
  }
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="hack5-registrations.csv"',
      "Cache-Control": "no-store",
    },
  });
}

// Premium: generate an AI poster BACKGROUND from a text prompt (gpt-image-1), overlaid with crisp
// event text on the client. Admin-only (it costs money) and metered per tenant per day.
const AI_POSTER_DAILY_CAP = 10;
async function generateAiPoster(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth || !tenant) return json({ error: "Admin only" }, 403);
  if (!env.OPENAI_API_KEY) return json({ error: "AI 海报未开通 / AI poster not enabled" }, 503);

  const body = await request.json<{ prompt?: string }>().catch(() => null);
  const style = String(body?.prompt ?? "").trim().slice(0, 500);
  if (!style) return json({ error: "请描述画风 / Describe the style" }, 400);

  // Daily cost cap per tenant.
  const day = Math.floor(unixNow() / 86400);
  const capKey = `aiposter:${tenant.id}:${day}`;
  const used = Number((await env.SHOTS.get(capKey)) ?? "0");
  if (used >= AI_POSTER_DAILY_CAP) return json({ error: "今日 AI 海报额度已用完 / Daily AI quota reached" }, 429);

  const name = (tenant.name ?? "Hackathon").slice(0, 80);
  const intro = (tenant.intro ?? "").replace(/\s+/g, " ").slice(0, 160);
  const prompt =
    `Poster BACKGROUND artwork for a hackathon called "${name}".` +
    (intro ? ` Event theme: ${intro}.` : "") +
    ` Art direction from the organizer: ${style}.` +
    ` Vertical A4 portrait composition, cinematic, high detail, vivid, professional event-poster quality.` +
    ` IMPORTANT: render NO text, NO letters, NO words, NO numbers and NO logos anywhere in the image;` +
    ` keep the lower third calmer and slightly darker so text can be overlaid on top.`;

  let resp: Response;
  try {
    resp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1536", quality: "medium", n: 1 }),
    });
  } catch {
    return json({ error: "AI 服务暂不可用 / AI service unavailable" }, 502);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.log("gpt-image-1 error", resp.status, detail.slice(0, 300));
    return json({ error: "生成失败,请稍后再试 / Generation failed" }, 502);
  }
  const data = await resp.json<{ data?: { b64_json?: string }[] }>().catch(() => null);
  const b64 = data?.data?.[0]?.b64_json;
  if (!b64) return json({ error: "生成失败 / Generation failed" }, 502);

  // Charge one credit only on success; TTL cleans up old day buckets.
  await env.SHOTS.put(capKey, String(used + 1), { expirationTtl: 2 * 86400 });
  return json({ image: `data:image/png;base64,${b64}`, remaining: AI_POSTER_DAILY_CAP - used - 1 });
}

// ============================ photo wall ============================

const MAX_PHOTO_BYTES = 128 * 1024; // ~120KB target, small slack

async function listPhotos(env: Env, tid: string | null): Promise<Response> {
  if (!tid) return json({ photos: [] });
  const rows = await env.DB.prepare("SELECT id, caption FROM photos WHERE tenant_id = ? ORDER BY sort ASC, created_at ASC")
    .bind(tid)
    .all<{ id: string; caption: string | null }>();
  return json({
    photos: rows.results.map((p) => ({ id: p.id, url: `/photo/${tid}/${p.id}`, caption: p.caption ?? "" })),
  });
}

async function servePhoto(env: Env, tid: string, id: string): Promise<Response> {
  const { value, metadata } = await env.SHOTS.getWithMetadata<{ contentType?: string }>(`photo:${tid}:${id}`, {
    type: "arrayBuffer",
  });
  if (!value) return json({ error: "Not found" }, 404);
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=3600",
      "X-Robots-Tag": "noindex",
    },
  });
}

async function uploadPhotos(request: Request, env: Env, tenant: Tenant | null): Promise<Response> {
  if (!tenant) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
  const auth = await requireRole(request, env, tenant.id, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const body = await request.json<{ photos?: { dataUrl?: string; caption?: string }[] }>().catch(() => null);
  const items = Array.isArray(body?.photos) ? body!.photos : [];
  if (!items.length) return json({ error: "没有照片 / No photos" }, 400);
  if (items.length > 40) return json({ error: "一次最多 40 张 / Up to 40 at a time" }, 400);

  const existing = await env.DB.prepare("SELECT COUNT(*) AS c FROM photos WHERE tenant_id = ?").bind(tenant.id).first<{ c: number }>();
  let sort = Number(existing?.c ?? 0);
  const now = unixNow();
  let saved = 0;
  for (const item of items) {
    const parsed = dataUrlToBytes(item?.dataUrl);
    if (!parsed || !parsed.contentType.startsWith("image/")) continue;
    if (parsed.bytes.byteLength > MAX_PHOTO_BYTES) return json({ error: "单张需 ≤120KB / Each photo must be ≤120KB" }, 400);
    const id = crypto.randomUUID();
    await env.SHOTS.put(`photo:${tenant.id}:${id}`, parsed.bytes, { metadata: { contentType: parsed.contentType } });
    await env.DB.prepare("INSERT INTO photos (id, tenant_id, content_type, caption, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, tenant.id, parsed.contentType, String(item?.caption ?? "").trim().slice(0, 120) || null, sort, now)
      .run();
    sort += 1;
    saved += 1;
  }
  return json({ ok: true, saved });
}

async function deletePhoto(request: Request, env: Env, tenant: Tenant | null, id: string): Promise<Response> {
  if (!tenant) return json({ error: "Not found" }, 404);
  const auth = await requireRole(request, env, tenant.id, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const row = await env.DB.prepare("SELECT id FROM photos WHERE id = ? AND tenant_id = ?").bind(id, tenant.id).first();
  if (!row) return json({ error: "Not found" }, 404);
  await env.SHOTS.delete(`photo:${tenant.id}:${id}`);
  await env.DB.prepare("DELETE FROM photos WHERE id = ? AND tenant_id = ?").bind(id, tenant.id).run();
  return json({ ok: true });
}

// ============================ submissions ============================

async function listSubmissions(env: Env, tid: string | null): Promise<Response> {
  if (!tid) return json({ submissions: [] });
  const rows = await env.DB.prepare(
    "SELECT id, project_name, team_name, repo_owner, repo_name, repo_url, description, video_url, shot_count, locked_sha, created_at FROM submissions WHERE tenant_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 300",
  )
    .bind(tid)
    .all<Record<string, unknown>>();
  return json({ submissions: rows.results.map((r) => publicSubmission(r, false)) });
}

async function getSubmission(request: Request, env: Env, tid: string | null, id: string): Promise<Response> {
  if (!tid) return json({ error: "Not found" }, 404);
  const row = await env.DB.prepare(
    "SELECT id, project_name, team_name, contact, repo_owner, repo_name, repo_url, description, video_url, shot_count, locked_sha, created_at FROM submissions WHERE id = ? AND tenant_id = ? AND status = 'ready'",
  )
    .bind(id, tid)
    .first<Record<string, unknown>>();
  if (!row) return json({ error: "Not found" }, 404);
  // Contact info (email/wechat) is for judges only — never expose it to anonymous viewers.
  const auth = await getAuth(request, env, tid);
  return json({ submission: publicSubmission(row, Boolean(auth)) });
}

function publicSubmission(row: Record<string, unknown>, includeContact: boolean) {
  const id = String(row.id);
  const shotCount = Number(row.shot_count ?? 0);
  return {
    id,
    projectName: row.project_name || row.team_name || "未命名作品",
    teamName: row.team_name ?? "",
    contact: includeContact ? (row.contact ?? null) : null,
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    repoUrl: row.repo_url,
    description: row.description ?? "",
    videoUrl: row.video_url,
    lockedSha: row.locked_sha ?? null,
    createdAt: row.created_at,
    shots: Array.from({ length: shotCount }, (_, i) => `/shot/${id}/${i}`),
    viewUrl: `/p/${id}`,
  };
}

async function createSubmission(request: Request, env: Env, tid: string | null): Promise<Response> {
  if (!tid) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
  const body = await request
    .json<{
      passcode?: string;
      projectName?: string;
      teamName?: string;
      contact?: string;
      repoUrl?: string;
      description?: string;
      videoUrl?: string;
      shots?: string[];
      editToken?: string;
    }>()
    .catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const inviteCode = String(body.passcode ?? "").trim();
  const projectName = String(body.projectName ?? "").trim().slice(0, 80);
  const teamName = String(body.teamName ?? "").trim().slice(0, 80);
  const contact = String(body.contact ?? "").trim().slice(0, 120) || null;
  const description = String(body.description ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  const videoUrl = String(body.videoUrl ?? "").trim();
  const repo = parseRepoUrl(body.repoUrl);
  const maxShots = numberEnv(env.MAX_SHOTS, DEFAULT_MAX_SHOTS);
  const maxShotBytes = numberEnv(env.MAX_SHOT_BYTES, DEFAULT_MAX_SHOT_BYTES);

  if (!projectName) return json({ error: "请填写产品名称 / Product name required" }, 400);
  if (!repo) return json({ error: "GitHub 仓库链接无效 / Invalid GitHub repo URL" }, 400);
  if (!isHttpUrl(videoUrl) || videoUrl.length > 500) {
    return json({ error: "请填写有效的视频链接(B站/YouTube)/ Valid video link required" }, 400);
  }
  const minShots = numberEnv(env.MIN_SHOTS, DEFAULT_MIN_SHOTS);
  const shots = Array.isArray(body.shots) ? body.shots : [];
  if (shots.length < minShots) return json({ error: `请至少上传 ${minShots} 张截图 / At least ${minShots} screenshots required` }, 400);
  if (shots.length > maxShots) return json({ error: `最多 ${maxShots} 张截图 / At most ${maxShots} screenshots` }, 400);

  const decoded: { contentType: string; bytes: Uint8Array }[] = [];
  for (const shot of shots) {
    const parsed = dataUrlToBytes(shot);
    if (!parsed || !parsed.contentType.startsWith("image/")) {
      return json({ error: "截图必须是图片 / Screenshots must be images" }, 400);
    }
    if (parsed.bytes.byteLength > maxShotBytes) {
      return json({ error: "单张截图过大 / A screenshot is too large" }, 400);
    }
    decoded.push(parsed);
  }

  // Verify the repo is public and exists.
  const check = await ghGet(env, `/repos/${repo.owner}/${repo.repo}`);
  if (check.status === 404) return json({ error: "仓库不存在或未公开 / Repo not found or not public" }, 400);
  if (check.status === 200) {
    try {
      if (JSON.parse(check.text).private) return json({ error: "仓库需设为 Public / Repo must be public" }, 400);
    } catch {
      /* ignore parse issues, allow through */
    }
  }

  const existing = await env.DB.prepare(
    "SELECT id, edit_token, shot_count FROM submissions WHERE tenant_id = ? AND repo_owner = ? AND repo_name = ?",
  )
    .bind(tid, repo.owner, repo.repo)
    .first<{ id: string; edit_token: string; shot_count: number }>();

  const now = unixNow();
  const shotsMeta = JSON.stringify(decoded.map((d) => ({ contentType: d.contentType })));

  if (existing) {
    if (!body.editToken || body.editToken !== existing.edit_token) {
      return json({ error: "该仓库已提交,如需修改请使用编辑令牌 / Already submitted; provide edit token to update" }, 409);
    }
    // Replace screenshots in KV.
    await clearShots(env, existing.id, existing.shot_count);
    await putShots(env, existing.id, decoded);
    await env.DB.prepare(
      "UPDATE submissions SET project_name = ?, team_name = ?, contact = ?, repo_url = ?, description = ?, video_url = ?, shot_count = ?, shots_meta = ?, updated_at = ? WHERE id = ?",
    )
      .bind(projectName, teamName, contact, repoUrl(repo), description, videoUrl, decoded.length, shotsMeta, now, existing.id)
      .run();
    return json({ ok: true, id: existing.id, editToken: existing.edit_token, viewUrl: `/p/${existing.id}`, updated: true });
  }

  // New submission: consume a per-team invite code (or the organizer master passcode).
  const id = crypto.randomUUID();
  const isMaster = Boolean(env.SUBMIT_PASSCODE) && inviteCode === env.SUBMIT_PASSCODE;
  if (!isMaster) {
    if (!inviteCode) return json({ error: "请填写邀请码 / Invite code required" }, 400);
    const consumed = await env.DB.prepare(
      "UPDATE invite_codes SET used_by = ?, used_at = ? WHERE code = ? AND tenant_id = ? AND used_by IS NULL",
    )
      .bind(id, unixNow(), inviteCode, tid)
      .run();
    if (consumed.meta.changes !== 1) {
      return json({ error: "邀请码无效或已被使用 / Invite code invalid or already used" }, 403);
    }
  }

  const shareToken = randomToken(16);
  const editToken = randomToken(18);
  try {
    await putShots(env, id, decoded);
    await env.DB.prepare(
      "INSERT INTO submissions (id, tenant_id, project_name, team_name, contact, repo_owner, repo_name, repo_url, description, video_url, shot_count, shots_meta, share_token, edit_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)",
    )
      .bind(id, tid, projectName, teamName, contact, repo.owner, repo.repo, repoUrl(repo), description, videoUrl, decoded.length, shotsMeta, shareToken, editToken, now, now)
      .run();
  } catch (error) {
    // Roll back so a failed create (e.g. a repo-uniqueness race) doesn't burn the
    // team's invite code or leave orphaned screenshots in KV.
    if (!isMaster) {
      await env.DB.prepare("UPDATE invite_codes SET used_by = NULL, used_at = NULL WHERE code = ? AND tenant_id = ? AND used_by = ?")
        .bind(inviteCode, tid, id)
        .run()
        .catch(() => {});
    }
    await clearShots(env, id, decoded.length).catch(() => {});
    throw error;
  }
  return json({ ok: true, id, editToken, viewUrl: `/p/${id}` });
}

async function putShots(env: Env, id: string, shots: { contentType: string; bytes: Uint8Array }[]): Promise<void> {
  await Promise.all(
    shots.map((shot, i) =>
      env.SHOTS.put(`shot:${id}:${i}`, shot.bytes, { metadata: { contentType: shot.contentType } }),
    ),
  );
}

async function clearShots(env: Env, id: string, count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, i) => env.SHOTS.delete(`shot:${id}:${i}`)));
}

async function serveShot(env: Env, id: string, idx: number): Promise<Response> {
  const { value, metadata } = await env.SHOTS.getWithMetadata<{ contentType?: string }>(`shot:${id}:${idx}`, {
    type: "arrayBuffer",
  });
  if (!value) return json({ error: "Not found" }, 404);
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=300",
      "X-Robots-Tag": "noindex",
    },
  });
}

async function serveAsset(env: Env, name: string): Promise<Response> {
  const { value, metadata } = await env.SHOTS.getWithMetadata<{ contentType?: string }>(`asset:${name}`, {
    type: "arrayBuffer",
  });
  if (!value) return json({ error: "Not found" }, 404);
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

async function lockSubmission(request: Request, env: Env, tid: string | null, id: string): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const row = await env.DB.prepare("SELECT repo_owner, repo_name FROM submissions WHERE id = ? AND tenant_id = ?")
    .bind(id, tid)
    .first<{ repo_owner: string; repo_name: string }>();
  if (!row) return json({ error: "Not found" }, 404);
  const res = await ghGet(env, `/repos/${row.repo_owner}/${row.repo_name}/commits?per_page=1`);
  if (res.status !== 200) return json({ error: "无法获取最新提交 / Could not fetch latest commit" }, 502);
  let sha = "";
  try {
    sha = JSON.parse(res.text)?.[0]?.sha ?? "";
  } catch {
    /* ignore */
  }
  if (!sha) return json({ error: "无法解析提交 SHA" }, 502);
  await env.DB.prepare("UPDATE submissions SET locked_sha = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(sha, unixNow(), id, tid)
    .run();
  return json({ ok: true, lockedSha: sha });
}

async function hideSubmission(request: Request, env: Env, tid: string | null, id: string): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  await env.DB.prepare("UPDATE submissions SET status = 'hidden', updated_at = ? WHERE id = ? AND tenant_id = ?")
    .bind(unixNow(), id, tid)
    .run();
  return json({ ok: true });
}

// ============================ GitHub proxy (cached) ============================

async function ghGet(env: Env, path: string, accept = "application/vnd.github+json"): Promise<{ status: number; text: string }> {
  const url = `https://api.github.com${path}`;
  const cache = (caches as unknown as { default: Cache }).default;
  const cacheKey = new Request(`${url}#${accept}`);
  const hit = await cache.match(cacheKey);
  if (hit) return { status: 200, text: await hit.text() };

  const headers: Record<string, string> = { "User-Agent": "HackVideo-Worker", Accept: accept };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const upstream = await fetch(url, { headers });
  const text = await upstream.text();
  if (upstream.ok) {
    await cache.put(
      cacheKey,
      new Response(text, {
        headers: {
          "Cache-Control": "public, max-age=600",
          "Content-Type": upstream.headers.get("content-type") || "application/json",
        },
      }),
    );
  }
  return { status: upstream.status, text };
}

async function ghRepo(env: Env, owner: string, repo: string): Promise<Response> {
  const res = await ghGet(env, `/repos/${owner}/${repo}`);
  if (res.status !== 200) return json({ error: "GitHub repo unavailable", status: res.status }, res.status === 404 ? 404 : 502);
  const d = JSON.parse(res.text);
  return json(
    {
      fullName: d.full_name,
      description: d.description,
      stars: d.stargazers_count,
      forks: d.forks_count,
      language: d.language,
      pushedAt: d.pushed_at,
      htmlUrl: d.html_url,
      homepage: d.homepage,
      defaultBranch: d.default_branch,
      topics: d.topics ?? [],
      openIssues: d.open_issues_count,
    },
    200,
    { "Cache-Control": "public, max-age=300" },
  );
}

async function ghReadme(env: Env, owner: string, repo: string): Promise<Response> {
  const res = await ghGet(env, `/repos/${owner}/${repo}/readme`, "application/vnd.github.html+json");
  if (res.status === 404) return json({ html: "<p>该仓库暂无 README。No README found.</p>" });
  if (res.status !== 200) return json({ html: "<p>README 加载失败。Failed to load README.</p>" });
  return json({ html: res.text });
}

// ============================ scoring ============================

async function listMyScores(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "judge");
  if (!auth) return json({ error: "Login required" }, 401);
  const rows = await env.DB.prepare(
    "SELECT submission_id, innovation, technical, completeness, presentation, comment FROM scores WHERE tenant_id = ? AND judge_id = ?",
  )
    .bind(tid, auth.jid)
    .all<Record<string, unknown>>();
  const byId: Record<string, unknown> = {};
  for (const r of rows.results) byId[String(r.submission_id)] = r;
  return json({ scores: byId });
}

async function upsertScore(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "judge");
  if (!auth) return json({ error: "Login required" }, 401);
  const body = await request.json<Record<string, unknown>>().catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  const submissionId = String(body.submissionId ?? "");
  if (!submissionId) return json({ error: "Missing submissionId" }, 400);
  const exists = await env.DB.prepare("SELECT id FROM submissions WHERE id = ? AND tenant_id = ? AND status = 'ready'")
    .bind(submissionId, tid)
    .first();
  if (!exists) return json({ error: "Submission not found" }, 404);

  const values: Record<Dim, number> = {} as Record<Dim, number>;
  for (const dim of DIMS) {
    const n = Math.round(Number(body[dim]));
    if (!Number.isFinite(n) || n < 1 || n > 10) return json({ error: `${dim} 必须是 1-10 / must be 1-10` }, 400);
    values[dim] = n;
  }
  const comment = String(body.comment ?? "").trim().slice(0, 500) || null;
  const now = unixNow();
  await env.DB.prepare(
    `INSERT INTO scores (id, tenant_id, submission_id, judge_id, judge_name, innovation, technical, completeness, presentation, comment, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(submission_id, judge_id) DO UPDATE SET
       judge_name = excluded.judge_name,
       innovation = excluded.innovation, technical = excluded.technical,
       completeness = excluded.completeness, presentation = excluded.presentation,
       comment = excluded.comment, updated_at = excluded.updated_at`,
  )
    .bind(crypto.randomUUID(), tid, submissionId, auth.jid, auth.name, values.innovation, values.technical, values.completeness, values.presentation, comment, now, now)
    .run();
  return json({ ok: true });
}

async function leaderboard(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "judge");
  if (!auth) return json({ error: "Login required" }, 401);
  const rows = await env.DB.prepare(
    `SELECT s.id, s.project_name, s.team_name, s.repo_owner, s.repo_name,
       COUNT(sc.id) AS judges,
       AVG(sc.innovation + sc.technical + sc.completeness + sc.presentation) AS avg_total
     FROM submissions s LEFT JOIN scores sc ON sc.submission_id = s.id
     WHERE s.tenant_id = ? AND s.status = 'ready'
     GROUP BY s.id
     ORDER BY (avg_total IS NULL), avg_total DESC, s.created_at ASC`,
  )
    .bind(tid)
    .all<Record<string, unknown>>();
  return json({
    rows: rows.results.map((r) => ({
      id: r.id,
      projectName: r.project_name || r.team_name || "未命名作品",
      teamName: r.team_name,
      repo: `${r.repo_owner}/${r.repo_name}`,
      judges: Number(r.judges ?? 0),
      avgTotal: r.avg_total == null ? null : Math.round(Number(r.avg_total) * 10) / 10,
    })),
  });
}

async function exportScores(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const rows = await env.DB.prepare(
    `SELECT s.project_name, s.team_name, s.repo_owner, s.repo_name, sc.judge_name,
       sc.innovation, sc.technical, sc.completeness, sc.presentation,
       (sc.innovation + sc.technical + sc.completeness + sc.presentation) AS total, sc.comment
     FROM scores sc JOIN submissions s ON s.id = sc.submission_id
     WHERE s.tenant_id = ?
     ORDER BY s.project_name, sc.judge_name`,
  )
    .bind(tid)
    .all<Record<string, unknown>>();
  const header = ["product", "team", "repo", "judge", "innovation", "technical", "completeness", "presentation", "total", "comment"];
  const lines = [header.join(",")];
  for (const r of rows.results) {
    lines.push(
      [
        r.project_name,
        r.team_name,
        `${r.repo_owner}/${r.repo_name}`,
        r.judge_name,
        r.innovation,
        r.technical,
        r.completeness,
        r.presentation,
        r.total,
        r.comment ?? "",
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="hackvideo-scores.csv"',
      "Cache-Control": "no-store",
    },
  });
}

function csvCell(value: unknown): string {
  let s = String(value ?? "");
  // Neutralize Excel/Sheets formula injection: a leading =,+,-,@ (or tab/CR) makes the cell
  // execute as a formula. Prefix with a single quote so it is treated as literal text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ============================ invite codes ============================

async function generateInvites(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const body = await request.json<{ count?: number; prefix?: string }>().catch(() => null);
  const count = Math.max(1, Math.min(500, Math.round(Number(body?.count) || 0)));
  if (!count) return json({ error: "数量需为 1-500 / count must be 1-500" }, 400);
  const prefix = (String(body?.prefix ?? "HV").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "HV").slice(0, 8);

  const now = unixNow();
  const codes: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  const insert = env.DB.prepare("INSERT OR IGNORE INTO invite_codes (code, tenant_id, created_at) VALUES (?, ?, ?)");
  for (let i = 0; i < count; i += 1) {
    const code = `${prefix}-${randomCodeBody(6)}`;
    codes.push(code);
    stmts.push(insert.bind(code, tid, now));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, count: codes.length, codes });
}

async function listInvites(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const rows = await env.DB.prepare(
    "SELECT code, used_by, created_at, used_at FROM invite_codes WHERE tenant_id = ? ORDER BY (used_by IS NOT NULL), created_at DESC LIMIT 1000",
  )
    .bind(tid)
    .all<{ code: string; used_by: string | null; created_at: number; used_at: number | null }>();
  const codes = rows.results.map((r) => ({ code: r.code, used: r.used_by != null }));
  return json({
    total: codes.length,
    unused: codes.filter((c) => !c.used).length,
    codes,
  });
}

async function createJudges(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const body = await request.json<{ names?: string[]; prefix?: string }>().catch(() => null);
  const names = (Array.isArray(body?.names) ? body!.names : [])
    .map((n) => String(n ?? "").trim().slice(0, 40))
    .filter(Boolean)
    .slice(0, 200);
  if (!names.length) return json({ error: "请提供至少一个评委姓名 / At least one name required" }, 400);
  const prefix = (String(body?.prefix ?? "J").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "J").slice(0, 8);

  const now = unixNow();
  const created: { name: string; code: string }[] = [];
  const stmts: D1PreparedStatement[] = [];
  const insert = env.DB.prepare("INSERT OR IGNORE INTO judges (code, tenant_id, name, created_at) VALUES (?, ?, ?, ?)");
  for (const name of names) {
    const code = `${prefix}-${randomCodeBody(6)}`;
    created.push({ name, code });
    stmts.push(insert.bind(code, tid, name, now));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, count: created.length, judges: created });
}

async function listJudges(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const rows = await env.DB.prepare("SELECT code, name FROM judges WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 500")
    .bind(tid)
    .all<{ code: string; name: string }>();
  return json({ judges: rows.results });
}

function randomCodeBody(len: number): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no I,O,0,1,L to avoid confusion
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// ============================ reserved R2 video upload (gated) ============================

async function startUpload(request: Request, env: Env): Promise<Response> {
  if (env.VIDEO_UPLOAD !== "on" || !env.VIDEO_BUCKET) {
    return json({ error: "视频直传暂未开放,请填视频外链 / Direct upload disabled; use a video link" }, 503);
  }
  const body = await request
    .json<{ passcode?: string; submissionId?: string; editToken?: string; filename?: string; contentType?: string; size?: number }>()
    .catch(() => null);
  if (!body || body.passcode !== env.SUBMIT_PASSCODE) return json({ error: "提交口令错误" }, 403);
  const row = await env.DB.prepare("SELECT id, edit_token FROM submissions WHERE id = ?")
    .bind(String(body.submissionId ?? ""))
    .first<{ id: string; edit_token: string }>();
  if (!row || body.editToken !== row.edit_token) return json({ error: "Not found" }, 404);

  const maxBytes = numberEnv(env.MAX_VIDEO_BYTES, 80 * 1024 * 1024);
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0 || size > maxBytes) return json({ error: `视频需 ≤ ${Math.round(maxBytes / 1024 / 1024)}MB` }, 400);
  const contentType = String(body.contentType || "video/mp4").split(";")[0];
  const key = `submissions/${row.id}/video`;
  const expires = numberEnv(env.SIGNED_UPLOAD_EXPIRES_SECONDS, 900);
  const uploadUrl = await presignR2Put(env, key, contentType, expires);
  return json({ uploadUrl, key, headers: { "Content-Type": contentType }, expiresInSeconds: expires });
}

async function completeUpload(request: Request, env: Env): Promise<Response> {
  if (env.VIDEO_UPLOAD !== "on" || !env.VIDEO_BUCKET) return json({ error: "Disabled" }, 503);
  const body = await request.json<{ submissionId?: string; editToken?: string }>().catch(() => null);
  const row = await env.DB.prepare("SELECT id, edit_token FROM submissions WHERE id = ?")
    .bind(String(body?.submissionId ?? ""))
    .first<{ id: string; edit_token: string }>();
  if (!row || body?.editToken !== row.edit_token) return json({ error: "Not found" }, 404);
  const key = `submissions/${row.id}/video`;
  const head = await env.VIDEO_BUCKET.head(key);
  if (!head) return json({ error: "Upload not visible yet" }, 409);
  await env.DB.prepare("UPDATE submissions SET video_key = ?, video_url = ?, updated_at = ? WHERE id = ?")
    .bind(key, `/media/${row.id}/video`, unixNow(), row.id)
    .run();
  return json({ ok: true, videoUrl: `/media/${row.id}/video` });
}

async function serveVideo(request: Request, env: Env, id: string): Promise<Response> {
  if (!env.VIDEO_BUCKET) return json({ error: "Not found" }, 404);
  const row = await env.DB.prepare("SELECT video_key, video_url FROM submissions WHERE id = ? AND status = 'ready'")
    .bind(id)
    .first<{ video_key: string | null }>();
  if (!row?.video_key) return json({ error: "Not found" }, 404);
  const head = await env.VIDEO_BUCKET.head(row.video_key);
  if (!head) return json({ error: "Not found" }, 404);
  const range = parseRange(request.headers.get("range"), head.size);
  const object = await env.VIDEO_BUCKET.get(
    row.video_key,
    range ? { range: { offset: range.start, length: range.end - range.start + 1 } } : undefined,
  );
  if (!object) return json({ error: "Not found" }, 404);
  const headers = new Headers({
    "Content-Type": head.httpMetadata?.contentType || "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=300",
  });
  if (range) {
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${head.size}`);
    headers.set("Content-Length", String(range.end - range.start + 1));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(head.size));
  return new Response(object.body, { headers });
}

async function presignR2Put(env: Env, key: string, contentType: string, expiresSeconds: number): Promise<string> {
  if (!env.R2_ACCOUNT_ID || !env.R2_BUCKET_NAME || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
    throw new Error("Missing R2 S3 credentials");
  }
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalUri = `/${encodePathSegment(env.R2_BUCKET_NAME)}/${key.split("/").map(encodePathSegment).join("/")}`;
  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${env.R2_ACCESS_KEY_ID}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "content-type;host",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
  });
  params.sort();
  const canonicalRequest = ["PUT", canonicalUri, params.toString(), `content-type:${contentType}\nhost:${host}\n`, "content-type;host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");
  const kDate = await hmacRaw(utf8(`AWS4${env.R2_SECRET_ACCESS_KEY}`), dateStamp);
  const kRegion = await hmacRaw(kDate, region);
  const kService = await hmacRaw(kRegion, service);
  const signingKey = await hmacRaw(kService, "aws4_request");
  params.set("X-Amz-Signature", await hmacHex(signingKey, stringToSign));
  return `https://${host}${canonicalUri}?${params.toString()}`;
}

function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!match[1] && match[2]) {
    start = Math.max(size - Number(match[2]), 0);
    end = size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

// ============================ helpers ============================

function parseRepoUrl(input: unknown): { owner: string; repo: string } | null {
  const s = String(input ?? "").trim();
  const m = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, "");
  if (!owner || !repo || owner === "." || repo === ".") return null;
  return { owner, repo };
}

function repoUrl(repo: { owner: string; repo: string }): string {
  return `https://github.com/${repo.owner}/${repo.repo}`;
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function dataUrlToBytes(dataUrl: unknown): { contentType: string; bytes: Uint8Array } | null {
  const s = String(dataUrl ?? "");
  if (!s.startsWith("data:")) return null;
  const comma = s.indexOf(",");
  if (comma < 0) return null;
  const header = s.slice(5, comma);
  if (!header.includes("base64")) return null;
  const contentType = header.split(";")[0] || "application/octet-stream";
  try {
    const bin = atob(s.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return { contentType, bytes };
  } catch {
    return null;
  }
}

function b64urlEncode(str: string): string {
  const bytes = utf8(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(str: string): string {
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacRaw(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", cryptoKey, utf8(data));
}

async function hmacHex(key: ArrayBuffer | Uint8Array, data: string): Promise<string> {
  return hex(await hmacRaw(key, data));
}

async function sha256Hex(data: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", utf8(data)));
}

// Peppered hash for per-tenant admin passwords (AUTH_SECRET is the pepper).
async function hashSecret(env: Env, value: string): Promise<string> {
  return sha256Hex(`${env.AUTH_SECRET}:${value}`);
}

function escapeHtml(value: string): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key) cookies[key] = value.join("=");
  }
  return cookies;
}

function numberEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function utf8(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}

function html(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}

function noContent(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

const APP_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>HackVideo</title>
  <style>
    :root{color-scheme:light;--bg:#f6f7fb;--panel:#fff;--ink:#14161c;--muted:#5f6675;--line:#e2e6ee;--brand:#5b4be6;--brand-dark:#4536c9;--ok:#0f9d6b;--danger:#c0392b;--shadow:0 14px 44px rgba(24,28,52,.10)}
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
    a{color:var(--brand);text-decoration:none}
    button,input,textarea,select{font:inherit}
    button{border:0;background:var(--brand);color:#fff;border-radius:8px;padding:9px 15px;cursor:pointer;font-weight:650}
    button:hover{background:var(--brand-dark)}
    button:disabled{opacity:.5;cursor:not-allowed}
    .ghost{background:#fff;color:var(--ink);border:1px solid var(--line)}
    .ghost:hover{background:#eef1f6}
    header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px clamp(16px,4vw,48px);background:rgba(255,255,255,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
    .brand{display:flex;align-items:center;gap:10px;font-weight:800;cursor:pointer}
    .mark{width:30px;height:30px;border-radius:8px;background:var(--brand);color:#fff;display:grid;place-items:center;font-size:13px}
    nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    nav .who{color:var(--muted);font-size:13px;margin-right:4px}
    main{width:min(1200px,100%);margin:0 auto;padding:24px clamp(14px,4vw,32px) 72px}
    h1{font-size:clamp(24px,4vw,36px);margin:0 0 8px}
    h2{font-size:20px;margin:0 0 12px}
    p{color:var(--muted);line-height:1.6}
    label{display:block;font-size:13px;font-weight:700;margin:14px 0 6px}
    input,textarea,select{width:100%;border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:#fff;color:var(--ink);outline:none}
    textarea{min-height:84px;resize:vertical}
    input:focus,textarea:focus,select:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(91,75,230,.14)}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;box-shadow:var(--shadow)}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .muted{color:var(--muted);font-size:13px}
    .notice{margin-top:14px;padding:11px 13px;border-radius:8px;background:#eef4ff;color:#25408f;word-break:break-word}
    .notice.err{background:#fdeeec;color:var(--danger)}
    .notice.ok{background:#e9f8f1;color:var(--ok)}
    .gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
    .card{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:var(--shadow);display:flex;flex-direction:column}
    .carousel{position:relative;aspect-ratio:16/9;background:#0b0d12;overflow:hidden;cursor:pointer}
    .carousel img{width:100%;height:100%;object-fit:cover;display:none}
    .carousel img.on{display:block}
    .carousel .nav-btn{position:absolute;top:50%;transform:translateY(-50%);width:30px;height:30px;border-radius:50%;background:rgba(15,17,24,.55);color:#fff;display:grid;place-items:center;cursor:pointer;font-size:16px;border:0;padding:0}
    .carousel .nav-btn:hover{background:rgba(15,17,24,.8)}
    .carousel .prev{left:8px}.carousel .next{right:8px}
    .carousel .dots{position:absolute;bottom:8px;left:0;right:0;display:flex;justify-content:center;gap:5px}
    .carousel .dot{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.5)}
    .carousel .dot.on{background:#fff}
    .vbadge{position:absolute;top:8px;left:8px;background:rgba(15,17,24,.65);color:#fff;font-size:11px;padding:3px 8px;border-radius:999px;display:flex;gap:4px;align-items:center}
    .card-body{padding:13px;display:flex;flex-direction:column;gap:8px;cursor:pointer;flex:1}
    .card-title{font-weight:750;line-height:1.35;color:var(--ink)}
    .card-repo{font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
    .card-desc{font-size:13px;color:#3c4250;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .card-meta{display:flex;gap:12px;font-size:12px;color:var(--muted);margin-top:auto;flex-wrap:wrap}
    .chip{display:inline-flex;gap:4px;align-items:center}
    .detail-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:20px;align-items:start}
    .videobox{position:relative;aspect-ratio:16/9;background:#000;border-radius:10px;overflow:hidden}
    .videobox iframe,.videobox video{position:absolute;inset:0;width:100%;height:100%;border:0}
    .shot-strip{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-top:12px}
    .shot-strip img{height:88px;border-radius:8px;border:1px solid var(--line);cursor:pointer;flex:0 0 auto}
    .readme-frame{width:100%;height:560px;border:1px solid var(--line);border-radius:10px;background:#fff;margin-top:8px}
    .kv{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
    .kv:last-child{border-bottom:0}
    .kv b{font-weight:650}
    .score-dim{display:flex;align-items:center;gap:12px;margin:10px 0}
    .score-dim label{margin:0;flex:1}
    .score-dim input[type=range]{flex:2}
    .score-dim .val{width:28px;text-align:center;font-weight:750}
    table{width:100%;border-collapse:collapse}
    th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);font-size:14px}
    th{color:var(--muted);font-weight:650}
    .rank{font-weight:800;color:var(--brand)}
    .thumbs{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
    .thumbs .t{position:relative}
    .thumbs img{height:70px;border-radius:8px;border:1px solid var(--line)}
    .thumbs .x{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;background:var(--danger);color:#fff;font-size:12px;line-height:20px;text-align:center;cursor:pointer}
    .lightbox{position:fixed;inset:0;background:rgba(6,8,14,.9);display:grid;place-items:center;z-index:50;padding:24px}
    .lightbox img{max-width:100%;max-height:100%;border-radius:8px}
    .hidden{display:none!important}
    @media(max-width:820px){.detail-grid{grid-template-columns:1fr}}
    .guide-banner{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:16px 0 22px;padding:14px 20px;background:linear-gradient(135deg,#efeafd,#eaf0ff);border:1px solid #ddd6f7;border-radius:12px;cursor:pointer;font-weight:650;color:var(--brand-dark)}
    .guide-banner:hover{background:linear-gradient(135deg,#e7e0fb,#e0ebff)}
    .guide-banner b{font-size:20px}
    .guide{max-width:900px;margin:0 auto}
    .guide-hero{text-align:center;padding:16px 0 6px}
    .guide-sub{color:var(--muted);font-size:18px;margin-top:-4px}
    .guide-row{display:grid;grid-template-columns:1fr 1fr;gap:28px;align-items:center;margin:28px 0;padding:24px;background:var(--panel);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow)}
    .guide-row .guide-art{background:linear-gradient(135deg,#f3f1fe,#eaf0ff);border-radius:12px;padding:16px}
    .guide-row.rev .guide-art{order:2}
    .guide-row h2{font-size:23px;margin:0 0 10px}
    .guide-row p{font-size:15px;line-height:1.75;color:#3c4250;margin:0}
    .guide-steps{display:grid;gap:14px;margin:22px 0}
    .step{display:flex;gap:16px;align-items:flex-start;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
    .step .num{flex:0 0 auto;width:40px;height:40px;border-radius:50%;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:800;font-size:18px}
    .step h3{margin:0 0 5px;font-size:17px}
    .step p{margin:0;color:#3c4250;line-height:1.6;font-size:14px}
    .guide-cta{text-align:center;margin:34px 0;padding:32px;background:linear-gradient(135deg,var(--brand),#7a6bf0);border-radius:16px;color:#fff}
    .guide-cta h2{color:#fff;margin:0 0 14px}
    .guide-cta button{background:#fff;color:var(--brand)}
    @media(max-width:720px){.guide-row{grid-template-columns:1fr}.guide-row.rev .guide-art{order:0}}
    .site-footer{text-align:center;padding:26px 16px;margin-top:48px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;line-height:1.7}
    .tenant-hero{margin-bottom:18px}
    .tenant-hero .hero-meta{display:flex;gap:18px;flex-wrap:wrap;color:#3c4250;font-size:14px;font-weight:600}
    .map-embed{width:100%;height:280px;border:0;border-radius:10px;margin-top:12px}
    .map-links{margin-top:10px;font-size:13px;color:var(--muted)}
    .map-links a{font-weight:650}
    .agenda{margin-top:16px}
    .agenda .ag-h{font-weight:700;font-size:14px;color:#3c4250;margin-bottom:8px}
    .ag-item{display:flex;gap:14px;padding:8px 0;border-bottom:1px dashed var(--line);font-size:14px}
    .ag-item:last-child{border-bottom:0}
    .ag-t{flex:0 0 140px;color:var(--brand);font-weight:650;font-family:ui-monospace,Menlo,monospace;font-size:13px}
    .ag-x{color:#3c4250}
    @media(max-width:560px){.ag-item{flex-direction:column;gap:2px}.ag-t{flex:none}}
    .masonry{columns:3 240px;column-gap:14px}
    .mphoto{position:relative;break-inside:avoid;margin-bottom:14px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:#fff;box-shadow:var(--shadow)}
    .mphoto img{width:100%;display:block;cursor:pointer}
    .mphoto .cap{padding:8px 10px;font-size:13px;color:#3c4250}
    .mphoto .pdel{position:absolute;top:8px;right:8px;width:24px;height:24px;border-radius:50%;background:rgba(192,57,43,.92);color:#fff;text-align:center;line-height:24px;cursor:pointer;font-size:15px}
  </style>
</head>
<body>
  <header>
    <div class="brand" onclick="go('/')">
      <svg width="32" height="32" viewBox="0 0 40 40" aria-hidden="true" style="flex:0 0 auto">
        <rect width="40" height="40" rx="11" fill="#0a0e0a"/>
        <path d="M12 13 6.5 20 12 27" fill="none" stroke="#25ff86" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M28 13 33.5 20 28 27" fill="none" stroke="#25ff86" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
        <text x="20" y="26.5" text-anchor="middle" font-family="ui-monospace,Menlo,monospace" font-size="17" font-weight="800" fill="#25ff86">5</text>
      </svg>
      <span id="brandName">hack5</span></div>
    <nav id="nav"></nav>
  </header>
  <main id="app"></main>
  <footer class="site-footer">Mycelium: Digital Public Goods 🚌 = 🪵 Infras | 🦠 Protocols | 🕸️ Networks. All rights reserved.</footer>
  <div id="lightbox" class="lightbox hidden" onclick="this.classList.add('hidden')"></div>

  <script>
  const app = document.getElementById('app');
  const $ = (s, r=document) => r.querySelector(s);
  let CONFIG = null, ME = { role: null }, ME_USER = { email: null };
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  let LANG = lsGet('hv_lang') === 'en' ? 'en' : 'zh';
  const t = (zh, en) => LANG === 'en' ? en : zh;
  window.toggleLang = () => { LANG = LANG === 'en' ? 'zh' : 'en'; lsSet('hv_lang', LANG); document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN'; renderNav(); route(); };

  function go(path){ history.pushState(null, '', path); route(); }
  window.addEventListener('popstate', route);
  window.go = go;

  boot();
  async function boot(){
    CONFIG = await api('/api/config').catch(()=>({appName:'hack5',platform:false,tenant:null,eventName:'Hackathon',minShots:2,maxShots:4,maxShotBytes:1048576,dims:['innovation','technical','completeness','presentation'],maxVideoSeconds:180}));
    const brand = CONFIG.tenant ? CONFIG.tenant.name : CONFIG.appName;
    document.getElementById('brandName').textContent = brand;
    document.title = brand;
    document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
    if(CONFIG.platform) ME_USER = await api('/api/platform/me').catch(()=>({email:null}));
    else ME = await api('/api/auth/me').catch(()=>({role:null}));
    renderNav();
    route();
  }

  function renderNav(){
    const n = document.getElementById('nav');
    if(CONFIG.platform){
      let hp = '<button class="ghost" onclick="go(\'/guide\')">'+t('指南','Guide')+'</button>'
             + '<button class="ghost" onclick="go(\'/about\')">'+t('关于','About')+'</button>';
      if(ME_USER.email){
        hp += '<button onclick="go(\'/dashboard\')">'+t('我的黑客松','My hackathons')+'</button>'
            + '<span class="who">'+esc(ME_USER.email)+'</span>'
            + '<button class="ghost" onclick="userLogout()">'+t('退出','Logout')+'</button>';
      } else {
        hp += '<button onclick="go(\'/start\')">'+t('发起黑客松','Start a hackathon')+'</button>';
      }
      hp += '<button class="ghost" onclick="toggleLang()" title="中 / EN">'+(LANG==='en'?'中文':'EN')+'</button>';
      n.innerHTML = hp; return;
    }
    let h = '<button class="ghost" onclick="go(\'/\')">'+t('作品墙','Gallery')+'</button>'
          + '<button class="ghost" onclick="go(\'/register\')">'+t('报名','Register')+'</button>'
          + '<button class="ghost" onclick="go(\'/photos\')">'+t('照片墙','Photos')+'</button>'
          + '<button class="ghost" onclick="go(\'/submit\')">'+t('提交作品','Submit')+'</button>'
          + '<button class="ghost" onclick="go(\'/about\')">'+t('关于','About')+'</button>';
    if(ME.role){
      h += '<button class="ghost" onclick="go(\'/leaderboard\')">'+t('排行榜','Leaderboard')+'</button>'
         + (ME.role==='admin'?'<button class="ghost" onclick="go(\'/manage\')">'+t('首页','Homepage')+'</button><button class="ghost" onclick="go(\'/poster\')">'+t('海报','Poster')+'</button><button class="ghost" onclick="go(\'/invites\')">'+t('邀请码','Invites')+'</button><button class="ghost" onclick="go(\'/judges\')">'+t('评委','Judges')+'</button>':'')
         + '<span class="who">'+esc(ME.name)+' · '+(ME.role==='admin'?t('管理','Admin'):t('评委','Judge'))+'</span>'
         + '<button onclick="logout()">'+t('退出','Logout')+'</button>';
    } else {
      h += '<button onclick="go(\'/judge\')">'+t('评审入口','Judge login')+'</button>';
    }
    h += '<button class="ghost" onclick="toggleLang()" title="中 / EN">'+(LANG==='en'?'中文':'EN')+'</button>';
    n.innerHTML = h;
  }

  async function logout(){ await api('/api/auth/logout',{method:'POST',body:{}}).catch(()=>{}); ME={role:null}; renderNav(); go('/'); }
  window.logout = logout;

  function route(){
    const p = location.pathname;
    let m;
    if(CONFIG.tenantNotFound) return renderTenantNotFound();
    if(CONFIG.platform){
      if(p === '/about') return renderAbout();
      if(p === '/guide') return renderGuide();
      if(p === '/start' || p === '/dashboard') return ME_USER.email ? renderDashboard() : renderPlatformLogin();
      return renderPlatformLanding();
    }
    if(p === '/' || p === '') return renderWall();
    if(p === '/submit') return renderSubmit();
    if(p === '/judge') return renderJudge();
    if(p === '/guide') return renderGuide();
    if(p === '/about') return renderAbout();
    if(p === '/start') return renderStart();
    if(p === '/leaderboard') return renderLeaderboard();
    if(p === '/invites') return renderInvites();
    if(p === '/judges') return renderJudges();
    if(p === '/manage') return renderTenantEdit();
    if(p === '/photos') return renderPhotos();
    if(p === '/poster') return renderPoster();
    if(p === '/register') return renderRegister();
    if((m = p.match(/^\/p\/([^/]+)$/))) return renderDetail(m[1]);
    if((m = p.match(/^\/watch\/([^/]+)/))) return renderDetail(m[1]);
    app.innerHTML = '<div class="panel"><p>'+t('页面不存在。','Page not found.')+'</p></div>';
  }

  // ---------------- work wall ----------------
  async function renderWall(){
    app.innerHTML = tenantHero()
      + '<h1>'+esc((CONFIG.tenant&&CONFIG.tenant.name)||CONFIG.eventName)+' · '+t('作品墙','Gallery')+'</h1>'
      + '<div class="guide-banner" onclick="go(\'/guide\')"><span>🚀 '+t('第一次参加黑客松?读《如何在 AI 时代成为创新者》','First hackathon? Read “How to become a builder in the AI era”')+'</span><b>→</b></div>'
      + '<div id="wall" class="gallery"></div>';
    const wall = $('#wall');
    wall.innerHTML = '<p>'+t('加载中…','Loading…')+'</p>';
    try {
      const { submissions } = await api('/api/submissions');
      if(!submissions.length){ wall.innerHTML = '<p>'+t('还没有作品,','No projects yet — ')+'<a href="/submit" onclick="go(\'/submit\');return false">'+t('来交第一个','submit the first')+'</a >'+t('。','.')+'</p>'; return; }
      wall.innerHTML = '';
      submissions.forEach(s => wall.appendChild(card(s)));
    } catch(e){ wall.innerHTML = '<p class="notice err">'+esc(e.message)+'</p>'; }
  }

  // ---------------- guide: how to become a builder ----------------
  function renderGuide(){
    const artEra = '<svg viewBox="0 0 440 210" width="100%" xmlns="http://www.w3.org/2000/svg">'
      + '<circle cx="66" cy="86" r="34" fill="#eceafd" stroke="#5b4be6" stroke-width="3"/>'
      + '<path d="M54 100h24M56 108h20" stroke="#5b4be6" stroke-width="3" stroke-linecap="round"/>'
      + '<path d="M66 48V34M40 62l-9-8M92 62l9-8" stroke="#b8adf5" stroke-width="3" stroke-linecap="round"/>'
      + '<path d="M118 92h175" stroke="#c7cede" stroke-width="3" stroke-dasharray="6 9" stroke-linecap="round"/>'
      + '<path d="M289 84l12 8-12 8" fill="none" stroke="#c7cede" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<g transform="translate(330,44)"><path d="M40 0c24 16 24 60 0 92C16 60 16 16 40 0Z" fill="#5b4be6"/>'
      + '<circle cx="40" cy="34" r="11" fill="#fff"/><path d="M22 70 8 92l22-8ZM58 70l14 22-22-8Z" fill="#b8adf5"/>'
      + '<path d="M34 92h12l-2 18h-8z" fill="#ff8a3d"/></g></svg>';
    const artTeam = '<svg viewBox="0 0 440 210" width="100%" xmlns="http://www.w3.org/2000/svg">'
      + '<path d="M220 20l9 20 22 2-17 15 6 22-20-12-20 12 6-22-17-15 22-2z" fill="#ffce54" stroke="#f6b73c" stroke-width="2"/>'
      + '<g><circle cx="140" cy="118" r="22" fill="#b8adf5"/><path d="M108 178a32 30 0 0 1 64 0z" fill="#b8adf5"/>'
      + '<circle cx="300" cy="118" r="22" fill="#8f7ff0"/><path d="M268 178a32 30 0 0 1 64 0z" fill="#8f7ff0"/>'
      + '<circle cx="220" cy="102" r="27" fill="#5b4be6"/><path d="M180 172a40 36 0 0 1 80 0z" fill="#5b4be6"/></g></svg>';
    const steps = [
      ['1','🐙', t('注册 GitHub,建一个仓库','Sign up for GitHub, create a repo'), t('这是你作品的家:代码、README、演示,全放这里。','The home of your project — code, README and demo all live here.')],
      ['2','🤖', t('选一个免费的 AI 开发工具','Pick a free AI coding tool'), t('让 AI 帮你写代码、调试、部署;你负责想法和判断。','Let AI write, debug and deploy; you bring the idea and the judgment.')],
      ['3','🚀', t('说出想法,几小时做出来,push 上线','Say your idea, build it in hours, ship it'), t('别等完美,先让它跑起来 —— 这就是黑客精神。','Do not wait for perfect — get it running. That is the hacker way.')],
    ];
    const artOrg = '<svg viewBox="0 0 440 210" width="100%" xmlns="http://www.w3.org/2000/svg">'
      + '<g stroke="#c7cede" stroke-width="2.5" fill="none"><path d="M220 105 118 55M220 105 322 55M220 105 110 156M220 105 330 156"/></g>'
      + '<circle cx="118" cy="55" r="17" fill="#b8adf5"/><circle cx="322" cy="55" r="17" fill="#8f7ff0"/>'
      + '<circle cx="110" cy="156" r="17" fill="#8f7ff0"/><circle cx="330" cy="156" r="17" fill="#b8adf5"/>'
      + '<circle cx="220" cy="105" r="32" fill="#5b4be6"/>'
      + '<path d="M220 87l6 13 14 1-11 9 4 14-13-8-13 8 4-14-11-9 14-1z" fill="#fff"/></svg>';
    const orgFeats = [
      ['🌐', t('独立域名站点','Your own subdomain'), t('每场黑客松一个 name.hack5.net,专业又好记。','A name.hack5.net for each event — clean and memorable.')],
      ['🖼️', t('作品墙','Work wall'), t('选手交 GitHub 链接,自动抓 star/语言/README 生成作品卡。','Teams submit a GitHub repo; cards auto-load stars, language, README.')],
      ['🏡', t('活动首页 + 地图','Event homepage + map'), t('介绍、时间地点、周期,内嵌地图(自动适配国内外)。','Intro, time, place, duration, embedded map (China-aware).')],
      ['📸', t('照片墙','Photo wall'), t('现场花絮瀑布流,上传自动压缩。','A masonry gallery of event moments; uploads auto-compress.')],
      ['⚖️', t('在线评审','Online judging'), t('评委登录码、四维打分、排行榜、CSV 导出、锁定评审版本。','Judge codes, 4-axis scoring, leaderboard, CSV export, commit lock.')],
      ['🆓', t('首场免费','First event free'), t('第一场黑客松免费,记录永久保留;更多场次与高级功能可订阅。','Your first hackathon is free with records kept forever; more events and premium features are a subscription.')],
    ];
    const launchSteps = [
      ['1','📧', t('邮箱登录(无需注册)','Log in with email (no signup)'), t('输入邮箱,收验证码即登录。','Enter your email, get a code, you are in.')],
      ['2','✏️', t('取名,拿到你的域名','Name it, get your subdomain'), t('给黑客松取个名字,自动分配 name.hack5.net。','Name your event; name.hack5.net is assigned automatically.')],
      ['3','🚀', t('一键部署,开始招募','Deploy, start recruiting'), t('拿到管理员密码,发邀请码给选手、登录码给评委。','Get your admin password; hand invite codes to teams, login codes to judges.')],
    ];
    app.innerHTML = '<div class="guide">'
      + '<div class="guide-hero"><h1>'+t('如何成为一名黑客','How to Become a Hacker')+'</h1>'
      + '<p class="guide-sub">'+t('—— 做 AI 时代的创新者','— an innovator in the AI era')+'</p></div>'
      + '<div class="guide-row"><div class="guide-art">'+artEra+'</div><div><h2>'+t('时代变了','The times have changed')+'</h2><p>'
      + t('从一个想法到一个能用的产品,过去要几个月甚至几年;现在被压缩到几天、甚至几个小时。AI 帮你写代码、调试、部署,创造的门槛前所未有地低。问题不再是「你会不会写代码」,而是「你有没有想法,敢不敢现在就动手」。',
          'Going from an idea to a working product used to take months, even years. Now it compresses into days — even hours. AI writes the code, debugs and deploys; the barrier to creating has never been lower. The question is no longer “can you code?” but “do you have an idea, and will you start now?”')
      + '</p></div></div>'
      + '<div class="guide-row rev"><div class="guide-art">'+artTeam+'</div><div><h2>'+t('为什么参加黑客松','Why join a hackathon')+'</h2><p>'
      + t('黑客松是最好的练习场:在真实的时间压力下,逼自己把想法变成能跑的东西。它更是一个圈子 —— 你会遇到志同道合的伙伴,被高手推着学新技能,拿到真实反馈,甚至认识未来的合伙人和投资人。一个周末,可能就改变你的轨迹。',
          'A hackathon is the best training ground: under real time pressure, you force an idea into something that actually runs. It is also a community — you meet like-minded builders, get pulled forward by sharper people, receive honest feedback, and may even find future co-founders and investors. One weekend can change your trajectory.')
      + '</p></div></div>'
      + '<h2 style="text-align:center;margin-top:36px">'+t('三步开始','Three steps to start')+'</h2>'
      + '<div class="guide-steps">'
      + steps.map(s=>'<div class="step"><div class="num">'+s[0]+'</div><div><h3>'+s[1]+' '+esc(s[2])+'</h3><p>'+esc(s[3])+'</p></div></div>').join('')
      + '</div>'
      + '<div class="guide-cta"><h2>'+t('准备好动手了吗?','Ready to build?')+'</h2><a href="https://demo.hack5.net" target="_blank" rel="noopener"><button>'+t('👀 看一个示例黑客松 →','👀 See a live hackathon →')+'</button></a ></div>'
      // ===== 并列大章节:如何组织一个黑客松 =====
      + '<div class="guide-hero" style="padding:46px 0 6px;border-top:1px solid var(--line);margin-top:18px"><h1>'+t('如何组织一个黑客松','How to Organize a Hackathon')+'</h1>'
      + '<p class="guide-sub">'+t('用 hack5.net,10 分钟拥有你自己的黑客松站点','With hack5.net — own your hackathon site in 10 minutes')+'</p></div>'
      + '<div class="guide-row"><div class="guide-art">'+artOrg+'</div><div><h2>'+t('为何要组织黑客松','Why organize one')+'</h2><p>'
      + t('组织一场黑客松,是把你在意的主题变成行动的最好方式 —— 环保节能、开放协议、AI 安全,或任何你想推动的领域。你会聚起一群志同道合的人,放大相关社区与企业的影响力,也为新产品的发布与试用创造真实场景。对组织者来说,这是难得的契机:凝聚人、传播理念、发现人才与合作。',
          'Organizing a hackathon is the best way to turn a theme you care about into action — climate & energy, open protocols, AI safety, or any field you want to push forward. You gather like-minded people, amplify the communities and companies around it, and create real settings to launch and trial new products. For an organizer it is a rare chance: to unite people, spread ideas, and find talent and partners.')
      + '</p></div></div>'
      + '<h2 style="text-align:center;margin-top:30px">'+t('hack5 帮你搞定这些','What hack5 handles for you')+'</h2>'
      + '<div class="guide-steps">'+orgFeats.map(f=>'<div class="step"><div class="num" style="background:#0a0e0a;font-size:19px">'+f[0]+'</div><div><h3>'+esc(f[1])+'</h3><p>'+esc(f[2])+'</p></div></div>').join('')+'</div>'
      + '<h2 style="text-align:center;margin-top:30px">'+t('三步启动你的黑客松','Three steps to launch')+'</h2>'
      + '<div class="guide-steps">'+launchSteps.map(s=>'<div class="step"><div class="num">'+s[0]+'</div><div><h3>'+s[1]+' '+esc(s[2])+'</h3><p>'+esc(s[3])+'</p></div></div>').join('')+'</div>'
      + '<p style="text-align:center;margin-top:26px;color:var(--muted);font-size:13px">'+t('延伸阅读:','Further reading: ')+'<a href="https://blog.mushroom.cv/blog/how-to-host-hackathon-free-tools-complete-guide/" target="_blank" rel="noopener">'+t('如何用免费工具办一场黑客松 · 完整指南','How to host a hackathon with free tools — the complete guide')+'</a></p>'
      + '<div class="guide-cta"><h2>'+t('办一场属于你的黑客松','Run your own hackathon')+'</h2><a href="https://hack5.net/start"><button>'+t('🚀 现在就发起 →','🚀 Start now →')+'</button></a ></div>'
      + '</div>';
  }

  // ---------------- about ----------------
  function renderAbout(){
    const feats = [
      ['⚡', t('10 分钟发起','Live in 10 minutes'), t('三步:登录 → 取名 → 一键部署你专属的黑客松站点(带独立域名)。','Three steps: log in → name it → deploy your own hackathon site on its own domain.')],
      ['🆓', t('单场免费','First event free'), t('办一场黑客松免费,记录永久保留;更多场次与高级功能(动态海报、一键转发、社区 Bot)可订阅。','Your first hackathon is free with records kept forever; more events and premium features (dynamic posters, one-click sharing, a community bot) come with a subscription.')],
      ['🌱', t('数字公共物品','A digital public good'), t('hack5 隶属于 Mycelium —— 一个数字公共物品组织,为开放的创造者社区而建。','hack5 is part of Mycelium — a digital-public-goods organization, built for an open community of makers.')],
    ];
    app.innerHTML = '<div class="guide">'
      + '<div class="guide-hero"><h1>'+t('关于 hack5','About hack5')+'</h1>'
      + '<p class="guide-sub">'+t('人人可办的黑客松平台','a hackathon platform anyone can run')+'</p></div>'
      + '<div class="panel" style="font-size:16px;line-height:1.8;color:#3c4250">'
      + t('<b>hack5.net</b> 隶属于 <b>Mycelium</b> —— 一个数字公共物品(Digital Public Goods)组织。它让任何人都能在 <b>10 分钟内</b>发起并部署一个属于自己的黑客松站点:<b>第一场免费</b>、记录永久保留;想办更多场次、或用上动态海报、一键转发、开发者社区 Bot 等高级功能,可订阅付费。',
          '<b>hack5.net</b> is part of <b>Mycelium</b> — a Digital Public Goods organization. Anyone can spin up their own hackathon site in <b>10 minutes</b>: your <b>first event is free</b> with records kept forever; hosting more events or unlocking premium features (dynamic posters, one-click sharing, a developer-community bot) comes with a subscription.')
      + '</div>'
      + '<div class="guide-steps" style="margin-top:20px">'
      + feats.map(f=>'<div class="step"><div class="num" style="font-size:20px;background:#0a0e0a">'+f[0]+'</div><div><h3>'+esc(f[1])+'</h3><p>'+esc(f[2])+'</p></div></div>').join('')
      + '</div>'
      + '<div class="guide-cta"><h2>'+t('办一场属于你的黑客松','Run your own hackathon')+'</h2><button onclick="go(\'/start\')">'+t('发起黑客松 →','Start a hackathon →')+'</button></div>'
      + '</div>';
  }

  function renderStart(){
    app.innerHTML = '<div class="guide"><div class="guide-hero"><h1>'+t('发起黑客松','Start a hackathon')+'</h1>'
      + '<p class="guide-sub">'+t('登录 → 取名 → 一键部署','log in → name it → deploy')+'</p></div>'
      + '<div class="panel" style="text-align:center;padding:40px">'
      + '<p style="font-size:16px">'+t('一键发起功能正在上线中 —— 你将能在 10 分钟内拥有一个独立域名的黑客松站点。','One-click launch is coming soon — you will get your own hackathon site, on its own domain, in 10 minutes.')+'</p>'
      + '<div class="row" style="justify-content:center;margin-top:16px"><button class="ghost" onclick="go(\'/about\')">'+t('← 了解 hack5','← About hack5')+'</button></div>'
      + '</div></div>';
  }

  // ---------------- platform landing (hack5.net apex) ----------------
  function renderPlatformLanding(){
    const feats = [
      ['⚡', t('三步 · 10 分钟','3 steps · 10 min'), t('登录 → 取名 → 一键部署你专属的黑客松站点。','Log in → name it → deploy your own hackathon site.')],
      ['🆓', t('单场免费','First event free'), t('办一场黑客松免费,记录永久保留;更多场次与高级功能(动态海报、一键转发、社区 Bot)可订阅。','Your first hackathon is free with records kept forever; more events and premium features (dynamic posters, one-click sharing, a community bot) come with a subscription.')],
      ['🌱', t('数字公共物品','Digital public good'), t('hack5 隶属于 Mycelium,为开放的创造者社区而建。','hack5 is part of Mycelium, built for open makers.')],
    ];
    app.innerHTML = '<div class="guide">'
      + '<div class="guide-hero" style="padding:44px 0 8px">'
      + '<h1 style="font-size:clamp(30px,6vw,54px)">'+t('人人可办的黑客松平台','The hackathon platform anyone can run')+'</h1>'
      + '<p class="guide-sub">'+t('10 分钟发起 · 独立域名 · 首场免费','Live in 10 minutes · your own domain · first event free')+'</p>'
      + '<div class="row" style="justify-content:center;margin-top:22px">'
      + '<button onclick="go(\'/start\')" style="font-size:16px;padding:12px 24px">'+t('🚀 发起你的黑客松','🚀 Start your hackathon')+'</button>'
      + '<button class="ghost" onclick="go(\'/about\')" style="font-size:16px;padding:12px 24px">'+t('了解 hack5','About hack5')+'</button></div>'
      + '<div style="text-align:center;margin-top:14px"><a href="https://demo.hack5.net" target="_blank" rel="noopener" style="color:var(--muted);font-size:14px;font-weight:600">'+t('👀 看一个示例黑客松站点 → demo.hack5.net','👀 See a live example → demo.hack5.net')+'</a></div>'
      + '</div>'
      + '<div class="guide-steps" style="margin-top:38px">'
      + feats.map(f=>'<div class="step"><div class="num" style="font-size:20px;background:#0a0e0a">'+f[0]+'</div><div><h3>'+esc(f[1])+'</h3><p>'+esc(f[2])+'</p></div></div>').join('')
      + '</div></div>';
  }

  function renderTenantNotFound(){
    app.innerHTML = '<div class="guide"><div class="guide-hero" style="padding:60px 0">'
      + '<h1>'+t('黑客松不存在','Hackathon not found')+'</h1>'
      + '<p class="guide-sub">'+t('这个地址还没有对应的黑客松。','No hackathon lives at this address yet.')+'</p>'
      + '<div class="row" style="justify-content:center;margin-top:20px"><a href="https://hack5.net"><button>'+t('去 hack5.net 发起一个 →','Start one at hack5.net →')+'</button></a ></div></div></div>';
  }

  // ---------------- platform: email login + dashboard ----------------
  async function userLogout(){ await api('/api/platform/logout',{method:'POST',body:{}}).catch(()=>{}); ME_USER={email:null}; renderNav(); go('/'); }
  window.userLogout = userLogout;

  function renderPlatformLogin(){
    app.innerHTML = '<div class="guide"><div class="guide-hero" style="padding:30px 0 8px"><h1>'+t('发起你的黑客松','Start your hackathon')+'</h1>'
      + '<p class="guide-sub">'+t('输入邮箱,用验证码登录 —— 无需注册','Enter your email and log in with a code — no signup')+'</p></div>'
      + '<div class="panel" style="max-width:420px;margin:0 auto">'
      + '<label>'+t('邮箱','Email')+'</label><input id="plEmail" type="email" autocomplete="email" placeholder="you@example.com">'
      + '<div id="plCodeArea" class="hidden"><label>'+t('验证码','Code')+'</label><input id="plCode" inputmode="numeric" maxlength="6" placeholder="'+t('6 位验证码','6-digit code')+'"></div>'
      + (CONFIG.turnstileSiteKey ? '<div id="cfts" style="margin-top:12px"></div>' : '')
      + '<div class="row" style="margin-top:14px"><button id="plSend">'+t('发送验证码','Send code')+'</button><button id="plVerify" class="hidden">'+t('登录','Log in')+'</button></div>'
      + '<div id="plMsg"></div></div></div>';
    let tsId = null;
    if(CONFIG.turnstileSiteKey) ensureTurnstile().then(()=>{ try{ tsId = window.turnstile.render('#cfts', {sitekey: CONFIG.turnstileSiteKey}); }catch(e){} });
    $('#plSend').addEventListener('click', async ()=>{
      const email = $('#plEmail').value.trim();
      let turnstileToken;
      if(CONFIG.turnstileSiteKey){
        turnstileToken = (window.turnstile && tsId!=null) ? window.turnstile.getResponse(tsId) : '';
        if(!turnstileToken){ setMsg('plMsg', t('请先完成人机验证','Please complete the check'), true); return; }
      }
      setMsg('plMsg', t('发送中…','Sending…'));
      try {
        const r = await api('/api/platform/login/request',{method:'POST',body:{email, turnstileToken}});
        $('#plCodeArea').classList.remove('hidden'); $('#plVerify').classList.remove('hidden');
        setMsg('plMsg', t('验证码已发送,请查收邮箱。','Code sent — check your email.')+(r.debugCode?(' [dev: '+r.debugCode+']'):''));
      } catch(e){ setMsg('plMsg', e.message, true); if(window.turnstile && tsId!=null) try{ window.turnstile.reset(tsId); }catch(_){} }
    });
    $('#plVerify').addEventListener('click', async ()=>{
      try {
        await api('/api/platform/login/verify',{method:'POST',body:{email:$('#plEmail').value.trim(), code:$('#plCode').value.trim()}});
        ME_USER = await api('/api/platform/me');
        renderNav(); go('/dashboard');
      } catch(e){ setMsg('plMsg', e.message, true); }
    });
  }

  async function renderDashboard(){
    if(!ME_USER.email){ go('/start'); return; }
    ME_USER = await api('/api/platform/me').catch(()=>ME_USER);
    const hs = ME_USER.hackathons || [];
    const canCreate = (ME_USER.used||0) < (ME_USER.quota||1);
    app.innerHTML = '<div class="guide"><h1>'+t('我的黑客松','My hackathons')+'</h1>'
      + '<p class="muted">'+t('已用','Used')+' '+(ME_USER.used||0)+' / '+(ME_USER.quota||1)+'</p>'
      + (hs.length ? '<div class="guide-steps">'+hs.map(h=>'<div class="step"><div class="num" style="background:#0a0e0a">🏆</div><div style="flex:1"><h3>'+esc(h.name)+'</h3><p class="card-repo">'+esc(h.subdomain)+'.hack5.net</p></div><a href="'+h.url+'"><button class="ghost">'+t('进入 →','Open →')+'</button></a ></div>').join('')+'</div>' : '<p class="muted">'+t('还没有黑客松,创建第一个 👇','No hackathons yet — create your first 👇')+'</p>')
      + '<div class="panel" style="margin-top:18px;max-width:520px"><h2>'+t('创建新黑客松','Create a hackathon')+'</h2>'
      + (canCreate
          ? '<label>'+t('名称','Name')+'</label><input id="hName" maxlength="60" placeholder="'+t('例:上海 2026 黑客松','e.g. Shanghai 2026 Hackathon')+'">'
            + '<label>'+t('子域名','Subdomain')+' <span class="muted">.hack5.net</span></label><input id="hSub" maxlength="30" placeholder="shanghai2026">'
            + '<div class="row" style="margin-top:14px"><button id="hCreate">'+t('创建并部署','Create & deploy')+'</button></div><div id="hMsg"></div>'
          : '<div class="notice">'+t('已达免费额度。充值 ¥99 可举办 100 场。','Free quota reached. Upgrade (¥99) for 100 hackathons.')+'</div><div class="row" style="margin-top:12px"><button id="hUpgrade">'+t('充值 ¥99','Upgrade ¥99')+'</button></div>')
      + '</div></div>';
    if(canCreate){
      $('#hCreate').addEventListener('click', async ()=>{
        const name=$('#hName').value.trim(), subdomain=$('#hSub').value.trim().toLowerCase();
        if(!name || !subdomain){ setMsg('hMsg', t('请填写名称和子域名','Fill in name and subdomain'), true); return; }
        $('#hCreate').disabled=true; setMsg('hMsg', t('创建中…','Creating…'));
        try {
          const r = await api('/api/platform/hackathons',{method:'POST',body:{name,subdomain}});
          const pw = r.adminPassword;
          const masked = pw.length>7 ? (pw.slice(0,-5)+'****'+pw.slice(-2)) : pw;
          window.__hpw = pw;
          setMsg('hMsg', t('创建成功!','Created! ')
            + '<div style="margin-top:10px">'+t('站点','Site')+': <a href="'+r.url+'" target="_blank" rel="noopener">'+esc(r.url)+'</a ></div>'
            + '<div style="margin-top:8px">'+t('管理员密码','Admin password')+': <code id="pwMask">'+esc(masked)+'</code> <button class="ghost" id="pwCopy" style="padding:3px 10px;font-size:13px">📋 '+t('复制','Copy')+'</button></div>'
            + '<div class="muted" style="margin-top:6px;font-size:12px">⚠️ '+t('只显示这一次,请立即复制保存。','Shown only once — copy and save it now.')+'</div>'
            + '<div class="muted" style="margin-top:4px;font-size:12px" id="pwGo"></div>', false, true);
          const cp = document.getElementById('pwCopy');
          cp.addEventListener('click', async ()=>{ try{ await navigator.clipboard.writeText(window.__hpw); cp.textContent='✓ '+t('已复制','Copied'); }catch{ prompt(t('复制这个密码','Copy this password'), window.__hpw); } });
          ME_USER = await api('/api/platform/me'); renderNav();
          let n=5; const go=document.getElementById('pwGo');
          const timer=setInterval(()=>{ n--; if(n<=0){ clearInterval(timer); location.href=r.url; } else if(go){ go.textContent=n+t(' 秒后自动进入你的黑客松站点…',' s — taking you to your hackathon site…'); } },1000);
        } catch(e){ setMsg('hMsg', e.message, true); $('#hCreate').disabled=false; }
      });
    } else {
      $('#hUpgrade').addEventListener('click', ()=>alert(t('支付功能即将上线,先联系主办方开通。','Payment coming soon — contact us to upgrade.')));
    }
  }

  // ---------------- tenant homepage (hero + editor) ----------------
  function tenantHero(){
    const tn = CONFIG.tenant; if(!tn) return '';
    const bits = [];
    if(tn.eventTime) bits.push('📅 '+esc(tn.eventTime));
    if(tn.location) bits.push('📍 '+esc(tn.location));
    if(tn.duration) bits.push('⏱ '+esc(tn.duration));
    const q = tn.mapQuery || tn.address;
    let map = '';
    if(q){
      const eq = encodeURIComponent(q);
      // In mainland China, Google Maps is blocked — skip the embed and offer open-links instead.
      const embed = (CONFIG.country !== 'CN')
        ? '<iframe class="map-embed" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="https://www.google.com/maps?q='+eq+'&output=embed"></iframe>'
        : '';
      const links = '<div class="map-links">🗺️ '+t('在地图打开','Open in maps')+':'
        + ' <a href="https://www.amap.com/search?query='+eq+'" target="_blank" rel="noopener">'+t('高德','Amap')+'</a> ·'
        + ' <a href="https://map.baidu.com/search/'+eq+'" target="_blank" rel="noopener">'+t('百度','Baidu')+'</a> ·'
        + ' <a href="https://www.google.com/maps/search/?api=1&query='+eq+'" target="_blank" rel="noopener">Google</a></div>';
      map = embed + links;
    }
    const ag = tn.agenda || [];
    const agHtml = ag.length ? '<div class="agenda"><div class="ag-h">'+t('日程 · Agenda','Agenda')+'</div>'
      + ag.map(a=>'<div class="ag-item"><span class="ag-t">'+esc(a.time||'')+'</span><span class="ag-x">'+esc(a.title||'')+'</span></div>').join('')+'</div>' : '';
    if(!tn.intro && !bits.length && !tn.address && !map && !agHtml) return '';
    return '<div class="panel tenant-hero">'
      + (tn.intro?'<p style="font-size:16px;color:#3c4250;white-space:pre-wrap;margin:0 0 10px">'+esc(tn.intro)+'</p>':'')
      + (bits.length?'<div class="hero-meta">'+bits.join('')+'</div>':'')
      + (tn.address?'<div class="muted" style="margin-top:6px">📮 '+esc(tn.address)+'</div>':'')
      + map
      + agHtml
      + '</div>';
  }

  function renderTenantEdit(){
    if(ME.role !== 'admin'){ go('/'); return; }
    const tn = CONFIG.tenant || {};
    const agendaText = (tn.agenda||[]).map(a=>(a.time||'')+' | '+(a.title||'')).join('\n');
    app.innerHTML = '<h1>'+t('首页设置','Homepage settings')+'</h1>'
      + '<div class="panel" style="max-width:640px">'
      + '<label>'+t('介绍','Intro')+'</label><textarea id="fIntro" maxlength="2000" rows="4" placeholder="'+t('这个黑客松是关于…','What this hackathon is about…')+'">'+esc(tn.intro||'')+'</textarea>'
      + '<label>'+t('时间','Time')+'</label><input id="fTime" maxlength="120" value="'+esc(tn.eventTime||'')+'" placeholder="'+t('例:2026-08-15 ~ 08-17','e.g. Aug 15-17, 2026')+'">'
      + '<label>'+t('地点','Location')+'</label><input id="fLoc" maxlength="120" value="'+esc(tn.location||'')+'" placeholder="'+t('例:上海·徐汇','e.g. Shanghai')+'">'
      + '<label>'+t('持续周期','Duration')+'</label><input id="fDur" maxlength="120" value="'+esc(tn.duration||'')+'" placeholder="'+t('例:48 小时','e.g. 48 hours')+'">'
      + '<label>'+t('地址(用于地图)','Address (for the map)')+'</label><input id="fAddr" maxlength="200" value="'+esc(tn.address||'')+'" placeholder="'+t('街道地址','street address')+'">'
      + '<label>'+t('地图搜索词','Map query')+' <span class="muted">'+t('(留空则用地址)','(defaults to address)')+'</span></label><input id="fMap" maxlength="200" value="'+esc(tn.mapQuery||'')+'">'
      + '<label>'+t('日程','Agenda')+' <span class="muted">'+t('(每行一项:时间 | 内容)','(one per line: time | item)')+'</span></label><textarea id="fAgenda" rows="5" maxlength="2000" placeholder="'+t('Day 1 09:00 | 开幕\\nDay 1 10:00 | 开始开发\\nDay 2 14:00 | Demo\\nDay 2 16:00 | 颁奖','Day 1 09:00 | Kickoff\\nDay 2 14:00 | Demos')+'">'+esc(agendaText)+'</textarea>'
      + '<div class="row" style="margin-top:14px"><button id="fSave">'+t('保存','Save')+'</button><button class="ghost" onclick="go(\'/\')">'+t('返回','Back')+'</button><span id="fMsg" class="muted"></span></div>'
      + '</div>';
    $('#fSave').addEventListener('click', async ()=>{
      $('#fSave').disabled=true;
      try {
        await api('/api/tenant/homepage',{method:'POST',body:{intro:$('#fIntro').value, eventTime:$('#fTime').value, location:$('#fLoc').value, duration:$('#fDur').value, address:$('#fAddr').value, mapQuery:$('#fMap').value, agenda:$('#fAgenda').value}});
        CONFIG = await api('/api/config');
        setMsg('fMsg', t('已保存 ✓','Saved ✓'));
      } catch(e){ setMsg('fMsg', e.message, true); }
      finally { $('#fSave').disabled=false; }
    });
  }

  // ---------------- photo wall ----------------
  let PHOTOS = []; // pending uploads: {dataUrl}
  async function renderPhotos(){
    app.innerHTML = '<h1>'+t('照片墙','Photo wall')+'</h1><p class="muted">'+t('黑客松现场花絮','Moments from the event')+'</p>'
      + (ME.role==='admin' ? '<div class="panel" style="margin-bottom:18px"><h2>'+t('上传照片','Upload photos')+'</h2>'
          + '<p class="muted">'+t('建议至少 5 张,自动压缩到 120KB 以内','At least 5 recommended, auto-compressed to ≤120KB')+'</p>'
          + '<input id="phFiles" type="file" accept="image/*" multiple>'
          + '<div class="thumbs" id="phThumbs"></div>'
          + '<div class="row" style="margin-top:10px"><button id="phUpload">'+t('上传','Upload')+'</button><span id="phMsg" class="muted"></span></div></div>' : '')
      + '<div id="photoWall" class="masonry"><p class="muted">'+t('加载中…','Loading…')+'</p></div>';
    if(ME.role==='admin'){
      PHOTOS = [];
      $('#phFiles').addEventListener('change', onPhotoPick);
      $('#phUpload').addEventListener('click', doPhotoUpload);
    }
    loadPhotoWall();
  }
  async function onPhotoPick(ev){
    const files=[...ev.target.files]; ev.target.value='';
    for(const f of files){ if(PHOTOS.length>=40){ alert(t('一次最多 40 张','Max 40 at a time')); break; } try{ PHOTOS.push({dataUrl: await compressPhoto(f)}); }catch(e){ alert(e.message); } }
    renderPhotoThumbs();
  }
  function renderPhotoThumbs(){
    $('#phThumbs').innerHTML = PHOTOS.map((p,i)=>'<div class="t"><img src="'+p.dataUrl+'"><span class="x" data-i="'+i+'">×</span></div>').join('');
    $('#phThumbs').querySelectorAll('.x').forEach(x=>x.addEventListener('click',()=>{ PHOTOS.splice(Number(x.dataset.i),1); renderPhotoThumbs(); }));
  }
  async function doPhotoUpload(){
    if(!PHOTOS.length){ setMsg('phMsg', t('请先选择照片','Pick photos first'), true); return; }
    $('#phUpload').disabled=true; setMsg('phMsg', t('上传中…','Uploading…'));
    try{
      const r = await api('/api/tenant/photos',{method:'POST',body:{photos:PHOTOS}});
      PHOTOS=[]; $('#phThumbs').innerHTML=''; setMsg('phMsg', t('已上传 ','Uploaded ')+r.saved);
      loadPhotoWall();
    }catch(e){ setMsg('phMsg', e.message, true); }
    finally{ $('#phUpload').disabled=false; }
  }
  async function loadPhotoWall(){
    const box=$('#photoWall'); if(!box) return;
    try{
      const {photos}=await api('/api/tenant/photos');
      if(!photos.length){ box.innerHTML='<p class="muted">'+t('还没有照片','No photos yet')+'</p>'; return; }
      box.innerHTML = photos.map(p=>'<div class="mphoto"><img src="'+p.url+'" loading="lazy" alt="">'
        + (p.caption?'<div class="cap">'+esc(p.caption)+'</div>':'')
        + (ME.role==='admin'?'<span class="pdel" data-id="'+p.id+'">×</span>':'')+'</div>').join('');
      box.querySelectorAll('.mphoto img').forEach(img=>img.addEventListener('click',()=>openLightbox(img.src)));
      if(ME.role==='admin') box.querySelectorAll('.pdel').forEach(x=>x.addEventListener('click',async()=>{
        if(!confirm(t('删除这张?','Delete this photo?'))) return;
        try{ await api('/api/tenant/photos/'+x.dataset.id,{method:'DELETE'}); loadPhotoWall(); }catch(e){ alert(e.message); }
      }));
    }catch(e){ box.innerHTML='<p class="notice err">'+esc(e.message)+'</p>'; }
  }
  function compressPhoto(file){
    return new Promise((resolve,reject)=>{
      if(!file.type.startsWith('image/')) return reject(new Error(t('不是图片','Not an image')));
      const img=new Image(); const url=URL.createObjectURL(file);
      img.onload=()=>{
        const max=1200; let w=img.width,h=img.height;
        if(w>max||h>max){ const r=Math.min(max/w,max/h); w=Math.round(w*r); h=Math.round(h*r); }
        const c=document.createElement('canvas'); const ctx=c.getContext('2d');
        c.width=w; c.height=h; ctx.drawImage(img,0,0,w,h);
        URL.revokeObjectURL(url);
        let q=0.82, out=c.toDataURL('image/jpeg',q);
        while(dataUrlBytes(out)>120000 && q>0.3){ q-=0.1; out=c.toDataURL('image/jpeg',q); }
        while(dataUrlBytes(out)>120000 && c.width>420){ c.width=Math.round(c.width*0.85); c.height=Math.round(c.height*0.85); ctx.drawImage(img,0,0,c.width,c.height); out=c.toDataURL('image/jpeg',0.7); }
        if(dataUrlBytes(out)>128000) return reject(new Error(t('图片太大,换一张','Photo too large')));
        resolve(out);
      };
      img.onerror=()=>{ URL.revokeObjectURL(url); reject(new Error(t('无法读取','Cannot read'))); };
      img.src=url;
    });
  }

  // ---------------- promo poster (free A4) ----------------
  function wrapText(str, per, maxLines){
    str = String(str||''); const lines=[];
    if(/\s/.test(str)){
      let cur=''; for(const w of str.split(/\s+/)){ if((cur+' '+w).trim().length>per){ if(cur){lines.push(cur);} cur=w; } else { cur=(cur+' '+w).trim(); } if(lines.length>=maxLines) break; }
      if(cur && lines.length<maxLines) lines.push(cur);
    } else { for(let i=0;i<str.length && lines.length<maxLines;i+=per) lines.push(str.slice(i,i+per)); }
    return lines;
  }
  function posterSvg(bg){
    const tn = CONFIG.tenant || {};
    const name = tn.name || 'Hackathon';
    const nameLines = wrapText(name, name.length>16?14:10, 3);
    const nameFs = nameLines.length>=3?56:(name.length>14?66:84);
    const introLines = wrapText(String(tn.intro||'').replace(/\s+/g,' ').slice(0,72), 30, 2);
    const bits=[]; if(tn.eventTime)bits.push(['📅',tn.eventTime]); if(tn.location)bits.push(['📍',tn.location]); if(tn.address)bits.push(['📮',tn.address]);
    const sub = tn.subdomain||'';
    let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="100%" style="display:block">'
      + '<defs><linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a0e0a" stop-opacity="0.72"/><stop offset="0.42" stop-color="#0a0e0a" stop-opacity="0.26"/><stop offset="0.66" stop-color="#0a0e0a" stop-opacity="0.5"/><stop offset="1" stop-color="#0a0e0a" stop-opacity="0.92"/></linearGradient></defs>'
      + '<rect width="794" height="1123" fill="#0a0e0a"/>'
      + (bg
          ? '<image href="'+bg+'" x="0" y="0" width="794" height="1123" preserveAspectRatio="xMidYMid slice"/><rect width="794" height="1123" fill="url(#scrim)"/>'
          : '<g fill="#25ff86" opacity="0.06" font-family="monospace" font-size="16">'+[0,60,120,680,740].map(x=>'<text x="'+x+'"><tspan x="'+x+'" dy="22">1010</tspan><tspan x="'+x+'" dy="22">0110</tspan><tspan x="'+x+'" dy="22">1101</tspan><tspan x="'+x+'" dy="22">0011</tspan></text>').join('')+'</g>')
      + '<g transform="translate(60,72)"><rect width="56" height="56" rx="14" fill="#141a16"/><text x="28" y="38" text-anchor="middle" font-family="ui-monospace,monospace" font-size="24" font-weight="800" fill="#25ff86">&#8249;5&#8250;</text></g>'
      + '<text x="132" y="110" font-family="ui-monospace,monospace" font-size="30" font-weight="800" fill="#ffffff">hack5</text>'
      + '<text x="734" y="106" text-anchor="end" font-family="monospace" font-size="15" fill="#25ff86" letter-spacing="3">HACKATHON</text>'
      + '<line x1="60" y1="150" x2="734" y2="150" stroke="#1c2620" stroke-width="2"/>';
    let y=290;
    nameLines.forEach((ln,i)=>{ svg+='<text x="60" y="'+(y+i*(nameFs+6))+'" font-family="Inter,-apple-system,sans-serif" font-size="'+nameFs+'" font-weight="800" fill="#ffffff">'+esc(ln)+'</text>'; });
    y = 290 + nameLines.length*(nameFs+6) + 24;
    introLines.forEach((ln,i)=>{ svg+='<text x="60" y="'+(y+i*34)+'" font-family="-apple-system,sans-serif" font-size="25" fill="#8fb3a0">'+esc(ln)+'</text>'; });
    y += introLines.length*34 + 66;
    bits.forEach((b,i)=>{ svg+='<text x="60" y="'+(y+i*56)+'" font-family="-apple-system,sans-serif" font-size="27" fill="#e3ece7">'+b[0]+'  '+esc(String(b[1]).slice(0,38))+'</text>'; });
    svg += '<rect x="60" y="978" width="674" height="92" rx="16" fill="#25ff86"/>'
      + '<text x="397" y="1018" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="24" font-weight="700" fill="#0a0e0a">'+t('提交作品 · 报名','Join &amp; submit at')+'</text>'
      + '<text x="397" y="1050" text-anchor="middle" font-family="ui-monospace,monospace" font-size="26" font-weight="800" fill="#0a0e0a">'+esc(sub)+'.hack5.net</text>'
      + '<text x="734" y="1102" text-anchor="end" font-family="monospace" font-size="13" fill="#3f8f63">Mycelium · Digital Public Goods · hack5.net</text>'
      + '</svg>';
    return svg;
  }
  function paint(bg){ const svg=posterSvg(bg); window.__posterSvg=svg; window.__posterBg=bg||''; $('#posterBox').innerHTML=svg; }
  function renderPoster(){
    if(!CONFIG.tenant){ go('/'); return; }
    const isAdmin = ME.role==='admin';
    const aiPanel = isAdmin
      ? '<div class="panel" style="max-width:640px;margin-bottom:16px">'
        + '<div class="row" style="justify-content:space-between;align-items:center"><b>'+t('AI 海报(付费)','AI poster (premium)')+'</b><span style="font-family:ui-monospace,monospace;font-size:12px;color:var(--brand);border:1px solid var(--line);border-radius:20px;padding:2px 10px">gpt-image-1</span></div>'
        + '<p class="muted" style="margin:6px 0 10px">'+t('用一句话描述你想要的画风,AI 生成背景画面,活动信息文字仍清晰叠加在上面。','Describe the art style you want; AI paints the background and your event text stays crisply overlaid.')+'</p>'
        + '<textarea id="aiPrompt" rows="2" maxlength="500" placeholder="'+t('例:赛博朋克夜景城市,霓虹紫青配色,未来感','e.g. cyberpunk night city, neon purple-teal, futuristic')+'"></textarea>'
        + '<div class="row" style="margin-top:10px;gap:8px"><button id="aiGen">'+t('生成 AI 海报','Generate')+'</button><button class="ghost" id="aiClear">'+t('恢复免费版','Reset to free')+'</button><span id="aiMsg" class="muted"></span></div>'
        + '</div>'
      : '';
    app.innerHTML = '<div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap"><h1>'+t('宣传海报','Promo poster')+'</h1>'
      + '<div class="row"><button id="dlPng">'+t('下载 PNG','Download PNG')+'</button><button class="ghost" id="dlSvg">'+t('下载 SVG','Download SVG')+'</button></div></div>'
      + '<p class="muted">'+t('A4 竖版,用你首页的信息(名称/时间/地点)自动生成。','A4 portrait, auto-built from your homepage info (name/time/place).')+'</p>'
      + aiPanel
      + '<div id="posterBox" style="max-width:460px;border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:var(--shadow)"></div>';
    paint('');
    if(isAdmin){
      $('#aiGen').addEventListener('click', async ()=>{
        const prompt=$('#aiPrompt').value.trim();
        if(!prompt){ setMsg('aiMsg', t('先描述画风','Describe a style first'), true); return; }
        $('#aiGen').disabled=true; setMsg('aiMsg', t('生成中,约 15-30 秒…','Generating, ~15-30s…'));
        try{ const r=await api('/api/tenant/poster/ai',{method:'POST',body:{prompt}});
          paint(r.image); setMsg('aiMsg', t('完成 ✓ 今日剩余 ','Done ✓ remaining today ')+r.remaining);
        }catch(e){ setMsg('aiMsg', e.message, true); }
        $('#aiGen').disabled=false;
      });
      $('#aiClear').addEventListener('click', ()=>{ paint(''); setMsg('aiMsg',''); });
    }
    $('#dlSvg').addEventListener('click', ()=>{ const b=new Blob([window.__posterSvg],{type:'image/svg+xml'}); const u=URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download='hack5-poster.svg'; a.click(); setTimeout(()=>URL.revokeObjectURL(u),1000); });
    $('#dlPng').addEventListener('click', ()=>{
      const img=new Image(); const url=URL.createObjectURL(new Blob([window.__posterSvg],{type:'image/svg+xml;charset=utf-8'}));
      img.onload=()=>{ const c=document.createElement('canvas'); c.width=1588; c.height=2246; const x=c.getContext('2d'); x.drawImage(img,0,0,1588,2246); URL.revokeObjectURL(url); c.toBlob(bl=>{ if(!bl){alert(t('导出失败','Export failed'));return;} const u=URL.createObjectURL(bl); const a=document.createElement('a'); a.href=u; a.download='hack5-poster.png'; a.click(); setTimeout(()=>URL.revokeObjectURL(u),1000); },'image/png'); };
      img.onerror=()=>alert(t('导出失败','Export failed')); img.src=url;
    });
  }

  // ---------------- participant registration ----------------
  async function renderRegister(){
    if(!CONFIG.tenant){ go('/'); return; }
    let adminBlock = '';
    if(ME.role==='admin'){
      try{ const d=await api('/api/tenant/registrations'); adminBlock='<div class="panel" style="margin-bottom:16px"><div class="row" style="justify-content:space-between;align-items:center"><b>'+t('已报名','Registered')+': '+d.count+'</b><a href="/api/tenant/registrations/export"><button class="ghost">'+t('导出 CSV','Export CSV')+'</button></a ></div></div>'; }catch(e){}
    }
    app.innerHTML = '<h1>'+t('报名参加','Register')+'</h1>'
      + '<p class="muted">'+esc((CONFIG.tenant&&CONFIG.tenant.name)||'')+'</p>'
      + adminBlock
      + '<div class="panel" style="max-width:460px"><div id="regForm">'
      + '<label>'+t('姓名','Name')+' *</label><input id="rgName" maxlength="60">'
      + '<label>'+t('邮箱','Email')+' *</label><input id="rgEmail" type="email" maxlength="254" placeholder="you@example.com">'
      + '<label>'+t('想法 / 找队友(可选)','Idea / looking for a team (optional)')+'</label><textarea id="rgNote" maxlength="300"></textarea>'
      + '<div class="row" style="margin-top:14px"><button id="rgBtn">'+t('提交报名','Register')+'</button></div>'
      + '<div id="rgMsg"></div></div></div>';
    $('#rgBtn').addEventListener('click', async ()=>{
      const name=$('#rgName').value.trim(), email=$('#rgEmail').value.trim(), note=$('#rgNote').value.trim();
      if(!name||!email){ setMsg('rgMsg', t('请填写姓名和邮箱','Name and email required'), true); return; }
      $('#rgBtn').disabled=true;
      try{ const r=await api('/api/tenant/register',{method:'POST',body:{name,email,note}});
        $('#regForm').innerHTML='<div class="notice ok">'+(r.already?t('你已经报名过了 ✓','You are already registered ✓'):t('报名成功!到时见 🎉','Registered! See you there 🎉'))+'</div>';
      }catch(e){ setMsg('rgMsg', e.message, true); $('#rgBtn').disabled=false; }
    });
  }

  function card(s){
    const el = document.createElement('div');
    el.className = 'card';
    const shots = s.shots.length ? s.shots : [];
    const imgs = shots.map((u,i)=>'<img class="'+(i===0?'on':'')+'" src="'+u+'" alt="" loading="lazy">').join('');
    const dots = shots.length>1 ? '<div class="dots">'+shots.map((_,i)=>'<span class="dot '+(i===0?'on':'')+'"></span>').join('')+'</div>' : '';
    const arrows = shots.length>1 ? '<button class="nav-btn prev" data-d="-1">‹</button><button class="nav-btn next" data-d="1">›</button>' : '';
    el.innerHTML =
      '<div class="carousel" data-i="0">'
      + '<span class="vbadge">▶ '+t('视频','Video')+'</span>' + imgs + arrows + dots
      + '</div>'
      + '<div class="card-body">'
      + '<div class="card-title">'+esc(s.projectName)+'</div>'
      + (s.teamName?'<div class="muted" style="font-size:12px">👥 '+esc(s.teamName)+'</div>':'')
      + '<div class="card-repo">'+esc(s.repoOwner)+'/'+esc(s.repoName)+'</div>'
      + (s.description?'<div class="card-desc">'+esc(s.description)+'</div>':'')
      + '<div class="card-meta" data-gh="'+esc(s.repoOwner)+'/'+esc(s.repoName)+'"><span class="chip">★ …</span></div>'
      + '</div>';
    // carousel nav + click image to open detail
    wireCarousel(el.querySelector('.carousel'), ()=>go(s.viewUrl));
    el.querySelector('.card-body').addEventListener('click', ()=>go(s.viewUrl));
    // lazy GitHub stars/lang
    loadGhMeta(el.querySelector('.card-meta'));
    return el;
  }

  async function loadGhMeta(elm){
    const [owner, repo] = elm.dataset.gh.split('/');
    try {
      const d = await api('/api/gh/'+owner+'/'+repo);
      elm.innerHTML = '<span class="chip">★ '+(d.stars??0)+'</span>'
        + (d.language?'<span class="chip">'+esc(d.language)+'</span>':'')
        + '<span class="chip">'+t('更新','upd.')+' '+fmtDate(d.pushedAt)+'</span>';
    } catch { elm.innerHTML = '<span class="chip">GitHub</span>'; }
  }

  // ---------------- detail ----------------
  async function renderDetail(id){
    app.innerHTML = '<div class="panel"><p>'+t('加载中…','Loading…')+'</p></div>';
    let s;
    try { s = (await api('/api/submissions/'+id)).submission; }
    catch(e){ app.innerHTML = '<div class="panel"><p class="notice err">'+esc(e.message)+'</p></div>'; return; }
    const embed = videoEmbed(s.videoUrl);
    const videoHtml = embed
      ? '<div class="videobox"><iframe src="'+embed+'" allow="accelerometer;autoplay;encrypted-media;gyroscope;picture-in-picture;fullscreen" allowfullscreen scrolling="no"></iframe></div>'
      : (s.videoUrl.match(/\.(mp4|webm|mov)(\?|$)/i) || s.videoUrl.startsWith('/media/')
          ? '<div class="videobox"><video controls playsinline src="'+esc(s.videoUrl)+'"></video></div>'
          : '<div class="panel"><a href="'+esc(s.videoUrl)+'" target="_blank" rel="noopener">▶ '+t('打开演示视频','Open demo video')+'</a ></div>');
    const shotsCar = s.shots.length
      ? '<div class="carousel detail-shots" data-i="0">'
        + s.shots.map((u,i)=>'<img class="'+(i===0?'on':'')+'" src="'+u+'" alt="screenshot '+(i+1)+'">').join('')
        + (s.shots.length>1
            ? '<button class="nav-btn prev" data-d="-1">‹</button><button class="nav-btn next" data-d="1">›</button>'
              + '<div class="dots">'+s.shots.map((_,i)=>'<span class="dot '+(i===0?'on':'')+'"></span>').join('')+'</div>'
            : '')
        + '</div>'
      : '';
    app.innerHTML =
      '<div class="row" style="justify-content:space-between;margin-bottom:14px">'
      + '<button class="ghost" onclick="go(\'/\')">← '+t('返回作品墙','Back to gallery')+'</button>'
      + '<a class="row" href="'+esc(s.repoUrl)+'" target="_blank" rel="noopener"><button>'+t('查看代码','View code')+' ↗</button></a >'
      + '</div>'
      + '<div class="detail-grid">'
      + '<div>'
      + videoHtml
      + (shotsCar ? '<h2 style="margin-top:22px">'+t('产品截图','Screenshots')+'</h2>'+shotsCar+'<div class="muted" style="margin-top:6px;font-size:12px">'+t('点图看大图','Click to enlarge')+'</div>' : '')
      + '<h2 style="margin-top:22px">README</h2>'
      + '<div id="readmeWrap"><button class="ghost" id="loadReadme">'+t('加载 README','Load README')+'</button></div>'
      + '</div>'
      + '<div>'
      + '<div class="panel">'
      + '<h2>'+esc(s.projectName)+'</h2>'
      + (s.teamName?'<div class="muted">👥 '+esc(s.teamName)+'</div>':'')
      + (s.description?'<p style="color:#3c4250">'+esc(s.description)+'</p>':'')
      + '<div class="kv"><span>'+t('仓库','Repo')+'</span><b><a href="'+esc(s.repoUrl)+'" target="_blank" rel="noopener">'+esc(s.repoOwner)+'/'+esc(s.repoName)+'</a ></b></div>'
      + '<div id="ghMeta"></div>'
      + (s.lockedSha?'<div class="kv"><span>'+t('评审版本','Reviewed')+'</span><b title="'+esc(s.lockedSha)+'">'+esc(s.lockedSha.slice(0,10))+'</b></div>':'')
      + '</div>'
      + '<div id="scorePanel"></div>'
      + '<div id="adminPanel"></div>'
      + '</div>'
      + '</div>';

    // github meta
    api('/api/gh/'+s.repoOwner+'/'+s.repoName).then(d=>{
      $('#ghMeta').innerHTML =
        '<div class="kv"><span>Stars</span><b>★ '+(d.stars??0)+'</b></div>'
        + (d.language?'<div class="kv"><span>'+t('语言','Language')+'</span><b>'+esc(d.language)+'</b></div>':'')
        + '<div class="kv"><span>'+t('最后提交','Last push')+'</span><b>'+fmtDate(d.pushedAt)+'</b></div>'
        + (d.homepage?'<div class="kv"><span>'+t('官网','Homepage')+'</span><b><a href="'+esc(d.homepage)+'" target="_blank" rel="noopener">'+t('链接','link')+' ↗</a ></b></div>':'');
    }).catch(()=>{});

    // screenshots carousel + lightbox
    const dcar = app.querySelector('.detail-shots');
    if(dcar) wireCarousel(dcar, ()=>{ const cur = dcar.querySelector('img.on'); if(cur) openLightbox(cur.src); });

    // readme
    $('#loadReadme').addEventListener('click', async ()=>{
      $('#loadReadme').disabled = true; $('#loadReadme').textContent = t('加载中…','Loading…');
      try {
        const { html } = await api('/api/gh/'+s.repoOwner+'/'+s.repoName+'/readme');
        const frame = document.createElement('iframe');
        frame.className = 'readme-frame';
        frame.setAttribute('sandbox','allow-popups allow-popups-to-escape-sandbox');
        frame.srcdoc = '<!doctype html><html><head><base target="_blank"><meta charset="utf-8">'
          + '<style>body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;padding:16px 20px;max-width:900px;margin:0 auto;color:#14161c;line-height:1.6}'
          + 'img{max-width:100%}pre{overflow:auto;background:#f6f8fa;padding:12px;border-radius:8px}code{background:#f0f2f5;padding:2px 5px;border-radius:4px}'
          + 'pre code{background:none;padding:0}table{border-collapse:collapse}td,th{border:1px solid #e2e6ee;padding:6px 10px}a{color:#5b4be6}h1,h2{border-bottom:1px solid #eee;padding-bottom:.3em}</style>'
          + '</head><body>'+html+'</body></html>';
        $('#readmeWrap').innerHTML = '';
        $('#readmeWrap').appendChild(frame);
      } catch(e){ $('#readmeWrap').innerHTML = '<p class="notice err">'+esc(e.message)+'</p>'; }
    });

    if(ME.role) renderScorePanel(s);
    if(ME.role === 'admin') renderAdminPanel(s);
  }

  async function renderScorePanel(s){
    const box = $('#scorePanel');
    let existing = {};
    try { const { scores } = await api('/api/scores'); existing = scores[s.id] || {}; } catch {}
    const labels = { innovation:t('创新','Innovation'), technical:t('技术','Technical'), completeness:t('完成度','Completeness'), presentation:t('展示','Presentation') };
    box.innerHTML = '<div class="panel" style="margin-top:16px"><h2>'+t('我的评分','My scores')+'</h2>'
      + CONFIG.dims.map(d=>{
          const v = existing[d] ?? 7;
          return '<div class="score-dim"><label>'+labels[d]+'</label><input type="range" min="1" max="10" value="'+v+'" data-dim="'+d+'" oninput="this.nextElementSibling.textContent=this.value"><span class="val">'+v+'</span></div>';
        }).join('')
      + '<label>'+t('评语(可选)','Comment (optional)')+'</label><textarea id="scoreComment" maxlength="500">'+esc(existing.comment||'')+'</textarea>'
      + '<div class="row" style="margin-top:12px"><button id="saveScore">'+t('保存评分','Save')+'</button><span id="scoreMsg" class="muted"></span></div>'
      + '</div>';
    $('#saveScore').addEventListener('click', async ()=>{
      const body = { submissionId: s.id, comment: $('#scoreComment').value };
      box.querySelectorAll('input[data-dim]').forEach(i=>body[i.dataset.dim]=Number(i.value));
      $('#saveScore').disabled = true;
      try { await api('/api/scores',{method:'POST',body}); $('#scoreMsg').textContent=t('已保存 ✓','Saved ✓'); }
      catch(e){ $('#scoreMsg').textContent = e.message; }
      finally { $('#saveScore').disabled = false; }
    });
  }

  function renderAdminPanel(s){
    const box = $('#adminPanel');
    box.innerHTML = '<div class="panel" style="margin-top:16px"><h2>'+t('管理','Admin')+'</h2>'
      + '<div class="row"><button class="ghost" id="lockBtn">'+t('锁定评审版本(记录当前 commit)','Lock reviewed version (record current commit)')+'</button>'
      + '<button class="ghost" id="hideBtn">'+t('隐藏该作品','Hide this project')+'</button></div>'
      + '<div id="adminMsg" class="muted" style="margin-top:8px"></div></div>';
    $('#lockBtn').addEventListener('click', async ()=>{
      try { const r = await api('/api/submissions/'+s.id+'/lock',{method:'POST',body:{}}); $('#adminMsg').textContent=t('已锁定 ','Locked ')+r.lockedSha.slice(0,10); }
      catch(e){ $('#adminMsg').textContent = e.message; }
    });
    $('#hideBtn').addEventListener('click', async ()=>{
      if(!confirm(t('确定隐藏该作品?','Hide this project?'))) return;
      try { await api('/api/submissions/'+s.id+'/hide',{method:'POST',body:{}}); go('/'); }
      catch(e){ $('#adminMsg').textContent = e.message; }
    });
  }

  // ---------------- submit ----------------
  let SHOTS = []; // dataURLs
  async function renderSubmit(){
    // NB: SHOTS is intentionally NOT reset here, so a language toggle / re-render keeps
    // already-selected screenshots. It's cleared after a successful submit instead.
    const mb = Math.round(CONFIG.maxShotBytes/1048576*10)/10;
    app.innerHTML =
      '<h1>'+t('提交作品','Submit a project')+'</h1>'
      + '<div class="panel" style="max-width:720px">'
      + '<div class="notice">'+t('规则:① 视频请传到 <b>B站/YouTube</b>,这里贴链接(别塞进 Git);② 仓库必须 <b>Public</b>,否则评委看不到;③ PPT 放仓库 <code>/docs</code> 里的 <b>PDF</b>(GitHub 可在线预览);④ 截止后建议打 Release tag 锁版本。','Rules: ① host the video on <b>Bilibili/YouTube</b> and paste the link (keep it out of Git); ② the repo must be <b>Public</b>; ③ put the slides as a <b>PDF</b> under <code>/docs</code> (GitHub previews it); ④ tag a Release after the deadline to lock the version.')+'</div>'
      + '<label>'+t('产品名称','Product name')+' * <span class="muted">('+t('作品的主标题','the main title')+')</span></label><input id="projectName" maxlength="80" placeholder="'+t('你的产品 / 作品名','Your product name')+'">'
      + '<label>'+t('GitHub 仓库链接','GitHub repo URL')+' * <span class="muted">('+t('必须 Public','must be Public')+')</span></label><input id="repoUrl" placeholder="https://github.com/owner/repo">'
      + '<label>'+t('演示视频链接','Demo video link')+' * <span class="muted">'+t('(B站 / YouTube)','(Bilibili / YouTube)')+'</span></label><input id="videoUrl" placeholder="https://www.bilibili.com/video/BV...">'
      + '<label>'+t('一句话介绍','One-line intro')+' <span class="muted">(≤300)</span></label><textarea id="description" maxlength="300" placeholder="'+t('项目亮点 / 技术栈','Highlights / tech stack')+'"></textarea>'
      + '<label>'+t('队伍名称','Team name')+' <span class="muted">('+t('可选','optional')+')</span></label><input id="teamName" maxlength="80" placeholder="'+t('队名','Team')+'">'
      + '<label>'+t('联系方式','Contact')+' <span class="muted">('+t('可选,评委联系用','optional, for judges')+')</span></label><input id="contact" maxlength="120" placeholder="'+t('微信 / 邮箱','WeChat / email')+'">'
      + '<label>'+t('产品截图','Screenshots')+' * <span class="muted">('+CONFIG.minShots+'–'+CONFIG.maxShots+' '+t('张,自动裁切为 16:9,单张≤','imgs, auto-cropped to 16:9, each ≤')+mb+'MB)</span></label>'
      + '<input id="shotFiles" type="file" accept="image/*" multiple>'
      + '<div class="thumbs" id="thumbs"></div>'
      + '<label>'+t('邀请码','Invite code')+' * <span class="muted">('+t('主办方发给你队的专属码','the code the organizer gave your team')+')</span></label><input id="passcode" placeholder="'+t('每队一个,如 HV-xxxxxx','one per team, e.g. HV-xxxxxx')+'">'
      + '<div class="row" style="margin-top:16px"><button id="submitBtn">'+t('提交','Submit')+'</button></div>'
      + '<div id="submitMsg"></div>'
      + '</div>';
    $('#shotFiles').addEventListener('change', onShots);
    $('#submitBtn').addEventListener('click', doSubmit);
    renderThumbs(); // re-show any screenshots kept across a re-render/language toggle
  }

  async function onShots(ev){
    const files = [...ev.target.files];
    ev.target.value = '';
    for(const f of files){
      if(SHOTS.length >= CONFIG.maxShots){ alert(t('最多 ','Max ')+CONFIG.maxShots+t(' 张','')); break; }
      try { SHOTS.push(await compress(f)); } catch(e){ alert(t('图片处理失败:','Image error: ')+e.message); }
    }
    renderThumbs();
  }

  function renderThumbs(){
    $('#thumbs').innerHTML = SHOTS.map((d,i)=>'<div class="t"><img src="'+d+'"><span class="x" data-i="'+i+'">×</span></div>').join('');
    $('#thumbs').querySelectorAll('.x').forEach(x=>x.addEventListener('click',()=>{ SHOTS.splice(Number(x.dataset.i),1); renderThumbs(); }));
  }

  function compress(file){
    return new Promise((resolve,reject)=>{
      if(!file.type.startsWith('image/')) return reject(new Error('不是图片'));
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = ()=>{
        const ratio = 16/9;
        // center-crop the source to 16:9
        let cw = img.width, ch = Math.round(img.width / ratio);
        if(ch > img.height){ ch = img.height; cw = Math.round(img.height * ratio); }
        const sx = Math.round((img.width - cw) / 2), sy = Math.round((img.height - ch) / 2);
        // output width capped at 1600
        const outW = Math.min(cw, 1600), outH = Math.round(outW / ratio);
        const c = document.createElement('canvas'); c.width = outW; c.height = outH;
        c.getContext('2d').drawImage(img, sx, sy, cw, ch, 0, 0, outW, outH);
        URL.revokeObjectURL(url);
        const maxBytes = CONFIG.maxShotBytes || 1048576;
        let q = 0.85, out = c.toDataURL('image/jpeg', q);
        while(dataUrlBytes(out) > maxBytes && q > 0.4){ q -= 0.1; out = c.toDataURL('image/jpeg', q); }
        if(dataUrlBytes(out) > maxBytes) return reject(new Error('图片太大,请换一张'));
        resolve(out);
      };
      img.onerror = ()=>{ URL.revokeObjectURL(url); reject(new Error('无法读取')); };
      img.src = url;
    });
  }
  function dataUrlBytes(d){ const i = d.indexOf(','); if(i<0) return 0; const n = d.length - i - 1; const pad = d.endsWith('==')?2:(d.endsWith('=')?1:0); return Math.floor(n*3/4) - pad; }

  async function doSubmit(){
    const body = {
      passcode: $('#passcode').value.trim(),
      projectName: $('#projectName').value.trim(),
      teamName: $('#teamName').value.trim(),
      contact: $('#contact').value.trim(),
      repoUrl: $('#repoUrl').value.trim(),
      description: $('#description').value.trim(),
      videoUrl: $('#videoUrl').value.trim(),
      shots: SHOTS,
    };
    if(!body.projectName || !body.repoUrl || !body.videoUrl){ setMsg('submitMsg',t('请填齐产品名、仓库、视频链接','Fill in product name, repo and video link'),true); return; }
    if(!body.passcode){ setMsg('submitMsg',t('请填写邀请码','Enter your invite code'),true); return; }
    if(SHOTS.length < CONFIG.minShots){ setMsg('submitMsg',t('请至少上传 ','At least ')+CONFIG.minShots+t(' 张截图',' screenshots required'),true); return; }
    $('#submitBtn').disabled = true; setMsg('submitMsg',t('提交中…','Submitting…'));
    try {
      const r = await api('/api/submissions',{method:'POST',body});
      setMsg('submitMsg',t('提交成功!','Submitted! ')+'<a href="'+r.viewUrl+'" onclick="go(\''+r.viewUrl+'\');return false">'+t('查看作品','View project')+'</a ><br>'+t('编辑令牌(改稿用,请保存):','Edit token (save it to edit later): ')+'<code>'+esc(r.editToken)+'</code>', false, true);
      SHOTS = []; renderThumbs();
      ['#projectName','#repoUrl','#videoUrl','#description','#teamName','#contact','#passcode'].forEach(id=>{ const el = $(id); if(el) el.value = ''; });
    } catch(e){ setMsg('submitMsg', e.message, true); }
    finally { $('#submitBtn').disabled = false; }
  }

  // ---------------- judge login ----------------
  function renderJudge(){
    if(ME.role){ go('/leaderboard'); return; }
    app.innerHTML = '<h1>'+t('评审入口','Judge login')+'</h1><div class="panel" style="max-width:440px">'
      + '<p>'+t('评委:输入主办方发给你的<b>专属登录码</b>(姓名由码决定)。管理员:输入管理口令。','Judges: enter your <b>personal login code</b> from the organizer (your name comes from the code). Admin: enter the admin passcode.')+'</p>'
      + '<label>'+t('登录码 / 口令','Login code / passcode')+' *</label><input id="jCode" placeholder="'+t('评委登录码,或管理口令','judge code, or admin passcode')+'">'
      + '<label>'+t('姓名','Name')+' <span class="muted">('+t('仅管理员可填','admin only')+')</span></label><input id="jName" maxlength="40" placeholder="'+t('管理员姓名(可选)','admin name (optional)')+'">'
      + '<div class="row" style="margin-top:14px"><button id="jLogin">'+t('登录','Log in')+'</button></div>'
      + '<div id="jMsg"></div></div>';
    $('#jLogin').addEventListener('click', async ()=>{
      try {
        ME = await api('/api/auth/login',{method:'POST',body:{code:$('#jCode').value.trim(), name:$('#jName').value.trim()}});
        renderNav(); go('/');
      } catch(e){ setMsg('jMsg', e.message, true); }
    });
  }

  // ---------------- leaderboard ----------------
  async function renderLeaderboard(){
    if(!ME.role){ go('/judge'); return; }
    app.innerHTML = '<div class="row" style="justify-content:space-between"><h1>'+t('排行榜','Leaderboard')+'</h1>'
      + (ME.role==='admin'?'<a href="/api/scores/export"><button class="ghost">'+t('导出 CSV','Export CSV')+'</button></a >':'')
      + '</div><div class="panel" id="lb"><p>'+t('加载中…','Loading…')+'</p></div>';
    try {
      const { rows } = await api('/api/leaderboard');
      $('#lb').innerHTML = '<table><thead><tr><th>#</th><th>'+t('产品','Product')+'</th><th>'+t('仓库','Repo')+'</th><th>'+t('评委数','Judges')+'</th><th>'+t('平均分(满分40)','Avg (of 40)')+'</th></tr></thead><tbody>'
        + rows.map((r,i)=>'<tr><td class="rank">'+(r.avgTotal==null?'-':i+1)+'</td><td>'+esc(r.projectName)+(r.teamName?' <span class="muted" style="font-size:12px">'+esc(r.teamName)+'</span>':'')+'</td>'
          + '<td class="card-repo"><a href="/p/'+r.id+'" onclick="go(\'/p/'+r.id+'\');return false">'+esc(r.repo)+'</a ></td>'
          + '<td>'+r.judges+'</td><td><b>'+(r.avgTotal==null?t('未评','—'):r.avgTotal)+'</b></td></tr>').join('')
        + '</tbody></table>';
    } catch(e){ $('#lb').innerHTML = '<p class="notice err">'+esc(e.message)+'</p>'; }
  }

  // ---------------- invite codes (admin) ----------------
  async function renderInvites(){
    if(ME.role !== 'admin'){ go('/judge'); return; }
    app.innerHTML = '<h1>'+t('邀请码','Invite codes')+'</h1><p>'+t('每队一个,单次有效。生成后发给各队,选手提交时填。','One per team, single-use. Generate, hand out, teams enter it when submitting.')+'</p>'
      + '<div class="panel" style="max-width:640px">'
      + '<div class="row"><div style="flex:1"><label>'+t('生成数量','Count')+'</label><input id="invCount" type="number" min="1" max="500" value="100"></div>'
      + '<div style="flex:1"><label>'+t('前缀','Prefix')+'</label><input id="invPrefix" maxlength="8" value="HV"></div>'
      + '<div style="align-self:flex-end"><button id="genBtn">'+t('生成','Generate')+'</button></div></div>'
      + '<div id="genOut"></div>'
      + '</div>'
      + '<div class="panel" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">'+t('已有邀请码','Existing codes')+'</h2>'
      + '<button class="ghost" id="copyUnused">'+t('复制全部未使用','Copy all unused')+'</button></div>'
      + '<div id="invList" style="margin-top:12px"><p class="muted">'+t('加载中…','Loading…')+'</p></div></div>';

    $('#genBtn').addEventListener('click', async ()=>{
      const count = Number($('#invCount').value), prefix = $('#invPrefix').value.trim();
      $('#genBtn').disabled = true;
      try {
        const r = await api('/api/invites',{method:'POST',body:{count,prefix}});
        $('#genOut').innerHTML = '<div class="notice ok">'+t('已生成 ','Generated ')+r.count+t(' 个,复制发给各队:',' — copy and hand out:')+'</div>'
          + '<textarea readonly rows="6" style="font-family:ui-monospace,monospace">'+r.codes.join('\n')+'</textarea>';
        loadInviteList();
      } catch(e){ $('#genOut').innerHTML = '<div class="notice err">'+esc(e.message)+'</div>'; }
      finally { $('#genBtn').disabled = false; }
    });
    $('#copyUnused').addEventListener('click', async ()=>{
      const unused = (window.__invites||[]).filter(c=>!c.used).map(c=>c.code);
      if(!unused.length){ alert(t('没有未使用的邀请码','No unused codes')); return; }
      try { await navigator.clipboard.writeText(unused.join('\n')); $('#copyUnused').textContent=t('已复制 ','Copied ')+unused.length+t(' 个 ✓',' ✓'); }
      catch { alert(unused.join('\n')); }
    });
    loadInviteList();
  }

  async function loadInviteList(){
    try {
      const r = await api('/api/invites');
      window.__invites = r.codes;
      $('#invList').innerHTML = '<div class="muted" style="margin-bottom:8px">'+t('共 ','Total ')+r.total+t(' 个,未使用 ',', unused ')+'<b>'+r.unused+'</b></div>'
        + '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:6px">'
        + r.codes.map(c=>'<code style="padding:5px 8px;border-radius:6px;border:1px solid var(--line);background:'+(c.used?'#f3f4f6;color:#9aa1ac;text-decoration:line-through':'#fff')+'">'+esc(c.code)+'</code>').join('')
        + '</div>';
    } catch(e){ $('#invList').innerHTML = '<p class="notice err">'+esc(e.message)+'</p>'; }
  }

  // ---------------- judge codes (admin) ----------------
  async function renderJudges(){
    if(ME.role !== 'admin'){ go('/judge'); return; }
    app.innerHTML = '<h1>'+t('评委登录码','Judge login codes')+'</h1><p>'+t('每个评委一个专属登录码,码绑定姓名,打分身份用码区分(不会同名互相覆盖)。','One code per judge, bound to a name; scores are keyed by code so same names never overwrite.')+'</p>'
      + '<div class="panel" style="max-width:640px">'
      + '<label>'+t('评委姓名(每行一个)','Judge names (one per line)')+'</label><textarea id="jNames" rows="5" placeholder="'+t('张三&#10;李四&#10;王五','Alice&#10;Bob&#10;Carol')+'"></textarea>'
      + '<div class="row" style="margin-top:6px"><div style="flex:1"><label>'+t('前缀','Prefix')+'</label><input id="jPrefix" maxlength="8" value="J"></div>'
      + '<div style="align-self:flex-end"><button id="jGen">'+t('生成登录码','Generate codes')+'</button></div></div>'
      + '<div id="jGenOut"></div></div>'
      + '<div class="panel" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">'+t('已有评委','Judges')+'</h2>'
      + '<button class="ghost" id="jCopy">'+t('复制全部(姓名+码)','Copy all (name + code)')+'</button></div>'
      + '<div id="jList" style="margin-top:12px"><p class="muted">'+t('加载中…','Loading…')+'</p></div></div>';

    $('#jGen').addEventListener('click', async ()=>{
      const names = $('#jNames').value.split('\n').map(s=>s.trim()).filter(Boolean);
      const prefix = $('#jPrefix').value.trim();
      if(!names.length){ alert(t('请至少输入一个姓名','Enter at least one name')); return; }
      $('#jGen').disabled = true;
      try {
        const r = await api('/api/judges',{method:'POST',body:{names,prefix}});
        $('#jGenOut').innerHTML = '<div class="notice ok">'+t('已生成 ','Generated ')+r.count+t(' 个,发给各评委:',' — hand out to judges:')+'</div>'
          + '<textarea readonly rows="6" style="font-family:ui-monospace,monospace">'+r.judges.map(j=>j.name+'  '+j.code).join('\n')+'</textarea>';
        $('#jNames').value = '';
        loadJudgeList();
      } catch(e){ $('#jGenOut').innerHTML = '<div class="notice err">'+esc(e.message)+'</div>'; }
      finally { $('#jGen').disabled = false; }
    });
    $('#jCopy').addEventListener('click', async ()=>{
      const all = (window.__judges||[]).map(j=>j.name+'  '+j.code).join('\n');
      if(!all){ alert(t('还没有评委','No judges yet')); return; }
      try { await navigator.clipboard.writeText(all); $('#jCopy').textContent=t('已复制 ✓','Copied ✓'); }
      catch { alert(all); }
    });
    loadJudgeList();
  }

  async function loadJudgeList(){
    try {
      const r = await api('/api/judges');
      window.__judges = r.judges;
      $('#jList').innerHTML = r.judges.length
        ? '<table><thead><tr><th>'+t('姓名','Name')+'</th><th>'+t('登录码','Login code')+'</th></tr></thead><tbody>'
          + r.judges.map(j=>'<tr><td>'+esc(j.name)+'</td><td><code>'+esc(j.code)+'</code></td></tr>').join('')
          + '</tbody></table>'
        : '<p class="muted">'+t('还没有评委,上面生成。','No judges yet — generate above.')+'</p>';
    } catch(e){ $('#jList').innerHTML = '<p class="notice err">'+esc(e.message)+'</p>'; }
  }

  // ---------------- utils ----------------
  function wireCarousel(car, onImgClick){
    if(!car) return;
    car.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', ev => {
      ev.stopPropagation();
      const imgs = car.querySelectorAll('img'), dots = car.querySelectorAll('.dot');
      let i = Number(car.dataset.i);
      imgs[i].classList.remove('on'); if(dots[i]) dots[i].classList.remove('on');
      i = (i + Number(btn.dataset.d) + imgs.length) % imgs.length;
      imgs[i].classList.add('on'); if(dots[i]) dots[i].classList.add('on');
      car.dataset.i = i;
    }));
    if(onImgClick) car.addEventListener('click', onImgClick);
  }
  function openLightbox(src){
    const lb = document.getElementById('lightbox');
    lb.innerHTML = '<img src="'+src+'" alt="">';
    lb.classList.remove('hidden');
  }
  function ensureTurnstile(){
    return new Promise((resolve)=>{
      if(window.turnstile){ resolve(); return; }
      let s = document.getElementById('cf-ts-script');
      if(s){ const iv=setInterval(()=>{ if(window.turnstile){ clearInterval(iv); resolve(); } },100); return; }
      s = document.createElement('script'); s.id='cf-ts-script';
      s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; s.async=true; s.defer=true;
      s.onload=()=>resolve(); document.head.appendChild(s);
    });
  }
  function videoEmbed(url){
    let m = url.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/i);
    if(m) return 'https://player.bilibili.com/player.html?bvid='+m[1]+'&page=1&high_quality=1&danmaku=0';
    m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{11})/);
    if(m) return 'https://www.youtube.com/embed/'+m[1];
    return null;
  }
  function fmtDate(s){ if(!s) return '-'; const d=new Date(s); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
  function esc(v){ return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function setMsg(id,msg,err,ok){ const t=document.getElementById(id); if(!t)return; t.className='notice'+(err?' err':ok?' ok':''); t.innerHTML=msg; }
  async function api(path,opts={}){
    const res = await fetch(path,{method:opts.method||'GET',headers:opts.body?{'Content-Type':'application/json'}:{},body:opts.body?JSON.stringify(opts.body):undefined,credentials:'same-origin'});
    const data = await res.json().catch(()=>({}));
    if(!res.ok) throw new Error(data.error||(t('请求失败 ','Request failed ')+res.status));
    return data;
  }
  </script>
</body>
</html>`;
