import { FAVICON_SVG, OG_PNG_B64, APPLE_ICON_B64 } from "./assets";
import qrcode from "qrcode-generator";
import { createWorkbench, workbenchMockEnabled, mintScopedChatToken } from "./workbench";
import { createParticipantRepo, mintRepoScopedPushToken, deleteParticipantRepo, validateRepoName, repoBotMockEnabled } from "./participant-repo";

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
  PLATFORM_ADMIN_EMAILS?: string; // comma/space-separated platform operator emails (can set user plan)
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
  // ---- WorkBench (Mini × fde-copilot/loop-engineer) — contract §5 v2, CC-51 ----
  WORKBENCH_BASE_URL?: string; // fde-copilot base URL (clients/projects/chat/commit/usage); unset → mock
  WORKBENCH_LOOP_URL?: string; // loop-engineer base URL (plan/run/status), e.g. https://loop.aastar.io
  WORKBENCH_TOKEN?: string; // admin orchestration token (B3)
  WORKBENCH_CALLBACK_SECRET?: string; // HMAC key to verify inbound W5 callbacks (C2)
  WORKBENCH_MOCK?: string; // "1" forces offline mock data (WorkBench client, AI naming self-test, ...)
  // ---- Mini participant public-repo provisioning (B2, CC-51) ----
  GITHUB_BOT_TOKEN?: string; // isolated bot account/org credential (CF secret) — create/delete repos
  HACK5_GITHUB_PAT?: string; // existing hack5 bot PAT (clestons account); alias of GITHUB_BOT_TOKEN
  GITHUB_BOT_OWNER?: string; // bot login owning the repos (default clestons)
  GITHUB_BOT_IS_ORG?: string; // "1" if the bot owner is an org
  GITHUB_APP_ID?: string; // GitHub App for repo-scoped short-lived push tokens
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM
  GITHUB_APP_INSTALLATION_ID?: string;
  // ---- Mini /make anonymous-abuse guardrails (tunable daily caps; defaults in code) ----
  MINIAPP_CHAT_GLOBAL_CAP?: string; // all-tenant daily chat (LLM) ceiling — default 3000
  MINIAPP_LAUNCH_IP_CAP?: string; // per-IP daily build ceiling — default 3
  MINIAPP_LAUNCH_TENANT_CAP?: string; // per-tenant daily build ceiling — default 10
  MINIAPP_LAUNCH_GLOBAL_CAP?: string; // all-tenant daily build ceiling — default 30
}

type Auth = { role: "judge" | "admin"; name: string; jid: string; tenant: string; exp: number };

const AUTH_COOKIE = "hv_auth";
const USER_COOKIE = "hv_user";
const PARTICIPANT_COOKIE = "hv_part"; // per-tenant participant session (email-verified), distinct from organizer USER_COOKIE
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

      // ---- brand assets (static, tenant-independent) ----
      if (method === "GET" && (path === "/favicon.svg" || path === "/favicon.ico")) {
        return new Response(FAVICON_SVG, {
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" },
        });
      }
      if (method === "GET" && path === "/og.png") return imageBytes(OG_PNG_B64, "image/png");
      if (method === "GET" && path === "/apple-touch-icon.png") return imageBytes(APPLE_ICON_B64, "image/png");

      // Resolve the tenant (hackathon) for this request from the Host.
      const tctx = await resolveTenant(request, env);
      const tenant = tctx.tenant;
      const tid = tenant ? tenant.id : null;

      // Secret-mode gate (server-side, not just the SPA): for a secret tenant with no access session,
      // block every data API and content-asset route. Allow only config, auth (judge/admin login),
      // the access-code redemption, and the SPA shell so the gate page can render.
      if (tenant && tenant.mode === "secret" && !(await hasSecretAccess(request, env, tenant))) {
        const allowedApi = path === "/api/config" || path === "/api/tenant/access" || path.startsWith("/api/auth/");
        const blockedAsset =
          path.startsWith("/photo/") || path.startsWith("/banner/") || path.startsWith("/qr/") || path.startsWith("/shot/") || path.startsWith("/media/");
        if ((path.startsWith("/api/") && !allowedApi) || blockedAsset) {
          return json({ error: "需要访问码 / Access required" }, 403);
        }
      }

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
      if (path === "/api/platform/admin/users" && method === "GET") return adminListUsers(request, env);
      if (path === "/api/platform/admin/set-plan" && method === "POST") return adminSetPlan(request, env);
      if (path === "/api/platform/org" && method === "GET") return getOrgProfile(request, env);
      if (path === "/api/platform/org" && method === "POST") return saveOrgProfile(request, env);
      const orgLogo = path.match(/^\/org-logo\/([a-z0-9-]+)$/);
      if (orgLogo && method === "GET") return serveOrgLogo(env, orgLogo[1]);

      // ---- secret-mode access gate + judge roster ----
      if (path === "/api/tenant/access" && method === "POST") return redeemAccess(request, env, tenant, tid);
      if (path === "/api/tenant/judges/roster" && method === "GET") return judgeRoster(request, env, tenant, tid);

      // ---- tenant homepage (admin) ----
      if (path === "/api/tenant/homepage" && method === "POST") return updateHomepage(request, env, tenant);

      // ---- participant session (email-verified, per-tenant) ----
      if (path === "/api/tenant/participant/login/request" && method === "POST") return participantLoginRequest(request, env, tenant);
      if (path === "/api/tenant/participant/login/verify" && method === "POST") return participantLoginVerify(request, env, tenant, tid);
      if (path === "/api/tenant/participant/logout" && method === "POST") return participantLogout(request);
      if (path === "/api/tenant/me" && method === "GET") return participantMe(request, env, tenant, tid);

      // ---- participant registration ----
      if (path === "/api/tenant/register" && method === "POST") return registerParticipant(request, env, tenant);
      if (path === "/api/tenant/registrations" && method === "GET") return listRegistrations(request, env, tid);
      if (path === "/api/tenant/registrations/export" && method === "GET") return exportRegistrations(request, env, tid);

      // ---- premium: AI text-to-image poster background (admin, metered) ----
      if (path === "/api/tenant/poster/ai" && method === "POST") return generateAiPoster(request, env, tenant, tid);
      if (path === "/api/tenant/poster/quota" && method === "GET") return getPosterQuota(request, env, tid);

      // ---- homepage banner ----
      if (path === "/api/tenant/banner" && method === "POST") return updateBanner(request, env, tenant);
      const bannerServe = path.match(/^\/banner\/([a-z0-9-]+)$/);
      if (bannerServe && method === "GET") return serveBanner(request, env, bannerServe[1]);
      const qrServe = path.match(/^\/qr\/([a-z0-9-]+)$/);
      if (qrServe && method === "GET") return serveQr(env, qrServe[1]);

      // ---- team formation board ----
      if (path === "/api/tenant/teams" && method === "POST") return createTeamPost(request, env, tenant);
      if (path === "/api/tenant/teams" && method === "GET") return listTeamPosts(env, tid);
      const teamDel = path.match(/^\/api\/tenant\/teams\/([^/]+)$/);
      if (teamDel && method === "DELETE") return deleteTeamPost(request, env, tenant, tid, teamDel[1]);

      // ---- photo wall ----
      if (path === "/api/tenant/photos" && method === "GET") return listPhotos(env, tid);
      if (path === "/api/tenant/photos" && method === "POST") return uploadPhotos(request, env, tenant);
      const photoDel = path.match(/^\/api\/tenant\/photos\/([^/]+)$/);
      if (photoDel && method === "DELETE") return deletePhoto(request, env, tenant, photoDel[1]);
      const photoServe = path.match(/^\/photo\/([^/]+)\/([^/]+)$/);
      if (photoServe && method === "GET") return servePhoto(request, env, photoServe[1], photoServe[2]);

      // ---- submissions (tenant-scoped) ----
      if (path === "/api/submissions" && method === "GET") return listSubmissions(request, env, tenant, tid);
      if (path === "/api/submissions" && method === "POST") return createSubmission(request, env, tenant, tid);
      const subMatch = path.match(/^\/api\/submissions\/([^/]+)$/);
      if (subMatch && method === "GET") return getSubmission(request, env, tenant, tid, subMatch[1]);
      const lockMatch = path.match(/^\/api\/submissions\/([^/]+)\/lock$/);
      if (lockMatch && method === "POST") return lockSubmission(request, env, tid, lockMatch[1]);
      const hideMatch = path.match(/^\/api\/submissions\/([^/]+)\/hide$/);
      if (hideMatch && method === "POST") return hideSubmission(request, env, tid, hideMatch[1]);
      const likeMatch = path.match(/^\/api\/submissions\/([^/]+)\/like$/);
      if (likeMatch && method === "POST") return likeSubmission(request, env, tenant, tid, likeMatch[1]);
      if (path === "/api/tenant/mini/assist" && method === "POST") return miniAssist(request, env, tenant, tid);
      if (path === "/api/tenant/mini/name" && method === "POST") return miniName(request, env, tenant, tid);
      if (path === "/api/tenant/mini/usage" && method === "GET") return miniUsage(request, env, tenant, tid);
      // A3 — mini「做成应用」: multi-turn chat → repo provisioning + trigger loop
      if (path === "/api/tenant/mini/app/chat" && method === "POST") return miniAppChat(request, env, tenant, tid);
      if (path === "/api/tenant/mini/app/launch" && method === "POST") return miniAppLaunch(request, env, tenant, tid);
      // ---- WorkBench usage aggregation smoke test (mock only; inert in production) ----
      if (path === "/api/wb/usage-selftest" && method === "GET") return usageSelftest(env);
      // ---- AI naming smoke test (mock only; inert in production) ----
      if (path === "/api/wb/name-selftest" && method === "GET") return nameSelftest(env);

      // ---- WorkBench client + repo-provisioning smoke tests (mock only; inert in production) ----
      if (path === "/api/wb/selftest" && method === "GET") return wbSelftest(env);
      if (path === "/api/wb/repo-selftest" && method === "GET") return repoSelftest(env);
      // ---- WorkBench build-status callback (W5, HMAC-verified) + its smoke test ----
      if (path === "/api/wb/callback" && method === "POST") return wbCallback(request, env);
      if (path === "/api/wb/callback-selftest" && method === "GET") return callbackSelftest(env);

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
  banner?: string;
  mode?: string;
  access_days?: number;
  org_name?: string;
  org_url?: string;
  org_has_logo?: number;
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
    `SELECT t.id, t.subdomain, t.name, t.admin_pass_hash, t.intro, t.event_time, t.location, t.duration, t.address, t.map_query, t.agenda, t.banner, t.mode, t.access_days,
       u.org_name AS org_name, u.org_url AS org_url,
       CASE WHEN u.org_logo IS NOT NULL AND u.org_logo <> '' THEN 1 ELSE 0 END AS org_has_logo
     FROM tenants t LEFT JOIN users u ON u.email = t.owner_email
     WHERE t.subdomain = ? AND t.status = 'active'`,
  )
    .bind(sub)
    .first<Tenant>();
  if (!tenant) return { platform: false, tenant: null, notFound: sub };
  return { platform: false, tenant };
}

async function getConfig(request: Request, env: Env): Promise<Response> {
  const tctx = await resolveTenant(request, env);
  const mode = tctx.tenant?.mode === "secret" ? "secret" : tctx.tenant?.mode === "mini" ? "mini" : "open";
  // Secret tenants gate everything behind an access session: without it, expose only name + mode
  // so the client can render the access-code page — never the intro/details/submissions.
  const gated = mode === "secret" && !(await hasSecretAccess(request, env, tctx.tenant));
  return json({
    appName: env.APP_NAME || "hack5",
    country: request.cf?.country ?? null,
    turnstileSiteKey: env.TURNSTILE_SITEKEY ?? null,
    platform: tctx.platform,
    tenantNotFound: tctx.notFound ?? null,
    tenant: tctx.tenant
      ? gated
        ? { subdomain: tctx.tenant.subdomain, name: tctx.tenant.name, mode, gated: true }
        : {
          subdomain: tctx.tenant.subdomain,
          name: tctx.tenant.name,
          mode,
          gated: false,
          intro: tctx.tenant.intro ?? "",
          eventTime: tctx.tenant.event_time ?? "",
          location: tctx.tenant.location ?? "",
          duration: tctx.tenant.duration ?? "",
          address: tctx.tenant.address ?? "",
          mapQuery: tctx.tenant.map_query ?? "",
          agenda: parseAgenda(tctx.tenant.agenda),
          hasBanner: Boolean(tctx.tenant.banner),
          organizer: tctx.tenant.org_name
            ? { name: tctx.tenant.org_name, url: tctx.tenant.org_url ?? "", hasLogo: Boolean(tctx.tenant.org_has_logo) }
            : null,
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

async function signAccessToken(env: Env, payload: { tenant: string; exp: number }): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload));
  return `${body}.${await hmacHex(utf8(env.AUTH_SECRET), body)}`;
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
    // Token-type separation: an hv_access session token ({tenant, exp}, no role) must NOT be
    // accepted as an hv_auth judge/admin session — reject anything without a real role.
    if (payload.role !== "judge" && payload.role !== "admin") return null;
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

// ---- secret-mode access gate ----
const ACCESS_COOKIE = "hv_access";
type Access = { tenant: string; exp: number };
function accessCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `${ACCESS_COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
async function getAccessSession(request: Request, env: Env, tid: string | null): Promise<boolean> {
  const raw = parseCookies(request.headers.get("cookie"))[ACCESS_COOKIE];
  if (!raw || !tid) return false;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return false;
  const body = raw.slice(0, dot);
  if (!timingSafeEqual(raw.slice(dot + 1), await hmacHex(utf8(env.AUTH_SECRET), body))) return false;
  try {
    const p = JSON.parse(b64urlDecode(body)) as Access;
    return typeof p.exp === "number" && p.exp >= unixNow() && p.tenant === tid;
  } catch {
    return false;
  }
}
// A request "has access" to a secret tenant's content if: open mode, OR a valid access session,
// OR an admin/judge session (they're already trusted).
async function hasSecretAccess(request: Request, env: Env, tenant: Tenant | null): Promise<boolean> {
  if (!tenant || tenant.mode !== "secret") return true;
  if (await getAccessSession(request, env, tenant.id)) return true;
  return Boolean(await getAuth(request, env, tenant.id));
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
    isOperator: isOperatorEmail(env, user.email),
    used: list.results.length,
    hackathons: list.results.map((h) => ({ subdomain: h.subdomain, name: h.name, url: `https://${h.subdomain}.hack5.net` })),
  });
}

// hack5 platform operator (运营方) — emails listed in PLATFORM_ADMIN_EMAILS. NOT a per-hackathon
// admin; this is the top-level operator who can grant/revoke paid accounts.
function isOperatorEmail(env: Env, email: string | null | undefined): boolean {
  if (!email) return false;
  const list = (env.PLATFORM_ADMIN_EMAILS ?? "").split(/[,\s]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  return list.includes(email.toLowerCase());
}

// Operator: list platform users with their plan/quota + active hackathon counts.
async function adminListUsers(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  if (!isOperatorEmail(env, user?.email)) return json({ error: "运营方专用 / Operator only" }, 403);
  const rows = await env.DB.prepare("SELECT email, plan, quota, created_at FROM users ORDER BY created_at DESC LIMIT 500").all<{ email: string; plan: string; quota: number; created_at: number }>();
  const counts = await env.DB.prepare(
    "SELECT owner_email, COUNT(*) AS c, SUM(CASE WHEN mode = 'mini' THEN 1 ELSE 0 END) AS mini FROM tenants WHERE status = 'active' AND owner_email IS NOT NULL GROUP BY owner_email",
  ).all<{ owner_email: string; c: number; mini: number }>();
  const cmap: Record<string, { c: number; mini: number }> = {};
  for (const r of counts.results) cmap[r.owner_email] = { c: Number(r.c), mini: Number(r.mini) };
  return json({
    users: rows.results.map((u) => ({
      email: u.email,
      plan: u.plan,
      quota: u.quota,
      createdAt: u.created_at,
      hackathons: cmap[u.email]?.c ?? 0,
      mini: cmap[u.email]?.mini ?? 0,
    })),
  });
}

// Operator: set a user's plan (free|paid) and optionally quota. Upserts so a plan can be granted
// before the user's first login. This is the entry that replaces manual `UPDATE users SET plan=...`.
async function adminSetPlan(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  if (!isOperatorEmail(env, user?.email)) return json({ error: "运营方专用 / Operator only" }, 403);
  const body = await request.json<{ email?: string; plan?: string; quota?: number }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return json({ error: "邮箱无效 / Invalid email" }, 400);
  const plan = body?.plan === "paid" ? "paid" : body?.plan === "free" ? "free" : null;
  if (!plan) return json({ error: "plan 只能是 free 或 paid / plan must be free or paid" }, 400);
  const now = unixNow();
  if (body?.quota != null && Number.isFinite(Number(body.quota))) {
    const q = Math.max(0, Math.min(100000, Math.floor(Number(body.quota))));
    await env.DB.prepare("INSERT INTO users (email, quota, plan, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET plan = excluded.plan, quota = excluded.quota")
      .bind(email, q, plan, now)
      .run();
  } else {
    await env.DB.prepare("INSERT INTO users (email, quota, plan, created_at) VALUES (?, 1, ?, ?) ON CONFLICT(email) DO UPDATE SET plan = excluded.plan")
      .bind(email, plan, now)
      .run();
  }
  const updated = await env.DB.prepare("SELECT email, plan, quota FROM users WHERE email = ?").bind(email).first<{ email: string; plan: string; quota: number }>();
  return json({ ok: true, user: updated });
}

// Organizer (host) org profile — account-level, reused across all their hackathons.
async function getOrgProfile(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  if (!user) return json({ error: "未登录 / Not logged in" }, 401);
  const row = await env.DB.prepare(
    "SELECT org_name, org_intro, org_url, org_contact, org_logo FROM users WHERE email = ?",
  )
    .bind(user.email)
    .first<{ org_name: string | null; org_intro: string | null; org_url: string | null; org_contact: string | null; org_logo: string | null }>();
  return json({
    orgName: row?.org_name ?? "",
    orgIntro: row?.org_intro ?? "",
    orgUrl: row?.org_url ?? "",
    orgContact: row?.org_contact ?? "",
    orgLogo: row?.org_logo ?? "",
  });
}

async function saveOrgProfile(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  if (!user) return json({ error: "未登录 / Not logged in" }, 401);
  const body = await request
    .json<{ orgName?: string; orgIntro?: string; orgUrl?: string; orgContact?: string; orgLogo?: string }>()
    .catch(() => null);
  const clip = (v: unknown, n: number) => String(v ?? "").trim().slice(0, n) || null;
  const orgName = clip(body?.orgName, 80);
  const orgIntro = clip(body?.orgIntro, 500);
  const orgUrl = clip(body?.orgUrl, 200);
  if (orgUrl && !isHttpUrl(orgUrl)) return json({ error: "网址需以 http(s):// 开头 / URL must start with http(s)://" }, 400);
  const orgContact = clip(body?.orgContact, 120);
  // Logo: optional, must be a small transparent PNG data URI (client resizes to 180×180).
  let orgLogo: string | null = null;
  const rawLogo = String(body?.orgLogo ?? "");
  if (rawLogo) {
    if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(rawLogo) || rawLogo.length > 120_000) {
      return json({ error: "Logo 需为 PNG,且不超过大小上限 / Logo must be a PNG within the size limit" }, 400);
    }
    orgLogo = rawLogo;
  }
  await env.DB.prepare("INSERT OR IGNORE INTO users (email, quota, plan, created_at) VALUES (?, 1, 'free', ?)")
    .bind(user.email, unixNow())
    .run();
  await env.DB.prepare("UPDATE users SET org_name = ?, org_intro = ?, org_url = ?, org_contact = ?, org_logo = ? WHERE email = ?")
    .bind(orgName, orgIntro, orgUrl, orgContact, orgLogo, user.email)
    .run();
  return json({ ok: true });
}

// Serve a tenant's organizer logo (public, cached) so tenant pages can show the host brand.
async function serveOrgLogo(env: Env, sub: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT u.org_logo AS logo FROM tenants t JOIN users u ON u.email = t.owner_email WHERE t.subdomain = ? AND t.status = 'active'",
  )
    .bind(sub)
    .first<{ logo: string | null }>();
  const parsed = row?.logo ? dataUrlToBytes(row.logo) : null;
  if (!parsed) return json({ error: "Not found" }, 404);
  return new Response(parsed.bytes, {
    headers: { "Content-Type": parsed.contentType, ...UPLOAD_SERVE_HEADERS },
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
    // Email not configured OR the provider failed: surface the code ONLY on dev/preview hosts,
    // never on the real product domain. In prod, degrade gracefully (503) instead of crashing (500).
    if (isDevHost(request)) return json({ ok: true, debugCode: code });
    return json({ error: "验证码发送失败,请稍后重试 / Could not send the code, please try again" }, 503);
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

// ---- Participant session (email-verified, per-tenant) ---------------------------------------------
// A participant of a hackathon proves email ownership via a one-time code (reusing the email_codes
// table + Resend), and gets an HMAC-signed cookie scoped to THIS tenant. It grants no organizer
// abilities — it is only an identity so the client can show "your" registration/submission state.
// The cookie is host-only (no Domain attr) so it never leaks across subdomains; the claim also pins
// the tenant id as defence in depth.
type ParticipantAuth = { email: string; tenant: string; exp: number };

async function signParticipant(env: Env, payload: ParticipantAuth): Promise<string> {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await hmacHex(utf8(env.AUTH_SECRET), body);
  return `${body}.${sig}`;
}

function participantCookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? " Secure;" : "";
  return `${PARTICIPANT_COOKIE}=${token}; HttpOnly;${secure} SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function getParticipant(request: Request, env: Env, tid: string | null): Promise<ParticipantAuth | null> {
  const raw = parseCookies(request.headers.get("cookie"))[PARTICIPANT_COOKIE];
  if (!raw || !tid) return null;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = raw.slice(0, dot);
  const expected = await hmacHex(utf8(env.AUTH_SECRET), body);
  if (!timingSafeEqual(raw.slice(dot + 1), expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body)) as ParticipantAuth;
    if (!payload?.email || payload.tenant !== tid || typeof payload.exp !== "number" || payload.exp < unixNow()) return null;
    return payload;
  } catch {
    return null;
  }
}

async function participantLoginRequest(request: Request, env: Env, tenant: Tenant | null): Promise<Response> {
  if (!tenant) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
  const body = await request.json<{ email?: string; turnstileToken?: string }>().catch(() => null);
  const email = normalizeEmail(body?.email);
  if (!email) return json({ error: "邮箱无效 / Invalid email" }, 400);
  const reqIp = request.headers.get("cf-connecting-ip") ?? "local";
  if (!(await verifyTurnstile(env, body?.turnstileToken, reqIp))) {
    return json({ error: "人机验证失败,请重试 / Verification failed" }, 403);
  }
  const now = unixNow();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS c FROM email_codes WHERE email = ? AND created_at > ?")
    .bind(email, now - 15 * 60)
    .first<{ c: number }>();
  if ((recent?.c ?? 0) >= 5) return json({ error: "请求过于频繁,请稍后再试 / Too many requests" }, 429);
  const code = generateCode();
  await env.DB.prepare(
    "INSERT INTO email_codes (id, email, code_hash, request_ip, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), email, await hashSecret(env, `${email}:${code}`), reqIp, now, now + 10 * 60)
    .run();
  const sent = await sendEmailCode(env, email, code);
  if (!sent) {
    if (isDevHost(request)) return json({ ok: true, debugCode: code });
    return json({ error: "验证码发送失败,请稍后重试 / Could not send the code, please try again" }, 503);
  }
  return json({ ok: true });
}

async function participantLoginVerify(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tenant || !tid) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
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
  const consumed = await env.DB.prepare("UPDATE email_codes SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(now, match.id)
    .run();
  if (consumed.meta.changes !== 1) return json({ error: "验证码已被使用 / Code already used" }, 401);
  await env.DB.prepare("UPDATE email_codes SET used_at = ? WHERE email = ? AND used_at IS NULL").bind(now, email).run();
  // Participant session only — NO users insert (that would grant organizer abilities).
  const token = await signParticipant(env, { email, tenant: tid, exp: now + 30 * 24 * 60 * 60 });
  return json({ ok: true, email }, 200, { "Set-Cookie": participantCookie(request, token, 30 * 24 * 60 * 60) });
}

function participantLogout(request: Request): Response {
  return json({ ok: true }, 200, { "Set-Cookie": participantCookie(request, "", 0) });
}

// The logged-in participant's own state on this tenant: are they registered, and their submission.
async function participantMe(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  const me = await getParticipant(request, env, tid);
  if (!me || !tid) return json({ email: null });
  const reg = await env.DB.prepare("SELECT name, note, created_at FROM registrations WHERE tenant_id = ? AND email = ? LIMIT 1")
    .bind(tid, me.email)
    .first<{ name: string; note: string | null; created_at: number }>();
  const sub = await env.DB.prepare(
    "SELECT id, project_name, repo_url, link_url, build_state, share_token, created_at FROM submissions WHERE tenant_id = ? AND email = ? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(tid, me.email)
    .first<{ id: string; project_name: string; repo_url: string | null; link_url: string | null; build_state: string | null; share_token: string; created_at: number }>();
  return json({
    email: me.email,
    registered: Boolean(reg),
    registration: reg ? { name: reg.name, note: reg.note, at: reg.created_at } : null,
    submission: sub
      ? { id: sub.id, projectName: sub.project_name, repoUrl: sub.repo_url, linkUrl: sub.link_url, buildState: sub.build_state, viewUrl: `/s/${sub.id}`, at: sub.created_at }
      : null,
  });
}

// Auto-pick a clean subdomain for mini's 5-minute flow (only the name is asked). Prefer the bare
// slug (`team-building`), then `-2`, `-3`… on collision, and only fall back to a random suffix if
// every numbered variant up to 20 is taken. Guarantees a valid (3–30, non-reserved, unused) result.
async function pickAvailableSubdomain(env: Env, base: string): Promise<string> {
  const clip = (s: string) => s.slice(0, 30).replace(/-+$/, "");
  const isFree = async (sub: string): Promise<boolean> => {
    if (sub.length < 3 || RESERVED_SUBDOMAINS.has(sub)) return false;
    const taken = await env.DB.prepare("SELECT id FROM tenants WHERE subdomain = ?").bind(sub).first();
    return !taken;
  };
  const root = clip(base) || "mini";
  if (await isFree(root)) return root;
  for (let n = 2; n <= 20; n++) {
    const cand = clip(`${base.slice(0, 27)}-${n}`);
    if (await isFree(cand)) return cand;
  }
  return clip(`${base.slice(0, 25)}-${randomCodeBody(4).toLowerCase()}`);
}

async function createHackathon(request: Request, env: Env): Promise<Response> {
  const user = await getUser(request, env);
  if (!user) return json({ error: "请先登录 / Please log in" }, 401);
  const body = await request.json<{ name?: string; subdomain?: string; intro?: string; banner?: string; mode?: string; accessDays?: number }>().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 60);
  const mode = body?.mode === "secret" ? "secret" : body?.mode === "mini" ? "mini" : "open";
  // Mini is a 5-minute flow: auto-generate a subdomain from the name if none given.
  let subdomain = String(body?.subdomain ?? "").trim().toLowerCase();
  if (mode === "mini" && !subdomain) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "mini";
    subdomain = await pickAvailableSubdomain(env, slug);
  }
  const intro = String(body?.intro ?? "").trim().slice(0, 2000);
  const accessDays = mode === "secret" ? Math.min(90, Math.max(1, Math.floor(Number(body?.accessDays) || 7))) : 7;
  if (!name) return json({ error: "请填写黑客松名称 / Name required" }, 400);
  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(subdomain)) {
    return json({ error: "子域名需 3-30 位小写字母/数字/连字符 / Invalid subdomain" }, 400);
  }
  if (RESERVED_SUBDOMAINS.has(subdomain)) return json({ error: "该子域名被保留 / Reserved subdomain" }, 400);
  // Mini is a 5-minute flow — intro optional (a default is used); other modes require an intro.
  const finalIntro = mode === "mini" && intro.length < 10 ? `${name} —— AI 驱动的 mini 黑客松:一句想法,AI 帮你自动做成能跑的应用` : intro;
  if (mode !== "mini" && intro.length < 10) return json({ error: "请写一段黑客松简介(至少 10 字)/ Add an intro (10+ chars)" }, 400);
  // Banner is optional — if omitted, the homepage shows a generated default. If provided it must be
  // a small raster image (no SVG, to avoid stored-XSS when the blob is fetched directly).
  let bannerParsed: { contentType: string; bytes: Uint8Array } | null = null;
  if (body?.banner) {
    bannerParsed = dataUrlToBytes(String(body.banner));
    if (!bannerParsed || !isRasterImage(bannerParsed.contentType)) {
      return json({ error: "Banner 需为图片(PNG/JPG),不支持 SVG / Banner must be a raster image" }, 400);
    }
    if (bannerParsed.bytes.byteLength > 160 * 1024) return json({ error: "banner 图过大(≤120KB)/ Banner too large" }, 400);
  }

  const taken = await env.DB.prepare("SELECT id FROM tenants WHERE subdomain = ?").bind(subdomain).first();
  if (taken) return json({ error: "子域名已被占用 / Subdomain taken" }, 409);

  const urow = await env.DB.prepare("SELECT quota, plan FROM users WHERE email = ?").bind(user.email).first<{ quota: number; plan: string }>();
  const quota = urow?.quota ?? 1;
  // Paid accounts (grant manually via `UPDATE users SET plan='paid' WHERE email=?`) bypass every free-tier
  // limit: unlimited secret + mini + regular. Free accounts keep the free tiers below.
  const paid = urow?.plan === "paid";
  if (!paid) {
    if (mode === "secret") {
      // Enterprise secret hackathon is paid-only — no free tier.
      return json({ error: "企业私密黑客松需付费账户,请购买后开通 / Enterprise secret hackathon requires a paid account", upgrade: true }, 402);
    } else if (mode === "mini") {
      // Mini has its own free allowance (1 per person), separate from the regular quota. Post-paid after.
      const miniUsed = await env.DB.prepare("SELECT COUNT(*) AS c FROM tenants WHERE owner_email = ? AND mode = 'mini' AND status = 'active'")
        .bind(user.email)
        .first<{ c: number }>();
      if ((miniUsed?.c ?? 0) >= 1) {
        return json({ error: "mini 免费额度已用完(每人 1 场)。充值或由赞助商代付后可继续 / Free mini used — top up or get a sponsor", upgrade: true }, 402);
      }
    } else {
      const used = await env.DB.prepare("SELECT COUNT(*) AS c FROM tenants WHERE owner_email = ? AND status = 'active' AND mode != 'mini'")
        .bind(user.email)
        .first<{ c: number }>();
      if ((used?.c ?? 0) >= quota) {
        return json({ error: `已达免费额度(${quota} 场)。充值 ¥99 可举办 100 场 / Quota reached — upgrade for 100`, upgrade: true }, 402);
      }
    }
  }

  const adminPass = `hack5-${randomCodeBody(8).toLowerCase()}`;
  const now = unixNow();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO tenants (id, subdomain, name, admin_pass_hash, creator_email, owner_email, intro, mode, access_days, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
  )
    .bind(id, subdomain, name, await hashSecret(env, adminPass), user.email, user.email, finalIntro, mode, accessDays, now, now)
    .run();

  // Close the quota race deterministically: recount after insert and roll back if a concurrent
  // create pushed this one past the limit (regular/secret share the quota; mini has its own free=1).
  // Paid accounts have no limit, so nothing to roll back.
  if (paid) {
    // no-op: unlimited
  } else if (mode === "mini") {
    const mine = await env.DB.prepare(
      "SELECT id FROM tenants WHERE owner_email = ? AND status = 'active' AND mode = 'mini' ORDER BY created_at ASC, id ASC",
    )
      .bind(user.email)
      .all<{ id: string }>();
    if (mine.results.findIndex((r) => r.id === id) >= 1) {
      await env.DB.prepare("DELETE FROM tenants WHERE id = ?").bind(id).run();
      return json({ error: "mini 免费额度已用完(每人 1 场)。充值或由赞助商代付后可继续 / Free mini used", upgrade: true }, 402);
    }
  } else {
    const owned = await env.DB.prepare(
      "SELECT id FROM tenants WHERE owner_email = ? AND status = 'active' AND mode != 'mini' ORDER BY created_at ASC, id ASC",
    )
      .bind(user.email)
      .all<{ id: string }>();
    if (owned.results.findIndex((r) => r.id === id) >= quota) {
      await env.DB.prepare("DELETE FROM tenants WHERE id = ?").bind(id).run();
      return json({ error: `已达免费额度(${quota} 场)。充值 ¥99 可举办 100 场 / Quota reached`, upgrade: true }, 402);
    }
  }

  // Auto-provision the subdomain DNS so <sub>.hack5.net resolves. Roll back the tenant if it fails.
  const dnsErr = await createSubdomainDns(env, subdomain);
  if (dnsErr) {
    await env.DB.prepare("DELETE FROM tenants WHERE id = ?").bind(id).run();
    return json({ error: "子域名配置失败,请重试 / Subdomain setup failed", detail: dnsErr }, 502);
  }

  // Store the banner now that the tenant is confirmed (survived quota + DNS); flag only after it lands.
  if (bannerParsed) {
    await env.SHOTS.put(`banner:${id}`, bannerParsed.bytes, { metadata: { contentType: bannerParsed.contentType } });
    await env.DB.prepare("UPDATE tenants SET banner = '1' WHERE id = ?").bind(id).run();
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
  // Best-effort: the admin password is also shown on-screen, so a mail failure must not break
  // (or roll back) hackathon creation. Log and move on.
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.MAIL_FROM || "hack5 <no-reply@hack5.net>", to: [email], subject: `‹5› 你的黑客松「${name}」已就绪`, text, html }),
    });
    if (!res.ok) console.log("ready-email send failed", res.status, (await res.text().catch(() => "")).slice(0, 200));
  } catch (err) {
    console.log("ready-email fetch error", String(err));
  }
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
    // Never throw: a provider error (e.g. rate limit, invalid recipient) must degrade to the
    // caller's graceful path (debugCode on dev / "try again" in prod), not crash login with a 500.
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM || "hack5 <no-reply@hack5.net>", to: [email], subject: "‹5› hack5 登录验证码 · 10 分钟发起你的黑客松", text, html }),
      });
      if (!res.ok) {
        console.log("resend send failed", res.status, (await res.text().catch(() => "")).slice(0, 200));
        return false;
      }
      return true;
    } catch (err) {
      console.log("resend fetch error", String(err));
      return false;
    }
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
  const email = normalizeEmail(body?.email);
  if (!email) return json({ error: "邮箱无效 / Invalid email" }, 400);
  const note = String(body?.note ?? "").trim().slice(0, 300) || null;
  // Mini keeps registration frictionless (it targets non-developers): email only, with the display
  // name derived from the email local part. Other modes still require an explicit name.
  let name = String(body?.name ?? "").trim().slice(0, 60);
  if (!name && tenant.mode === "mini") name = (email.split("@")[0] || "").slice(0, 60);
  if (!name) return json({ error: "请填写姓名 / Name required" }, 400);

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

// ---- secret-mode access gate ----
// Redeem a single-use access code (reuses invite_codes) into a time-boxed access session cookie.
async function redeemAccess(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tenant || !tid) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
  if (tenant.mode !== "secret") return json({ ok: true, open: true });
  const body = await request.json<{ code?: string }>().catch(() => null);
  const code = String(body?.code ?? "").trim();
  if (!code) return json({ error: "请输入访问码 / Access code required" }, 400);
  const now = unixNow();
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const rlKey = `access-rl:${tid}:${ip}`;
  const attempts = Number((await env.SHOTS.get(rlKey)) ?? "0");
  if (attempts >= 10) return json({ error: "尝试过于频繁,请稍后再试 / Too many attempts" }, 429);
  const consumed = await env.DB.prepare(
    "UPDATE invite_codes SET used_by = 'access', used_at = ? WHERE code = ? AND tenant_id = ? AND used_by IS NULL",
  )
    .bind(now, code, tid)
    .run();
  if (consumed.meta.changes !== 1) {
    await env.SHOTS.put(rlKey, String(attempts + 1), { expirationTtl: 3600 });
    return json({ error: "访问码无效或已被使用 / Invalid or already used" }, 403);
  }
  const days = tenant.access_days && tenant.access_days > 0 ? tenant.access_days : 7;
  const token = await signAccessToken(env, { tenant: tid, exp: now + days * 86400 });
  return json({ ok: true, days }, 200, { "Set-Cookie": accessCookie(request, token, days * 86400) });
}

// Judge roster (name + GitHub, NO codes) so participants know who to add as private-repo collaborators.
async function judgeRoster(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tenant || !tid) return json({ error: "Not found" }, 404);
  if (!(await hasSecretAccess(request, env, tenant))) return json({ error: "需要访问码 / Access required" }, 403);
  const rows = await env.DB.prepare("SELECT name, github_user FROM judges WHERE tenant_id = ? ORDER BY created_at ASC")
    .bind(tid)
    .all<{ name: string; github_user: string | null }>();
  return json({ judges: rows.results.map((r) => ({ name: r.name, github: r.github_user ?? "" })) });
}

// ---- team formation: "looking for teammates" board ----
async function createTeamPost(request: Request, env: Env, tenant: Tenant | null): Promise<Response> {
  if (!tenant) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
  const body = await request
    .json<{ name?: string; contact?: string; skills?: string; lookingFor?: string; idea?: string }>()
    .catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 40);
  const contact = String(body?.contact ?? "").trim().slice(0, 80);
  const skills = String(body?.skills ?? "").trim().slice(0, 120) || null;
  const lookingFor = String(body?.lookingFor ?? "").trim().slice(0, 120) || null;
  const idea = String(body?.idea ?? "").trim().slice(0, 300) || null;
  if (!name) return json({ error: "请填写昵称 / Name required" }, 400);
  if (!contact) return json({ error: "请填写联系方式 / Contact required" }, 400);

  const now = unixNow();
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const total = await env.DB.prepare("SELECT COUNT(*) AS c FROM team_posts WHERE tenant_id = ?")
    .bind(tenant.id)
    .first<{ c: number }>();
  if ((total?.c ?? 0) >= 500) return json({ error: "组队墙已满 / Board full" }, 403);
  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS c FROM team_posts WHERE tenant_id = ? AND request_ip = ? AND created_at > ?",
  )
    .bind(tenant.id, ip, now - 60 * 60)
    .first<{ c: number }>();
  if ((recent?.c ?? 0) >= 10) return json({ error: "发布过于频繁,请稍后再试 / Too many posts" }, 429);

  await env.DB.prepare(
    "INSERT INTO team_posts (id, tenant_id, name, contact, skills, looking_for, idea, created_at, request_ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), tenant.id, name, contact, skills, lookingFor, idea, now, ip)
    .run();
  return json({ ok: true });
}

async function listTeamPosts(env: Env, tid: string | null): Promise<Response> {
  if (!tid) return json({ posts: [] });
  const rows = await env.DB.prepare(
    "SELECT id, name, contact, skills, looking_for, idea, created_at FROM team_posts WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 200",
  )
    .bind(tid)
    .all<{ id: string; name: string; contact: string; skills: string | null; looking_for: string | null; idea: string | null; created_at: number }>();
  return json({ posts: rows.results });
}

async function deleteTeamPost(request: Request, env: Env, tenant: Tenant | null, tid: string | null, id: string): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth || !tenant) return json({ error: "Admin only" }, 403);
  await env.DB.prepare("DELETE FROM team_posts WHERE id = ? AND tenant_id = ?").bind(id, tenant.id).run();
  return json({ ok: true });
}

// Premium: generate an AI poster BACKGROUND from a text prompt (gpt-image-1), overlaid with crisp
// event text on the client. Admin-only (it costs money) and metered per tenant per day.
// Free = fixed curated style (we absorb the cost, a few rolls per event); custom = organizer's own
// prompt (the paid tier). Both capped per event for lifetime (KV counter, no expiry).
const AI_POSTER_FREE_CAP = 3;
const AI_POSTER_CUSTOM_CAP = 3;
const freeCapKey = (tid: string) => `aiposter:free:${tid}`;
const customCapKey = (tid: string) => `aiposter:custom:${tid}`;

async function getPosterQuota(request: Request, env: Env, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth || !tid) return json({ error: "Admin only" }, 403);
  const usedFree = Number((await env.SHOTS.get(freeCapKey(tid))) ?? "0");
  const usedCustom = Number((await env.SHOTS.get(customCapKey(tid))) ?? "0");
  return json({
    aiEnabled: Boolean(env.OPENAI_API_KEY),
    free: Math.max(0, AI_POSTER_FREE_CAP - usedFree),
    custom: Math.max(0, AI_POSTER_CUSTOM_CAP - usedCustom),
    freeCap: AI_POSTER_FREE_CAP,
    customCap: AI_POSTER_CUSTOM_CAP,
  });
}

async function generateAiPoster(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth || !tenant) return json({ error: "Admin only" }, 403);
  if (!env.OPENAI_API_KEY) return json({ error: "AI 海报未开通 / AI poster not enabled" }, 503);

  const body = await request.json<{ prompt?: string; mode?: string }>().catch(() => null);
  const mode = body?.mode === "free" ? "free" : "custom";
  const style = String(body?.prompt ?? "").trim().slice(0, 500);
  if (mode === "custom" && !style) return json({ error: "请描述画风 / Describe the style" }, 400);

  // Per-mode lifetime cap per event. Reserve the credit BEFORE calling OpenAI so a rapid burst
  // can't all read used<cap and slip past (KV has no atomic increment). Refunded only when OpenAI
  // never generated (non-2xx / network error = not billed; a success keeps the charge).
  const cap = mode === "free" ? AI_POSTER_FREE_CAP : AI_POSTER_CUSTOM_CAP;
  const capKey = mode === "free" ? freeCapKey(tenant.id) : customCapKey(tenant.id);
  const used = Number((await env.SHOTS.get(capKey)) ?? "0");
  if (used >= cap) {
    return json(
      { error: mode === "free" ? "免费额度已用完 / Free quota used up" : "自定义额度已用完(每场 3 次)/ Custom quota used up" },
      429,
    );
  }
  await env.SHOTS.put(capKey, String(used + 1));
  const refund = () => env.SHOTS.put(capKey, String(used));

  const name = (tenant.name ?? "Hackathon").slice(0, 80);
  const intro = (tenant.intro ?? "").replace(/\s+/g, " ").slice(0, 160);
  const prompt =
    mode === "free"
      ? `Abstract poster BACKGROUND for a hackathon called "${name}".` +
        (intro ? ` Theme: ${intro}.` : "") +
        ` Style: deep indigo-to-black vertical gradient with luminous violet and emerald-green glows,` +
        ` subtle glowing mycelium / network filaments, clean modern, cinematic, high detail, professional.` +
        ` Vertical A4 portrait. IMPORTANT: NO text, letters, numbers or logos anywhere;` +
        ` keep the lower third calmer and darker for text overlay.`
      : `Poster BACKGROUND artwork for a hackathon called "${name}".` +
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
    await refund();
    return json({ error: "AI 服务暂不可用 / AI service unavailable" }, 502);
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    console.log("gpt-image-1 error", resp.status, detail.slice(0, 300));
    await refund();
    return json({ error: "生成失败,请稍后再试 / Generation failed" }, 502);
  }
  const data = await resp.json<{ data?: { b64_json?: string }[] }>().catch(() => null);
  const rawB64 = data?.data?.[0]?.b64_json;
  if (!rawB64) {
    await refund();
    return json({ error: "生成失败 / Generation failed" }, 502);
  }
  // Defensive: guarantee the value is pure base64 so it can't break out of the SVG <image href="...">
  // attribute when the client concatenates it into markup.
  const b64 = rawB64.replace(/[^A-Za-z0-9+/=]/g, "");

  // Credit already reserved up-front; success keeps the charge.
  return json({ image: `data:image/png;base64,${b64}`, mode, remaining: cap - used - 1 });
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

async function servePhoto(request: Request, env: Env, tid: string, id: string): Promise<Response> {
  // Cross-host path-param route: gate secret tenants' photos here (ids are unguessable + the list
  // is gated, but defend in depth anyway).
  const trow = await env.DB.prepare("SELECT mode FROM tenants WHERE id = ?").bind(tid).first<{ mode: string }>();
  if (trow?.mode === "secret" && !(await getAccessSession(request, env, tid)) && !(await getAuth(request, env, tid))) {
    return json({ error: "Not found" }, 404);
  }
  const { value, metadata } = await env.SHOTS.getWithMetadata<{ contentType?: string }>(`photo:${tid}:${id}`, {
    type: "arrayBuffer",
  });
  if (!value) return json({ error: "Not found" }, 404);
  return new Response(value, {
    headers: {
      "Content-Type": metadata?.contentType || "image/jpeg",
      "X-Robots-Tag": "noindex",
      ...UPLOAD_SERVE_HEADERS,
    },
  });
}

// QR code as a crisp SVG (our own trusted markup — just black squares, no script).
function qrSvg(text: string): string {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const cell = 8;
  const margin = 4 * cell;
  const size = n * cell + margin * 2;
  let rects = "";
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (qr.isDark(r, c)) rects += `<rect x="${margin + c * cell}" y="${margin + r * cell}" width="${cell}" height="${cell}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#ffffff"/><g fill="#000000">${rects}</g></svg>`;
}

// Serve a QR of a tenant's URL (public, cached). Self-generated SVG, safe to serve.
async function serveQr(env: Env, sub: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT subdomain FROM tenants WHERE subdomain = ? AND status = 'active'")
    .bind(sub)
    .first<{ subdomain: string }>();
  if (!row) return json({ error: "Not found" }, 404);
  const root = env.ROOT_DOMAIN || "hack5.net";
  return new Response(qrSvg(`https://${row.subdomain}.${root}`), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
}

// Homepage banner: served by subdomain (public, cached), stored in KV as banner:<tid>.
async function serveBanner(request: Request, env: Env, sub: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT id, mode FROM tenants WHERE subdomain = ? AND status = 'active'")
    .bind(sub)
    .first<{ id: string; mode: string }>();
  if (!row) return json({ error: "Not found" }, 404);
  // Path-param route works cross-host, so the central gate can't cover it — gate secret banners here.
  if (row.mode === "secret" && !(await getAccessSession(request, env, row.id)) && !(await getAuth(request, env, row.id))) {
    return json({ error: "Not found" }, 404);
  }
  const { value, metadata } = await env.SHOTS.getWithMetadata<{ contentType?: string }>(`banner:${row.id}`, {
    type: "arrayBuffer",
  });
  if (!value) return json({ error: "Not found" }, 404);
  return new Response(value, {
    headers: { "Content-Type": metadata?.contentType || "image/jpeg", ...UPLOAD_SERVE_HEADERS },
  });
}

async function updateBanner(request: Request, env: Env, tenant: Tenant | null): Promise<Response> {
  const auth = await requireRole(request, env, tenant ? tenant.id : null, "admin");
  if (!auth || !tenant) return json({ error: "Admin only" }, 403);
  const body = await request.json<{ banner?: string }>().catch(() => null);
  const parsed = dataUrlToBytes(String(body?.banner ?? ""));
  if (!parsed || !isRasterImage(parsed.contentType)) return json({ error: "请上传图片 / Image required" }, 400);
  if (parsed.bytes.byteLength > 160 * 1024) return json({ error: "图片过大(≤120KB)/ Too large" }, 400);
  await env.SHOTS.put(`banner:${tenant.id}`, parsed.bytes, { metadata: { contentType: parsed.contentType } });
  await env.DB.prepare("UPDATE tenants SET banner = '1' WHERE id = ?").bind(tenant.id).run();
  return json({ ok: true });
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
    if (!parsed || !isRasterImage(parsed.contentType)) continue;
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

async function listSubmissions(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tid) return json({ submissions: [] });
  // Secret tenants: the work list is gated (participants who passed the gate, judges, admin).
  if (!(await hasSecretAccess(request, env, tenant))) return json({ error: "需要访问码 / Access required" }, 403);
  const secret = tenant?.mode === "secret";
  const rows = await env.DB.prepare(
    "SELECT id, project_name, team_name, repo_owner, repo_name, repo_url, description, video_url, shot_count, locked_sha, created_at, demo_url, link_url, likes, wb_client, wb_project, app_url, build_state FROM submissions WHERE tenant_id = ? AND status = 'ready' ORDER BY created_at DESC LIMIT 300",
  )
    .bind(tid)
    .all<Record<string, unknown>>();
  return json({ submissions: rows.results.map((r) => publicSubmission(r, false, secret)) });
}

async function getSubmission(request: Request, env: Env, tenant: Tenant | null, tid: string | null, id: string): Promise<Response> {
  if (!tid) return json({ error: "Not found" }, 404);
  if (!(await hasSecretAccess(request, env, tenant))) return json({ error: "需要访问码 / Access required" }, 403);
  const row = await env.DB.prepare(
    "SELECT id, project_name, team_name, email, contact, repo_owner, repo_name, repo_url, description, video_url, shot_count, locked_sha, created_at, demo_url, demo_user, demo_pass, readme_md, link_url, likes, wb_client, wb_project, app_url, build_state FROM submissions WHERE id = ? AND tenant_id = ? AND status = 'ready'",
  )
    .bind(id, tid)
    .first<Record<string, unknown>>();
  if (!row) return json({ error: "Not found" }, 404);
  // Contact + demo credentials are for judges/admin only — never expose to anonymous viewers.
  const auth = await getAuth(request, env, tid);
  return json({ submission: publicSubmission(row, Boolean(auth), tenant?.mode === "secret") });
}

function publicSubmission(row: Record<string, unknown>, includeContact: boolean, secret = false) {
  const id = String(row.id);
  const shotCount = Number(row.shot_count ?? 0);
  return {
    id,
    projectName: row.project_name || row.team_name || "未命名作品",
    teamName: row.team_name ?? "",
    email: includeContact ? (row.email ?? null) : null,
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
    linkUrl: row.link_url ?? null,
    likes: Number(row.likes ?? 0),
    // WorkBench build status (A4) — present once a mini idea is sent to "make into app".
    wbClient: row.wb_client ?? null,
    wbProject: row.wb_project ?? null,
    appUrl: row.app_url ?? null,
    buildState: row.build_state ?? null,
    // Secret fields only appear for secret tenants (open-mode responses stay unchanged). Online
    // demo + README show to anyone past the gate; credentials are judges/admin only (like contact).
    ...(secret
      ? {
          secret: true,
          demoUrl: row.demo_url ?? null,
          readmeMd: row.readme_md ?? null,
          demoUser: includeContact ? (row.demo_user ?? null) : null,
          demoPass: includeContact ? (row.demo_pass ?? null) : null,
        }
      : {}),
  };
}

// Like a submission (mini judging only). Deduped per liker (hashed IP) so a browser can't inflate it.
async function likeSubmission(request: Request, env: Env, tenant: Tenant | null, tid: string | null, id: string): Promise<Response> {
  if (!tid || tenant?.mode !== "mini") return json({ error: "Not found" }, 404);
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const liker = await hmacHex(utf8(env.AUTH_SECRET), `like:${ip}`);
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO submission_likes (submission_id, liker, created_at) VALUES (?, ?, ?)")
    .bind(id, liker, unixNow())
    .run();
  // Derive the counter from the dedup table so it can never drift (self-healing, no lost-update race).
  await env.DB.prepare(
    "UPDATE submissions SET likes = (SELECT COUNT(*) FROM submission_likes WHERE submission_id = ?) WHERE id = ? AND tenant_id = ?",
  )
    .bind(id, id, tid)
    .run();
  const row = await env.DB.prepare("SELECT likes FROM submissions WHERE id = ? AND tenant_id = ?").bind(id, tid).first<{ likes: number }>();
  return json({ ok: true, likes: row?.likes ?? 0, liked: ins.meta.changes === 1 });
}

// Mini AI assist: write a one-line project description from the name/link (cheap gpt-4o-mini).
async function miniAssist(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tenant || tenant.mode !== "mini" || !tid) return json({ error: "Not found" }, 404);
  if (!env.OPENAI_API_KEY) return json({ error: "AI 未开通 / AI not enabled" }, 503);
  const body = await request.json<{ name?: string; link?: string }>().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 120);
  const link = String(body?.link ?? "").trim().slice(0, 300);
  if (!name && !link) return json({ error: "请先填作品名或链接 / Add a name or link first" }, 400);
  const day = Math.floor(unixNow() / 86400);
  const capKey = `miniassist:${tid}:${day}`;
  const used = Number((await env.SHOTS.get(capKey)) ?? "0");
  if (used >= 60) return json({ error: "今日 AI 次数已用完 / Daily AI limit reached" }, 429);
  await env.SHOTS.put(capKey, String(used + 1), { expirationTtl: 2 * 86400 });
  const prompt =
    `为一个黑客松作品写一句话中文简介(不超过 80 字,亲切、具体、不浮夸)。作品名:${name || "(未命名)"}。` +
    (link ? `作品链接:${link}。` : "") +
    ` 只输出简介本身,不要引号、不要前缀。`;
  let resp: Response;
  try {
    resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 160, temperature: 0.7 }),
    });
  } catch {
    return json({ error: "AI 暂不可用 / AI unavailable" }, 502);
  }
  if (!resp.ok) {
    console.log("mini assist error", resp.status, (await resp.text().catch(() => "")).slice(0, 200));
    return json({ error: "生成失败,请稍后再试 / Generation failed" }, 502);
  }
  const data = await resp.json<{ choices?: { message?: { content?: string } }[] }>().catch(() => null);
  const text = String(data?.choices?.[0]?.message?.content ?? "").trim().slice(0, 300);
  if (!text) return json({ error: "生成失败 / Failed" }, 502);
  return json({ ok: true, text });
}

// WorkBench client smoke test — exercises all 8 contract-v2 functions against the mock and
// returns their shapes. Strictly gated on WORKBENCH_MOCK=1 so it is a no-op (404) in production;
// it lets `wrangler dev` self-test the client module (A1) with no server. Not tenant-scoped.
async function wbSelftest(env: Env): Promise<Response> {
  if (env.WORKBENCH_MOCK !== "1") return json({ error: "Not found" }, 404);
  const wb = createWorkbench(env);
  const { client } = await wb.createClient({ name: "Demo Hackathon", background: "mini" });
  const { project } = await wb.createProject(client.slug, { name: "邻里团购小工具", deliverableName: "app", deliverableType: "web" });
  const chatShort = await wb.chat({ clientSlug: client.slug, projectSlug: project.slug, input: "帮小区做团购" });
  const chatLong = await wb.chat({
    clientSlug: client.slug,
    projectSlug: project.slug,
    input: "帮我小区做一个团购小工具:邻居可以发起团购、其他人一键跟团、到量自动通知团长联系供应商,手机上用,界面简单亲切,不要注册。",
  });
  const commit = await wb.commit({ clientSlug: client.slug, projectSlug: project.slug, push: true, repo: "https://github.com/hack5-mini-bot/demo.git" });
  const { jobId } = await wb.plan({ clientSlug: client.slug, projectSlug: project.slug, repo: "https://github.com/hack5-mini-bot/demo.git" });
  const run = await wb.run(jobId);
  const status = await wb.status(jobId);
  const usage = await wb.usage(client.slug);
  // B3 scoped chat token — decode the payload to prove it matches WorkBench verifyScopedToken
  // (claim {client,project,exp}; token = base64url(payload).base64url(hmac)). Token value itself omitted.
  const scoped = await mintScopedChatToken(env, client.slug, project.slug, 3600);
  const [scopedPayload, scopedSig] = scoped.split(".");
  const scopedClaim = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(scopedPayload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
  return json({
    ok: true,
    mock: wb.mock,
    workbenchMockEnabled: workbenchMockEnabled(env),
    client,
    project,
    chatShort: chatShort.result.readiness,
    chatLong: chatLong.result.readiness,
    commit,
    plan: { jobId },
    run,
    status,
    usage,
    scopedToken: { format: "base64url(payloadJson).base64url(hmac_sha256(payloadBytes))", claim: scopedClaim, payloadLen: scopedPayload.length, sigLen: scopedSig.length },
  });
}

// Participant repo provisioning smoke test — validates the B2 whitelist and runs a mock
// create → mint repo-scoped push token → delete round-trip. Strictly gated on WORKBENCH_MOCK=1
// (404 in production). Never returns the token itself, only proof-of-shape (length), to keep the
// "tokens never leak to logs/responses" discipline visible. Not tenant-scoped.
async function repoSelftest(env: Env): Promise<Response> {
  if (env.WORKBENCH_MOCK !== "1") return json({ error: "Not found" }, 404);
  // Whitelist: these must all be rejected.
  const badNames = ["", "UPPER", "-lead", "trailing-", "has_underscore", "a/b", "空格 name", "x".repeat(40), "汉字名"];
  const rejected = badNames.map((n) => ({ name: n, ok: validateRepoName(n).ok }));
  const allRejected = rejected.every((r) => r.ok === false);
  // Whitelist: these must all be accepted.
  const goodNames = ["a", "app1", "neighborhood-groupbuy", "x".repeat(39)];
  const accepted = goodNames.map((n) => ({ name: n.length > 12 ? n.slice(0, 6) + "…(" + n.length + ")" : n, ok: validateRepoName(n).ok }));
  const allAccepted = accepted.every((r) => r.ok === true);

  // Mock create → token → delete round-trip.
  const repo = await createParticipantRepo(env, "neighborhood-groupbuy", { description: "mini demo" });
  const push = await mintRepoScopedPushToken(env, repo.name);
  const del = await deleteParticipantRepo(env, repo.name);
  return json({
    ok: allRejected && allAccepted && del.deleted,
    mock: repoBotMockEnabled(env),
    whitelist: { allRejected, allAccepted, rejected, accepted },
    repo,
    pushToken: { repository: push.repository, expiresAt: push.expiresAt, mock: push.mock, tokenLen: push.token.length }, // token value intentionally omitted
    deleted: del,
  });
}

// ============================ WorkBench build-status (A4) ============================

// Build state machine (contract §5 v2). Stored fine-grained; the UI buckets it into 4 badges.
type BuildState = "queued" | "planning" | "coding" | "reviewing" | "deployed" | "failed";
const BUILD_STATE_RANK: Record<BuildState, number> = { queued: 0, planning: 1, coding: 2, reviewing: 3, deployed: 4, failed: 4 };

// W5 callback events → build state. `failed` may arrive at any point; `deployed` is terminal-success.
function wbEventToBuildState(event: string): BuildState | null {
  switch (event) {
    case "loop_ready":
      return "coding"; // spec is ready and coding has begun
    case "coding_done":
      return "reviewing";
    case "deployed":
      return "deployed";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

// W5 callback receiver (C2): WorkBench notifies hack5 of build progress. Body is HMAC-signed with
// WORKBENCH_CALLBACK_SECRET (hex SHA-256 over the raw body, header `x-workbench-signature`) so a
// deployed/failed event can't be forged. Not tenant-scoped; the submission is located by its
// (wb_client, wb_project) pair. State only advances (monotonic) except `failed`, which always wins —
// this also makes retried/out-of-order callbacks idempotent.
async function wbCallback(request: Request, env: Env): Promise<Response> {
  const secret = env.WORKBENCH_CALLBACK_SECRET;
  if (!secret) return json({ error: "callback not configured" }, 503);
  const raw = await request.text();
  const sig = request.headers.get("x-workbench-signature") ?? "";
  const expected = await hmacHex(utf8(secret), raw);
  // WorkBench signs with a `sha256=` prefix (Self-FDE-WorkBench#35); strip it before comparing.
  const provided = sig.startsWith("sha256=") ? sig.slice(7) : sig;
  if (!provided || !timingSafeEqual(provided.toLowerCase(), expected)) return json({ error: "bad signature" }, 401);
  const body = (() => {
    try {
      return JSON.parse(raw) as { event?: string; clientSlug?: string; projectSlug?: string; repo?: string; appUrl?: string };
    } catch {
      return null;
    }
  })();
  if (!body) return json({ error: "Invalid JSON" }, 400);
  const state = wbEventToBuildState(String(body.event ?? ""));
  if (!state) return json({ error: "unknown event" }, 400);
  const clientSlug = String(body.clientSlug ?? "").trim();
  const projectSlug = String(body.projectSlug ?? "").trim();
  if (!clientSlug || !projectSlug) return json({ error: "clientSlug and projectSlug required" }, 400);
  const row = await env.DB.prepare("SELECT id, build_state FROM submissions WHERE wb_client = ? AND wb_project = ? LIMIT 1")
    .bind(clientSlug, projectSlug)
    .first<{ id: string; build_state: string | null }>();
  if (!row) return json({ error: "submission not found for client/project" }, 404);
  // Monotonic: state only advances. `failed` applies unless the build already reached the terminal
  // `deployed` — a stale/out-of-order `failed` must not un-deploy a live app. Makes retries idempotent.
  const current = row.build_state as BuildState | null;
  const advance = !current || (state === "failed" ? current !== "deployed" : BUILD_STATE_RANK[state] >= BUILD_STATE_RANK[current]);
  if (advance) {
    // Signed (trusted) source, but validate scheme as defense-in-depth so only http(s) URLs are stored/rendered.
    const appUrl = body.appUrl && isHttpUrl(body.appUrl) ? body.appUrl : null;
    const repo = body.repo && isHttpUrl(body.repo) ? body.repo : "";
    await env.DB.prepare("UPDATE submissions SET build_state = ?, app_url = COALESCE(?, app_url), repo_url = CASE WHEN ? <> '' THEN ? ELSE repo_url END, updated_at = ? WHERE id = ?")
      .bind(state, appUrl, repo, repo, unixNow(), row.id)
      .run();
  }
  return json({ ok: true, id: row.id, state: advance ? state : current, applied: advance });
}

// Callback smoke test — mock-gated (404 in production); verifies the event→state mapping + badge
// buckets without needing a signed request or a DB row.
async function callbackSelftest(env: Env): Promise<Response> {
  if (env.WORKBENCH_MOCK !== "1") return json({ error: "Not found" }, 404);
  const mapping = ["loop_ready", "coding_done", "deployed", "failed", "bogus"].map((e) => ({ event: e, state: wbEventToBuildState(e) }));
  const ok = mapping.filter((m) => m.event !== "bogus").every((m) => m.state !== null) && mapping.find((m) => m.event === "bogus")?.state === null;
  return json({ ok, mapping });
}

// ============================ A3 — mini「做成应用」入口 ============================

// Multi-turn chat with WorkBench (fde-copilot). On the first call we create the client (hackathon)
// + project (idea); subsequent calls pass their slugs back. chat carries the hack5-signed scoped
// token (B3). Returns readiness (score, loop_ready) so the UI can show progress toward "ready".
// Best-effort daily counter in KV (same read-modify-write pattern as miniAssist). false → over cap.
async function bumpDailyCap(env: Env, key: string, cap: number, ttlDays = 2): Promise<boolean> {
  const used = Number((await env.SHOTS.get(key)) ?? "0");
  if (used >= cap) return false;
  await env.SHOTS.put(key, String(used + 1), { expirationTtl: ttlDays * 86400 });
  return true;
}

// Parse a positive-integer cap from an env string, falling back to a default when unset/invalid.
function capNum(v: string | undefined, def: number): number {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

async function miniAppChat(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tenant || tenant.mode !== "mini" || !tid) return json({ error: "Not found" }, 404);
  // Public/anonymous mini: bound WorkBench LLM cost with per-IP + per-tenant daily caps.
  const day = Math.floor(unixNow() / 86400);
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const ipHash = (await hmacHex(utf8(env.AUTH_SECRET), `miniappip:${ip}`)).slice(0, 24);
  if (!(await bumpDailyCap(env, `miniapp:chat:${tid}:ip:${ipHash}:${day}`, 40))) return json({ error: "今日对话次数已达上限,请明天再来 / Daily chat limit reached" }, 429);
  if (!(await bumpDailyCap(env, `miniapp:chat:${tid}:${day}`, 400))) return json({ error: "本场今日对话已达上限 / Event daily chat limit reached" }, 429);
  // Absolute platform-wide backstop: caps total LLM spend even if an attacker spreads across many
  // tenants/IPs. Per-IP + per-tenant caps above bound a single source; this bounds the whole day.
  if (!(await bumpDailyCap(env, `miniapp:chat:global:${day}`, capNum(env.MINIAPP_CHAT_GLOBAL_CAP, 3000)))) return json({ error: "系统今日对话已达上限,请明天再来 / Service daily chat limit reached" }, 429);
  const body = await request.json<{ clientSlug?: string; projectSlug?: string; input?: string; projectName?: string }>().catch(() => null);
  const input = String(body?.input ?? "").trim().slice(0, 1000);
  if (!input) return json({ error: "请说说你的想法 / Describe your idea" }, 400);
  const wb = createWorkbench(env);
  let clientSlug = String(body?.clientSlug ?? "").trim();
  let projectSlug = String(body?.projectSlug ?? "").trim();
  try {
    if (!clientSlug) {
      // One WorkBench client per hackathon (tenant) — reuse it rather than creating one per chat.
      const cached = await env.SHOTS.get(`miniapp:wbclient:${tid}`);
      if (cached) {
        clientSlug = cached;
      } else {
        const c = await wb.createClient({ name: tenant.name || tenant.subdomain, background: "hack5 mini hackathon" });
        clientSlug = c.client.slug;
        await env.SHOTS.put(`miniapp:wbclient:${tid}`, clientSlug, { expirationTtl: 30 * 86400 });
      }
    }
    if (!projectSlug) {
      // One WorkBench client is shared per hackathon, so a project name derived from the idea text
      // collides across participants who phrase the same idea — WorkBench then 400s "already exists"
      // and the turn 502s. Append a short random suffix so each new conversation gets its own project;
      // the returned projectSlug is echoed back to the client and reused on subsequent turns.
      const base = String(body?.projectName ?? input).trim().slice(0, 32) || "idea";
      const pname = `${base} ${randomCodeBody(4).toLowerCase()}`.slice(0, 40);
      const p = await wb.createProject(clientSlug, { name: pname, deliverableName: "app", deliverableType: "web" });
      projectSlug = p.project.slug;
    }
    const scoped = await mintScopedChatToken(env, clientSlug, projectSlug);
    const res = await wb.chat({ clientSlug, projectSlug, input }, { scopedToken: scoped });
    return json({ ok: true, clientSlug, projectSlug, readiness: res.result.readiness, reply: res.result.reply ?? "" });
  } catch {
    return json({ error: "WorkBench 暂不可用,请稍后再试 / WorkBench unavailable" }, 502);
  }
}

// Once the spec is loop_ready: create the participant's public repo (B2), push the spec, and
// enqueue the coding loop. Records/refreshes the participant's submission (email-hash identity)
// with the WorkBench link + build_state='queued' so it appears on the wall with a build badge.
async function miniAppLaunch(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tenant || tenant.mode !== "mini" || !tid) return json({ error: "Not found" }, 404);
  const body = await request.json<{ clientSlug?: string; projectSlug?: string; repoName?: string; projectName?: string; email?: string; idea?: string }>().catch(() => null);
  const clientSlug = String(body?.clientSlug ?? "").trim();
  const projectSlug = String(body?.projectSlug ?? "").trim();
  const email = normalizeEmail(body?.email);
  const idea = String(body?.idea ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  const projectName = (String(body?.projectName ?? "").trim().slice(0, 80) || projectSlug).slice(0, 80);
  if (!clientSlug || !projectSlug) return json({ error: "请先完成对话 / Complete the chat first" }, 400);
  if (!email) return json({ error: "请填写有效邮箱 / Valid email required" }, 400);
  const nameCheck = validateRepoName(body?.repoName);
  if (!nameCheck.ok || !nameCheck.name) return json({ error: nameCheck.error || "仓库名不合法 / Invalid repo name" }, 400);
  const repoName = nameCheck.name;

  // Identity-independent abuse caps. `email` below is attacker-controllable and unverified, so the
  // per-email free quota alone can't bound how many real GitHub repos + coding-loop runs get created
  // (rotate the email string -> unlimited). These per-IP / per-tenant / global daily ceilings bound
  // the blast radius regardless of email. Counted per attempt (before provisioning) so retries can't
  // bypass them. Tunable via MINIAPP_LAUNCH_*_CAP.
  const day = Math.floor(unixNow() / 86400);
  const ip = request.headers.get("cf-connecting-ip") ?? "local";
  const ipHash = (await hmacHex(utf8(env.AUTH_SECRET), `miniappip:${ip}`)).slice(0, 24);
  if (!(await bumpDailyCap(env, `miniapp:launch:ip:${ipHash}:${day}`, capNum(env.MINIAPP_LAUNCH_IP_CAP, 3)))) return json({ error: "今日生成次数已达上限,请明天再来 / Daily build limit reached" }, 429);
  if (!(await bumpDailyCap(env, `miniapp:launch:t:${tid}:${day}`, capNum(env.MINIAPP_LAUNCH_TENANT_CAP, 10)))) return json({ error: "本场今日生成已达上限 / Event daily build limit reached" }, 429);
  if (!(await bumpDailyCap(env, `miniapp:launch:global:${day}`, capNum(env.MINIAPP_LAUNCH_GLOBAL_CAP, 30)))) return json({ error: "系统今日生成已达上限,请明天再来 / Service daily build limit reached" }, 429);

  const owner = "mini";
  const repoKey = (await hmacHex(utf8(env.AUTH_SECRET), `mini:${email}`)).slice(0, 40);
  // Per-participant free quota: mini gives 1 free build per email; beyond that requires payment
  // (anonymous mini has no login, so email is the identity — same key as the submission identity).
  const launchKey = `miniapp:launch:${tid}:${repoKey}`;
  const launched = Number((await env.SHOTS.get(launchKey)) ?? "0");
  const FREE_LAUNCHES = 1;
  if (launched >= FREE_LAUNCHES) {
    return json({ error: "免费额度已用完(每人首场免费),请充值后再生成 / Free quota used — top up to build more", pricingUrl: "/pricing" }, 402);
  }

  const wb = createWorkbench(env);
  let repo, jobId: string, queuePos: number;
  try {
    repo = await createParticipantRepo(env, repoName, { description: idea || projectName });
    // B2: mint a repo-scoped, short-lived push token and hand it only to the commit/push boundary.
    const push = await mintRepoScopedPushToken(env, repoName);
    await wb.commit({ clientSlug, projectSlug, push: true, repo: repo.cloneUrl, pushToken: push.token });
    jobId = (await wb.plan({ clientSlug, projectSlug, repo: repo.cloneUrl })).jobId;
    queuePos = (await wb.run(jobId)).queuePos;
  } catch {
    return json({ error: "建仓或触发编码失败,请稍后再试 / Provisioning failed" }, 502);
  }
  // Count this build against the participant's quota only after successful provisioning.
  await env.SHOTS.put(launchKey, String(launched + 1), { expirationTtl: 400 * 86400 });

  const now = unixNow();
  const existing = await env.DB.prepare("SELECT id, edit_token FROM submissions WHERE tenant_id = ? AND repo_owner = ? AND repo_name = ?")
    .bind(tid, owner, repoKey)
    .first<{ id: string; edit_token: string }>();
  let id: string, editToken: string;
  if (existing) {
    id = existing.id;
    editToken = existing.edit_token;
    await env.DB.prepare("UPDATE submissions SET project_name = ?, email = ?, link_url = ?, description = ?, repo_url = ?, wb_client = ?, wb_project = ?, build_state = 'queued', updated_at = ? WHERE id = ?")
      .bind(projectName, email, repo.htmlUrl, idea, repo.htmlUrl, clientSlug, projectSlug, now, id)
      .run();
  } else {
    id = crypto.randomUUID();
    editToken = randomToken(18);
    const shareToken = randomToken(16);
    await env.DB.prepare(
      "INSERT INTO submissions (id, tenant_id, project_name, team_name, email, repo_owner, repo_name, repo_url, description, video_url, shot_count, shots_meta, share_token, edit_token, link_url, status, created_at, updated_at, wb_client, wb_project, build_state) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, '', 0, '[]', ?, ?, ?, 'ready', ?, ?, ?, ?, 'queued')",
    )
      .bind(id, tid, projectName, email, owner, repoKey, repo.htmlUrl, idea, shareToken, editToken, repo.htmlUrl, now, now, clientSlug, projectSlug)
      .run();
  }
  return json({ ok: true, id, editToken, viewUrl: `/s/${id}`, repoUrl: repo.htmlUrl, jobId, queuePos });
}

// A6 — AI 起名: suggest 2–3 Chinese project names from the participant's idea (cheap gpt-4o-mini).
// Reuses the miniAssist rate-limit + daily quota pattern. Mock (WORKBENCH_MOCK=1) returns
// deterministic offline names so the flow is testable via wrangler dev with no OpenAI billing.
async function generateMiniNames(env: Env, idea: string, link: string): Promise<string[]> {
  if (env.WORKBENCH_MOCK === "1") {
    const base = idea.replace(/[\s，。,.]+/g, "").slice(0, 4) || "作品";
    return [`${base}小助手`, `一键${base}`, `${base}Go`].map((s) => s.slice(0, 12));
  }
  const prompt =
    `你是取名助手。为下面这个黑客松作品想法起 3 个中文项目名,每个 2–8 个字,好记、具体、不浮夸。` +
    `想法:${idea || "(未描述)"}。` +
    (link ? `参考链接:${link}。` : "") +
    ` 只输出一个 JSON 字符串数组,例如 ["邻里团","楼下拼","一键凑单"],不要解释、不要多余文字。`;
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: prompt }], max_tokens: 120, temperature: 0.9 }),
  });
  if (!resp.ok) {
    console.log("mini name error", resp.status, (await resp.text().catch(() => "")).slice(0, 200));
    throw new Error("openai");
  }
  const data = await resp.json<{ choices?: { message?: { content?: string } }[] }>().catch(() => null);
  return parseNameList(String(data?.choices?.[0]?.message?.content ?? ""));
}

// Robustly extract up to 3 names from a model reply (prefers a JSON array; falls back to lines).
function parseNameList(raw: string): string[] {
  let names: string[] = [];
  const m = raw.match(/\[[\s\S]*\]/);
  if (m) {
    try {
      const arr = JSON.parse(m[0]);
      if (Array.isArray(arr)) names = arr.map((x) => String(x));
    } catch {
      /* fall through to line parsing */
    }
  }
  if (!names.length) {
    names = raw.split(/[\n,、,]+/).map((s) => s.replace(/^[\s\d.。、)）"'“”*\-]+/, ""));
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const clean = n.replace(/["'“”]/g, "").trim().slice(0, 20);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
    if (out.length >= 3) break;
  }
  return out;
}

async function miniName(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tenant || tenant.mode !== "mini" || !tid) return json({ error: "Not found" }, 404);
  const mock = env.WORKBENCH_MOCK === "1";
  if (!env.OPENAI_API_KEY && !mock) return json({ error: "AI 未开通 / AI not enabled" }, 503);
  const body = await request.json<{ idea?: string; name?: string; link?: string }>().catch(() => null);
  const idea = String(body?.idea ?? body?.name ?? "").trim().slice(0, 300);
  const link = String(body?.link ?? "").trim().slice(0, 300);
  if (!idea && !link) return json({ error: "请先描述你的想法 / Describe your idea first" }, 400);
  const day = Math.floor(unixNow() / 86400);
  const capKey = `mininame:${tid}:${day}`;
  const used = Number((await env.SHOTS.get(capKey)) ?? "0");
  if (used >= 60) return json({ error: "今日 AI 次数已用完 / Daily AI limit reached" }, 429);
  await env.SHOTS.put(capKey, String(used + 1), { expirationTtl: 2 * 86400 });
  let names: string[];
  try {
    names = await generateMiniNames(env, idea, link);
  } catch {
    return json({ error: "生成失败,请稍后再试 / Generation failed" }, 502);
  }
  if (!names.length) return json({ error: "生成失败 / Failed" }, 502);
  return json({ ok: true, names });
}

// AI-naming smoke test — mock-gated (404 in production); lets wrangler dev exercise the parse/shape.
async function nameSelftest(env: Env): Promise<Response> {
  if (env.WORKBENCH_MOCK !== "1") return json({ error: "Not found" }, 404);
  const names = await generateMiniNames(env, "帮小区做团购的小工具", "");
  return json({ ok: names.length > 0, mock: true, names });
}

// ============================ WorkBench usage / billing (A7) ============================

// Shape the raw WorkBench usage into a per-participant summary + the mini free-tier note.
// Read-only display (C4: v1 只记录用量;成本模型 Phase 2). `mini 首场免费,之后累计待结算`.
function shapeMiniUsage(usage: { global?: { tokens?: number; requests?: number }; perProject?: Record<string, { tokens?: number; requests?: number }>; byClient?: Record<string, { tokens?: number }>; at?: string }) {
  const perProject = Object.entries(usage.perProject ?? {})
    .map(([project, v]) => ({ project, tokens: Number(v?.tokens ?? 0), requests: v?.requests ?? null }))
    .sort((a, b) => b.tokens - a.tokens);
  return {
    at: usage.at ?? null,
    totalTokens: Number(usage.global?.tokens ?? 0),
    totalRequests: usage.global?.requests ?? null,
    participants: perProject.length,
    perProject,
    byClient: usage.byClient ?? null,
    // v1 只读:免费/付费由 hack5 侧 DB plan='paid' 控制;这里仅展示用量与额度口径。
    freeTier: { model: "mini 首场免费,之后按 token 累计待结算 / first event free, then metered", freeEvents: 1 },
  };
}

// A7 — mini 计费汇总(只读):按 hackathon(client)/参赛者(project)归集 token 用量。
async function miniUsage(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tenant || tenant.mode !== "mini" || !tid) return json({ error: "Not found" }, 404);
  const auth = await requireRole(request, env, tid, "admin");
  if (!auth) return json({ error: "Admin only" }, 403);
  const wb = createWorkbench(env);
  let usage;
  try {
    usage = await wb.usage(tenant.subdomain);
  } catch {
    return json({ error: "用量暂不可用 / usage unavailable" }, 502);
  }
  return json({ ok: true, mock: wb.mock, ...shapeMiniUsage(usage) });
}

// Usage-shaping smoke test — mock-gated (404 in production).
async function usageSelftest(env: Env): Promise<Response> {
  if (env.WORKBENCH_MOCK !== "1") return json({ error: "Not found" }, 404);
  const usage = await createWorkbench(env).usage("demo-hackathon");
  const shaped = shapeMiniUsage(usage);
  return json({ ok: shaped.totalTokens > 0 && shaped.participants > 0, ...shaped });
}

// Mini-mode submission: no code required. Any work link (no-code app / site / doc / video) + a
// one-line description + optional screenshots. Open (no invite code); one per email (edit via token).
async function createMiniSubmission(request: Request, env: Env, tid: string): Promise<Response> {
  const body = await request
    .json<{ projectName?: string; linkUrl?: string; description?: string; email?: string; teamName?: string; shots?: string[]; editToken?: string }>()
    .catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  const projectName = String(body.projectName ?? "").trim().slice(0, 80);
  const linkUrl = String(body.linkUrl ?? "").trim();
  const description = String(body.description ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  const email = normalizeEmail(body.email);
  const teamName = String(body.teamName ?? "").trim().slice(0, 80);
  if (!projectName) return json({ error: "请填写作品名称 / Product name required" }, 400);
  if (!isHttpUrl(linkUrl) || linkUrl.length > 500) return json({ error: "请填写有效的作品链接 / Valid work link required" }, 400);
  if (!email) return json({ error: "请填写有效邮箱 / Valid email required" }, 400);

  const maxShots = numberEnv(env.MAX_SHOTS, DEFAULT_MAX_SHOTS);
  const maxShotBytes = numberEnv(env.MAX_SHOT_BYTES, DEFAULT_MAX_SHOT_BYTES);
  const decoded: { contentType: string; bytes: Uint8Array }[] = [];
  for (const shot of (Array.isArray(body.shots) ? body.shots : []).slice(0, maxShots)) {
    const parsed = dataUrlToBytes(shot);
    if (!parsed || !isRasterImage(parsed.contentType) || parsed.bytes.byteLength > maxShotBytes) continue;
    decoded.push(parsed);
  }
  const now = unixNow();
  // No repo in mini — key identity on email so each person has one editable entry.
  const owner = "mini";
  // Hash the email (not a slug) so different emails can't collide onto the same identity key.
  const repo = (await hmacHex(utf8(env.AUTH_SECRET), `mini:${email}`)).slice(0, 40);
  const shotsMeta = JSON.stringify(decoded.map((d) => ({ ct: d.contentType })));
  const existing = await env.DB.prepare(
    "SELECT id, edit_token, shot_count FROM submissions WHERE tenant_id = ? AND repo_owner = ? AND repo_name = ?",
  )
    .bind(tid, owner, repo)
    .first<{ id: string; edit_token: string; shot_count: number }>();
  if (existing) {
    if (String(body.editToken ?? "") !== existing.edit_token) {
      return json({ error: "你已提交过,请用编辑令牌修改 / Already submitted — use the edit token" }, 409);
    }
    if (decoded.length) {
      await clearShots(env, existing.id, existing.shot_count);
      await putShots(env, existing.id, decoded);
      await env.DB.prepare(
        "UPDATE submissions SET project_name = ?, team_name = ?, email = ?, link_url = ?, description = ?, shot_count = ?, shots_meta = ?, updated_at = ? WHERE id = ?",
      )
        .bind(projectName, teamName, email, linkUrl, description, decoded.length, shotsMeta, now, existing.id)
        .run();
    } else {
      await env.DB.prepare(
        "UPDATE submissions SET project_name = ?, team_name = ?, email = ?, link_url = ?, description = ?, updated_at = ? WHERE id = ?",
      )
        .bind(projectName, teamName, email, linkUrl, description, now, existing.id)
        .run();
    }
    return json({ ok: true, id: existing.id, editToken: existing.edit_token, viewUrl: `/p/${existing.id}`, updated: true });
  }
  const id = crypto.randomUUID();
  const shareToken = randomToken(16);
  const editToken = randomToken(18);
  await putShots(env, id, decoded);
  await env.DB.prepare(
    "INSERT INTO submissions (id, tenant_id, project_name, team_name, email, repo_owner, repo_name, repo_url, description, video_url, shot_count, shots_meta, share_token, edit_token, link_url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, '', ?, ?, ?, ?, ?, 'ready', ?, ?)",
  )
    .bind(id, tid, projectName, teamName, email, owner, repo, description, decoded.length, shotsMeta, shareToken, editToken, linkUrl, now, now)
    .run();
  return json({ ok: true, id, editToken, viewUrl: `/p/${id}` });
}

// Secret-mode submission: online demo + credentials + pasted README + private repo. No public-repo
// validation, no screenshots; gated by the access session; edits require the returned edit token.
async function createSecretSubmission(request: Request, env: Env, tenant: Tenant, tid: string): Promise<Response> {
  if (!(await hasSecretAccess(request, env, tenant))) return json({ error: "需要访问码 / Access required" }, 403);
  const body = await request
    .json<{ projectName?: string; teamName?: string; email?: string; demoUrl?: string; demoUser?: string; demoPass?: string; readmeMd?: string; repoUrl?: string; videoUrl?: string; editToken?: string }>()
    .catch(() => null);
  if (!body) return json({ error: "Invalid JSON" }, 400);
  const projectName = String(body.projectName ?? "").trim().slice(0, 80);
  const teamName = String(body.teamName ?? "").trim().slice(0, 80);
  const email = normalizeEmail(body.email);
  const demoUrl = String(body.demoUrl ?? "").trim();
  const demoUser = String(body.demoUser ?? "").trim().slice(0, 120) || null;
  const demoPass = String(body.demoPass ?? "").trim().slice(0, 200) || null;
  const readmeMd = String(body.readmeMd ?? "").trim().slice(0, 20000);
  const videoUrl = String(body.videoUrl ?? "").trim();
  const repo = parseRepoUrl(body.repoUrl);
  if (!projectName) return json({ error: "请填写产品名称 / Product name required" }, 400);
  if (!email) return json({ error: "请填写有效邮箱 / Valid email required" }, 400);
  if (!isHttpUrl(demoUrl) || demoUrl.length > 500) return json({ error: "请填写有效的在线 Demo 链接 / Valid demo URL required" }, 400);
  if (!demoUser || !demoPass) return json({ error: "请填写 Demo 账号和密码 / Demo username & password required" }, 400);
  if (readmeMd.length < 20) return json({ error: "请粘贴项目 README(至少 20 字)/ Paste a README (20+ chars)" }, 400);
  if (!repo) return json({ error: "GitHub 私有仓库链接无效 / Invalid repo URL" }, 400);
  if (videoUrl && (!isHttpUrl(videoUrl) || videoUrl.length > 500)) return json({ error: "视频链接无效 / Invalid video link" }, 400);

  const now = unixNow();
  const existing = await env.DB.prepare(
    "SELECT id, edit_token FROM submissions WHERE tenant_id = ? AND repo_owner = ? AND repo_name = ?",
  )
    .bind(tid, repo.owner, repo.repo)
    .first<{ id: string; edit_token: string }>();
  if (existing) {
    if (String(body.editToken ?? "") !== existing.edit_token) {
      return json({ error: "该仓库已提交,请用编辑令牌修改 / Already submitted — use the edit token" }, 409);
    }
    await env.DB.prepare(
      "UPDATE submissions SET project_name = ?, team_name = ?, email = ?, repo_url = ?, demo_url = ?, demo_user = ?, demo_pass = ?, readme_md = ?, video_url = ?, updated_at = ? WHERE id = ?",
    )
      .bind(projectName, teamName, email, repoUrl(repo), demoUrl, demoUser, demoPass, readmeMd, videoUrl, now, existing.id)
      .run();
    return json({ ok: true, id: existing.id, editToken: existing.edit_token, viewUrl: `/p/${existing.id}`, updated: true });
  }
  const id = crypto.randomUUID();
  const shareToken = randomToken(16);
  const editToken = randomToken(18);
  await env.DB.prepare(
    "INSERT INTO submissions (id, tenant_id, project_name, team_name, email, repo_owner, repo_name, repo_url, description, video_url, shot_count, shots_meta, share_token, edit_token, demo_url, demo_user, demo_pass, readme_md, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, 0, '[]', ?, ?, ?, ?, ?, ?, 'ready', ?, ?)",
  )
    .bind(id, tid, projectName, teamName, email, repo.owner, repo.repo, repoUrl(repo), videoUrl, shareToken, editToken, demoUrl, demoUser, demoPass, readmeMd, now, now)
    .run();
  return json({ ok: true, id, editToken, viewUrl: `/p/${id}` });
}

async function createSubmission(request: Request, env: Env, tenant: Tenant | null, tid: string | null): Promise<Response> {
  if (!tid) return json({ error: "无效的黑客松 / No hackathon here" }, 404);
  if (tenant?.mode === "secret") return createSecretSubmission(request, env, tenant, tid);
  if (tenant?.mode === "mini") return createMiniSubmission(request, env, tid);
  const body = await request
    .json<{
      passcode?: string;
      projectName?: string;
      teamName?: string;
      email?: string;
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
  const email = normalizeEmail(body.email);
  const contact = String(body.contact ?? "").trim().slice(0, 120) || null;
  const description = String(body.description ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
  const videoUrl = String(body.videoUrl ?? "").trim();
  const repo = parseRepoUrl(body.repoUrl);
  const maxShots = numberEnv(env.MAX_SHOTS, DEFAULT_MAX_SHOTS);
  const maxShotBytes = numberEnv(env.MAX_SHOT_BYTES, DEFAULT_MAX_SHOT_BYTES);

  if (!projectName) return json({ error: "请填写产品名称 / Product name required" }, 400);
  if (!email) return json({ error: "请填写有效邮箱 / Valid email required" }, 400);
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
    if (!parsed || !isRasterImage(parsed.contentType)) {
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
      "UPDATE submissions SET project_name = ?, team_name = ?, email = ?, contact = ?, repo_url = ?, description = ?, video_url = ?, shot_count = ?, shots_meta = ?, updated_at = ? WHERE id = ?",
    )
      .bind(projectName, teamName, email, contact, repoUrl(repo), description, videoUrl, decoded.length, shotsMeta, now, existing.id)
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
      "INSERT INTO submissions (id, tenant_id, project_name, team_name, email, contact, repo_owner, repo_name, repo_url, description, video_url, shot_count, shots_meta, share_token, edit_token, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)",
    )
      .bind(id, tid, projectName, teamName, email, contact, repo.owner, repo.repo, repoUrl(repo), description, videoUrl, decoded.length, shotsMeta, shareToken, editToken, now, now)
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
    `SELECT s.project_name, s.team_name, s.email, s.contact, s.repo_owner, s.repo_name, sc.judge_name,
       sc.innovation, sc.technical, sc.completeness, sc.presentation,
       (sc.innovation + sc.technical + sc.completeness + sc.presentation) AS total, sc.comment
     FROM scores sc JOIN submissions s ON s.id = sc.submission_id
     WHERE s.tenant_id = ?
     ORDER BY s.project_name, sc.judge_name`,
  )
    .bind(tid)
    .all<Record<string, unknown>>();
  const header = ["product", "team", "email", "contact", "repo", "judge", "innovation", "technical", "completeness", "presentation", "total", "comment"];
  const lines = [header.join(",")];
  for (const r of rows.results) {
    lines.push(
      [
        r.project_name,
        r.team_name,
        r.email ?? "",
        r.contact ?? "",
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
  const body = await request.json<{ names?: string[]; githubs?: string[]; prefix?: string }>().catch(() => null);
  const rawNames = Array.isArray(body?.names) ? body!.names : [];
  const rawGithubs = Array.isArray(body?.githubs) ? body!.githubs : [];
  const entries = rawNames
    .map((n, i) => ({
      name: String(n ?? "").trim().slice(0, 40),
      // GitHub usernames: alphanumeric + single hyphens, ≤39 chars.
      github: String(rawGithubs[i] ?? "").trim().replace(/^@/, "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 39) || null,
    }))
    .filter((e) => e.name)
    .slice(0, 200);
  if (!entries.length) return json({ error: "请提供至少一个评委姓名 / At least one name required" }, 400);
  const prefix = (String(body?.prefix ?? "J").trim().toUpperCase().replace(/[^A-Z0-9]/g, "") || "J").slice(0, 8);

  const now = unixNow();
  const created: { name: string; code: string; github: string | null }[] = [];
  const stmts: D1PreparedStatement[] = [];
  const insert = env.DB.prepare("INSERT OR IGNORE INTO judges (code, tenant_id, name, github_user, created_at) VALUES (?, ?, ?, ?, ?)");
  for (const e of entries) {
    const code = `${prefix}-${randomCodeBody(6)}`;
    created.push({ name: e.name, code, github: e.github });
    stmts.push(insert.bind(code, tid, e.name, e.github, now));
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

// Only raster images may be uploaded — an SVG could carry <script> and execute as a document
// when its KV blob is fetched directly at its same-origin URL (stored XSS). Reject SVG/anything else.
const RASTER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
function isRasterImage(contentType: string): boolean {
  return RASTER_IMAGE_TYPES.has(contentType.toLowerCase());
}
// Defense-in-depth headers for any user-uploaded binary we serve back.
const UPLOAD_SERVE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cache-Control": "public, max-age=3600",
};

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

// Decode a base64-embedded brand asset into a cacheable binary Response.
function imageBytes(b64: string, contentType: string): Response {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, {
    headers: { "Content-Type": contentType, "Cache-Control": "public, max-age=604800" },
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
  <title>&#8249;5&#8250; hack5: Launch Your Hackathon!</title>
  <meta name="description" content="hack5 — 10 分钟发起并部署属于你自己的黑客松站点:报名、作品墙、评审打分、海报、组队、一键转发。开源公共物品,第一场免费。">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="hack5">
  <meta property="og:title" content="hack5 · 10 分钟发起你的黑客松">
  <meta property="og:description" content="报名、作品墙、评审打分、海报、组队、一键转发。开源公共物品,第一场免费。Launch your own hackathon in 10 minutes.">
  <meta property="og:image" content="https://hack5.net/og.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:url" content="https://hack5.net">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="hack5 · 10 分钟发起你的黑客松">
  <meta name="twitter:description" content="报名、作品墙、评审打分、海报、组队、一键转发。开源公共物品,第一场免费。">
  <meta name="twitter:image" content="https://hack5.net/og.png">
  <style>
    :root{color-scheme:light;--bg:#f6f7fb;--panel:#fff;--card:#fff;--ink:#14161c;--ink2:#3c4250;--muted:#5f6675;--line:#e2e6ee;--brand:#5b4be6;--brand-dark:#4536c9;--ok:#0f9d6b;--danger:#c0392b;--shadow:0 14px 44px rgba(24,28,52,.10);--ghost-bg:#fff;--ghost-hover:#eef1f6;--input-bg:#fff;--header-bg:rgba(255,255,255,.9);--info-bg:#eef4ff;--info-ink:#25408f;--ok-bg:#e9f8f1;--err-bg:#fdeeec}
    :root[data-theme="dark"]{color-scheme:dark;--bg:#0d1017;--panel:#161b24;--card:#161b24;--ink:#e7eaf0;--ink2:#aeb6c4;--muted:#8b94a3;--line:#28303c;--brand:#8b7bff;--brand-dark:#7a68ff;--ok:#3fca8f;--danger:#ff6b5b;--shadow:0 14px 44px rgba(0,0,0,.45);--ghost-bg:#1b212b;--ghost-hover:#232b37;--input-bg:#11161e;--header-bg:rgba(13,16,23,.9);--info-bg:#16233f;--info-ink:#9db8ff;--ok-bg:#123026;--err-bg:#33191a}
    *{box-sizing:border-box}
    body{margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
    a{color:var(--brand);text-decoration:none}
    button,input,textarea,select{font:inherit}
    button{border:0;background:var(--brand);color:#fff;border-radius:8px;padding:9px 15px;cursor:pointer;font-weight:650}
    button:hover{background:var(--brand-dark)}
    button:disabled{opacity:.5;cursor:not-allowed}
    .ghost{background:var(--ghost-bg);color:var(--ink);border:1px solid var(--line)}
    .ghost:hover{background:var(--ghost-hover)}
    header{position:sticky;top:0;z-index:5;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px clamp(16px,4vw,48px);background:var(--header-bg);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
    .brand{display:flex;align-items:center;gap:10px;font-weight:800;cursor:pointer}
    .mark{width:30px;height:30px;border-radius:8px;background:var(--brand);color:#fff;display:grid;place-items:center;font-size:13px}
    nav{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    nav .who{color:var(--muted);font-size:13px;margin-right:4px}
    main{width:min(1200px,100%);margin:0 auto;padding:24px clamp(14px,4vw,32px) 72px}
    h1{font-size:clamp(24px,4vw,36px);margin:0 0 8px}
    h2{font-size:20px;margin:0 0 12px}
    p{color:var(--muted);line-height:1.6}
    label{display:block;font-size:13px;font-weight:700;margin:14px 0 6px}
    input,textarea,select{width:100%;border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--input-bg);color:var(--ink);outline:none}
    textarea{min-height:84px;resize:vertical}
    input:focus,textarea:focus,select:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(91,75,230,.14)}
    .panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;box-shadow:var(--shadow)}
    .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
    .muted{color:var(--muted);font-size:13px}
    .notice{margin-top:14px;padding:11px 13px;border-radius:8px;background:var(--info-bg);color:var(--info-ink);word-break:break-word}
    .notice.err{background:var(--err-bg);color:var(--danger)}
    .notice.ok{background:var(--ok-bg);color:var(--ok)}
    .gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
    .card{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:var(--shadow);display:flex;flex-direction:column}
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
    .card-desc{font-size:13px;color:var(--ink2);line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
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
    .guide-row p{font-size:15px;line-height:1.75;color:var(--ink2);margin:0}
    .guide-steps{display:grid;gap:14px;margin:22px 0}
    .step{display:flex;gap:16px;align-items:flex-start;padding:18px;background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
    .step .num{flex:0 0 auto;width:40px;height:40px;border-radius:50%;background:var(--brand);color:#fff;display:grid;place-items:center;font-weight:800;font-size:18px}
    .step h3{margin:0 0 5px;font-size:17px}
    .step p{margin:0;color:var(--ink2);line-height:1.6;font-size:14px}
    .guide-cta{text-align:center;margin:34px 0;padding:32px;background:linear-gradient(135deg,var(--brand),#7a6bf0);border-radius:16px;color:#fff}
    .guide-cta h2{color:#fff;margin:0 0 14px}
    .guide-cta button{background:#fff;color:var(--brand)}
    @media(max-width:720px){.guide-row{grid-template-columns:1fr}.guide-row.rev .guide-art{order:0}}
    .likebtn{background:var(--ghost-bg);border:1px solid var(--line);color:var(--danger);border-radius:999px;padding:5px 14px;font-weight:700;font-size:14px;cursor:pointer}
    .likebtn:hover{background:var(--ghost-hover)}
    .likebtn.liked{background:var(--danger);color:#fff;border-color:var(--danger)}
    .price-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:20px;max-width:760px;margin:24px auto 0;text-align:left}
    @media(max-width:680px){.price-grid{grid-template-columns:1fr}}
    .price-card{border:1px solid var(--line);border-radius:16px;padding:26px;background:var(--card);box-shadow:var(--shadow);display:flex;flex-direction:column;gap:8px}
    .price-card .pc-ico{font-size:32px}
    .price-card h2{margin:2px 0 0}
    .price-card .pc-tag{color:var(--brand);font-weight:700;font-size:13px}
    .price-card p{margin:6px 0;font-size:14px;color:var(--ink2)}
    .price-card .pc-list{margin:4px 0 8px;padding-left:18px;color:var(--ink2);font-size:14px;line-height:1.9}
    .price-card .pc-price{margin-top:auto;padding-top:10px;font-size:15px}
    .price-card .pc-btn{margin-top:12px;width:100%;font-size:15px;padding:11px}
    .entry-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;max-width:940px;margin:26px auto 0;text-align:left}
    @media(max-width:760px){.entry-grid{grid-template-columns:1fr}}
    .entry-card{border:1px solid var(--line);border-radius:16px;padding:22px;background:var(--card);box-shadow:var(--shadow);cursor:pointer;transition:transform .12s,border-color .12s;display:flex;flex-direction:column;gap:6px}
    .entry-card:hover{transform:translateY(-3px);border-color:var(--brand)}
    .entry-card .ec-ico{font-size:30px}
    .entry-card h3{margin:4px 0 0;font-size:19px}
    .entry-card .ec-sub{color:var(--brand);font-weight:700;font-size:13px}
    .entry-card p{margin:6px 0 10px;font-size:14px;color:var(--ink2)}
    .entry-card .ec-go{margin-top:auto;color:var(--brand);font-weight:700;font-size:14px}
    .site-footer{text-align:center;padding:26px 16px;margin-top:48px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;line-height:1.7}
    .sponsor-bar{display:flex;align-items:center;justify-content:center;flex-wrap:wrap;gap:14px;margin-bottom:12px;font-size:13px}
    .sponsor-bar .muted{text-transform:uppercase;letter-spacing:.1em;font-size:11px;font-weight:700}
    .sponsor-item{display:inline-flex;align-items:center;color:var(--ink);font-weight:650}
    .sponsor-item img{height:26px;max-width:120px;object-fit:contain;vertical-align:middle}
    .media-table{width:100%;border-collapse:collapse;font-size:14px;min-width:520px}
    .media-table th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);padding:0 14px 10px 0;border-bottom:1px solid var(--line)}
    .media-table td{padding:14px 14px 14px 0;border-bottom:1px solid var(--line);vertical-align:top}
    .media-table tr:last-child td{border-bottom:0}
    .org-foot{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:12px;font-size:14px;color:var(--ink2);font-weight:600}
    .org-foot-logo{width:28px;height:28px;object-fit:contain;border-radius:6px}
    .orglogo-prev{width:64px;height:64px;border:1px solid var(--line);border-radius:10px;display:flex;align-items:center;justify-content:center;overflow:hidden;background:repeating-conic-gradient(#f0f2f1 0% 25%,#fff 0% 50%) 50%/16px 16px}
    .orglogo-prev img{max-width:100%;max-height:100%;object-fit:contain}
    .tenant-hero{margin-bottom:18px}
    .hero-banner{margin:-20px -20px 16px;overflow:hidden;aspect-ratio:1280/440;background:var(--ghost-hover)}
    .hero-banner img{width:100%;height:100%;object-fit:cover;display:block}
    .hero-default{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;
      background:radial-gradient(120% 140% at 82% 8%,rgba(91,75,230,.55),transparent 55%),radial-gradient(120% 140% at 8% 96%,rgba(37,255,134,.16),transparent 55%),linear-gradient(160deg,#141a2e,#0b0f1a 60%,#080a12)}
    .hero-default .hd-badge{font-family:ui-monospace,Menlo,monospace;font-weight:800;color:#25ff86;font-size:26px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:4px 12px}
    .hero-default .hd-name{color:#fff;font-weight:800;font-size:clamp(20px,3.4vw,34px);letter-spacing:-.01em;padding:0 16px}
    .hero-default .hd-sub{color:#aeb6cc;font-family:ui-monospace,Menlo,monospace;font-size:13px}
    .tenant-hero .hero-meta{display:flex;gap:18px;flex-wrap:wrap;color:var(--ink2);font-size:14px;font-weight:600}
    .map-embed{width:100%;height:280px;border:0;border-radius:10px;margin-top:12px}
    .map-links{margin-top:10px;font-size:13px;color:var(--muted)}
    .map-links a{font-weight:650}
    .agenda{margin-top:16px}
    .agenda .ag-h{font-weight:700;font-size:14px;color:var(--ink2);margin-bottom:8px}
    .ag-item{display:flex;gap:14px;padding:8px 0;border-bottom:1px dashed var(--line);font-size:14px}
    .ag-item:last-child{border-bottom:0}
    .ag-t{flex:0 0 140px;color:var(--brand);font-weight:650;font-family:ui-monospace,Menlo,monospace;font-size:13px}
    .ag-x{color:var(--ink2)}
    @media(max-width:560px){.ag-item{flex-direction:column;gap:2px}.ag-t{flex:none}}
    .share-grid{display:grid;grid-template-columns:340px 1fr;gap:22px;align-items:start}
    .share-poster{border-radius:14px;overflow:hidden;border:1px solid var(--line);box-shadow:var(--shadow)}
    .share-plats{display:flex;flex-wrap:wrap;gap:8px}
    .share-qr{display:flex;align-items:center;gap:14px;margin-top:16px;padding:12px;border:1px solid var(--line);border-radius:12px}
    .share-qr img{width:132px;height:132px;border-radius:8px;background:#fff;padding:6px;flex:0 0 auto}
    .splat{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border:1px solid var(--line);border-radius:999px;font-size:13px;font-weight:600;color:var(--ink)}
    .splat:hover{background:var(--ghost-hover)}
    .sdot{width:9px;height:9px;border-radius:50%;flex:0 0 auto}
    @media(max-width:720px){.share-grid{grid-template-columns:1fr}.share-poster{max-width:340px}}
    .teamgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
    .tcard{position:relative;border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--card);box-shadow:var(--shadow)}
    .tcard .tname{font-weight:800;font-size:16px;margin-bottom:8px}
    .tcard .trow{font-size:14px;color:var(--ink2);margin:3px 0}
    .tcard .tk{display:inline-block;min-width:30px;margin-right:8px;padding:1px 8px;border-radius:20px;background:#eef6f1;color:var(--brand);font-size:12px;font-weight:700}
    .tcard .tidea{font-size:14px;color:var(--ink2);margin:8px 0;white-space:pre-wrap}
    .tcard .tcontact{margin-top:10px;padding-top:10px;border-top:1px dashed var(--line);font-size:13px;color:var(--brand);font-weight:650;word-break:break-all}
    .tcard .tmdel{position:absolute;top:8px;right:10px;width:22px;height:22px;border-radius:50%;background:rgba(192,57,43,.9);color:#fff;text-align:center;line-height:22px;cursor:pointer;font-size:15px}
    .masonry{columns:3 240px;column-gap:14px}
    .mphoto{position:relative;break-inside:avoid;margin-bottom:14px;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:var(--card);box-shadow:var(--shadow)}
    .mphoto img{width:100%;display:block;cursor:pointer}
    .mphoto .cap{padding:8px 10px;font-size:13px;color:var(--ink2)}
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
  <footer class="site-footer"><div id="sponsorBar"></div><div id="orgFooter"></div>Mycelium: Digital Public Goods 🚌 = 🪵 Infras | 🦠 Protocols | 🕸️ Networks. All rights reserved.<span id="appVer"></span></footer>
  <div id="lightbox" class="lightbox hidden" onclick="this.classList.add('hidden')"></div>

  <script>
  const app = document.getElementById('app');
  const $ = (s, r=document) => r.querySelector(s);
  let CONFIG = null, ME = { role: null }, ME_USER = { email: null };
  // Platform sponsors (up to 4). Fill when a sponsor signs; shown in every hackathon footer.
  const APP_VERSION = '0.5.2'; // shown in the footer; bump on release
  const SPONSORS = []; // e.g. { name:'Acme', url:'https://acme.com', logo:'https://…/logo.png' }
  // Our owned media matrix (for the /media sponsor pitch). Fill followers/handle/link with real data.
  const MEDIA = [
    { platform: '微信公众号 / WeChat', handle: '', followers: '', topic: '开源 · 黑客松 · 数字公共物品', link: '' },
    { platform: '小红书 / RED', handle: '', followers: '', topic: '开发者成长 · AI 工具 · 活动', link: '' },
    { platform: '微信群 / WeChat groups', handle: '', followers: '', topic: '开发者社群 · 活动通知', link: '' },
    { platform: 'Telegram 群', handle: '', followers: '', topic: 'Builders · hackathons · DPG', link: '' },
  ];
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  let LANG = lsGet('hv_lang') === 'en' ? 'en' : 'zh';
  const t = (zh, en) => LANG === 'en' ? en : zh;
  window.toggleLang = () => { LANG = LANG === 'en' ? 'zh' : 'en'; lsSet('hv_lang', LANG); document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN'; renderNav(); route(); };

  function initTheme(){
    const saved = lsGet('hv_theme');
    const dark = saved ? saved === 'dark' : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme:dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }
  initTheme();
  window.toggleTheme = () => { const dark = document.documentElement.dataset.theme !== 'dark'; document.documentElement.dataset.theme = dark ? 'dark' : 'light'; lsSet('hv_theme', dark ? 'dark' : 'light'); renderNav(); };
  function themeBtn(){ return '<button class="ghost" onclick="toggleTheme()" title="'+t('深色 / 浅色','Dark / Light')+'">'+(document.documentElement.dataset.theme==='dark'?'☀️':'🌙')+'</button>'; }

  function go(path){ history.pushState(null, '', path); route(); }
  window.addEventListener('popstate', route);
  window.go = go;
  window.startMode = (m)=>{ window.__createMode = m; go('/start'); };

  boot();
  async function boot(){
    CONFIG = await api('/api/config').catch(()=>({appName:'hack5',platform:false,tenant:null,eventName:'Hackathon',minShots:2,maxShots:4,maxShotBytes:1048576,dims:['innovation','technical','completeness','presentation'],maxVideoSeconds:180}));
    const brand = CONFIG.tenant ? CONFIG.tenant.name : CONFIG.appName;
    document.getElementById('brandName').textContent = brand;
    document.title = CONFIG.tenant ? (brand + ' · ‹5› hack5') : '‹5› hack5: Launch Your Hackathon!';
    document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
    if(CONFIG.platform) ME_USER = await api('/api/platform/me').catch(()=>({email:null}));
    else ME = await api('/api/auth/me').catch(()=>({role:null}));
    renderOrgFooter();
    renderSponsorFooter();
    const av = document.getElementById('appVer');
    if(av) av.innerHTML = ' · <a href="https://github.com/MushroomDAO/hack5-net/releases" target="_blank" rel="noopener">v'+APP_VERSION+'</a>';
    renderNav();
    route();
  }
  function renderSponsorFooter(){
    const el = document.getElementById('sponsorBar'); if(!el) return;
    if(!SPONSORS.length){ el.innerHTML=''; return; }
    el.innerHTML = '<div class="sponsor-bar"><span class="muted">'+t('赞助商','Sponsors')+'</span>'
      + SPONSORS.map(s=>{ const inner = s.logo?'<img src="'+esc(s.logo)+'" alt="'+esc(s.name)+'">':esc(s.name); return s.url?'<a href="'+esc(s.url)+'" target="_blank" rel="noopener" class="sponsor-item">'+inner+'</a >':'<span class="sponsor-item">'+inner+'</span>'; }).join('')
      + '</div>';
  }
  function renderOrgFooter(){
    const el = document.getElementById('orgFooter'); if(!el) return;
    const org = CONFIG.tenant && CONFIG.tenant.organizer;
    if(!org || !org.name){ el.innerHTML=''; return; }
    const sub = CONFIG.tenant.subdomain;
    const logo = org.hasLogo ? '<img src="/org-logo/'+esc(sub)+'" alt="" class="org-foot-logo">' : '';
    const name = org.url ? '<a href="'+esc(org.url)+'" target="_blank" rel="noopener">'+esc(org.name)+'</a>' : esc(org.name);
    el.innerHTML = '<div class="org-foot">'+logo+'<span>'+t('主办方','Organized by')+': '+name+'</span></div>';
  }

  function renderNav(){
    const n = document.getElementById('nav');
    if(CONFIG.platform){
      let hp = '<button class="ghost" onclick="go(\'/guide\')">'+t('指南','Guide')+'</button>'
             + '<button class="ghost" onclick="go(\'/pricing\')">'+t('价格','Pricing')+'</button>'
             + '<button class="ghost" onclick="go(\'/media\')">'+t('媒体','Media')+'</button>'
             + '<button class="ghost" onclick="go(\'/about\')">'+t('关于','About')+'</button>';
      if(ME_USER.email){
        hp += '<button onclick="go(\'/dashboard\')">'+t('我组织的黑客松','Hackathons I organize')+'</button>'
            + '<button class="ghost" onclick="go(\'/settings\')">'+t('我的设置','Settings')+'</button>'
            + (ME_USER.isOperator?'<button class="ghost" onclick="go(\'/operator\')">'+t('运营','Operator')+'</button>':'')
            + '<span class="who">'+esc(ME_USER.email)+'</span>'
            + '<button class="ghost" onclick="userLogout()">'+t('退出','Logout')+'</button>';
      } else {
        hp += '<button onclick="go(\'/start\')">'+t('发起黑客松','Start a hackathon')+'</button>';
      }
      hp += themeBtn() + '<button class="ghost" onclick="toggleLang()" title="中 / EN">'+(LANG==='en'?'中文':'EN')+'</button>';
      n.innerHTML = hp; return;
    }
    let h = '<button class="ghost" onclick="go(\'/\')">'+t('作品墙','Gallery')+'</button>'
          + '<button class="ghost" onclick="go(\'/register\')">'+t('报名','Register')+'</button>'
          + '<button class="ghost" onclick="go(\'/teams\')">'+t('组队','Teams')+'</button>'
          + '<button class="ghost" onclick="go(\'/photos\')">'+t('照片墙','Photos')+'</button>'
          + '<button class="ghost" onclick="go(\'/submit\')">'+t('提交作品','Submit')+'</button>'
          + '<button class="ghost" onclick="go(\'/share\')">'+t('分享','Share')+'</button>'
          + '<button class="ghost" onclick="go(\'/about\')">'+t('关于','About')+'</button>';
    if(ME.role){
      h += '<button class="ghost" onclick="go(\'/leaderboard\')">'+t('排行榜','Leaderboard')+'</button>'
         + (ME.role==='admin'?'<button class="ghost" onclick="go(\'/manage\')">'+t('首页','Homepage')+'</button><button class="ghost" onclick="go(\'/poster\')">'+t('海报','Poster')+'</button><button class="ghost" onclick="go(\'/invites\')">'+t('邀请码','Invites')+'</button><button class="ghost" onclick="go(\'/judges\')">'+t('评委','Judges')+'</button>':'')
         + (ME.role==='admin' && CONFIG.tenant && CONFIG.tenant.mode==='mini'?'<button class="ghost" onclick="go(\'/usage\')">'+t('用量','Usage')+'</button>':'')
         + '<span class="who">'+esc(ME.name)+' · '+(ME.role==='admin'?t('管理','Admin'):t('评委','Judge'))+'</span>'
         + '<button onclick="logout()">'+t('退出','Logout')+'</button>';
    } else {
      h += '<button onclick="go(\'/judge\')">'+t('评审入口','Judge login')+'</button>';
    }
    h += themeBtn() + '<button class="ghost" onclick="toggleLang()" title="中 / EN">'+(LANG==='en'?'中文':'EN')+'</button>';
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
      if(p === '/media') return renderMedia();
      if(p === '/pricing') return renderPricing();
      if(p === '/start' || p === '/dashboard') return ME_USER.email ? renderDashboard() : renderPlatformLogin();
      if(p === '/settings') return ME_USER.email ? renderSettings() : renderPlatformLogin();
      if(p === '/operator') return ME_USER.isOperator ? renderOperator() : (ME_USER.email ? renderDashboard() : renderPlatformLogin());
      return renderPlatformLanding();
    }
    // Secret tenant, not yet unlocked: show the access gate for everything except judge login.
    if(CONFIG.tenant && CONFIG.tenant.gated && p !== '/judge') return renderGate();
    if(p === '/' || p === '') return renderWall();
    if(p === '/submit') return renderSubmit();
    if(p === '/make') return renderMiniMakeApp(); // A3 — mini「做成应用」
    if(p === '/judge') return renderJudge();
    if(p === '/guide') return renderGuide();
    if(p === '/about') return renderAbout();
    if(p === '/start') return renderStart();
    if(p === '/leaderboard') return renderLeaderboard();
    if(p === '/usage') return renderMiniUsage();
    if(p === '/invites') return renderInvites();
    if(p === '/judges') return renderJudges();
    if(p === '/manage') return renderTenantEdit();
    if(p === '/photos') return renderPhotos();
    if(p === '/poster') return renderPoster();
    if(p === '/register') return renderRegister();
    if(p === '/share') return renderShare();
    if(p === '/teams') return renderTeams();
    if((m = p.match(/^\/p\/([^/]+)$/))) return renderDetail(m[1]);
    if((m = p.match(/^\/s\/([^/]+)$/))) return renderDetail(m[1]); // A5 — mini work detail page
    if((m = p.match(/^\/watch\/([^/]+)/))) return renderDetail(m[1]);
    app.innerHTML = '<div class="panel"><p>'+t('页面不存在。','Page not found.')+'</p></div>';
  }

  // ---------------- work wall ----------------
  function renderGate(){
    const tn = CONFIG.tenant || {};
    app.innerHTML = '<div style="max-width:440px;margin:8vh auto">'
      + '<div class="panel" style="text-align:center">'
      + '<div style="font-size:40px;margin-bottom:6px">🔒</div>'
      + '<h1 style="font-size:24px;margin:0 0 6px">'+esc(tn.name||'')+'</h1>'
      + '<p class="muted">'+t('这是一场受邀的私密黑客松,请输入主办方发给你的访问码。','A private, invite-only hackathon. Enter the access code from the organizer.')+'</p>'
      + '<input id="gCode" placeholder="'+t('访问码','Access code')+'" style="text-align:center;margin-top:10px">'
      + '<div class="row" style="margin-top:12px;justify-content:center"><button id="gBtn">'+t('进入','Enter')+'</button></div>'
      + '<div id="gMsg" class="muted" style="margin-top:8px"></div>'
      + '<div class="muted" style="margin-top:12px;font-size:12px"><a href="/judge" onclick="go(\'/judge\');return false">'+t('我是评委,去登录 →','I am a judge →')+'</a></div>'
      + '</div></div>';
    $('#gBtn').addEventListener('click', async ()=>{
      const code = $('#gCode').value.trim();
      if(!code){ setMsg('gMsg', t('请输入访问码','Enter the code'), true); return; }
      $('#gBtn').disabled=true; setMsg('gMsg', t('验证中…','Checking…'));
      try{ await api('/api/tenant/access',{method:'POST',body:{code}});
        CONFIG = await api('/api/config'); renderNav(); go('/');
      }catch(e){ setMsg('gMsg', e.message, true); $('#gBtn').disabled=false; }
    });
    $('#gCode').addEventListener('keydown', e=>{ if(e.key==='Enter') $('#gBtn').click(); });
  }
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
  function renderPricing(){
    app.innerHTML = '<div class="guide"><div class="guide-hero"><h1>'+t('购买 / 充值','Pricing')+'</h1>'
      + '<p class="guide-sub">'+t('常规黑客松首场免费;Mini 与企业私密为付费产品。','Regular is free for your first event; Mini and Enterprise are paid.')+'</p></div>'
      + '<div class="price-grid">'
      // Mini — recharge / pay-per-use
      + '<div class="price-card"><div class="pc-ico">✨</div><h2>'+t('Mini 黑客松','Mini')+'</h2>'
      + '<div class="pc-tag">'+t('充值制 · 按用量','Top-up · pay as you go')+'</div>'
      + '<p>'+t('面向非开发者:AI 帮你把想法做成能跑的应用。每建一个应用都会消耗 AI token,所以按充值使用。','For non-coders: AI turns your idea into a working app. Building each app consumes AI tokens, so it runs on top-ups.')+'</p>'
      + '<ul class="pc-list"><li>'+t('每人首场免费','First event free per person')+'</li><li>'+t('之后按 token 充值继续','Then top up to keep going')+'</li><li>'+t('可由赞助商代付','A sponsor can pay for you')+'</li></ul>'
      + '<div class="pc-price"><b>'+t('充值包','Top-up')+'</b> <span class="muted">¥50 / ¥100 / ¥200</span></div>'
      + '<button class="pc-btn" data-plan="mini">'+t('充值','Top up')+'</button></div>'
      // Enterprise secret — direct purchase
      + '<div class="price-card"><div class="pc-ico">🔒</div><h2>'+t('企业私密黑客松','Enterprise')+'</h2>'
      + '<div class="pc-tag">'+t('直接购买 · 按场','Buy directly · per event')+'</div>'
      + '<p>'+t('邀请制、访问码门禁、不公开源码、Demo 评审。适合企业内部赛与命题赛。','Invite-only, access-gated, no source exposed, demo review. For internal & themed enterprise events.')+'</p>'
      + '<ul class="pc-list"><li>'+t('访问码门禁 + 会话时效','Access gate + timed sessions')+'</li><li>'+t('评委作为协作者评估私有代码','Judges review private code as collaborators')+'</li><li>'+t('一口价,按场购买','Flat price, per event')+'</li></ul>'
      + '<div class="pc-price"><b>'+t('按场','Per event')+'</b> <span class="muted">'+t('购买后即用','buy & go')+'</span></div>'
      + '<button class="pc-btn" data-plan="secret">'+t('购买','Buy')+'</button></div>'
      + '</div>'
      + '<p class="muted" style="text-align:center;margin-top:20px;font-size:13px">'+t('支付通道即将上线。现在需要开通请联系我们。','Payment is coming soon — contact us to get set up now.')+'</p>'
      + '</div>';
    app.querySelectorAll('.pc-btn').forEach(b=>b.addEventListener('click',()=>{
      alert(t('支付通道即将上线,我们会尽快开通。可先联系 Mycelium 团队。','Payment is coming soon. Please contact the Mycelium team to get set up.'));
    }));
  }
  function renderMedia(){
    const rows = MEDIA.map(m=>'<tr><td><b>'+esc(m.platform)+'</b>'+(m.handle?'<div class="muted" style="font-size:12px">'+esc(m.handle)+'</div>':'')+'</td>'
      +'<td>'+(m.followers?esc(m.followers):'<span class="muted">'+t('更新中','TBA')+'</span>')+'</td>'
      +'<td class="muted">'+esc(m.topic)+'</td>'
      +'<td>'+(m.link?'<a href="'+esc(m.link)+'" target="_blank" rel="noopener">'+t('打开','open')+' ↗</a >':'<span class="muted">—</span>')+'</td></tr>').join('');
    app.innerHTML = '<div class="guide"><div class="guide-hero"><h1>'+t('媒体矩阵','Media matrix')+'</h1>'
      +'<p class="guide-sub">'+t('hack5 · Mycelium 触达开源开发者社区的自有渠道','How hack5 · Mycelium reaches the open-source developer community')+'</p></div>'
      +'<div class="panel" style="overflow-x:auto"><table class="media-table"><thead><tr><th>'+t('渠道','Channel')+'</th><th>'+t('触达','Reach')+'</th><th>'+t('主要话题','Topics')+'</th><th>'+t('链接','Link')+'</th></tr></thead><tbody>'+rows+'</tbody></table>'
      +'<p class="muted" style="margin:12px 2px 0;font-size:12px">'+t('每个参加过黑客松的开发者都留下 email —— 这是我们随每场活动持续增长的社区基础。','Every hackathon participant leaves an email — a community base that grows with each event.')+'</p></div>'
      +'<div class="panel guide-cta" style="margin-top:20px"><h2>'+t('成为赞助商','Become a sponsor')+'</h2>'
      +'<p style="color:rgba(255,255,255,.88)">'+t('$1500 / 年 · 限 4 席。你的 logo 出现在所有 hack5 组织的黑客松页脚,并通过上面的渠道与订阅用户一起转发,触达开源开发者社区。所得用于覆盖平台成本、反哺更多数字公共物品。','$1500 / year · 4 seats. Your logo in the footer of every hack5 hackathon, amplified across the channels above.')+'</p>'
      +'<a href="https://blog.mushroom.cv/" target="_blank" rel="noopener"><button>'+t('了解 Mycelium →','About Mycelium →')+'</button></a></div></div>';
  }
  function renderAbout(){
    const feats = [
      ['⚡', t('10 分钟发起','Live in 10 minutes'), t('三步:登录 → 取名 → 一键部署你专属的黑客松站点(带独立域名)。','Three steps: log in → name it → deploy your own hackathon site on its own domain.')],
      ['🆓', t('单场免费','First event free'), t('办一场黑客松免费,记录永久保留;更多场次与高级功能(动态海报、一键转发、社区 Bot)可订阅。','Your first hackathon is free with records kept forever; more events and premium features (dynamic posters, one-click sharing, a community bot) come with a subscription.')],
      ['🌱', t('数字公共物品','A digital public good'), t('hack5 隶属于 Mycelium —— 一个数字公共物品组织,为开放的创造者社区而建。','hack5 is part of Mycelium — a digital-public-goods organization, built for an open community of makers.')],
    ];
    app.innerHTML = '<div class="guide">'
      + '<div class="guide-hero"><h1>'+t('关于 hack5','About hack5')+'</h1>'
      + '<p class="guide-sub">'+t('人人可办的黑客松平台','a hackathon platform anyone can run')+'</p></div>'
      + '<div class="panel" style="font-size:16px;line-height:1.8;color:var(--ink2)">'
      + t('<b>hack5.net</b> 隶属于 <b>Mycelium</b> —— 一个数字公共物品(Digital Public Goods)组织。它让任何人都能在 <b>10 分钟内</b>发起并部署一个属于自己的黑客松站点:<b>第一场免费</b>、记录永久保留;想办更多场次、或用上动态海报、一键转发、开发者社区 Bot 等高级功能,可订阅付费。',
          '<b>hack5.net</b> is part of <b>Mycelium</b> — a Digital Public Goods organization. Anyone can spin up their own hackathon site in <b>10 minutes</b>: your <b>first event is free</b> with records kept forever; hosting more events or unlocking premium features (dynamic posters, one-click sharing, a developer-community bot) comes with a subscription.')
      + '</div>'
      + '<div class="guide-steps" style="margin-top:20px">'
      + feats.map(f=>'<div class="step"><div class="num" style="font-size:20px;background:#0a0e0a">'+f[0]+'</div><div><h3>'+esc(f[1])+'</h3><p>'+esc(f[2])+'</p></div></div>').join('')
      + '</div>'
      + '<div class="guide-cta"><h2>'+t('办一场属于你的黑客松','Run your own hackathon')+'</h2><button onclick="go(\'/start\')">'+t('发起黑客松 →','Start a hackathon →')+'</button></div>'
      + '</div>';
  }

  // B — hack5 运营方(operator)账户管理:按 email 设 paid/free(+可选额度),替代手敲 SQL。
  async function renderOperator(){
    app.innerHTML = '<h1>'+t('运营 · 账户管理','Operator · Accounts')+'</h1>'
      + '<div class="notice">'+t('把用户设为 paid → 无限开企业私密 + mini + 常规;free → 走免费额度(企业私密免费不可开、mini 每人首场免费)。','Set a user to paid for unlimited secret + mini + regular; free uses the free tiers.')+'</div>'
      + '<div class="panel" style="max-width:560px">'
      + '<label>'+t('用户邮箱','User email')+'</label><input id="opEmail" type="email" placeholder="user@example.com">'
      + '<div class="row" style="gap:8px;margin-top:8px;align-items:center">'
      + '<select id="opPlan"><option value="paid">paid</option><option value="free">free</option></select>'
      + '<input id="opQuota" type="number" min="0" placeholder="'+t('额度(可选)','quota (optional)')+'" style="width:150px">'
      + '<button id="opSet">'+t('设置','Set')+'</button></div>'
      + '<div id="opMsg" class="muted" style="margin-top:6px"></div>'
      + '</div>'
      + '<h2 style="margin-top:20px">'+t('用户列表','Users')+'</h2>'
      + '<div id="opList" class="panel"><p class="muted">'+t('加载中…','Loading…')+'</p></div>';
    async function setPlan(email, plan, quota){
      setMsg('opMsg', t('设置中…','Saving…'));
      try{
        const body={email:email, plan:plan}; if(quota!=null && quota!=='') body.quota=Number(quota);
        const r=await api('/api/platform/admin/set-plan',{method:'POST',body:body});
        setMsg('opMsg', '✓ '+esc(r.user.email)+' → '+esc(r.user.plan)+' · quota '+r.user.quota); load();
      }catch(e){ setMsg('opMsg', e.message, true); }
    }
    async function load(){
      try{
        const d = await api('/api/platform/admin/users');
        const rows = (d.users||[]).map(u=>{
          const c = u.plan==='paid'?'#16a34a':'#6b7280';
          const to = u.plan==='paid'?'free':'paid';
          return '<tr><td>'+esc(u.email)+'</td>'
            + '<td><span class="chip" style="border-color:'+c+';color:'+c+'">'+esc(u.plan)+'</span></td>'
            + '<td style="text-align:right">'+u.quota+'</td>'
            + '<td style="text-align:right">'+u.hackathons+' ('+u.mini+' mini)</td>'
            + '<td style="text-align:right"><button class="ghost" data-e="'+esc(u.email)+'" data-p="'+to+'">→ '+to+'</button></td></tr>';
        }).join('');
        $('#opList').innerHTML = '<table style="width:100%;border-collapse:collapse"><thead><tr>'
          + '<th style="text-align:left">'+t('邮箱','Email')+'</th><th style="text-align:left">plan</th>'
          + '<th style="text-align:right">'+t('额度','Quota')+'</th><th style="text-align:right">'+t('黑客松','Hackathons')+'</th><th></th></tr></thead><tbody>'
          + (rows||'<tr><td colspan="5" class="muted">'+t('暂无用户','No users')+'</td></tr>')+'</tbody></table>';
        $('#opList').querySelectorAll('button[data-e]').forEach(b=>b.addEventListener('click',()=>setPlan(b.dataset.e, b.dataset.p)));
      }catch(e){ $('#opList').innerHTML='<p class="muted">'+esc(e.message)+'</p>'; }
    }
    $('#opSet').addEventListener('click', ()=>{ const email=$('#opEmail').value.trim(); if(!email){ setMsg('opMsg', t('请填邮箱','Enter an email'), true); return; } setPlan(email, $('#opPlan').value, $('#opQuota').value); });
    load();
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
      + '<p class="guide-sub">'+t('三种规模,一键发起 · 独立域名 · 首场免费','Three scales, one click · your own domain · first free')+'</p>'
      + '<div class="entry-grid">'
      + '<div class="entry-card" onclick="startMode(\'open\')"><div class="ec-ico">⚡</div><h3>'+t('常规黑客松','Regular')+'</h3><div class="ec-sub">'+t('10 分钟启动 · 200 人以下','10 min · under 200 people')+'</div><p>'+t('公开报名、作品墙、评审打分——通用规模。','Public sign-up, gallery, judging — general scale.')+'</p><span class="ec-go">'+t('启动 →','Start →')+'</span></div>'
      + '<div class="entry-card" onclick="startMode(\'secret\')"><div class="ec-ico">🔒</div><h3>'+t('企业私密黑客松','Enterprise')+'</h3><div class="ec-sub">'+t('10 分钟启动 · 邀请制','10 min · invite-only')+'</div><p>'+t('访问码门禁、不公开源码、Demo 评审。付费。','Access-gated, no source exposed, demo review. Paid.')+'</p><span class="ec-go">'+t('启动 →','Start →')+'</span></div>'
      + '<div class="entry-card" onclick="startMode(\'mini\')"><div class="ec-ico">✨</div><h3>'+t('Mini 黑客松','Mini')+'</h3><div class="ec-sub">'+t('5 分钟启动 · AI 驱动 · 50 人以下','5 min · AI-powered · under 50')+'</div><p>'+t('面向非开发者:AI 驱动,一句想法就能自动做成能跑的应用。每人 1 次免费。','For non-coders — AI-powered: one idea auto-built into a working app. 1 free each.')+'</p><span class="ec-go">'+t('启动 →','Start →')+'</span></div>'
      + '</div>'
      + '<div style="text-align:center;margin-top:16px"><a href="https://demo.hack5.net" target="_blank" rel="noopener" style="color:var(--muted);font-size:14px;font-weight:600">'+t('👀 看 Demo 示例 → demo.hack5.net','👀 See the demo → demo.hack5.net')+'</a></div>'
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

  // 180×180 PNG, transparency preserved, contained + centered.
  function compressLogo(file){
    return new Promise(function(resolve,reject){
      if(!file.type.startsWith('image/')) return reject(new Error(t('请选择图片文件','Pick an image')));
      const img=new Image(); const url=URL.createObjectURL(file);
      img.onload=function(){
        const S=180; const c=document.createElement('canvas'); c.width=S; c.height=S;
        const x=c.getContext('2d');
        const scale=Math.min(S/img.width,S/img.height); const w=Math.round(img.width*scale), h=Math.round(img.height*scale);
        x.drawImage(img,Math.round((S-w)/2),Math.round((S-h)/2),w,h); URL.revokeObjectURL(url);
        const out=c.toDataURL('image/png');
        if(out.length>120000) return reject(new Error(t('图片太复杂,换一张更简单的 Logo','Too complex — use a simpler logo')));
        resolve(out);
      };
      img.onerror=function(){ URL.revokeObjectURL(url); reject(new Error(t('无法读取图片','Cannot read image'))); };
      img.src=url;
    });
  }
  async function renderSettings(){
    app.innerHTML='<h1>'+t('我的设置 · 组织资料','Settings · Organization')+'</h1>'
      +'<p class="muted">'+t('你的主办方身份,会显示在你创建的每个黑客松页面底部(主办方:…),跨所有活动复用。','Your host identity — shown in the footer of every hackathon you create, reused across all your events.')+'</p>'
      +'<div class="panel" style="max-width:560px"><div id="orgForm" class="muted">'+t('加载中…','Loading…')+'</div></div>';
    let cur; try{ cur=await api('/api/platform/org'); }catch(e){ cur={}; }
    window.__orgLogo = cur.orgLogo || '';
    $('#orgForm').innerHTML=
       '<label>'+t('组织名称','Organization name')+'</label><input id="orgName" maxlength="80" value="'+esc(cur.orgName||'')+'">'
      +'<label>'+t('组织简介','About')+'</label><textarea id="orgIntro" maxlength="500">'+esc(cur.orgIntro||'')+'</textarea>'
      +'<label>'+t('组织网址','Website')+'</label><input id="orgUrl" maxlength="200" placeholder="https://" value="'+esc(cur.orgUrl||'')+'">'
      +'<label>'+t('对外联系方式','Contact')+'</label><input id="orgContact" maxlength="120" placeholder="'+t('邮箱 / 微信 / Telegram','email / WeChat / Telegram')+'" value="'+esc(cur.orgContact||'')+'">'
      +'<label>Logo <span class="muted">('+t('PNG 透明,自动裁为 180×180','transparent PNG, resized to 180×180')+')</span></label>'
      +'<div class="row" style="align-items:center;gap:12px"><div id="orgLogoPrev" class="orglogo-prev"></div><input id="orgLogoFile" type="file" accept="image/*"><button class="ghost" id="orgLogoClear">'+t('移除','Remove')+'</button></div>'
      +'<div class="row" style="margin-top:16px"><button id="orgSave">'+t('保存','Save')+'</button></div><div id="orgMsg"></div>';
    function drawLogo(){ $('#orgLogoPrev').innerHTML = window.__orgLogo ? '<img src="'+window.__orgLogo+'" alt="logo">' : '<span class="muted" style="font-size:12px">'+t('无','none')+'</span>'; }
    drawLogo();
    $('#orgLogoFile').addEventListener('change', async function(ev){
      const f=ev.target.files[0]; ev.target.value=''; if(!f) return;
      try{ window.__orgLogo=await compressLogo(f); drawLogo(); setMsg('orgMsg',t('Logo 已就绪,记得点保存','Logo ready — remember to Save')); }
      catch(e){ setMsg('orgMsg',e.message,true); }
    });
    $('#orgLogoClear').addEventListener('click',function(){ window.__orgLogo=''; drawLogo(); });
    $('#orgSave').addEventListener('click', async function(){
      $('#orgSave').disabled=true;
      try{ await api('/api/platform/org',{method:'POST',body:{orgName:$('#orgName').value.trim(),orgIntro:$('#orgIntro').value.trim(),orgUrl:$('#orgUrl').value.trim(),orgContact:$('#orgContact').value.trim(),orgLogo:window.__orgLogo}});
        setMsg('orgMsg',t('已保存 ✓','Saved ✓')); }
      catch(e){ setMsg('orgMsg',e.message,true); }
      $('#orgSave').disabled=false;
    });
  }
  async function renderDashboard(){
    if(!ME_USER.email){ go('/start'); return; }
    ME_USER = await api('/api/platform/me').catch(()=>ME_USER);
    const hs = ME_USER.hackathons || [];
    const cm = window.__createMode==='mini'?'mini':window.__createMode==='secret'?'secret':'open';
    const modeLabel = cm==='mini'?t('✨ Mini(5 分钟)','✨ Mini'):cm==='secret'?t('🔒 企业私密','🔒 Enterprise'):t('⚡ 常规','⚡ Regular');
    // Mini has its own free allowance; regular/secret share the quota. canCreate never blocks mini here.
    const canCreate = cm==='mini' || (ME_USER.used||0) < (ME_USER.quota||1);
    app.innerHTML = '<div class="guide"><h1>'+t('我组织的黑客松','Hackathons I organize')+'</h1>'
      + '<p class="muted">'+t('已用','Used')+' '+(ME_USER.used||0)+' / '+(ME_USER.quota||1)+'</p>'
      + (hs.length ? '<div class="guide-steps">'+hs.map(h=>'<div class="step"><div class="num" style="background:#0a0e0a">🏆</div><div style="flex:1"><h3>'+esc(h.name)+'</h3><p class="card-repo">'+esc(h.subdomain)+'.hack5.net</p></div><div class="row" style="gap:6px"><a href="'+h.url+'/poster"><button class="ghost" title="'+t('海报','Poster')+'">🎨</button></a ><a href="'+h.url+'/share"><button class="ghost" title="'+t('转发','Share')+'">🔗</button></a ><a href="'+h.url+'"><button class="ghost">'+t('进入 →','Open →')+'</button></a ></div></div>').join('')+'</div>' : '<p class="muted">'+t('还没有黑客松,创建第一个 👇','No hackathons yet — create your first 👇')+'</p>')
      + '<div class="panel" style="margin-top:18px;max-width:520px"><h2>'+t('创建新黑客松','Create a hackathon')+'</h2>'
      + (canCreate
          ? '<div class="muted" style="margin-bottom:10px">'+t('模式','Mode')+': <b>'+modeLabel+'</b>'+(cm!=='open'?' · <a href="#" onclick="window.__createMode=null;renderDashboard();return false" style="font-size:12px">'+t('换常规','switch to regular')+'</a>':'')+'</div>'
            + '<label>'+t('名称','Name')+'</label><input id="hName" maxlength="60" placeholder="'+t('例:上海 2026 黑客松','e.g. Shanghai 2026 Hackathon')+'">'
            + (cm==='mini' ? '' : '<label>'+t('子域名','Subdomain')+' <span class="muted">.hack5.net</span></label><input id="hSub" maxlength="30" placeholder="shanghai2026">')
            + (cm==='mini'
                ? '<label>'+t('一句话介绍','One-line intro')+' <span class="muted">'+t('(可选)','(optional)')+'</span></label><input id="hIntro" maxlength="2000" placeholder="'+t('这是一场关于…的 mini 黑客松','A mini hackathon about…')+'">'
                : '<label>'+t('黑客松简介','Intro')+' * <span class="muted">'+t('(会显示在首页,至少 10 字)','(shown on your homepage, 10+ chars)')+'</span></label><textarea id="hIntro" rows="3" maxlength="2000" placeholder="'+t('这是一场关于…的黑客松,面向…','A hackathon about… for…')+'"></textarea>')
            + (cm==='mini' ? '' : '<label>'+t('首页 Banner 图','Homepage banner')+' <span class="muted">'+t('(可选,不传给默认款)','(optional — default used)')+'</span></label><input id="hBanner" type="file" accept="image/png,image/jpeg,image/webp"><div id="hBannerPrev"></div>')
            + (cm==='open'
                ? '<label style="display:flex;align-items:center;gap:8px;margin-top:14px"><input type="checkbox" id="hSecret" style="width:auto"> '+t('🔒 私密 / 企业模式','🔒 Private / enterprise')+'</label><div id="hSecretOpts" style="display:none"><label>'+t('访问有效期(天)','Access validity (days)')+'</label><input id="hDays" type="number" min="1" max="90" value="7" style="max-width:120px"></div>'
                : cm==='secret' ? '<label>'+t('访问有效期(天)','Access validity (days)')+'</label><input id="hDays" type="number" min="1" max="90" value="7" style="max-width:120px">' : '')
            + '<div class="row" style="margin-top:14px"><button id="hCreate">'+(cm==='mini'?t('✨ 5 分钟创建','✨ Create in 5 min'):t('创建并部署','Create & deploy'))+'</button></div><div id="hMsg"></div>'
          : '<div class="notice">'+t('已达免费额度。充值 ¥99 可举办 100 场。','Free quota reached. Upgrade (¥99) for 100 hackathons.')+'</div><div class="row" style="margin-top:12px"><button id="hUpgrade">'+t('充值 ¥99','Upgrade ¥99')+'</button></div>')
      + '</div></div>';
    if(canCreate){
      const sc=$('#hSecret'); if(sc) sc.addEventListener('change', ()=>{ $('#hSecretOpts').style.display = sc.checked ? 'block' : 'none'; });
      const bf=$('#hBanner'); if(bf) bf.addEventListener('change', async ev=>{
        const f=ev.target.files[0]; ev.target.value=''; if(!f) return;
        try{ window.__hBanner=await compressBanner(f); $('#hBannerPrev').innerHTML='<img src="'+window.__hBanner+'" alt="banner" style="width:100%;max-width:380px;border-radius:10px;margin-top:8px;border:1px solid var(--line)">'; }
        catch(e){ setMsg('hMsg', t('图片处理失败','Image error')+': '+e.message, true); }
      });
      $('#hCreate').addEventListener('click', async ()=>{
        const name=$('#hName').value.trim();
        const subdomain = $('#hSub') ? $('#hSub').value.trim().toLowerCase() : '';
        const intro = $('#hIntro') ? $('#hIntro').value.trim() : '';
        if(!name){ setMsg('hMsg', t('请填写名称','Enter a name'), true); return; }
        if(cm!=='mini' && !subdomain){ setMsg('hMsg', t('请填写子域名','Enter a subdomain'), true); return; }
        if(cm!=='mini' && intro.length<10){ setMsg('hMsg', t('请写至少 10 字的简介','Add a 10+ character intro'), true); return; }
        const secretChecked = $('#hSecret') && $('#hSecret').checked;
        const mode = cm==='mini' ? 'mini' : (cm==='secret' || secretChecked) ? 'secret' : 'open';
        const accessDays = (mode==='secret' && $('#hDays')) ? Number($('#hDays').value)||7 : 7;
        $('#hCreate').disabled=true; setMsg('hMsg', t('创建中…','Creating…'));
        try {
          const r = await api('/api/platform/hackathons',{method:'POST',body:{name,subdomain,intro,banner:window.__hBanner,mode,accessDays}});
          window.__hBanner='';
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
        } catch(e){ if(e.data && e.data.upgrade){ setMsg('hMsg', e.message+' →', true); setTimeout(()=>go('/pricing'), 900); return; } setMsg('hMsg', e.message, true); $('#hCreate').disabled=false; }
      });
    } else {
      $('#hUpgrade').addEventListener('click', ()=>go('/pricing'));
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
    const banner = tn.hasBanner
      ? '<div class="hero-banner"><img src="/banner/'+esc(tn.subdomain)+'" alt=""></div>'
      : '<div class="hero-banner hero-default"><span class="hd-badge">&#8249;5&#8250;</span><span class="hd-name">'+esc(tn.name||'Hackathon')+'</span><span class="hd-sub">'+esc((tn.subdomain||'')+'.hack5.net')+'</span></div>';
    return '<div class="panel tenant-hero">'
      + banner
      + (tn.intro?'<p style="font-size:16px;color:var(--ink2);white-space:pre-wrap;margin:0 0 10px">'+esc(tn.intro)+'</p>':'')
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
      + '<label>'+t('首页 Banner','Homepage banner')+' <span class="muted">'+t('(宽幅,自动裁 ~2.9:1 并压 ≤120KB;不设则用默认款)','(wide ~2.9:1, ≤120KB; a default is used if unset)')+'</span></label>'
      + '<div id="fBannerPrev">'+(tn.hasBanner?'<img src="/banner/'+esc(tn.subdomain||'')+'?t='+Date.now()+'" alt="banner" style="width:100%;max-width:380px;border-radius:10px;border:1px solid var(--line);display:block;margin-bottom:8px">':'')+'</div>'
      + '<input id="fBanner" type="file" accept="image/*"><span id="fBannerMsg" class="muted"></span>'
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
    $('#fBanner').addEventListener('change', async ev=>{
      const f=ev.target.files[0]; ev.target.value=''; if(!f) return;
      setMsg('fBannerMsg', t('处理中…','Processing…'));
      try{ const b=await compressBanner(f); await api('/api/tenant/banner',{method:'POST',body:{banner:b}});
        $('#fBannerPrev').innerHTML='<img src="'+b+'" alt="banner" style="width:100%;max-width:380px;border-radius:10px;border:1px solid var(--line);display:block;margin-bottom:8px">';
        CONFIG = await api('/api/config'); setMsg('fBannerMsg', t('Banner 已更新 ✓','Banner updated ✓'));
      }catch(e){ setMsg('fBannerMsg', e.message, true); }
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
    const eyebrow = [tn.eventTime, tn.location].filter(Boolean).join('   ·   ');
    const bits=[]; if(tn.location)bits.push(['📍',tn.location]); if(tn.address)bits.push(['🏛',tn.address]);
    const sub = tn.subdomain||'';
    let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="100%" style="display:block">'
      + '<defs>'
      + '<linearGradient id="pbg" x1="0" y1="0" x2="0.4" y2="1"><stop offset="0" stop-color="#141a2e"/><stop offset="0.55" stop-color="#0c1020"/><stop offset="1" stop-color="#080a12"/></linearGradient>'
      + '<radialGradient id="pglow" cx="0.82" cy="0.12" r="0.5"><stop offset="0" stop-color="#5b4be6" stop-opacity="0.55"/><stop offset="1" stop-color="#5b4be6" stop-opacity="0"/></radialGradient>'
      + '<radialGradient id="pglow2" cx="0.1" cy="0.9" r="0.5"><stop offset="0" stop-color="#25ff86" stop-opacity="0.18"/><stop offset="1" stop-color="#25ff86" stop-opacity="0"/></radialGradient>'
      + '<linearGradient id="pcta" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#6d5cf0"/><stop offset="1" stop-color="#8b7bff"/></linearGradient>'
      + '<linearGradient id="pscrim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#080a12" stop-opacity="0.7"/><stop offset="0.45" stop-color="#080a12" stop-opacity="0.25"/><stop offset="1" stop-color="#080a12" stop-opacity="0.92"/></linearGradient>'
      + '</defs>'
      + (bg
          ? '<rect width="794" height="1123" fill="#080a12"/><image href="'+bg+'" x="0" y="0" width="794" height="1123" preserveAspectRatio="xMidYMid slice"/><rect width="794" height="1123" fill="url(#pscrim)"/>'
          : '<rect width="794" height="1123" fill="url(#pbg)"/><rect width="794" height="1123" fill="url(#pglow)"/><rect width="794" height="1123" fill="url(#pglow2)"/><text x="470" y="1050" font-family="ui-monospace,monospace" font-size="520" font-weight="800" fill="#ffffff" opacity="0.03">5</text>')
      + '<g transform="translate(64,74)"><rect width="52" height="52" rx="14" fill="#ffffff" opacity="0.08"/><rect width="52" height="52" rx="14" fill="none" stroke="#ffffff" stroke-opacity="0.14"/><text x="26" y="35" text-anchor="middle" font-family="ui-monospace,monospace" font-size="23" font-weight="800" fill="#25ff86">&#8249;5&#8250;</text></g>'
      + '<text x="130" y="108" font-family="ui-monospace,monospace" font-size="27" font-weight="800" fill="#ffffff" letter-spacing="0.5">hack5</text>'
      + '<text x="730" y="105" text-anchor="end" font-family="-apple-system,sans-serif" font-size="13" fill="#8b93b5" letter-spacing="4">HACKATHON</text>';
    let y=300;
    if(eyebrow){ svg+='<text x="64" y="'+y+'" font-family="-apple-system,sans-serif" font-size="19" font-weight="600" fill="#8b7bff" letter-spacing="1.5">'+esc(eyebrow.slice(0,60))+'</text>'; y+=20; }
    y+=48;
    nameLines.forEach((ln,i)=>{ svg+='<text x="62" y="'+(y+i*(nameFs+4))+'" font-family="Inter,-apple-system,sans-serif" font-size="'+nameFs+'" font-weight="800" fill="#ffffff" letter-spacing="-1">'+esc(ln)+'</text>'; });
    y = y + nameLines.length*(nameFs+4) + 18;
    svg+='<rect x="64" y="'+y+'" width="64" height="5" rx="2.5" fill="#25ff86"/>'; y+=44;
    introLines.forEach((ln,i)=>{ svg+='<text x="64" y="'+(y+i*36)+'" font-family="-apple-system,sans-serif" font-size="24" fill="#aeb6cc">'+esc(ln)+'</text>'; });
    y += introLines.length*36 + 40;
    bits.forEach((b,i)=>{ svg+='<text x="64" y="'+(y+i*46)+'" font-family="-apple-system,sans-serif" font-size="22" fill="#dbe0ee">'+b[0]+'  '+esc(String(b[1]).slice(0,40))+'</text>'; });
    svg += '<g transform="translate(64,968)"><rect width="666" height="96" rx="20" fill="url(#pcta)"/><rect width="666" height="96" rx="20" fill="none" stroke="#ffffff" stroke-opacity="0.15"/>'
      + '<text x="34" y="42" font-family="-apple-system,sans-serif" font-size="16" font-weight="600" fill="#ffffff" opacity="0.85" letter-spacing="0.5">'+t('报名 · 提交作品','Join &amp; submit')+'</text>'
      + '<text x="34" y="74" font-family="ui-monospace,monospace" font-size="30" font-weight="800" fill="#ffffff">'+esc(sub)+'.hack5.net</text></g>'
      + '<text x="730" y="1100" text-anchor="end" font-family="-apple-system,sans-serif" font-size="12" fill="#5a6285" letter-spacing="0.5">Mycelium · Digital Public Goods</text>'
      + '</svg>';
    return svg;
  }
  function paint(bg){ const svg=posterSvg(bg); window.__posterSvg=svg; window.__posterBg=bg||''; $('#posterBox').innerHTML=svg; }
  // Rasterize the free A4 poster to a PNG blob (for share/download).
  function posterBlob(){ return new Promise(function(res,rej){
    const svg=posterSvg(''); const img=new Image();
    const u=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml;charset=utf-8'}));
    img.onload=function(){ const c=document.createElement('canvas'); c.width=794; c.height=1123; c.getContext('2d').drawImage(img,0,0,794,1123); URL.revokeObjectURL(u); c.toBlob(function(b){ b?res(b):rej(new Error('fail')); },'image/png'); };
    img.onerror=function(){ URL.revokeObjectURL(u); rej(new Error('fail')); }; img.src=u;
  }); }
  async function copyText(str,elId){ try{ await navigator.clipboard.writeText(str); setMsg(elId,t('已复制 ✓','Copied ✓')); }catch(e){ setMsg(elId,t('复制失败,请手动选择','Copy failed—select manually'),true); } }
  function shareLink(href,label,color){ return '<a target="_blank" rel="noopener" href="'+href+'" class="splat"><span class="sdot" style="background:'+color+'"></span>'+esc(label)+'</a>'; }
  function renderShare(){
    if(!CONFIG.tenant){ go('/'); return; }
    const tn=CONFIG.tenant; const sub=tn.subdomain||'';
    const url='https://'+sub+'.hack5.net';
    const meta=[]; if(tn.eventTime)meta.push('📅 '+tn.eventTime); if(tn.location)meta.push('📍 '+tn.location);
    const caption=(tn.name||'Hackathon')+'\n'+(tn.intro?tn.intro+'\n':'')+(meta.length?meta.join('   ')+'\n':'')
      +'👉 '+t('报名 / 提交作品:','Join / submit: ')+url+'\n#hackathon #hack5';
    const hasNative = !!(navigator.share);
    app.innerHTML='<h1>'+t('一键转发','Share')+'</h1>'
      +'<p class="muted">'+t('下面是自动生成的海报和文案。复制文案 + 下载海报,发到公众号 / 小红书 / 微信群 / Telegram 群;手机可直接用系统分享。','Here are your auto-generated poster and caption. Copy the caption, download the poster, and post to your channels.')+'</p>'
      +'<div class="share-grid">'
      +'<div><div id="shPosterBox" class="share-poster"></div>'
      +'<a target="_blank" rel="noopener" href="'+url+'/poster" style="display:inline-block;margin-top:8px;font-size:13px;font-weight:600">'+t('🎨 换成 AI 定制海报(付费)→','🎨 Make an AI poster (premium) →')+'</a></div>'
      +'<div class="panel">'
      +'<label>'+t('分享文案','Caption')+'</label><textarea id="shCap" rows="6">'+esc(caption)+'</textarea>'
      +(hasNative?'<button id="shNative" style="width:100%;margin-top:12px;font-size:15px;padding:12px">📲 '+t('分享到微信 / 更多(含海报)','Share to WeChat / more (with poster)')+'</button>':'')
      +'<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">'
      +'<button class="ghost" id="shCopyCap">'+t('复制文案','Copy caption')+'</button>'
      +'<button class="ghost" id="shCopyUrl">'+t('复制链接','Copy link')+'</button>'
      +'<button class="ghost" id="shPoster">'+t('下载海报','Download poster')+'</button>'
      +'</div>'
      +'<div class="muted" style="margin:14px 0 6px;font-size:12px">'+t('分享到平台','Post to a platform')+'</div>'
      +'<div class="share-plats">'
      +shareLink('https://service.weibo.com/share/share.php?url='+encodeURIComponent(url)+'&title='+encodeURIComponent(caption),'微博','#e6162d')
      +shareLink('https://sns.qzone.qq.com/cgi-bin/qzshare/cgi_qzshare_onekey?url='+encodeURIComponent(url)+'&title='+encodeURIComponent((tn.name||'hack5'))+'&summary='+encodeURIComponent(caption),'QQ空间','#f7b500')
      +shareLink('https://t.me/share/url?url='+encodeURIComponent(url)+'&text='+encodeURIComponent(caption),'Telegram','#229ed9')
      +shareLink('https://twitter.com/intent/tweet?text='+encodeURIComponent(caption),'X','#111')
      +shareLink('https://www.facebook.com/sharer/sharer.php?u='+encodeURIComponent(url),'Facebook','#1877f2')
      +shareLink('https://www.linkedin.com/sharing/share-offsite/?url='+encodeURIComponent(url),'LinkedIn','#0a66c2')
      +'</div>'
      +'<div class="share-qr"><img src="/qr/'+esc(sub)+'" alt="'+t('报名二维码','Join QR')+'" width="132" height="132"><div><div style="font-weight:700;font-size:14px">'+t('微信 / 相机扫码打开','Scan to open')+'</div><div class="muted" style="font-size:12px;margin-top:2px">'+t('电脑上微信分享:扫这个码,或复制链接粘到微信。','On desktop WeChat: scan this, or copy the link.')+'</div><a href="/qr/'+esc(sub)+'" target="_blank" rel="noopener" style="font-size:13px;font-weight:600">'+t('下载二维码 →','Download QR →')+'</a></div></div>'
      +'<div id="shMsg" class="muted" style="margin-top:8px"></div></div>'
      +'</div>';
    $('#shPosterBox').innerHTML = posterSvg('');
    $('#shCopyCap').addEventListener('click',()=>copyText($('#shCap').value,'shMsg'));
    $('#shCopyUrl').addEventListener('click',()=>copyText(url,'shMsg'));
    $('#shPoster').addEventListener('click',async()=>{
      setMsg('shMsg',t('生成海报中…','Rendering poster…'));
      try{ const b=await posterBlob(); const u=URL.createObjectURL(b); const a=document.createElement('a'); a.href=u; a.download='hack5-poster.png'; a.click(); setTimeout(()=>URL.revokeObjectURL(u),1000); setMsg('shMsg',t('海报已下载 ✓','Poster downloaded ✓')); }
      catch(e){ setMsg('shMsg',t('海报生成失败','Poster failed'),true); }
    });
    if(hasNative) $('#shNative').addEventListener('click',async()=>{
      const data={ title:tn.name||'hack5', text:$('#shCap').value, url:url };
      try{ const b=await posterBlob(); const f=new File([b],'hack5-poster.png',{type:'image/png'}); if(navigator.canShare && navigator.canShare({files:[f]})) data.files=[f]; }catch(e){}
      try{ await navigator.share(data); }catch(e){}
    });
  }
  async function loadAiPanel(){
    const box=$('#aiPanel'); if(!box) return;
    let q; try{ q=await api('/api/tenant/poster/quota'); }catch(e){ box.innerHTML='<span class="muted">'+t('AI 海报加载失败','AI panel failed')+'</span>'; return; }
    if(!q.aiEnabled){ box.innerHTML='<b>'+t('AI 海报','AI poster')+'</b><p class="muted">'+t('暂未开通','Not enabled yet')+'</p>'; return; }
    box.innerHTML =
       '<div class="row" style="justify-content:space-between;align-items:center"><b>'+t('AI 海报','AI poster')+'</b><span style="font-family:ui-monospace,monospace;font-size:12px;color:var(--brand);border:1px solid var(--line);border-radius:20px;padding:2px 10px">gpt-image-1</span></div>'
      +'<div class="row" style="gap:10px;margin:12px 0 4px;align-items:center"><button id="aiFree">'+t('🎨 免费生成(固定风格)','🎨 Free (fixed style)')+'</button><span class="muted">'+t('剩','left')+' '+q.free+'/'+q.freeCap+'</span></div>'
      +'<p class="muted" style="margin:0 0 4px;font-size:12px">'+t('免费:用你的活动名/简介 + 品牌固定画风生成背景。','Free: a fixed on-brand style built from your event name/intro.')+'</p>'
      +'<hr style="border:0;border-top:1px solid var(--line);margin:14px 0">'
      +'<div class="row" style="justify-content:space-between;align-items:center"><b style="font-size:14px">'+t('自定义(付费)','Custom (premium)')+'</b><span class="muted">'+t('剩','left')+' '+q.custom+'/'+q.customCap+t(' · 每场'+q.customCap+'次',' · '+q.customCap+'/event')+'</span></div>'
      +'<textarea id="aiPrompt" rows="2" maxlength="500" placeholder="'+t('例:赛博朋克夜景,霓虹紫青配色','e.g. cyberpunk night, neon purple-teal')+'" style="margin-top:8px"></textarea>'
      +'<div class="row" style="margin-top:10px;gap:8px"><button id="aiCustom">'+t('✨ 生成自定义海报','✨ Generate custom')+'</button><button class="ghost" id="aiClear">'+t('恢复模板版','Reset to template')+'</button><span id="aiMsg" class="muted"></span></div>';
    $('#aiFree').addEventListener('click', ()=>genAi('free'));
    $('#aiCustom').addEventListener('click', ()=>genAi('custom'));
    $('#aiClear').addEventListener('click', ()=>{ paint(''); });
  }
  async function genAi(mode){
    const prompt = mode==='custom' ? $('#aiPrompt').value.trim() : '';
    if(mode==='custom' && !prompt){ setMsg('aiMsg', t('先描述画风','Describe a style first'), true); return; }
    const btn = mode==='free'?$('#aiFree'):$('#aiCustom');
    if(btn) btn.disabled=true; setMsg('aiMsg', t('生成中,约 15-30 秒…','Generating, ~15-30s…'));
    try{ const r=await api('/api/tenant/poster/ai',{method:'POST',body:{mode,prompt}});
      if(!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(r.image||'')) throw new Error(t('返回无效','Invalid response'));
      paint(r.image);
      await loadAiPanel(); setMsg('aiMsg', t('完成 ✓ 剩 ','Done ✓ left ')+r.remaining);
    }catch(e){ setMsg('aiMsg', e.message, true); if(btn) btn.disabled=false; }
  }
  function renderPoster(){
    if(!CONFIG.tenant){ go('/'); return; }
    const isAdmin = ME.role==='admin';
    app.innerHTML = '<div class="row" style="justify-content:space-between;align-items:center;flex-wrap:wrap"><h1>'+t('宣传海报','Promo poster')+'</h1>'
      + '<div class="row"><button id="dlPng">'+t('下载 PNG','Download PNG')+'</button><button class="ghost" id="dlSvg">'+t('下载 SVG','Download SVG')+'</button></div></div>'
      + '<p class="muted">'+t('A4 竖版,用你首页的信息(名称/时间/地点)自动生成。免费可换成 AI 固定画风背景。','A4 portrait, auto-built from your homepage info. Free AI (fixed style) background available.')+'</p>'
      + (isAdmin ? '<div id="aiPanel" class="panel" style="max-width:640px;margin-bottom:16px"><span class="muted">'+t('加载中…','Loading…')+'</span></div>' : '')
      + '<div id="posterBox" style="max-width:460px;border:1px solid var(--line);border-radius:10px;overflow:hidden;box-shadow:var(--shadow)"></div>';
    paint('');
    if(isAdmin) loadAiPanel();
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
    const isMini = !!(CONFIG.tenant && CONFIG.tenant.mode==='mini');
    app.innerHTML = '<h1>'+t('报名参加','Register')+'</h1>'
      + '<p class="muted">'+esc((CONFIG.tenant&&CONFIG.tenant.name)||'')+'</p>'
      + adminBlock
      + '<div class="panel" style="max-width:460px"><div id="regForm">'
      + (isMini ? '' : '<label>'+t('姓名','Name')+' *</label><input id="rgName" maxlength="60">')
      + '<label>'+t('邮箱','Email')+' *</label><input id="rgEmail" type="email" maxlength="254" placeholder="you@example.com">'
      + (isMini ? '<p class="muted" style="margin:6px 0 0;font-size:13px">'+t('用户名将自动取自邮箱','Your display name is taken from your email')+'</p>' : '')
      + '<label>'+t('想法 / 找队友(可选)','Idea / looking for a team (optional)')+'</label><textarea id="rgNote" maxlength="300"></textarea>'
      + '<div class="row" style="margin-top:14px"><button id="rgBtn">'+t('提交报名','Register')+'</button></div>'
      + '<div id="rgMsg"></div></div></div>';
    $('#rgBtn').addEventListener('click', async ()=>{
      const nameEl=$('#rgName'); const name=nameEl?nameEl.value.trim():''; const email=$('#rgEmail').value.trim(), note=$('#rgNote').value.trim();
      if(!email||(!isMini&&!name)){ setMsg('rgMsg', isMini?t('请填写邮箱','Email required'):t('请填写姓名和邮箱','Name and email required'), true); return; }
      $('#rgBtn').disabled=true;
      try{ const r=await api('/api/tenant/register',{method:'POST',body:{name,email,note}});
        const done = r.already ? t('你已经报名过了 ✓','You are already registered ✓') : t('报名成功!🎉','Registered! 🎉');
        let next;
        if(isMini){
          next = '<p style="margin:10px 0 6px"><b>'+t('下一步','What is next')+'</b></p>'
            + '<div class="row" style="gap:8px;flex-wrap:wrap"><button onclick="go(\'/submit\')">'+t('提交作品','Submit your work')+'</button>'
            + '<button class="ghost" onclick="go(\'/make\')">✨ '+t('AI 做成应用','Build with AI')+'</button></div>'
            + '<p class="muted" style="margin-top:8px;font-size:13px">'+t('贴上你的作品链接即可参赛,或让 AI 把想法做成能跑的应用。请收藏本页 —— 活动都在这里,系统不会给你发邮件。','Submit a link to your work, or let AI turn your idea into a working app. Bookmark this page — everything happens here and no email is sent.')+'</p>';
        } else {
          next = '<p style="margin:10px 0 6px"><b>'+t('下一步','What is next')+'</b></p>'
            + '<p class="muted" style="font-size:13px">'+t('主办方会把你的参赛邀请码发给你(微信 / 邮件 / 群)。拿到后,到「提交作品」填邀请码提交。请收藏本页 —— 系统不会给你发邮件。','The organizer will send you an invite code (WeChat / email / group). Once you have it, go to Submit and enter it. Bookmark this page — no email is sent by the system.')+'</p>'
            + '<div class="row" style="margin-top:6px"><button onclick="go(\'/submit\')">'+t('去提交作品','Go to Submit')+'</button></div>';
        }
        $('#regForm').innerHTML='<div class="notice ok">'+done+'</div>'+next;
      }catch(e){ setMsg('rgMsg', e.message, true); $('#rgBtn').disabled=false; }
    });
  }

  // ---------------- team formation board ----------------
  function teamCard(p){
    const rows=[];
    if(p.skills) rows.push('<div class="trow"><span class="tk">'+t('会','Can')+'</span>'+esc(p.skills)+'</div>');
    if(p.looking_for) rows.push('<div class="trow"><span class="tk">'+t('找','Wants')+'</span>'+esc(p.looking_for)+'</div>');
    if(p.idea) rows.push('<div class="tidea">'+esc(p.idea)+'</div>');
    return '<div class="tcard">'
      +(ME.role==='admin'?'<span class="tmdel" data-id="'+esc(p.id)+'" title="'+t('删除','Delete')+'">×</span>':'')
      +'<div class="tname">'+esc(p.name)+'</div>'
      +rows.join('')
      +'<div class="tcontact">📇 '+esc(p.contact)+'</div></div>';
  }
  async function loadTeams(){
    const board=$('#tmBoard'); if(!board) return;
    try{ const d=await api('/api/tenant/teams'); const posts=d.posts||[];
      if(!posts.length){ board.innerHTML='<p class="muted">'+t('还没有人发布,来当第一个 👋','No posts yet — be the first 👋')+'</p>'; return; }
      board.innerHTML='<div class="teamgrid">'+posts.map(teamCard).join('')+'</div>';
      if(ME.role==='admin') board.querySelectorAll('.tmdel').forEach(x=>x.addEventListener('click',async()=>{
        if(!confirm(t('删除这张卡片?','Delete this card?'))) return;
        try{ await api('/api/tenant/teams/'+x.dataset.id,{method:'DELETE'}); loadTeams(); }catch(e){ alert(e.message); }
      }));
    }catch(e){ board.innerHTML='<p class="muted">'+t('加载失败','Failed to load')+'</p>'; }
  }
  function renderTeams(){
    if(!CONFIG.tenant){ go('/'); return; }
    app.innerHTML='<h1>'+t('组队 · 找队友','Find teammates')+'</h1>'
      +'<p class="muted">'+t('发一张卡片:你会什么、想做什么、想找什么样的队友。联系方式会公开显示,方便别人直接找你。','Post a card: what you can do, what you want to build, who you are looking for. Your contact is shown publicly so others can reach you.')+'</p>'
      +'<div class="panel" style="max-width:560px;margin-bottom:20px"><div id="tmForm">'
      +'<label>'+t('昵称','Name')+' *</label><input id="tmName" maxlength="40">'
      +'<label>'+t('联系方式','Contact')+' * (TG / '+t('微信','WeChat')+' / '+t('邮箱','Email')+')</label><input id="tmContact" maxlength="80" placeholder="TG @you / '+t('微信','WeChat')+' your-id">'
      +'<label>'+t('我会什么 / 角色','Skills / role')+'</label><input id="tmSkills" maxlength="120" placeholder="'+t('前端 / 设计 / 合约 …','frontend / design / contracts …')+'">'
      +'<label>'+t('想找什么队友','Looking for')+'</label><input id="tmLooking" maxlength="120">'
      +'<label>'+t('想做的方向(可选)','Idea (optional)')+'</label><textarea id="tmIdea" maxlength="300"></textarea>'
      +'<div class="row" style="margin-top:12px"><button id="tmBtn">'+t('发布','Post')+'</button></div><div id="tmMsg"></div>'
      +'</div></div><div id="tmBoard" class="muted">'+t('加载中…','Loading…')+'</div>';
    $('#tmBtn').addEventListener('click',async()=>{
      const name=$('#tmName').value.trim(), contact=$('#tmContact').value.trim();
      if(!name||!contact){ setMsg('tmMsg',t('请填写昵称和联系方式','Name and contact required'),true); return; }
      $('#tmBtn').disabled=true;
      try{ await api('/api/tenant/teams',{method:'POST',body:{name,contact,skills:$('#tmSkills').value.trim(),lookingFor:$('#tmLooking').value.trim(),idea:$('#tmIdea').value.trim()}});
        $('#tmForm').innerHTML='<div class="notice ok">'+t('已发布,祝你早日找到队友 🎉','Posted — good luck! 🎉')+'</div>'; loadTeams();
      }catch(e){ setMsg('tmMsg',e.message,true); $('#tmBtn').disabled=false; }
    });
    loadTeams();
  }

  // A4 — build-status badge (buckets the fine-grained build_state into 排队/构建/上线/失败).
  function buildBadge(s){
    const st = s.buildState;
    if(!st) return '';
    const map = {
      queued:['⏳','排队中','Queued','#6b7280'],
      planning:['🛠','构建中','Building','#d97706'],
      coding:['🛠','构建中','Building','#d97706'],
      reviewing:['🛠','构建中','Building','#d97706'],
      deployed:['✅','已上线','Live','#16a34a'],
      failed:['⚠️','构建失败','Build failed','#dc2626']
    };
    const m = map[st]; if(!m) return '';
    let badge = '<span class="chip" style="border-color:'+m[3]+';color:'+m[3]+'">'+m[0]+' '+esc(t(m[1],m[2]))+'</span>';
    if(st==='deployed' && s.appUrl){
      badge += ' <a class="chip" href="'+esc(s.appUrl)+'" target="_blank" rel="noopener" onclick="event.stopPropagation()">🔗 '+t('试用','Try it')+'</a>';
    }
    return '<div class="card-build" style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">'+badge+'</div>';
  }
  function card(s){
    const isMini = CONFIG.tenant && CONFIG.tenant.mode==='mini';
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
      + (isMini
          ? (s.linkUrl?'<div class="card-repo">🔗 '+esc((s.linkUrl||'').replace(/^https?:\/\//,'').slice(0,40))+'</div>':'')
          : '<div class="card-repo">'+esc(s.repoOwner)+'/'+esc(s.repoName)+'</div>')
      + (s.description?'<div class="card-desc">'+esc(s.description)+'</div>':'')
      + (isMini ? buildBadge(s) : '')
      + (isMini
          ? '<div class="card-meta"><button class="likebtn" data-id="'+esc(s.id)+'">♥ <span>'+(s.likes||0)+'</span></button></div>'
          : '<div class="card-meta" data-gh="'+esc(s.repoOwner)+'/'+esc(s.repoName)+'"><span class="chip">★ …</span></div>')
      + '</div>';
    // carousel nav + click image to open detail
    wireCarousel(el.querySelector('.carousel'), ()=>go(s.viewUrl));
    el.querySelector('.card-body').addEventListener('click', (e)=>{ if(e.target.closest('.likebtn')) return; go(s.viewUrl); });
    if(isMini){
      const lb=el.querySelector('.likebtn');
      if(lb) lb.addEventListener('click', async (e)=>{ e.stopPropagation(); try{ const r=await api('/api/submissions/'+s.id+'/like',{method:'POST',body:{}}); lb.querySelector('span').textContent=r.likes; lb.classList.add('liked'); }catch(err){} });
    } else {
      loadGhMeta(el.querySelector('.card-meta'));
    }
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
      + '<div class="row" style="gap:8px">'
      + '<button class="ghost" id="dShare">🔗 '+t('分享','Share')+'</button>'
      + (s.repoUrl?'<a class="row" href="'+esc(s.repoUrl)+'" target="_blank" rel="noopener"><button>'+t('查看代码','View code')+' ↗</button></a >':'')
      + '</div>'
      + '</div>'
      + '<div class="detail-grid">'
      + '<div>'
      + videoHtml
      + (shotsCar ? '<h2 style="margin-top:22px">'+t('产品截图','Screenshots')+'</h2>'+shotsCar+'<div class="muted" style="margin-top:6px;font-size:12px">'+t('点图看大图','Click to enlarge')+'</div>' : '')
      + (s.linkUrl ? '' : '<h2 style="margin-top:22px">README</h2><div id="readmeWrap"><button class="ghost" id="loadReadme">'+t('加载 README','Load README')+'</button></div>')
      + '</div>'
      + '<div>'
      + '<div class="panel">'
      + '<h2>'+esc(s.projectName)+'</h2>'
      + (s.teamName?'<div class="muted">👥 '+esc(s.teamName)+'</div>':'')
      + (s.description?'<p style="color:var(--ink2)">'+esc(s.description)+'</p>':'')
      // A5 — WorkBench build block: status badge + 在线试用(app_url)+ 公有仓库(repo_url), only when set.
      + ((s.buildState||s.appUrl||s.wbClient) ? buildBadge(s)
          + (s.appUrl?'<div class="kv"><span>'+t('在线试用','Try it live')+'</span><b><a href="'+esc(s.appUrl)+'" target="_blank" rel="noopener">'+t('打开','Open')+' ↗</a ></b></div>':'')
          + (s.repoUrl?'<div class="kv"><span>'+t('公有仓库','Public repo')+'</span><b><a href="'+esc(s.repoUrl)+'" target="_blank" rel="noopener">'+t('打开','Open')+' ↗</a ></b></div>':'')
        : '')
      + (s.secret && s.demoUrl?'<div class="kv"><span>'+t('在线 Demo','Live demo')+'</span><b><a href="'+esc(s.demoUrl)+'" target="_blank" rel="noopener">'+t('打开','Open')+' ↗</a ></b></div>':'')
      + (s.secret && s.demoUser?'<div class="kv"><span>'+t('Demo 账号','Demo user')+'</span><b>'+esc(s.demoUser)+'</b></div>':'')
      + (s.secret && s.demoPass?'<div class="kv"><span>'+t('Demo 密码','Demo pass')+'</span><b>'+esc(s.demoPass)+'</b></div>':'')
      + (s.linkUrl
          ? '<div class="kv"><span>'+t('作品链接','Work link')+'</span><b><a href="'+esc(s.linkUrl)+'" target="_blank" rel="noopener">'+t('打开','Open')+' ↗</a ></b></div>'
          : '<div class="kv"><span>'+(s.secret?t('私有仓库','Private repo'):t('仓库','Repo'))+'</span><b><a href="'+esc(s.repoUrl)+'" target="_blank" rel="noopener">'+esc(s.repoOwner)+'/'+esc(s.repoName)+'</a ></b></div>'
            + (s.secret?'<div class="muted" style="font-size:12px">'+t('作为协作者可 clone 评估','Clone it as a collaborator to review')+'</div>':''))
      + (s.linkUrl?'<div class="kv"><span>👍 '+t('点赞','Likes')+'</span><b><button class="likebtn" id="dLike" data-id="'+esc(s.id)+'">♥ <span>'+(s.likes||0)+'</span></button></b></div>':'')
      + '<div id="ghMeta"></div>'
      + (s.lockedSha?'<div class="kv"><span>'+t('评审版本','Reviewed')+'</span><b title="'+esc(s.lockedSha)+'">'+esc(s.lockedSha.slice(0,10))+'</b></div>':'')
      + (s.email?'<div class="kv"><span>'+t('邮箱','Email')+'</span><b><a href="mailto:'+esc(s.email)+'">'+esc(s.email)+'</a ></b></div>':'')
      + (s.contact?'<div class="kv"><span>'+t('联系','Contact')+'</span><b>'+esc(s.contact)+'</b></div>':'')
      + '</div>'
      + '<div id="scorePanel"></div>'
      + '<div id="adminPanel"></div>'
      + '</div>'
      + '</div>';

    // detail like button (mini)
    const dl=$('#dLike'); if(dl) dl.addEventListener('click', async ()=>{ try{ const r=await api('/api/submissions/'+s.id+'/like',{method:'POST',body:{}}); dl.querySelector('span').textContent=r.likes; dl.classList.add('liked'); }catch(e){} });
    // share (A5) — native share sheet, fallback to clipboard copy of the /s/<id> link
    const sh=$('#dShare'); if(sh) sh.addEventListener('click', async ()=>{ const url=location.origin+'/s/'+s.id; try{ if(navigator.share){ await navigator.share({title:s.projectName,url}); } else { await navigator.clipboard.writeText(url); const o=sh.textContent; sh.textContent='✓ '+t('已复制','Copied'); setTimeout(()=>{sh.textContent=o;},1500); } }catch(e){} });
    // github meta — skipped for secret (private repo) and mini (no repo)
    if(!s.secret && !s.linkUrl) api('/api/gh/'+s.repoOwner+'/'+s.repoName).then(d=>{
      $('#ghMeta').innerHTML =
        '<div class="kv"><span>Stars</span><b>★ '+(d.stars??0)+'</b></div>'
        + (d.language?'<div class="kv"><span>'+t('语言','Language')+'</span><b>'+esc(d.language)+'</b></div>':'')
        + '<div class="kv"><span>'+t('最后提交','Last push')+'</span><b>'+fmtDate(d.pushedAt)+'</b></div>'
        + (d.homepage?'<div class="kv"><span>'+t('官网','Homepage')+'</span><b><a href="'+esc(d.homepage)+'" target="_blank" rel="noopener">'+t('链接','link')+' ↗</a ></b></div>':'');
    }).catch(()=>{});

    // screenshots carousel + lightbox
    const dcar = app.querySelector('.detail-shots');
    if(dcar) wireCarousel(dcar, ()=>{ const cur = dcar.querySelector('img.on'); if(cur) openLightbox(cur.src); });

    // readme — secret: render the pasted markdown (escaped) directly; open: fetch from GitHub
    function readmeFrame(inner){
      const frame = document.createElement('iframe');
      frame.className = 'readme-frame';
      frame.setAttribute('sandbox','allow-popups allow-popups-to-escape-sandbox');
      frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:ui-monospace,Menlo,monospace;padding:16px 20px;color:#14161c;line-height:1.6;white-space:pre-wrap;word-break:break-word}</style></head><body>'+inner+'</body></html>';
      $('#readmeWrap').innerHTML=''; $('#readmeWrap').appendChild(frame);
    }
    if(s.secret){
      $('#readmeWrap').innerHTML='';
      readmeFrame(esc(s.readmeMd||t('(未提供 README)','(no README)')));
    } else if(!s.linkUrl && $('#loadReadme'))
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
  async function renderSecretSubmit(){
    if(!CONFIG.tenant){ go('/'); return; }
    let roster = [];
    try{ roster = (await api('/api/tenant/judges/roster')).judges || []; }catch(e){}
    const rosterHtml = roster.length
      ? '<div class="panel" style="max-width:720px;margin-bottom:16px"><b>'+t('本场评委 —— 把他们加为你私有仓库的协作者','Judges — add them as collaborators on your private repo')+'</b>'
        + '<table class="media-table" style="margin-top:10px"><thead><tr><th>'+t('评委','Judge')+'</th><th>GitHub</th></tr></thead><tbody>'
        + roster.map(j=>'<tr><td>'+esc(j.name)+'</td><td>'+(j.github?'<a href="https://github.com/'+esc(j.github)+'" target="_blank" rel="noopener">@'+esc(j.github)+'</a >':'<span class="muted">—</span>')+'</td></tr>').join('')
        + '</tbody></table><p class="muted" style="font-size:12px;margin:8px 2px 0">'+t('在你的仓库 Settings → Collaborators 逐个添加上面账号,评审期保持,结束后可移除。','Add each handle in your repo Settings → Collaborators; keep during judging, remove after.')+'</p></div>'
      : '<div class="panel" style="max-width:720px;margin-bottom:16px"><span class="muted">'+t('评委名单尚未公布,可先提交,稍后回来加协作者。','Judge roster not published yet — you can submit and add collaborators later.')+'</span></div>';
    app.innerHTML = '<h1>'+t('提交作品(私密赛)','Submit (private track)')+'</h1>'
      + '<div class="notice">'+t('私密赛不公开源码:提供在线 Demo + 账号密码给评委体验;代码放 GitHub 私有仓库,把评委加为协作者。','Private track — no public source: give judges an online demo + credentials; keep code in a private repo and add the judges as collaborators.')+'</div>'
      + rosterHtml
      + '<div class="panel" style="max-width:720px">'
      + '<label>'+t('产品名称','Product name')+' *</label><input id="sProj" maxlength="80">'
      + '<label>'+t('在线 Demo 链接','Online demo URL')+' *</label><input id="sDemo" placeholder="https://your-demo.app">'
      + '<label>'+t('Demo 账号','Demo username')+' * <span class="muted">'+t('(仅评委可见)','(judges only)')+'</span></label><input id="sUser" maxlength="120">'
      + '<label>'+t('Demo 密码','Demo password')+' * <span class="muted">'+t('(仅评委可见)','(judges only)')+'</span></label><input id="sPass" maxlength="200">'
      + '<label>'+t('项目 README(粘贴 Markdown)','README (paste Markdown)')+' *</label><textarea id="sReadme" rows="8" maxlength="20000" placeholder="# 项目\n介绍、技术栈、亮点…"></textarea>'
      + '<label>'+t('GitHub 私有仓库链接','Private repo URL')+' *</label><input id="sRepo" placeholder="https://github.com/owner/repo">'
      + '<label>'+t('演示视频链接(可选)','Demo video (optional)')+'</label><input id="sVideo" placeholder="https://...">'
      + '<label>'+t('联系邮箱','Contact email')+' *</label><input id="sEmail" type="email" maxlength="254" placeholder="you@example.com">'
      + '<label>'+t('队伍名称(可选)','Team (optional)')+'</label><input id="sTeam" maxlength="80">'
      + '<div class="row" style="margin-top:16px"><button id="sBtn">'+t('提交','Submit')+'</button></div><div id="sMsg"></div>'
      + '</div>';
    $('#sBtn').addEventListener('click', doSecretSubmit);
  }
  async function doSecretSubmit(){
    const body = { projectName:$('#sProj').value.trim(), demoUrl:$('#sDemo').value.trim(), demoUser:$('#sUser').value.trim(), demoPass:$('#sPass').value.trim(), readmeMd:$('#sReadme').value.trim(), repoUrl:$('#sRepo').value.trim(), videoUrl:$('#sVideo').value.trim(), email:$('#sEmail').value.trim(), teamName:$('#sTeam').value.trim() };
    if(!body.projectName||!body.demoUrl||!body.demoUser||!body.demoPass||!body.readmeMd||!body.repoUrl||!body.email){ setMsg('sMsg', t('请填齐带 * 的必填项','Fill in all required (*) fields'), true); return; }
    $('#sBtn').disabled=true; setMsg('sMsg', t('提交中…','Submitting…'));
    try{ const r=await api('/api/submissions',{method:'POST',body});
      setMsg('sMsg', t('提交成功!','Submitted! ')+'<a href="'+r.viewUrl+'" onclick="go(\''+r.viewUrl+'\');return false">'+t('查看','View')+'</a ><br>'+t('编辑令牌(改稿用,请保存):','Edit token (save it to edit later): ')+'<code>'+esc(r.editToken)+'</code>', false, true);
    }catch(e){ setMsg('sMsg', e.message, true); }
    finally{ $('#sBtn').disabled=false; }
  }
  // A3 — mini「做成应用」: multi-turn chat → provision repo + trigger loop, then it appears on the wall.
  async function renderMiniMakeApp(){
    if(!CONFIG.tenant || CONFIG.tenant.mode!=='mini'){ go('/'); return; }
    let clientSlug='', projectSlug='', ready=false, lastIdea='';
    app.innerHTML = '<h1>✨ '+t('让 AI 帮我做成应用','Turn your idea into an app')+'</h1>'
      + '<div class="notice">'+t('说说你的想法,AI 会追问补全;准备好后自动建公有仓库 + 编码 + 部署。','Describe your idea — the AI asks follow-ups, then provisions a public repo, codes and deploys it.')+'</div>'
      + '<div class="panel" style="max-width:680px">'
      + '<div id="chatLog" style="display:flex;flex-direction:column;gap:8px;margin-bottom:10px"></div>'
      + '<div id="readyBar" style="margin-bottom:8px"></div>'
      + '<div class="row" style="gap:8px"><textarea id="chatIn" rows="2" maxlength="1000" placeholder="'+t('例:帮小区做一个团购小工具…','e.g. a group-buy tool for my neighborhood…')+'" style="flex:1"></textarea><button id="chatSend">'+t('发送','Send')+'</button></div>'
      + '<div id="chatMsg" class="muted" style="margin-top:6px"></div>'
      + '<div id="launchBox" style="margin-top:12px"></div>'
      + '</div>';
    const log=$('#chatLog');
    function addMsg(who, text){
      const d=document.createElement('div');
      d.style.cssText = who==='me'
        ? 'align-self:flex-end;background:#2563eb;color:#fff;padding:8px 12px;border-radius:12px;max-width:82%'
        : 'align-self:flex-start;background:var(--panel2,rgba(127,127,127,.12));padding:8px 12px;border-radius:12px;max-width:82%';
      d.textContent=text; log.appendChild(d); log.scrollTop=log.scrollHeight;
    }
    function renderReady(r){
      if(!r){ $('#readyBar').innerHTML=''; return; }
      const pct=Math.max(0,Math.min(100,r.score||0));
      $('#readyBar').innerHTML = '<div class="muted" style="font-size:12px;margin-bottom:2px">'+t('规格完备度','Spec readiness')+' '+pct+'%'+(r.loop_ready?' · ✅ '+t('可以开始生成','ready to build'):'')+'</div>'
        + '<div style="height:8px;border-radius:4px;background:var(--line,#333);overflow:hidden"><div style="height:100%;width:'+pct+'%;background:'+(r.loop_ready?'#16a34a':'#d97706')+'"></div></div>';
      if(r.loop_ready && !ready){ ready=true; showLaunch(); }
    }
    function showLaunch(){
      $('#launchBox').innerHTML = '<div class="notice ok">'+t('规格已就绪!给作品起个仓库名(小写字母/数字/连字符),AI 就开始建仓 + 编码。','Spec ready! Pick a repo name (lowercase, digits, hyphens) and it will provision + code.')+'</div>'
        + '<label>'+t('仓库名','Repo name')+' *</label><input id="mkRepo" maxlength="39" placeholder="my-cool-app">'
        + '<label>'+t('作品名称','Project name')+'</label><input id="mkName" maxlength="80">'
        + '<label>'+t('联系邮箱','Contact email')+' *</label><input id="mkEmail" type="email" maxlength="254" placeholder="you@example.com">'
        + '<div class="row" style="margin-top:12px"><button id="mkGo">🚀 '+t('开始生成','Build it')+'</button></div><div id="mkMsg"></div>';
      $('#mkGo').addEventListener('click', doLaunch);
    }
    async function send(){
      const input=$('#chatIn').value.trim();
      if(!input) return;
      lastIdea=input;
      addMsg('me', input); $('#chatIn').value=''; $('#chatSend').disabled=true; setMsg('chatMsg', t('思考中…','Thinking…'));
      try{
        const r=await api('/api/tenant/mini/app/chat',{method:'POST',body:{clientSlug,projectSlug,input}});
        clientSlug=r.clientSlug; projectSlug=r.projectSlug;
        if(r.reply) addMsg('ai', r.reply);
        renderReady(r.readiness); setMsg('chatMsg','');
      }catch(e){ setMsg('chatMsg', e.message, true); }
      $('#chatSend').disabled=false;
    }
    async function doLaunch(){
      const repoName=$('#mkRepo').value.trim(), email=$('#mkEmail').value.trim(), projectName=$('#mkName').value.trim();
      if(!repoName||!email){ setMsg('mkMsg', t('请填仓库名和邮箱','Repo name and email required'), true); return; }
      $('#mkGo').disabled=true; setMsg('mkMsg', t('建仓 + 触发编码中…','Provisioning…'));
      try{
        const r=await api('/api/tenant/mini/app/launch',{method:'POST',body:{clientSlug,projectSlug,repoName,email,projectName,idea:lastIdea}});
        $('#launchBox').innerHTML = '<div class="notice ok">🎉 '+t('已排队构建!','Queued!')+' '+t('队列位','Queue')+' #'+(r.queuePos||1)+'<br>'
          + t('公有仓库','Repo')+': <a href="'+esc(r.repoUrl)+'" target="_blank" rel="noopener">'+esc(r.repoUrl)+'</a ><br>'
          + '<a href="'+esc(r.viewUrl)+'" onclick="go(\''+esc(r.viewUrl)+'\');return false">'+t('查看作品详情 →','View project →')+'</a > · '+t('编辑令牌','Edit token')+': <code>'+esc(r.editToken)+'</code></div>';
      }catch(e){ setMsg('mkMsg', e.message, true); $('#mkGo').disabled=false; }
    }
    $('#chatSend').addEventListener('click', send);
    $('#chatIn').addEventListener('keydown', e=>{ if(e.key==='Enter' && (e.metaKey||e.ctrlKey)){ e.preventDefault(); send(); } });
  }
  async function renderMiniSubmit(){
    if(!CONFIG.tenant){ go('/'); return; }
    app.innerHTML = '<h1>'+t('提交作品','Submit')+'</h1>'
      + '<div class="notice">'+t('Mini 赛:不用写代码,交一个作品链接就行 —— no-code 应用 / 网站 / 文档 / 视频都可以。','Mini track: no coding — just submit a work link (no-code app / site / doc / video).')+'</div>'
      + '<div class="guide-banner" onclick="go(\'/make\')" style="cursor:pointer"><span>✨ '+t('还没做出来?让 AI 把你的想法直接做成应用','No app yet? Let AI turn your idea into one')+'</span><b>→</b></div>'
      + '<div class="panel" style="max-width:640px">'
      + '<label>'+t('作品名称','Product name')+' *</label><input id="mProj" maxlength="80">'
      + '<div class="row" style="margin-top:6px"><button class="ghost" id="mNameAI">✨ '+t('AI 帮我起名','AI names it')+'</button><span id="mNameMsg" class="muted"></span></div>'
      + '<div id="mNames" class="row" style="flex-wrap:wrap;gap:6px;margin-top:4px"></div>'
      + '<label>'+t('作品链接','Work link')+' *</label><input id="mLink" placeholder="https://...">'
      + '<label>'+t('一句话介绍','One-line intro')+' <span class="muted">'+t('(可让 AI 帮你写)','(AI can help)')+'</span></label>'
      + '<textarea id="mDesc" rows="3" maxlength="300" placeholder="'+t('你的作品是做什么的?','What does it do?')+'"></textarea>'
      + '<div class="row" style="margin-top:6px"><button class="ghost" id="mAI">✨ '+t('AI 帮我写简介','AI writes it')+'</button><span id="mAIMsg" class="muted"></span></div>'
      + '<label style="margin-top:12px">'+t('截图','Screenshots')+' <span class="muted">'+t('(可选,'+CONFIG.minShots+'–'+CONFIG.maxShots+' 张)','(optional)')+'</span></label><input id="mShots" type="file" accept="image/*" multiple><div class="thumbs" id="mThumbs"></div>'
      + '<label>'+t('联系邮箱','Contact email')+' *</label><input id="mEmail" type="email" maxlength="254" placeholder="you@example.com">'
      + '<label>'+t('队伍/昵称(可选)','Team/name (optional)')+'</label><input id="mTeam" maxlength="80">'
      + '<div class="row" style="margin-top:16px"><button id="mBtn">'+t('提交','Submit')+'</button></div><div id="mMsg"></div>'
      + '</div>';
    SHOTS = [];
    $('#mShots').addEventListener('change', async ev=>{ const files=[...ev.target.files]; ev.target.value=''; for(const f of files){ if(SHOTS.length>=CONFIG.maxShots){ alert(t('最多 ','Max ')+CONFIG.maxShots); break; } try{ SHOTS.push(await compress(f)); }catch(e){ alert(t('图片处理失败','Image error')); } } renderMiniThumbs(); });
    $('#mNameAI').addEventListener('click', async ()=>{
      const idea=($('#mDesc').value.trim()||$('#mProj').value.trim()), link=$('#mLink').value.trim();
      if(!idea && !link){ setMsg('mNameMsg', t('先写点想法/简介或链接','Add an idea or link first'), true); return; }
      $('#mNameAI').disabled=true; setMsg('mNameMsg', t('起名中…','Naming…'));
      try{
        const r=await api('/api/tenant/mini/name',{method:'POST',body:{idea,link}});
        const names=r.names||[];
        $('#mNames').innerHTML = names.map(n=>'<button type="button" class="ghost" data-n="'+esc(n)+'">'+esc(n)+'</button>').join('');
        $('#mNames').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ $('#mProj').value=b.dataset.n; setMsg('mNameMsg', t('✓ 已填入,可再改','✓ filled, edit as you like')); }));
        setMsg('mNameMsg', names.length? t('点一个填入','tap one to use') : t('没想出来,再试一次','try again'));
      }catch(e){ setMsg('mNameMsg', e.message, true); }
      $('#mNameAI').disabled=false;
    });
    $('#mAI').addEventListener('click', async ()=>{
      const name=$('#mProj').value.trim(), link=$('#mLink').value.trim();
      if(!name && !link){ setMsg('mAIMsg', t('先填作品名或链接','Add a name or link first'), true); return; }
      $('#mAI').disabled=true; setMsg('mAIMsg', t('生成中…','Writing…'));
      try{ const r=await api('/api/tenant/mini/assist',{method:'POST',body:{name,link}}); $('#mDesc').value=r.text||''; setMsg('mAIMsg', t('✓ 可以再改改','✓ edit as you like')); }
      catch(e){ setMsg('mAIMsg', e.message, true); }
      $('#mAI').disabled=false;
    });
    $('#mBtn').addEventListener('click', async ()=>{
      const body={ projectName:$('#mProj').value.trim(), linkUrl:$('#mLink').value.trim(), description:$('#mDesc').value.trim(), email:$('#mEmail').value.trim(), teamName:$('#mTeam').value.trim(), shots:SHOTS };
      if(!body.projectName||!body.linkUrl||!body.email){ setMsg('mMsg', t('请填齐作品名、链接、邮箱','Fill in name, link and email'), true); return; }
      $('#mBtn').disabled=true; setMsg('mMsg', t('提交中…','Submitting…'));
      try{ const r=await api('/api/submissions',{method:'POST',body});
        setMsg('mMsg', t('提交成功!','Submitted! ')+'<a href="'+r.viewUrl+'" onclick="go(\''+r.viewUrl+'\');return false">'+t('查看','View')+'</a ><br>'+t('编辑令牌(改稿用):','Edit token: ')+'<code>'+esc(r.editToken)+'</code>', false, true);
        SHOTS=[];
      }catch(e){ setMsg('mMsg', e.message, true); }
      finally{ $('#mBtn').disabled=false; }
    });
  }
  function renderMiniThumbs(){ $('#mThumbs').innerHTML = SHOTS.map((d,i)=>'<div class="t"><img src="'+d+'"><span class="x" data-i="'+i+'">×</span></div>').join(''); $('#mThumbs').querySelectorAll('.x').forEach(x=>x.addEventListener('click',()=>{ SHOTS.splice(Number(x.dataset.i),1); renderMiniThumbs(); })); }
  async function renderSubmit(){
    if(CONFIG.tenant && CONFIG.tenant.mode==='mini') return renderMiniSubmit();
    if(CONFIG.tenant && CONFIG.tenant.mode==='secret') return renderSecretSubmit();
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
      + '<label>'+t('邮箱','Email')+' * <span class="muted">('+t('仅主办方/评委可见,用于联系你','organizer/judges only, to reach you')+')</span></label><input id="email" type="email" maxlength="254" placeholder="you@example.com">'
      + '<label>'+t('其他联系方式','Other contact')+' <span class="muted">('+t('可选,如微信','optional, e.g. WeChat')+')</span></label><input id="contact" maxlength="120" placeholder="'+t('微信 / Telegram …','WeChat / Telegram …')+'">'
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
  // Homepage banner: crop to a wide hero ratio (~2.9:1) and step JPEG quality down until <=120KB.
  function compressBanner(file){
    return new Promise(function(resolve,reject){
      if(!file.type.startsWith('image/')) return reject(new Error(t('请选择图片','Pick an image')));
      const img=new Image(); const url=URL.createObjectURL(file);
      img.onload=function(){
        const ratio=1280/440;
        let cw=img.width, ch=Math.round(img.width/ratio);
        if(ch>img.height){ ch=img.height; cw=Math.round(img.height*ratio); }
        const sx=Math.round((img.width-cw)/2), sy=Math.round((img.height-ch)/2);
        const outW=Math.min(cw,1280), outH=Math.round(outW/ratio);
        const c=document.createElement('canvas'); c.width=outW; c.height=outH;
        c.getContext('2d').drawImage(img,sx,sy,cw,ch,0,0,outW,outH); URL.revokeObjectURL(url);
        let q=0.85, out=c.toDataURL('image/jpeg',q);
        while(dataUrlBytes(out)>120000 && q>0.4){ q-=0.1; out=c.toDataURL('image/jpeg',q); }
        if(dataUrlBytes(out)>120000) return reject(new Error(t('图片太大,换一张更简单的','Image too large — try another')));
        resolve(out);
      };
      img.onerror=function(){ URL.revokeObjectURL(url); reject(new Error(t('无法读取图片','Cannot read image'))); };
      img.src=url;
    });
  }

  async function doSubmit(){
    const body = {
      passcode: $('#passcode').value.trim(),
      projectName: $('#projectName').value.trim(),
      teamName: $('#teamName').value.trim(),
      email: $('#email').value.trim(),
      contact: $('#contact').value.trim(),
      repoUrl: $('#repoUrl').value.trim(),
      description: $('#description').value.trim(),
      videoUrl: $('#videoUrl').value.trim(),
      shots: SHOTS,
    };
    if(!body.projectName || !body.repoUrl || !body.videoUrl){ setMsg('submitMsg',t('请填齐产品名、仓库、视频链接','Fill in product name, repo and video link'),true); return; }
    if(!body.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)){ setMsg('submitMsg',t('请填写有效邮箱','Enter a valid email'),true); return; }
    if(!body.passcode){ setMsg('submitMsg',t('请填写邀请码','Enter your invite code'),true); return; }
    if(SHOTS.length < CONFIG.minShots){ setMsg('submitMsg',t('请至少上传 ','At least ')+CONFIG.minShots+t(' 张截图',' screenshots required'),true); return; }
    $('#submitBtn').disabled = true; setMsg('submitMsg',t('提交中…','Submitting…'));
    try {
      const r = await api('/api/submissions',{method:'POST',body});
      setMsg('submitMsg',t('提交成功!','Submitted! ')+'<a href="'+r.viewUrl+'" onclick="go(\''+r.viewUrl+'\');return false">'+t('查看作品','View project')+'</a ><br>'+t('编辑令牌(改稿用,请保存):','Edit token (save it to edit later): ')+'<code>'+esc(r.editToken)+'</code>', false, true);
      SHOTS = []; renderThumbs();
      ['#projectName','#repoUrl','#videoUrl','#description','#teamName','#email','#contact','#passcode'].forEach(id=>{ const el = $(id); if(el) el.value = ''; });
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
  async function renderMiniUsage(){
    if(!CONFIG.tenant){ go('/'); return; }
    app.innerHTML = '<h1>'+t('用量与计费','Usage & billing')+'</h1>'
      + '<div class="notice">'+t('只读:mini 首场免费,之后按 token 累计待结算。真实用量需 WorkBench 联调后显示。','Read-only: first mini event free, then metered. Real figures appear after WorkBench integration.')+'</div>'
      + '<div id="usageBox" class="panel"><p>'+t('加载中…','Loading…')+'</p></div>';
    try{
      const u = await api('/api/tenant/mini/usage');
      const rows = (u.perProject||[]).map(p=>'<tr><td>'+esc(p.project)+'</td><td style="text-align:right">'+Number(p.tokens||0).toLocaleString()+'</td><td style="text-align:right">'+(p.requests==null?'—':p.requests)+'</td></tr>').join('');
      $('#usageBox').innerHTML =
        '<div class="row" style="gap:20px;flex-wrap:wrap;align-items:flex-end">'
        + '<div><div class="muted">'+t('总 token','Total tokens')+'</div><div style="font-size:26px;font-weight:700">'+Number(u.totalTokens||0).toLocaleString()+'</div></div>'
        + '<div><div class="muted">'+t('参赛者','Participants')+'</div><div style="font-size:26px;font-weight:700">'+(u.participants||0)+'</div></div>'
        + (u.mock?'<span class="chip" style="border-color:#d97706;color:#d97706">mock</span>':'')
        + '</div>'
        + '<table style="width:100%;margin-top:14px;border-collapse:collapse"><thead><tr><th style="text-align:left;border-bottom:1px solid var(--line,#333)">'+t('参赛作品','Project')+'</th><th style="text-align:right;border-bottom:1px solid var(--line,#333)">token</th><th style="text-align:right;border-bottom:1px solid var(--line,#333)">'+t('请求','Requests')+'</th></tr></thead><tbody>'+(rows||'<tr><td colspan="3" class="muted">'+t('暂无用量','No usage yet')+'</td></tr>')+'</tbody></table>'
        + '<div class="muted" style="margin-top:10px">'+esc(u.freeTier?u.freeTier.model:'')+(u.at?' · '+esc(u.at):'')+'</div>';
    }catch(e){ $('#usageBox').innerHTML = '<p class="muted">'+esc(e.message)+'</p>'; }
  }
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
      + '<label>'+t('评委(每行一个:姓名 或 姓名, GitHub)','Judges (one per line: name, or name, github)')+' <span class="muted">'+t('GitHub 用于私密赛加协作者','GitHub is for private-track collaborators')+'</span></label><textarea id="jNames" rows="5" placeholder="'+t('张三, alice-gh&#10;李四, bob-gh','Alice, alice-gh&#10;Bob, bob-gh')+'"></textarea>'
      + '<div class="row" style="margin-top:6px"><div style="flex:1"><label>'+t('前缀','Prefix')+'</label><input id="jPrefix" maxlength="8" value="J"></div>'
      + '<div style="align-self:flex-end"><button id="jGen">'+t('生成登录码','Generate codes')+'</button></div></div>'
      + '<div id="jGenOut"></div></div>'
      + '<div class="panel" style="margin-top:16px"><div class="row" style="justify-content:space-between"><h2 style="margin:0">'+t('已有评委','Judges')+'</h2>'
      + '<button class="ghost" id="jCopy">'+t('复制全部(姓名+码)','Copy all (name + code)')+'</button></div>'
      + '<div id="jList" style="margin-top:12px"><p class="muted">'+t('加载中…','Loading…')+'</p></div></div>';

    $('#jGen').addEventListener('click', async ()=>{
      const lines = $('#jNames').value.split('\n').map(s=>s.trim()).filter(Boolean);
      const names = lines.map(l=>l.split(',')[0].trim());
      const githubs = lines.map(l=>{ const p=l.split(','); return p.length>1?p.slice(1).join(',').trim():''; });
      const prefix = $('#jPrefix').value.trim();
      if(!names.filter(Boolean).length){ alert(t('请至少输入一个姓名','Enter at least one name')); return; }
      $('#jGen').disabled = true;
      try {
        const r = await api('/api/judges',{method:'POST',body:{names,githubs,prefix}});
        $('#jGenOut').innerHTML = '<div class="notice ok">'+t('已生成 ','Generated ')+r.count+t(' 个,发给各评委:',' — hand out to judges:')+'</div>'
          + '<textarea readonly rows="6" style="font-family:ui-monospace,monospace">'+r.judges.map(j=>j.name+(j.github?' (@'+j.github+')':'')+'  '+j.code).join('\n')+'</textarea>';
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
    if(!res.ok){ const err = new Error(data.error||(t('请求失败 ','Request failed ')+res.status)); err.status = res.status; err.data = data; throw err; }
    return data;
  }
  </script>
</body>
</html>`;
