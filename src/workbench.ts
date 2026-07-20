// WorkBench (fde-copilot + loop-engineer) client for hack5 Mini.
//
// Implements the §5 v2 contract finalised in Seeder · Cooperation-Center · CC-51:
//   fde-copilot:   POST /api/clients, POST /api/clients/:c/projects, POST /api/chat,
//                  POST /api/commit, GET /api/usage
//   loop-engineer: POST /plan, POST /run (enqueue semantics — B1), GET /status/:jobId
//
// Two-layer auth (B3): orchestration calls (clients/projects/commit/plan/run/status/usage)
// carry the admin `x-workbench-token: WORKBENCH_TOKEN`. Participant chat carries a
// hack5-signed *scoped* token whose claim pins the client/project path; WorkBench verifies
// the signature and that the claim matches the request subtree. hack5 is the sole issuer.
//
// Mock mode (WORKBENCH_MOCK=1, or no WORKBENCH_BASE_URL configured) returns contract-shaped
// fake data with no network calls, so the whole hack5 UI + data flow (A3–A7) can be built and
// tested before the real WorkBench / Mac Mini is online (A8 real integration is blocked on W1/W2).

export interface WorkbenchEnv {
  WORKBENCH_BASE_URL?: string; // e.g. https://self-fde-workbench.example
  WORKBENCH_TOKEN?: string; // admin orchestration token (B3)
  WORKBENCH_CALLBACK_SECRET?: string; // HMAC key to verify inbound W5 callbacks (used elsewhere)
  WORKBENCH_MOCK?: string; // "1" forces the offline mock
  AUTH_SECRET?: string; // pepper used to sign scoped chat tokens (B3)
}

// ---------------------------------------------------------------------------
// Contract v2 shapes
// ---------------------------------------------------------------------------

export interface WbClient {
  slug: string;
  name?: string;
  [k: string]: unknown;
}

export interface WbProject {
  slug: string;
  name?: string;
  deliverableName?: string;
  deliverableType?: string;
  [k: string]: unknown;
}

export interface WbReadiness {
  score: number; // 0..100
  loop_ready: boolean;
}

export interface WbChatResult {
  result: { readiness: WbReadiness; reply?: string };
  commit?: { sha?: string; pushed?: boolean } | null;
}

export interface WbCommitResult {
  pushed: boolean;
  sha: string;
  repo?: string;
  [k: string]: unknown;
}

export type WbJobState = "queued" | "planning" | "coding" | "reviewing" | "done" | "failed";

export interface WbPlanResult {
  jobId: string;
}

// B1: /run has enqueue semantics — never 409; the caller shows queuePos in the UI.
export interface WbRunResult {
  accepted: boolean;
  jobId: string;
  queuePos: number;
}

export interface WbStatus {
  state: WbJobState;
  jobId?: string;
  prUrl?: string;
  appUrl?: string;
}

export interface WbUsageBucket {
  tokens: number;
  requests?: number;
}

export interface WbUsage {
  global: WbUsageBucket;
  perProject: Record<string, WbUsageBucket>;
  byClient?: Record<string, WbUsageBucket>;
  at: string; // ISO timestamp
}

// Inputs
export interface CreateClientInput {
  name: string;
  background?: string;
}
export interface CreateProjectInput {
  name: string;
  deliverableName?: string;
  deliverableType?: string;
}
export interface ChatInput {
  clientSlug: string;
  projectSlug: string;
  input: string;
  attachments?: unknown[];
}
export interface CommitInput {
  clientSlug: string;
  projectSlug: string;
  push: boolean;
  repo?: string; // W2: target repo remote URL
}
export interface PlanInput {
  clientSlug: string;
  projectSlug: string;
  repo: string;
}

export interface WorkbenchClient {
  readonly mock: boolean;
  createClient(input: CreateClientInput): Promise<{ client: WbClient }>;
  createProject(clientSlug: string, input: CreateProjectInput): Promise<{ project: WbProject }>;
  chat(input: ChatInput, opts?: { scopedToken?: string }): Promise<WbChatResult>;
  commit(input: CommitInput): Promise<WbCommitResult>;
  plan(input: PlanInput): Promise<WbPlanResult>;
  run(jobId: string): Promise<WbRunResult>;
  status(jobId: string): Promise<WbStatus>;
  usage(clientSlug?: string): Promise<WbUsage>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function workbenchMockEnabled(env: WorkbenchEnv): boolean {
  return env.WORKBENCH_MOCK === "1" || !env.WORKBENCH_BASE_URL;
}

// Lower-case, hyphenated, ASCII slug for deterministic mock ids (also handy for real requests).
export function slugify(input: string, fallback = "x"): string {
  const s = String(input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40);
  // Strip anything still non-ASCII (e.g. CJK that NFKD leaves intact) so ids stay URL-safe.
  const ascii = s.replace(/[^a-z0-9-]/g, "");
  return ascii || fallback;
}

async function hmacHex(key: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(input: string): string {
  return btoa(input).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

// B3: hack5-signed scoped chat token. Claim pins client/project path + expiry, HMAC-signed
// with AUTH_SECRET. WorkBench verifies the signature and that the claim matches the request
// subtree. Format: base64url(JSON claim) + "." + hmacHex(claim).
export async function mintScopedChatToken(
  env: WorkbenchEnv,
  clientSlug: string,
  projectSlug: string,
  ttlSeconds = 3600,
): Promise<string> {
  const secret = env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET required to sign scoped chat token");
  const claim = JSON.stringify({
    c: clientSlug,
    p: projectSlug,
    exp: Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds),
  });
  const payload = b64url(claim);
  const sig = await hmacHex(secret, payload);
  return `${payload}.${sig}`;
}

// ---------------------------------------------------------------------------
// Real client (HTTP against WORKBENCH_BASE_URL)
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "WorkbenchHttpError";
  }
}

function createHttpClient(env: WorkbenchEnv): WorkbenchClient {
  const base = String(env.WORKBENCH_BASE_URL ?? "").replace(/\/+$/, "");
  const adminToken = env.WORKBENCH_TOKEN ?? "";

  async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { "x-workbench-token": token ?? adminToken };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`WorkBench ${method} ${path} -> ${res.status}`, res.status, text.slice(0, 500));
    return (text ? JSON.parse(text) : {}) as T;
  }

  return {
    mock: false,
    createClient: (input) => call("POST", "/api/clients", input),
    createProject: (clientSlug, input) => call("POST", `/api/clients/${encodeURIComponent(clientSlug)}/projects`, input),
    chat: (input, opts) => call("POST", "/api/chat", input, opts?.scopedToken),
    commit: (input) => call("POST", "/api/commit", input),
    plan: (input) => call("POST", "/plan", input),
    run: (jobId) => call("POST", "/run", { jobId }),
    status: (jobId) => call("GET", `/status/${encodeURIComponent(jobId)}`),
    usage: (clientSlug) => call("GET", clientSlug ? `/api/usage?client=${encodeURIComponent(clientSlug)}` : "/api/usage"),
  };
}

// ---------------------------------------------------------------------------
// Mock client (no network) — deterministic, contract-shaped
// ---------------------------------------------------------------------------

// Readiness ramps with how much detail the participant has given, so the A3 UI shows a
// believable multi-turn "keep describing → loop_ready" flow with no server. Deterministic.
function mockReadiness(input: string): WbReadiness {
  const len = input.trim().length;
  const score = Math.max(10, Math.min(100, Math.round((len / 120) * 100)));
  return { score, loop_ready: score >= 80 };
}

function mockJobState(jobId: string): WbJobState {
  // Derive a stable pseudo-state from the jobId so /status looks like it advances across
  // different jobs without any stored state (real progression comes from W1 later).
  const order: WbJobState[] = ["queued", "planning", "coding", "reviewing", "done"];
  let h = 0;
  for (const ch of jobId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return order[h % order.length];
}

function createMockClient(env: WorkbenchEnv): WorkbenchClient {
  return {
    mock: true,
    async createClient(input) {
      return { client: { slug: slugify(input.name, "client"), name: input.name, mock: true } };
    },
    async createProject(clientSlug, input) {
      return {
        project: {
          slug: slugify(input.name, "project"),
          name: input.name,
          deliverableName: input.deliverableName,
          deliverableType: input.deliverableType,
          clientSlug,
          mock: true,
        },
      };
    },
    async chat(input) {
      const readiness = mockReadiness(input.input);
      return {
        result: {
          readiness,
          reply: readiness.loop_ready
            ? "规格已足够,可以开始编码了 / Spec looks ready — we can start coding."
            : "再多说说:目标用户、核心功能、想要的样子? / Tell me more: who is it for, the core feature, the look?",
        },
        commit: { sha: "mock" + slugify(input.projectSlug, "sha").slice(0, 7), pushed: false },
      };
    },
    async commit(input) {
      return { pushed: Boolean(input.push), sha: "mock" + slugify(input.projectSlug, "sha").slice(0, 7), repo: input.repo, mock: true };
    },
    async plan(input) {
      return { jobId: `mock-${slugify(input.clientSlug, "c")}-${slugify(input.projectSlug, "p")}` };
    },
    async run(jobId) {
      return { accepted: true, jobId, queuePos: 1 };
    },
    async status(jobId) {
      const state = mockJobState(jobId);
      return {
        state,
        jobId,
        prUrl: state === "reviewing" || state === "done" ? `https://github.com/hack5-mini-bot/${slugify(jobId, "repo")}/pull/1` : undefined,
        appUrl: state === "done" ? `https://${slugify(jobId, "app")}.pages.dev` : undefined,
      };
    },
    async usage(clientSlug) {
      const bucket: WbUsageBucket = { tokens: 12345, requests: 7 };
      return {
        global: { tokens: 12345, requests: 7 },
        perProject: { "mock-project": bucket },
        byClient: clientSlug ? { [clientSlug]: bucket } : { "mock-client": bucket },
        at: new Date(0).toISOString(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkbench(env: WorkbenchEnv): WorkbenchClient {
  return workbenchMockEnabled(env) ? createMockClient(env) : createHttpClient(env);
}
