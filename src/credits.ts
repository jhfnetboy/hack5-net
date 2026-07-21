// Credits / token billing client (mini /make). hack5 does NOT own the balance — an external credits
// system, keyed by participant email, is the authority. This module is the seam that queries and
// charges it, with a real-time reserve→settle flow so an account can never be overdrawn.
//
// Everything degrades safely: when CREDITS_ENABLED is off or the API URL/secret is unset, the helpers
// return a disabled/neutral result and callers keep the current free-quota behaviour unchanged.
//
// Contract (hack5 -> your API, HMAC-signed body, header `x-hack5-signature: sha256=<hex>`):
//   POST {URL}/balance {email}                  -> {email, credits}
//   POST {URL}/reserve {email, credits, ref}    -> {ok, credits, holdId?}   (ok:false if balance < credits)
//   POST {URL}/settle  {ref, actualCredits}     -> {ok, credits}
//   POST {URL}/release {ref}                     -> {ok}
// All idempotent by `ref`.

export type CreditsEnv = {
  CREDITS_ENABLED?: string; // "1"/"true" to turn the whole feature on
  CREDITS_API_URL?: string; // base URL of the external credits API
  CREDITS_API_SECRET?: string; // shared secret for HMAC request signing
  CREDIT_USD_VALUE?: string; // dollars per credit (default 0.02 — "两美分")
  CREDITS_MARKUP?: string; // price multiplier over raw model cost (default 2)
  CREDITS_PER_1K_TOKENS?: string; // fallback flat rate when actual $ cost isn't reported
};

export function creditsEnabled(env: CreditsEnv): boolean {
  const on = env.CREDITS_ENABLED === "1" || env.CREDITS_ENABLED === "true";
  return on && !!env.CREDITS_API_URL && !!env.CREDITS_API_SECRET;
}

// Primary billing: credits owed for the actual USD model cost of a job (computed by WorkBench from
// docs/model-prices.csv). credits = ceil(cost * markup / creditUsd) = ceil(cost * 100) at defaults.
export function costUsdToCredits(env: CreditsEnv, usdCost: number): number {
  const creditUsd = Number(env.CREDIT_USD_VALUE ?? "0.02") || 0.02;
  const markup = Number(env.CREDITS_MARKUP ?? "2") || 2;
  if (!Number.isFinite(usdCost) || usdCost <= 0) return 0;
  return Math.ceil((usdCost * markup) / creditUsd);
}

// Fallback estimate when the actual $ cost isn't available: a flat blended rate per 1000 tokens.
export function tokensToCredits(env: CreditsEnv, tokens: number): number {
  const rate = Number(env.CREDITS_PER_1K_TOKENS ?? "0");
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(tokens) || tokens <= 0) return 0;
  return Math.ceil((tokens / 1000) * rate);
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function call<T>(env: CreditsEnv, path: string, payload: unknown): Promise<T | null> {
  if (!creditsEnabled(env)) return null;
  const body = JSON.stringify(payload);
  const sig = await hmacHex(env.CREDITS_API_SECRET as string, body);
  try {
    const res = await fetch(`${env.CREDITS_API_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hack5-signature": `sha256=${sig}` },
      body,
    });
    if (!res.ok) {
      console.log("credits call failed", path, res.status, (await res.text().catch(() => "")).slice(0, 200));
      return null;
    }
    return (await res.json<T>().catch(() => null)) as T | null;
  } catch (err) {
    console.log("credits fetch error", path, String(err));
    return null;
  }
}

// Real-time balance for an email. null = disabled/unavailable (caller should treat as "cannot bill").
export async function getBalance(env: CreditsEnv, email: string): Promise<number | null> {
  const r = await call<{ credits?: number }>(env, "/balance", { email });
  return r && Number.isFinite(Number(r.credits)) ? Number(r.credits) : null;
}

// Reserve (hold) credits before doing any real work. ok:false = insufficient balance -> block the build.
export async function reserve(env: CreditsEnv, args: { email: string; credits: number; ref: string }): Promise<{ ok: boolean; credits?: number; holdId?: string } | null> {
  return call<{ ok: boolean; credits?: number; holdId?: string }>(env, "/reserve", args);
}

// Settle a reservation to the actual amount once real token usage is known (releases the overheld part).
export async function settle(env: CreditsEnv, args: { ref: string; actualCredits: number }): Promise<{ ok: boolean; credits?: number } | null> {
  return call<{ ok: boolean; credits?: number }>(env, "/settle", args);
}

// Release a reservation entirely (e.g. the build failed before consuming anything).
export async function release(env: CreditsEnv, args: { ref: string }): Promise<{ ok: boolean } | null> {
  return call<{ ok: boolean }>(env, "/release", args);
}
