# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

HackVideo is a hackathon submission + showcase portal on Cloudflare Workers. A submission is **a public GitHub repo + an external demo-video link (Bilibili/YouTube) + 1–4 product screenshots + team info**. The site auto-fetches GitHub metadata/README to build a work wall, and judges score entries online. UI is bilingual (中/英).

The entire app is **one file**: `src/index.ts` (a Cloudflare Worker). Backend + the whole SPA (`APP_HTML` at the bottom) live there. There is no build step, no framework, no client bundle.

> History: this started as a "upload your video to R2, email-OTP login" app. It pivoted to the GitHub-link model with passcode auth. Traces of the old model remain **intentionally** (see "Reserved R2 upload path"). `vps/` is a now-**stale** fallback from the old model — its `loadWorkerHtml()` regex no longer matches `src/index.ts` and its endpoints don't match the current API. Don't treat `vps/` as live; ignore it unless explicitly reviving it.

## Commands

Uses **npm** (per `package-lock.json`). Run from repo root:

```bash
npm install
npm run dev                  # wrangler dev --local on :8787
npm run typecheck            # tsc --noEmit — the ONLY gate; there is no test suite, no lint
npm run db:migrate:local     # apply migrations/ to local D1
npm run db:migrate:remote    # apply migrations/ to remote D1
npm run deploy               # wrangler deploy
```

Always run `npm run typecheck` before deploying.

## Deploying (credential note that will bite you)

`~/Dev/.env` only has narrow Cloudflare DNS/Tunnel/Registrar tokens — **not** usable for Workers/D1/KV. Deploy uses wrangler's **OAuth login** (jhfnetboy@gmail.com). But wrangler refuses OAuth in a non-interactive shell and demands `CLOUDFLARE_API_TOKEN`. Workaround that works here — feed the stored OAuth token in as the API token:

```bash
export CLOUDFLARE_API_TOKEN=$(grep -E '^oauth_token' ~/Library/Preferences/.wrangler/config/default.toml | head -1 | sed -E 's/.*=[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/')
export CLOUDFLARE_ACCOUNT_ID=7bf23342f21baa5ebfc7bc7b74f5a1f2
npx wrangler deploy   # d1/kv commands too
```

This OAuth token has `workers`/`d1`/`kv`/`pages` write but **no `r2` and no email** scope — which is why the R2 video-upload path is off and auth is passcode-based, not email-OTP. Live deploy: `https://hackvideo.jhfnetboy.workers.dev`.

## Architecture / things you can't see from one function

**Storage split:** D1 (`DB`) holds submission metadata + scores; **Workers KV (`SHOTS`)** holds the screenshot image bytes (key `shot:<submissionId>:<index>`, contentType in KV metadata). Screenshots are uploaded inline as base64 data URLs in the create-submission POST body — the browser compresses them to JPEG (canvas, max 1600px, q0.82) *before* upload, so bodies stay ~1MB. No R2 in the live path; video is an external link, so it costs zero storage. This is the whole reason 100 participants stay in the free tier.

**Auth is passcode + stateless signed cookie — no session/auth table.** `JUDGE_PASSCODE` / `ADMIN_PASSCODE` log in → `hv_auth` cookie = `base64url(json{role,name,exp}).hmacSHA256(body, AUTH_SECRET)`, verified in `getAuth()`, never stored server-side. `requireRole(req, env, 'admin'|'judge')` treats **admin as a superset of judge**. Judge identity for scoring is just the name typed at login.

**Submitting is gated by single-use invite codes, not a shared passcode.** A shared submit passcode was rejected (one team could pass it around). Admin batch-generates codes (`invite_codes` table, `/api/invites`, admin-only); the create-submission handler consumes one atomically via `UPDATE ... WHERE code = ? AND used_by IS NULL` and checks `meta.changes === 1` — that's the race-safe single-use guarantee. Editing an existing submission uses its `edit_token`, not a code. `SUBMIT_PASSCODE` still works as an organizer master key that bypasses code consumption (kept private, not distributed).

**GitHub API is proxied through the Worker, never called from the browser.** `ghGet()` fetches `api.github.com` with `GITHUB_TOKEN` (5000 req/hr vs 60 unauth) and caches in `caches.default` keyed by `url#accept` for 600s. This is deliberate: a work wall with N cards would blow the 60/hr unauthenticated limit instantly if each visitor's browser called GitHub directly. Two endpoints: `/api/gh/:owner/:repo` (trimmed metadata) and `/api/gh/:owner/:repo/readme` (GitHub-rendered HTML). The README HTML is injected client-side into a **sandboxed iframe** (`sandbox="allow-popups allow-popups-to-escape-sandbox"`, no `allow-scripts`) via `srcdoc` — that isolation is load-bearing, don't render README HTML directly into the page.

**Create-submission is an upsert keyed by `(repo_owner, repo_name)`** (unique constraint). Re-submitting the same repo requires the `edit_token` returned on first submit (there are no participant accounts). It verifies the repo is public via GitHub before accepting, and rewrites the KV screenshots on edit (`clearShots` then `putShots`).

**Scoring:** 4 fixed dimensions in the `DIMS` constant (`innovation/technical/completeness/presentation`, 1–10). `/api/scores` upserts on `(submission_id, judge_name)`. Leaderboard averages the 4-dim sum across judges; `ORDER BY (avg_total IS NULL), avg_total DESC` pushes unscored entries to the bottom (SQLite has no `NULLS LAST`). Admin-only CSV export at `/api/scores/export`.

**SPA routing** is `history.pushState` + a `route()` switch on `location.pathname` (`/`, `/submit`, `/p/:id`, `/judge`, `/leaderboard`). All server routes return JSON except `GET *` (fallthrough) which returns `APP_HTML`.

**Reserved R2 upload path (dormant, keep it):** `startUpload`/`completeUpload`/`serveVideo`/`presignR2Put` implement browser→R2 direct upload with hand-rolled SigV4, gated behind `VIDEO_UPLOAD === "on" && env.VIDEO_BUCKET`. Off by default; returns 503. To enable later: add the `r2_buckets` binding + `R2_*` vars/secrets in `wrangler.jsonc`, set `VIDEO_UPLOAD=on`. Don't delete this — it's the sanctioned way video-upload comes back.

## Config & secrets

- **`wrangler.jsonc` vars** (non-secret): `APP_NAME`, `EVENT_NAME`, `VIDEO_UPLOAD` (`off`), `MAX_VIDEO_BYTES`, `MAX_VIDEO_SECONDS`, `MAX_SHOTS` (4), `MAX_SHOT_BYTES`. Bindings: `DB` (D1), `SHOTS` (KV).
- **Secrets** (`wrangler secret put`): `AUTH_SECRET`, `SUBMIT_PASSCODE`, `JUDGE_PASSCODE`, `ADMIN_PASSCODE`, `GITHUB_TOKEN`.
- Limits (`MAX_SHOTS`, `MAX_SHOT_BYTES`, `DIMS`) are enforced server-side; the client mirrors some for UX. Keep both in sync when changing them.
- `.dev.vars.example` → `.dev.vars` for local dev.

## Editing `APP_HTML`

It's a `String.raw` template literal at the end of `src/index.ts`. Because it's `String.raw`, you do **not** escape backslashes, but you must still escape backticks (`` \` ``) and `${` (`\${`) that belong to the client JS rather than the outer literal. The client's own template literals use string concatenation (not nested backticks) specifically to avoid that trap — follow that style when extending it.
