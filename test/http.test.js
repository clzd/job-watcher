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
  assert.ok(html.includes(`<tr class="failed">`));
  assert.ok(html.includes(`<td class="outcome">ok</td><td class="num">4</td><td class="num">3</td><td class="num">3</td><td class="num">1</td>`));
});

test("GET / renders the three status buttons with the current one disabled", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "X" }], 1, db);
  const html = await (await get("/", { DB: db })).text();
  assert.match(html, /<button type="submit" disabled>New<\/button>[\s\S]*<button type="submit">Applied<\/button>[\s\S]*<button type="submit">Dismissed<\/button>/);
});

test("GET / and GET /runs send a Content-Security-Policy without form-action", async () => {
  const csp = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";
  for (const path of ["/", "/runs"]) {
    const res = await get(path, { DB: fakeDb() });
    assert.equal(res.headers.get("content-security-policy"), csp);
  }
});

test("GET on a status path redirects to / and changes nothing", async () => {
  const db = fakeDb();
  await saveJobs([{ id: 1, title: "X" }], 1, db);
  const res = await get("/jobs/1/status?status=applied", { DB: db });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://jobs.example/");
  const row = await db.prepare("SELECT status FROM jobs WHERE id = ?").bind("1").first();
  assert.equal(row.status, "new");
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

// Helpers for the Run now route. deps.run resolves by default; pass a rejecting
// fn to test the failure path. waited collects what the route hands to waitUntil.
function runNow({ origin = "https://jobs.example", db = fakeDb(), run, waitUntil } = {}) {
  const waited = [];
  const calls = [];
  const deps = {
    run: run ?? (async () => { calls.push(1); }),
  };
  const ctxNow = {
    access: { aud: "test" },
    waitUntil: waitUntil === null ? undefined : (p) => waited.push(p),
  };
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (origin !== null) headers.origin = origin;
  const req = new Request("https://jobs.example/runs/now", { method: "POST", headers, body: new URLSearchParams() });
  return handleRequest(req, { DB: db }, ctxNow, deps).then((res) => ({ res, waited, calls }));
}

async function runningRowStarted(db, isoStartedAt) {
  await db.prepare("INSERT INTO runs (started_at, outcome) VALUES (?, 'running')").bind(isoStartedAt).run();
}

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

test("POST /runs/now starts a run in the background and redirects to /runs", async () => {
  const { res, waited, calls } = await runNow();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://jobs.example/runs");
  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(calls.length, 1);
});

test("POST /runs/now rejects a missing or foreign Origin with 403 and starts nothing", async () => {
  for (const origin of [null, "https://evil.example"]) {
    const { res, waited, calls } = await runNow({ origin });
    assert.equal(res.status, 403, String(origin));
    assert.equal(waited.length, 0);
    assert.equal(calls.length, 0);
  }
});

test("POST /runs/now skips the start when a running row is under 10 minutes old", async () => {
  const db = fakeDb();
  await runningRowStarted(db, minutesAgo(1));
  const { res, waited, calls } = await runNow({ db });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://jobs.example/runs");
  assert.equal(waited.length, 0);
  assert.equal(calls.length, 0);
});

test("POST /runs/now starts a run when the running row is over 10 minutes old", async () => {
  const db = fakeDb();
  await runningRowStarted(db, minutesAgo(11));
  const { waited, calls } = await runNow({ db });
  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(calls.length, 1);
});

test("POST /runs/now starts a run when the latest row is finished", async () => {
  const db = fakeDb();
  const id = await startRun(db);
  await finishRun(id, { outcome: "failed", error: "All Adzuna searches failed" }, db);
  const { waited, calls } = await runNow({ db });
  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(calls.length, 1);
});

test("POST /runs/now treats a running row with an unparseable started_at as not in progress", async () => {
  const db = fakeDb();
  await runningRowStarted(db, "not a date");
  const { res, waited } = await runNow({ db });
  assert.equal(res.status, 303);
  assert.equal(waited.length, 1);
});

test("POST /runs/now treats a running row started in the future as in progress", async () => {
  const db = fakeDb();
  await runningRowStarted(db, minutesAgo(-5));
  const { waited, calls } = await runNow({ db });
  assert.equal(waited.length, 0);
  assert.equal(calls.length, 0);
});

test("POST /runs/now logs a rejected run and the waitUntil promise resolves", async (t) => {
  const errors = [];
  t.mock.method(console, "error", (msg) => errors.push(msg));
  const { res, waited } = await runNow({ run: async () => { throw new Error("All Adzuna searches failed"); } });
  assert.equal(res.status, 303);
  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Run now failed: All Adzuna searches failed/);
});

test("POST /runs/now still starts the run when ctx has no waitUntil", async () => {
  const { res, calls } = await runNow({ waitUntil: null });
  assert.equal(res.status, 303);
  // Without waitUntil the promise is simply started; give it a tick to run.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1);
});

test("POST /runs/now without deps.run redirects and starts nothing", async () => {
  const headers = { "content-type": "application/x-www-form-urlencoded", origin: "https://jobs.example" };
  const req = new Request("https://jobs.example/runs/now", { method: "POST", headers, body: new URLSearchParams() });
  const res = await handleRequest(req, { DB: fakeDb() }, ctx);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://jobs.example/runs");
});

test("GET /runs/now redirects to /runs and starts nothing", async () => {
  const waited = [];
  const calls = [];
  const ctxNow = { access: { aud: "test" }, waitUntil: (p) => waited.push(p) };
  const res = await handleRequest(new Request("https://jobs.example/runs/now"), { DB: fakeDb() }, ctxNow, { run: async () => { calls.push(1); } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://jobs.example/runs");
  assert.equal(waited.length, 0);
  assert.equal(calls.length, 0);
});

test("POST /runs/now returns 500 when D1 is down", async (t) => {
  t.mock.method(console, "error", () => {});
  const { res } = await runNow({ db: fakeDb({ broken: true }) });
  assert.equal(res.status, 500);
  assert.equal(await res.text(), "Database error");
});

test("GET /runs renders the Run now form in the empty and non-empty states", async () => {
  const form = '<form method="post" action="/runs/now" class="run-now"><button type="submit">Run now</button></form>';
  const empty = await (await get("/runs", { DB: fakeDb() })).text();
  assert.ok(empty.includes(form), "empty state");
  assert.ok(empty.includes("No runs yet"));

  const db = fakeDb();
  const id = await startRun(db);
  await finishRun(id, { outcome: "ok", candidates: 1, fresh: 1, sent: 1, termsFailed: 0 }, db);
  const full = await (await get("/runs", { DB: db })).text();
  assert.ok(full.includes(form), "non-empty state");
  assert.ok(full.indexOf(form) < full.indexOf("<table"), "form sits above the table");
});
