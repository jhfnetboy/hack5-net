// Participant public-repo provisioning for hack5 Mini (contract §5 v2 · CC-51 · constraint B2).
//
// SECURITY MODEL (B2 — highest-priority constraint):
//   - Public repos for mini output live under an ISOLATED bot account/org (e.g. `hack5-mini-bot`),
//     NEVER the main org, so hackathon output quality/safety is not tied to our reputation.
//   - hack5 (this Worker) holds ONE server-side credential to *create* repos: either a GitHub App
//     (preferred) or a bot fine-grained token (`GITHUB_BOT_TOKEN`), stored only as a CF secret.
//   - Each idea's PUSH credential is a REPO-SCOPED, SHORT-LIVED token (GitHub App installation
//     token restricted to that one repo, `contents:write`). It is minted on demand at the
//     git-push boundary and is:
//       * NEVER an account-level PAT,
//       * NEVER written to env / loop.json / the worktree (invisible to the loop's code sandbox),
//       * NEVER logged.
//   Nothing in this module logs a token; callers must treat the returned token as a secret and
//   use it only at the push boundary, then discard it.
//
// Mock mode (WORKBENCH_MOCK=1, or no bot/App credentials configured) returns deterministic fake
// data with NO network calls and NO real secrets, so the whitelist + create→token→delete flow is
// testable via `wrangler dev` before the bot account / App is provisioned (real GitHub is blocked
// on that provisioning, same class as A8).

export interface RepoBotEnv {
  // Repo creation credential (any of — HACK5_GITHUB_PAT is the existing CF secret / ~/Dev/.env one):
  GITHUB_BOT_TOKEN?: string; // bot account/org fine-grained token — create + delete + push
  HACK5_GITHUB_PAT?: string; // existing hack5 bot PAT (clestons account); alias of GITHUB_BOT_TOKEN
  GITHUB_BOT_OWNER?: string; // bot login that owns the repos (default: clestons)
  GITHUB_BOT_IS_ORG?: string; // "1" if the bot owner is an org (uses /orgs/:org/repos)
  // Repo-scoped short-lived push token via GitHub App (preferred for B2):
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----")
  GITHUB_APP_INSTALLATION_ID?: string;
  WORKBENCH_MOCK?: string; // "1" forces offline mock
}

const DEFAULT_BOT_OWNER = "clestons";
const GITHUB_API = "https://api.github.com";

// The bot credential: prefer GITHUB_BOT_TOKEN, fall back to the existing HACK5_GITHUB_PAT (clestons).
function botToken(env: RepoBotEnv): string | undefined {
  return env.GITHUB_BOT_TOKEN || env.HACK5_GITHUB_PAT;
}

// Repo-name whitelist (defends against path injection / weird GitHub names). Lower-case,
// digit/hyphen, must start alphanumeric, 1..39 chars — mirrors the plan's B2 whitelist.
const REPO_NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export interface RepoNameCheck {
  ok: boolean;
  name?: string;
  error?: string;
}

export function validateRepoName(input: unknown): RepoNameCheck {
  const name = String(input ?? "").trim();
  if (!name) return { ok: false, error: "仓库名不能为空 / Repo name required" };
  if (name.length > 39) return { ok: false, error: "仓库名过长(最多 39 字符)/ Repo name too long" };
  if (!REPO_NAME_RE.test(name)) {
    return { ok: false, error: "仓库名只能用小写字母、数字、连字符,且以字母或数字开头 / lowercase a-z 0-9 and -, must start alphanumeric" };
  }
  if (name.endsWith("-")) return { ok: false, error: "仓库名不能以连字符结尾 / cannot end with a hyphen" };
  return { ok: true, name };
}

export interface ParticipantRepo {
  owner: string;
  name: string;
  fullName: string;
  htmlUrl: string;
  cloneUrl: string; // https clone URL (no embedded credential)
  apiUrl: string;
  mock?: boolean;
}

// A repo-scoped, short-lived push credential. Treat `token` as a secret: use it only at the
// git-push boundary and never persist or log it.
export interface RepoPushToken {
  token: string;
  expiresAt: string; // ISO
  repository: string; // repo the token is scoped to
  mock?: boolean;
}

export function repoBotMockEnabled(env: RepoBotEnv): boolean {
  return env.WORKBENCH_MOCK === "1" || !botToken(env);
}

function botOwner(env: RepoBotEnv): string {
  return env.GITHUB_BOT_OWNER || DEFAULT_BOT_OWNER;
}

// ---------------------------------------------------------------------------
// GitHub REST helper (never logs the token)
// ---------------------------------------------------------------------------

interface GhResult {
  status: number;
  ok: boolean;
  json: unknown;
  message: string;
}

async function githubApi(method: string, path: string, token: string, body?: unknown, extraAccept?: string): Promise<GhResult> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      "User-Agent": "hack5-mini-repo-provisioner",
      Accept: extraAccept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const message = (json && typeof json === "object" && "message" in json ? String((json as { message: unknown }).message) : "") || text.slice(0, 200);
  return { status: res.status, ok: res.ok, json, message };
}

// ---------------------------------------------------------------------------
// GitHub App JWT + installation token (repo-scoped short-lived push token)
// ---------------------------------------------------------------------------

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlFromString(s: string): string {
  return b64urlFromBytes(new TextEncoder().encode(s));
}

function pemToPkcs8Bytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// RS256 JWT for GitHub App auth. Private key must be PKCS#8 PEM (convert PKCS#1 with:
// `openssl pkcs8 -topk8 -nocrypt -in app.pem`). We keep the JWT lifetime short (<=9 min).
async function mintAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: now - 30, exp: now + 9 * 60, iss: appId };
  const signingInput = `${b64urlFromString(JSON.stringify(header))}.${b64urlFromString(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8Bytes(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
  return `${signingInput}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

async function mintInstallationToken(env: RepoBotEnv, repository: string): Promise<RepoPushToken> {
  if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY || !env.GITHUB_APP_INSTALLATION_ID) {
    throw new Error("GitHub App not configured (need GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_INSTALLATION_ID) for repo-scoped push tokens");
  }
  const jwt = await mintAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await githubApi("POST", `/app/installations/${encodeURIComponent(env.GITHUB_APP_INSTALLATION_ID)}/access_tokens`, jwt, {
    repositories: [repository],
    permissions: { contents: "write" }, // scoped to a single repo's contents only
  });
  if (!res.ok) throw new Error(`installation token mint failed: ${res.status} ${res.message}`);
  const data = res.json as { token?: string; expires_at?: string };
  if (!data?.token) throw new Error("installation token response missing token");
  return { token: data.token, expiresAt: data.expires_at || "", repository };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function mockRepo(owner: string, name: string): ParticipantRepo {
  return {
    owner,
    name,
    fullName: `${owner}/${name}`,
    htmlUrl: `https://github.com/${owner}/${name}`,
    cloneUrl: `https://github.com/${owner}/${name}.git`,
    apiUrl: `${GITHUB_API}/repos/${owner}/${name}`,
    mock: true,
  };
}

// Create the participant's public repo under the isolated bot owner. Validates the name first.
export async function createParticipantRepo(env: RepoBotEnv, rawName: string, opts?: { description?: string }): Promise<ParticipantRepo> {
  const check = validateRepoName(rawName);
  if (!check.ok || !check.name) throw new Error(check.error || "invalid repo name");
  const name = check.name;
  const owner = botOwner(env);

  if (repoBotMockEnabled(env)) return mockRepo(owner, name);

  const token = botToken(env) as string;
  const isOrg = env.GITHUB_BOT_IS_ORG === "1";
  const body = {
    name,
    private: false, // Mini output is public by design (B2)
    auto_init: true,
    has_issues: true,
    has_wiki: false,
    description: opts?.description?.slice(0, 200),
  };
  const path = isOrg ? `/orgs/${encodeURIComponent(owner)}/repos` : `/user/repos`;
  const res = await githubApi("POST", path, token, body);
  if (!res.ok) throw new Error(`repo create failed: ${res.status} ${res.message}`);
  const d = res.json as { name: string; owner?: { login?: string }; full_name: string; html_url: string; clone_url: string; url: string };
  return {
    owner: d.owner?.login || owner,
    name: d.name,
    fullName: d.full_name,
    htmlUrl: d.html_url,
    cloneUrl: d.clone_url,
    apiUrl: d.url,
  };
}

// Mint the repo-scoped PUSH token (B2). Secret — use only at the push boundary, never log it.
// Order: offline mock → GitHub App installation token (preferred: repo-scoped + short-lived) →
// a repo-scoped fine-grained bot PAT via GITHUB_BOT_TOKEN (A8 联调 fallback, "PAT 不用 App").
export async function mintRepoScopedPushToken(env: RepoBotEnv, repoName: string): Promise<RepoPushToken> {
  const check = validateRepoName(repoName);
  if (!check.ok || !check.name) throw new Error(check.error || "invalid repo name");
  const name = check.name;
  // Offline mock (WORKBENCH_MOCK=1 or no bot credential): fake token, no real secret.
  if (repoBotMockEnabled(env)) {
    return { token: `mock-push-token-${name}`, expiresAt: new Date(0).toISOString(), repository: name, mock: true };
  }
  // Preferred: GitHub App installation token scoped to this one repo.
  if (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID) {
    return mintInstallationToken(env, name);
  }
  // Fallback: a repo-scoped fine-grained bot PAT supplied via GITHUB_BOT_TOKEN. MUST be repo-scoped
  // (never account-level, per B2). Reaching here means WORKBENCH_MOCK is off and GITHUB_BOT_TOKEN is set.
  const pat = botToken(env);
  if (pat) {
    return { token: pat, expiresAt: "", repository: name };
  }
  throw new Error("no push credential: configure a GitHub App or a repo-scoped GITHUB_BOT_TOKEN / HACK5_GITHUB_PAT");
}

// Delete a repo (used for one-off provisioning self-tests). Needs delete permission on the bot token.
export async function deleteParticipantRepo(env: RepoBotEnv, repoName: string): Promise<{ deleted: boolean; status: number; mock?: boolean }> {
  const check = validateRepoName(repoName);
  if (!check.ok || !check.name) throw new Error(check.error || "invalid repo name");
  const owner = botOwner(env);
  if (repoBotMockEnabled(env)) return { deleted: true, status: 204, mock: true };
  const res = await githubApi("DELETE", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(check.name)}`, botToken(env) as string);
  return { deleted: res.status === 204, status: res.status };
}
