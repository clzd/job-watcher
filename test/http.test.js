import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest, escapeHtml, formatEastern } from "../src/http.js";
import { saveJobs, setJobStatus, startRun, finishRun } from "../src/store.js";
import { fakeDb } from "./helpers.js";

const ctx = { access: { aud: "test" }, waitUntil() {} };
const get = (path, env) => handleRequest(new Request(`https://jobs.example${path}`), env, ctx);

test("escapeHtml escapes the five characters and blanks null", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(escapeHtml(null), "");
});

test("formatEastern renders UTC as Eastern with a 24-hour clock", () => {
  assert.equal(formatEastern("2026-10-10T06:00:00.000Z"), "2026-10-10 02:00 ET");
  assert.equal(formatEastern("2026-01-15T05:30:00.000Z"), "2026-01-15 00:30 ET");
  assert.equal(formatEastern(null), "");
});

test("returns 401 when Access did not authenticate the request", async () => {
  const res = await handleRequest(new Request("https://jobs.example/"), { DB: fakeDb() }, { waitUntil() {} });
  assert.equal(res.status, 401);
  assert.equal(await res.text(), "Access required");
});

test("GET / shows only new jobs by default, escapes titles, and links the url", async () => {
  const db = fakeDb();
  await saveJobs([
    { id: 1, title: `<script>alert("x")</script> & Co`, company: { display_name: "Acme" }, redirect_url: "https://www.adzuna.com/land/ad/1?a=1&b=2" },
    { id: 2, title: "Applied One", company: { display_name: "Beta" } },
  ], 1, db);
  await setJobStatus("2", "applied", db);
  const res = await get("/", { DB: db });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Co"));
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes(`href="https://www.adzuna.com/land/ad/1?a=1&amp;b=2"`));
  assert.ok(!html.includes("Applied One"));
  assert.ok(html.includes("No runs yet"));
});

test("GET / does not link a non-http job url", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "Sneaky Job", redirect_url: "javascript:alert(1)" }], 1, db);
  const html = await (await get("/", { DB: db })).text();
  assert.ok(html.includes("Sneaky Job"));
  assert.ok(!html.includes("javascript:"));
});

test("GET /?status=all shows every job and ?status=bogus falls back to new", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "New One" }, { id: 2, title: "Applied One" }], 1, db);
  await setJobStatus("2", "applied", db);
  const all = await (await get("/?status=all", { DB: db })).text();
  assert.ok(all.includes("New One") && all.includes("Applied One"));
  const bogus = await get("/?status=bogus", { DB: db });
  assert.equal(bogus.status, 200);
  const html = await bogus.text();
  assert.ok(html.includes("New One") && !html.includes("Applied One") && !html.includes("bogus"));
});

test("GET / status line shows the latest run", async () => {
  const db = fakeDb();
  const id = await startRun(db);
  await finishRun(id, { outcome: "ok", candidates: 4, fresh: 3, sent: 3, termsFailed: 0 }, db);
  const html = await (await get("/", { DB: db })).text();
  assert.match(html, /Last run \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET, ok, 3 sent/);
});

test("GET /runs renders ok and failed runs", async () => {
  const db = fakeDb();
  const a = await startRun(db);
  await finishRun(a, { outcome: "ok", candidates: 4, fresh: 3, sent: 3, termsFailed: 1 }, db);
  const b = await startRun(db);
  await finishRun(b, { outcome: "failed", error: "Telegram sendMessage failed: 500" }, db);
  const html = await (await get("/runs", { DB: db })).text();
  assert.ok(html.includes("Telegram sendMessage failed: 500"));
  assert.ok(html.includes("failed") && html.includes("ok"));
});

test("GET /runs shows the empty state", async () => {
  const html = await (await get("/runs", { DB: fakeDb() })).text();
  assert.ok(html.includes("No runs yet"));
});

test("unknown path is 404 and a D1 failure is a 500 with no SQL in the body", async (t) => {
  t.mock.method(console, "error", () => {});
  assert.equal((await get("/nope", { DB: fakeDb() })).status, 404);
  const res = await get("/", { DB: fakeDb({ broken: true }) });
  assert.equal(res.status, 500);
  const body = await res.text();
  assert.equal(body, "Database error");
});

function post(path, body, { origin = "https://jobs.example", referer } = {}, env) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  if (referer) headers.referer = referer;
  return handleRequest(new Request(`https://jobs.example${path}`, { method: "POST", headers, body: new URLSearchParams(body) }), env, ctx);
}

test("POST status updates the job and redirects to a same-origin referer", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "X" }], 1, db);
  const res = await post("/jobs/1/status", { status: "applied" }, { referer: "https://jobs.example/?status=new" }, { DB: db });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://jobs.example/?status=new");
  const row = await db.prepare("SELECT status FROM jobs WHERE id = ?").bind("1").first();
  assert.equal(row.status, "applied");
});

test("POST status redirects to / when the referer is off-site or missing", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "X" }], 1, db);
  const offsite = await post("/jobs/1/status", { status: "dismissed" }, { referer: "https://evil.example/" }, { DB: db });
  assert.equal(offsite.headers.get("location"), "https://jobs.example/");
  const none = await post("/jobs/1/status", { status: "new" }, {}, { DB: db });
  assert.equal(none.headers.get("location"), "https://jobs.example/");
});

test("POST status rejects a missing or foreign Origin with 403", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "X" }], 1, db);
  assert.equal((await post("/jobs/1/status", { status: "applied" }, { origin: null }, { DB: db })).status, 403);
  assert.equal((await post("/jobs/1/status", { status: "applied" }, { origin: "https://evil.example" }, { DB: db })).status, 403);
  const row = await db.prepare("SELECT status FROM jobs WHERE id = ?").bind("1").first();
  assert.equal(row.status, "new");
});

test("POST status returns 400 for a bad value, a missing field, or an unknown id", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "X" }], 1, db);
  assert.equal((await post("/jobs/1/status", { status: "bogus" }, {}, { DB: db })).status, 400);
  assert.equal((await post("/jobs/1/status", {}, {}, { DB: db })).status, 400);
  assert.equal((await post("/jobs/999/status", { status: "applied" }, {}, { DB: db })).status, 400);
});

test("POST requires Access too", async () => {
  const res = await handleRequest(new Request("https://jobs.example/jobs/1/status", { method: "POST", headers: { origin: "https://jobs.example" }, body: new URLSearchParams({ status: "applied" }) }), { DB: fakeDb() }, { waitUntil() {} });
  assert.equal(res.status, 401);
});

test("POST status treats a malformed Origin as 403 and a malformed Referer as /", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "X" }], 1, db);
  assert.equal((await post("/jobs/1/status", { status: "applied" }, { origin: "not a url" }, { DB: db })).status, 403);
  assert.equal((await post("/jobs/1/status", { status: "applied" }, { origin: "null" }, { DB: db })).status, 403);
  const res = await post("/jobs/1/status", { status: "applied" }, { referer: "::not a url::" }, { DB: db });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://jobs.example/");
});

test("POST status returns 400 for a malformed id escape or a non-form body", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "X" }], 1, db);
  assert.equal((await post("/jobs/%E0%A4%A/status", { status: "applied" }, {}, { DB: db })).status, 400);
  const res = await handleRequest(new Request("https://jobs.example/jobs/1/status", { method: "POST", headers: { origin: "https://jobs.example", "content-type": "text/plain" }, body: "status=applied" }), { DB: db }, ctx);
  assert.equal(res.status, 400);
  const row = await db.prepare("SELECT status FROM jobs WHERE id = ?").bind("1").first();
  assert.equal(row.status, "new");
});

test("POST status decodes an escaped id", async () => {
  const db = fakeDb();
  await saveJobs([{ id: "a/b c", title: "X" }], 1, db);
  const res = await post(`/jobs/${encodeURIComponent("a/b c")}/status`, { status: "dismissed" }, {}, { DB: db });
  assert.equal(res.status, 303);
  const row = await db.prepare("SELECT status FROM jobs WHERE id = ?").bind("a/b c").first();
  assert.equal(row.status, "dismissed");
});
