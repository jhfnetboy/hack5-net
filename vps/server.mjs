import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const UPLOAD_DIR = join(DATA_DIR, "uploads");
const DB_PATH = join(DATA_DIR, "db.json");
const PORT = Number(process.env.PORT || 8787);
const APP_NAME = process.env.APP_NAME || "HackVideo";
const MAIL_FROM = process.env.MAIL_FROM || "no-reply@example.com";
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || APP_NAME;
const AUTH_SECRET = process.env.AUTH_SECRET || "dev-only-change-me";
const DEV_MODE = process.env.DEV_MODE === "true";
const MAX_VIDEO_BYTES = Number(process.env.MAX_VIDEO_BYTES || 200 * 1024 * 1024);
const MAX_VIDEO_SECONDS = Number(process.env.MAX_VIDEO_SECONDS || 300);
const SESSION_COOKIE = "hv_session";
const MAX_DESCRIPTION_CHARS = 120;
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "avi", "mkv", "mpeg", "mpg"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-msvideo", "video/x-matroska", "video/mpeg"]);

let dbLock = Promise.resolve();
const appHtml = await loadWorkerHtml();

await mkdir(UPLOAD_DIR, { recursive: true });
await ensureDb();

createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (request.method === "OPTIONS") return send(response, 204, "");

    if (url.pathname === "/api/auth/request-code" && request.method === "POST") return requestCode(request, response);
    if (url.pathname === "/api/auth/verify" && request.method === "POST") return verifyCode(request, response);
    if (url.pathname === "/api/auth/logout" && request.method === "POST") return logout(response);
    if (url.pathname === "/api/me" && request.method === "GET") return me(request, response);
    if (url.pathname === "/api/submissions" && request.method === "GET") return listSubmissions(request, response);
    if (url.pathname === "/api/uploads/start" && request.method === "POST") return startUpload(request, response);
    if (url.pathname === "/api/uploads/complete" && request.method === "POST") return completeUpload(request, response);

    const apiSubmissionMatch = url.pathname.match(/^\/api\/submissions\/([^/]+)$/);
    if (apiSubmissionMatch && request.method === "GET") return getSubmission(request, response, apiSubmissionMatch[1], url);

    const uploadMatch = url.pathname.match(/^\/upload\/([^/]+)\/(video|thumb)$/);
    if (uploadMatch && request.method === "PUT") return receiveUpload(request, response, uploadMatch[1], uploadMatch[2]);

    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)\/(video|thumb)$/);
    if (mediaMatch && request.method === "GET") return serveMedia(request, response, mediaMatch[1], mediaMatch[2], url);

    if (request.method === "GET") {
      return send(response, 200, appHtml, { "Content-Type": "text/html; charset=utf-8", "X-Robots-Tag": "noindex" });
    }
    return json(response, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return json(response, 500, { error: "Server error" });
  }
}).listen(PORT, () => {
  console.log(`${APP_NAME} VPS server listening on http://localhost:${PORT}`);
});

async function requestCode(request, response) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  if (!email) return json(response, 400, { error: "Invalid email" });
  const now = unixNow();
  const ip = request.socket.remoteAddress || "local";
  const code = generateCode();
  const codeHash = hashSecret(`${email}:${code}`);
  const tooMany = await withDb(async (db) => {
    const emailCount = db.authCodes.filter((row) => row.email === email && row.created_at > now - 15 * 60).length;
    const ipCount = db.authCodes.filter((row) => row.request_ip === ip && row.created_at > now - 60 * 60).length;
    if (emailCount >= 3 || ipCount >= 30) return true;
    db.authCodes.push({
      id: randomUUID(),
      email,
      code_hash: codeHash,
      request_ip: ip,
      created_at: now,
      expires_at: now + 10 * 60,
      used_at: null,
    });
    return false;
  });
  if (tooMany) return json(response, 429, { error: "Too many requests. Please try again later." });
  await sendOtpEmail(email, code);
  json(response, 200, { ok: true, ...(DEV_MODE ? { debugCode: code } : {}) });
}

async function verifyCode(request, response) {
  const body = await readJson(request);
  const email = normalizeEmail(body.email);
  const code = String(body.code || "").replace(/\D/g, "");
  if (!email || code.length !== 6) return json(response, 400, { error: "Invalid email or code" });
  const now = unixNow();
  const expectedHash = hashSecret(`${email}:${code}`);
  const token = randomToken(32);
  const tokenHash = hashSecret(token);
  const ok = await withDb(async (db) => {
    const match = db.authCodes
      .filter((row) => row.email === email && !row.used_at && row.expires_at >= now)
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, 5)
      .find((row) => safeEqual(row.code_hash, expectedHash));
    if (!match) return false;
    match.used_at = now;
    db.sessions.push({
      id: randomUUID(),
      email,
      token_hash: tokenHash,
      created_at: now,
      last_seen_at: now,
      expires_at: now + 14 * 24 * 60 * 60,
    });
    return true;
  });
  if (!ok) return json(response, 401, { error: "Invalid or expired code" });
  json(response, 200, { ok: true, email }, {
    "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${14 * 24 * 60 * 60}`,
  });
}

function logout(response) {
  json(response, 200, { ok: true }, {
    "Set-Cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
  });
}

async function me(request, response) {
  const session = await getSession(request);
  if (!session) return json(response, 401, { authenticated: false });
  json(response, 200, { authenticated: true, email: session.email });
}

async function listSubmissions(request, response) {
  const session = await getSession(request);
  if (!session) return json(response, 401, { error: "Unauthorized" });
  const db = await readDb();
  const submissions = db.submissions
    .filter((row) => row.status === "ready")
    .sort((a, b) => b.created_at - a.created_at)
    .slice(0, 200)
    .map((row) => publicSubmission(row, true));
  json(response, 200, { submissions });
}

async function getSubmission(request, response, id, url) {
  const token = url.searchParams.get("token");
  const session = await getSession(request);
  const submission = await findReadySubmission(id);
  if (!submission) return json(response, 404, { error: "Not found" });
  if (!session && token !== submission.share_token) return json(response, 401, { error: "Unauthorized" });
  json(response, 200, { submission: publicSubmission(submission, Boolean(session)) });
}

async function startUpload(request, response) {
  const session = await getSession(request);
  if (!session) return json(response, 401, { error: "Unauthorized" });
  const body = await readJson(request);
  const filename = cleanFilename(body.filename || "video");
  const contentType = normalizeContentType(body.contentType);
  const size = Number(body.size);
  const durationSeconds = Number(body.durationSeconds);
  const description = normalizeDescription(body.description);
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  if (!description) return json(response, 400, { error: "Description is required" });
  if ([...description].length > MAX_DESCRIPTION_CHARS) return json(response, 400, { error: `Description must be ${MAX_DESCRIPTION_CHARS} characters or less` });
  if (!Number.isFinite(size) || size <= 0 || size > MAX_VIDEO_BYTES) return json(response, 400, { error: "Video must be 200 MB or smaller" });
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > MAX_VIDEO_SECONDS + 1) return json(response, 400, { error: "Video must be 5 minutes or shorter" });
  if (!VIDEO_TYPES.has(contentType) && !VIDEO_EXTENSIONS.has(ext)) return json(response, 400, { error: "Unsupported video format" });

  const id = randomUUID();
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  const videoKey = join(UPLOAD_DIR, id, `video-${safeName}`);
  const thumbKey = join(UPLOAD_DIR, id, "thumb.jpg");
  const now = unixNow();
  await mkdir(join(UPLOAD_DIR, id), { recursive: true });
  await withDb(async (db) => {
    db.submissions.push({
      id,
      email: session.email,
      description,
      filename,
      content_type: contentType,
      size: Math.floor(size),
      duration_seconds: durationSeconds,
      video_key: videoKey,
      thumb_key: thumbKey,
      share_token: randomToken(24),
      status: "pending",
      created_at: now,
      updated_at: now,
    });
  });
  json(response, 200, {
    id,
    expiresInSeconds: 900,
    upload: {
      videoUrl: `/upload/${id}/video`,
      thumbUrl: `/upload/${id}/thumb`,
      videoHeaders: { "Content-Type": contentType },
      thumbHeaders: { "Content-Type": "image/jpeg" },
    },
  });
}

async function receiveUpload(request, response, id, kind) {
  const session = await getSession(request);
  if (!session) return json(response, 401, { error: "Unauthorized" });
  const db = await readDb();
  const submission = db.submissions.find((row) => row.id === id && row.email === session.email && row.status === "pending");
  if (!submission) return json(response, 404, { error: "Not found" });
  const target = kind === "video" ? submission.video_key : submission.thumb_key;
  const limit = kind === "video" ? MAX_VIDEO_BYTES : 3 * 1024 * 1024;
  try {
    await writeRequestBody(request, target, limit);
    send(response, 200, "ok", { "Content-Type": "text/plain" });
  } catch (error) {
    await unlink(target).catch(() => {});
    json(response, 413, { error: error.message });
  }
}

async function completeUpload(request, response) {
  const session = await getSession(request);
  if (!session) return json(response, 401, { error: "Unauthorized" });
  const body = await readJson(request);
  const id = body.id;
  const now = unixNow();
  const result = await withDb(async (db) => {
    const submission = db.submissions.find((row) => row.id === id && row.email === session.email);
    if (!submission) return { status: 404 };
    const videoExists = await exists(submission.video_key);
    const thumbExists = await exists(submission.thumb_key);
    if (!videoExists || !thumbExists) return { status: 409 };
    submission.status = "ready";
    submission.updated_at = now;
    return { status: 200, submission };
  });
  if (result.status === 404) return json(response, 404, { error: "Not found" });
  if (result.status === 409) return json(response, 409, { error: "Upload is incomplete" });
  const origin = `http://${request.headers.host}`;
  json(response, 200, {
    ok: true,
    submission: publicSubmission(result.submission, true),
    viewUrl: `${origin}/watch/${result.submission.id}/${result.submission.share_token}`.replace(origin, ""),
  });
}

async function serveMedia(request, response, id, kind, url) {
  const token = url.searchParams.get("token");
  const session = await getSession(request);
  const submission = await findReadySubmission(id);
  if (!submission) return json(response, 404, { error: "Not found" });
  if (!session && token !== submission.share_token) return json(response, 401, { error: "Unauthorized" });
  const filePath = kind === "video" ? submission.video_key : submission.thumb_key;
  const info = await stat(filePath).catch(() => null);
  if (!info) return json(response, 404, { error: "Not found" });
  const contentType = kind === "video" ? submission.content_type : "image/jpeg";
  if (kind === "thumb") {
    response.writeHead(200, { "Content-Type": contentType, "Cache-Control": "private, max-age=300", "X-Robots-Tag": "noindex" });
    return createReadStream(filePath).pipe(response);
  }
  const range = parseRange(request.headers.range, info.size);
  if (range) {
    response.writeHead(206, {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
      "Content-Length": range.end - range.start + 1,
      "Cache-Control": "private, max-age=300",
      "X-Robots-Tag": "noindex",
    });
    return createReadStream(filePath, { start: range.start, end: range.end }).pipe(response);
  }
  response.writeHead(200, {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Content-Length": info.size,
    "Cache-Control": "private, max-age=300",
    "X-Robots-Tag": "noindex",
  });
  createReadStream(filePath).pipe(response);
}

async function getSession(request) {
  const token = parseCookies(request.headers.cookie || "")[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = hashSecret(token);
  const now = unixNow();
  return withDb(async (db) => {
    const session = db.sessions.find((row) => row.token_hash === tokenHash && row.expires_at > now);
    if (!session) return null;
    session.last_seen_at = now;
    return session;
  });
}

async function findReadySubmission(id) {
  const db = await readDb();
  return db.submissions.find((row) => row.id === id && row.status === "ready") || null;
}

function publicSubmission(row, includeToken) {
  const tokenParam = includeToken ? "" : `?token=${row.share_token}`;
  return {
    id: row.id,
    email: row.email,
    description: row.description,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at,
    thumbUrl: `/media/${row.id}/thumb${tokenParam}`,
    videoUrl: `/media/${row.id}/video${tokenParam}`,
    viewUrl: `/watch/${row.id}/${row.share_token}`,
  };
}

async function sendOtpEmail(email, code) {
  const subject = `${APP_NAME} verification code`;
  const text = `Your ${APP_NAME} verification code is ${code}.\nThis code expires in 10 minutes.\n\n你的 ${APP_NAME} 登录验证码是 ${code}。\n验证码 10 分钟内有效。`;
  if (process.env.RESEND_API_KEY) {
    const result = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${MAIL_FROM_NAME} <${MAIL_FROM}>`, to: [email], subject, text }),
    });
    if (!result.ok) throw new Error(`Resend email failed: ${result.status}`);
    return;
  }
  if (DEV_MODE) {
    console.log(`OTP for ${email}: ${code}`);
    return;
  }
  throw new Error("No email provider configured");
}

async function readJson(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > 1024 * 1024) throw new Error("JSON body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function writeRequestBody(request, target, limit) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > limit) throw new Error("Upload too large");
  await mkdir(dirname(target), { recursive: true });
  await new Promise((resolve, reject) => {
    let total = 0;
    const output = createWriteStream(target, { flags: "wx" });
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > limit) {
        output.destroy();
        request.destroy(new Error("Upload too large"));
      }
    });
    request.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);
    request.pipe(output);
  });
}

async function ensureDb() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!(await exists(DB_PATH))) {
    await writeDb({ authCodes: [], sessions: [], submissions: [] });
  }
}

async function readDb() {
  return JSON.parse(await readFile(DB_PATH, "utf8"));
}

async function writeDb(db) {
  const temp = `${DB_PATH}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(db, null, 2));
  await rename(temp, DB_PATH);
}

async function withDb(fn) {
  const run = dbLock.then(async () => {
    const db = await readDb();
    const result = await fn(db);
    await writeDb(db);
    return result;
  });
  dbLock = run.catch(() => {});
  return run;
}

async function loadWorkerHtml() {
  const source = await readFile(join(ROOT, "src", "index.ts"), "utf8");
  const match = source.match(/const APP_HTML = `([\s\S]*)`;\s*$/);
  if (!match) throw new Error("Could not extract APP_HTML from src/index.ts");
  return new Function(`return \`${match[1]}\`;`)();
}

async function exists(path) {
  return stat(path).then(() => true, () => false);
}

function normalizeEmail(input) {
  const email = String(input || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254 ? email : null;
}

function normalizeDescription(input) {
  return String(input || "").trim().replace(/\s+/g, " ");
}

function normalizeContentType(input) {
  return String(input || "application/octet-stream").split(";")[0].trim().toLowerCase();
}

function cleanFilename(input) {
  return String(input).trim().replace(/[/\\]/g, "_") || "video";
}

function parseCookies(header) {
  const cookies = {};
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key) cookies[key] = value.join("=");
  }
  return cookies;
}

function parseRange(header, size) {
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

function generateCode() {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function randomToken(bytes) {
  return randomBytes(bytes).toString("base64url");
}

function hashSecret(value) {
  return createHash("sha256").update(`${AUTH_SECRET}:${value}`).digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function unixNow() {
  return Math.floor(Date.now() / 1000);
}

function json(response, status, data, headers = {}) {
  send(response, status, JSON.stringify(data), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, headers);
  response.end(body);
}
