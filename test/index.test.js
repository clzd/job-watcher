import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import worker, { run, SEARCH_TERMS } from "../src/index.js";
import { fakeKv, fakeDb } from "./helpers.js";
import { formatMessages } from "../src/telegram.js";

// adzunaStatus and telegramStatus may each be a number or a function of the 0-based call index.
function fakeFetch({ results = [], telegramStatus = 200, adzunaStatus = 200 } = {}) {
  const calls = { adzuna: [], telegram: [] };
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.startsWith("https://api.adzuna.com/")) {
      const status = typeof adzunaStatus === "function" ? adzunaStatus(calls.adzuna.length) : adzunaStatus;
      calls.adzuna.push(u);
      if (status !== 200) return new Response("server error", { status });
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    if (u.startsWith("https://api.telegram.org/")) {
      const status = typeof telegramStatus === "function" ? telegramStatus(calls.telegram.length) : telegramStatus;
      calls.telegram.push(JSON.parse(options.body));
      return new Response(status === 200 ? '{"ok":true}' : '{"ok":false}', { status });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}

function makeEnv(kv, db = fakeDb()) {
  return {
    ADZUNA_APP_ID: "id",
    ADZUNA_APP_KEY: "key",
    TELEGRAM_BOT_TOKEN: "tok",
    TELEGRAM_CHAT_ID: "chat",
    SEEN_JOBS: kv,
    DB: db,
    SEARCH_GAP_MS: "0",
  };
}

const remoteJob = {
  id: 101,
  title: "Web Platform Manager",
  company: { display_name: "Acme" },
  location: { display_name: "Remote", area: ["US"] },
  redirect_url: "https://www.adzuna.com/land/ad/101",
};
const texasJob = {
  id: 102,
  title: "Website Manager",
  company: { display_name: "Lone Star" },
  location: { display_name: "Austin, Texas", area: ["US", "Texas", "Austin"] },
  redirect_url: "https://www.adzuna.com/land/ad/102",
};
const internJob = {
  id: 103,
  title: "Web Manager Intern",
  company: { display_name: "Acme" },
  location: { display_name: "Remote", area: ["US"] },
  redirect_url: "https://www.adzuna.com/land/ad/103",
};

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; });

test("SEARCH_TERMS is exactly the seven terms from the spec", () => {
  assert.deepEqual(SEARCH_TERMS, [
    "web platform manager",
    "digital experience manager",
    "web experience manager",
    "website manager",
    "Optimizely",
    "conversion rate optimization manager",
    "WordPress manager",
  ]);
});

test("run calls Adzuna once per term, sends one message, and marks the job seen once", async () => {
  // Every search returns the same job, so in-run dedupe must collapse 7 copies to 1.
  const calls = fakeFetch({ results: [remoteJob, texasJob, internJob] });
  const kv = fakeKv();

  await run(makeEnv(kv));

  assert.equal(calls.adzuna.length, 7);
  assert.deepEqual(
    calls.adzuna.map((u) => new URL(u).searchParams.get("what")),
    SEARCH_TERMS,
  );
  assert.equal(calls.telegram.length, 1);
  const text = calls.telegram[0].text;
  assert.ok(text.startsWith("New jobs (1)\n\n"), text);
  assert.equal(text.split("https://www.adzuna.com/land/ad/101").length - 1, 1, "job listed once");
  assert.ok(!text.includes("Lone Star"), "Texas job filtered out");
  assert.ok(!text.includes("Intern"), "intern job filtered out");
  assert.deepEqual(kv.puts.map((p) => p.key), ["101"]);
  assert.equal(kv.puts[0].options.expirationTtl, 5184000);
});

test("run searches one term at a time, pausing SEARCH_GAP_MS between searches", async () => {
  // Adzuna answers 429 and 503 when several searches land at once.
  let inFlight = 0;
  let maxInFlight = 0;
  const startedAt = [];
  globalThis.fetch = async (url) => {
    assert.ok(String(url).startsWith("https://api.adzuna.com/"));
    startedAt.push(Date.now());
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };

  await run({ ...makeEnv(fakeKv()), SEARCH_GAP_MS: "30" });

  assert.equal(startedAt.length, 7);
  assert.equal(maxInFlight, 1);
  for (let i = 1; i < startedAt.length; i++) {
    assert.ok(startedAt[i] - startedAt[i - 1] >= 30, `gap before search ${i} was too short`);
  }
});

test("run sends nothing and writes nothing when every match is already seen", async () => {
  const calls = fakeFetch({ results: [remoteJob] });
  const kv = fakeKv([101]);

  await run(makeEnv(kv));

  assert.equal(calls.telegram.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("run sends nothing when Adzuna returns no results at all", async () => {
  const calls = fakeFetch({ results: [] });
  const kv = fakeKv();
  await run(makeEnv(kv));
  assert.equal(calls.telegram.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("run throws, sends nothing, and writes nothing when every Adzuna search fails", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fakeFetch({ results: [remoteJob], adzunaStatus: 500 });
  const kv = fakeKv();

  await assert.rejects(run(makeEnv(kv)), /All Adzuna searches failed/);
  assert.equal(calls.adzuna.length, 7);
  assert.equal(calls.telegram.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("run carries on with the other searches when one Adzuna search fails", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fakeFetch({ results: [remoteJob], adzunaStatus: (i) => (i === 0 ? 500 : 200) });
  const kv = fakeKv();

  await run(makeEnv(kv));

  assert.equal(calls.adzuna.length, 7);
  assert.equal(calls.telegram.length, 1);
  const text = calls.telegram[0].text;
  assert.equal(text.split("https://www.adzuna.com/land/ad/101").length - 1, 1, "job listed once");
  assert.deepEqual(kv.puts.map((p) => p.key), ["101"]);
});

test("run throws and leaves KV untouched when Telegram rejects the message", async () => {
  fakeFetch({ results: [remoteJob], telegramStatus: 500 });
  const kv = fakeKv();

  await assert.rejects(run(makeEnv(kv)), /Telegram sendMessage failed: 500/);
  assert.equal(kv.puts.length, 0);
});

test("run marks each message part seen only after that part is sent", async () => {
  const jobs = Array.from({ length: 80 }, (_, i) => ({
    ...remoteJob,
    id: 1000 + i,
    title: `Web Platform Manager ${i} ${"x".repeat(120)}`,
    redirect_url: `https://www.adzuna.com/land/ad/${1000 + i}`,
  }));
  const parts = formatMessages(jobs);
  assert.ok(parts.length > 1, "fixture must need several parts");
  const calls = fakeFetch({ results: jobs, telegramStatus: (i) => (i === 0 ? 200 : 500) });
  const kv = fakeKv();

  await assert.rejects(run(makeEnv(kv)), /Telegram sendMessage failed: 500/);
  assert.equal(calls.telegram.length, 2);
  assert.deepEqual(
    kv.puts.map((p) => p.key),
    parts[0].jobs.map((j) => String(j.id)),
  );
});

test("scheduled handler awaits run", async () => {
  const calls = fakeFetch({ results: [remoteJob] });
  const kv = fakeKv();
  await worker.scheduled({ cron: "0 */6 * * *" }, makeEnv(kv), { waitUntil() {} });
  assert.equal(calls.telegram.length, 1);
});

test("fetch handler passes run through to the dashboard", async () => {
  const calls = fakeFetch({ results: [remoteJob] });
  const kv = fakeKv();
  const waited = [];
  const ctx = { access: { aud: "test" }, waitUntil: (p) => waited.push(p) };
  const req = new Request("https://jobs.example/runs/now", {
    method: "POST",
    headers: { origin: "https://jobs.example" },
    body: new URLSearchParams(),
  });
  const res = await worker.fetch(req, makeEnv(kv), ctx);
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "https://jobs.example/runs");
  assert.equal(waited.length, 1);
  await waited[0];
  assert.equal(calls.adzuna.length, 7, "run reached Adzuna through the dashboard");
  assert.equal(calls.telegram.length, 1);
});

test("a clean run records an ok run row and one job row per sent job", async () => {
  fakeFetch({ results: [remoteJob, texasJob, internJob] });
  const db = fakeDb();
  await run(makeEnv(fakeKv(), db));
  const runRow = await db.prepare("SELECT * FROM runs").first();
  assert.equal(runRow.outcome, "ok");
  assert.deepEqual([runRow.candidates, runRow.fresh, runRow.sent, runRow.terms_failed], [1, 1, 1, 0]);
  assert.ok(runRow.finished_at);
  const { results } = await db.prepare("SELECT id, run_id FROM jobs").all();
  assert.deepEqual(results, [{ id: "101", run_id: runRow.id }]);
});

test("a run with nothing new still records an ok row with zero fresh", async () => {
  fakeFetch({ results: [remoteJob] });
  const db = fakeDb();
  await run(makeEnv(fakeKv([101]), db));
  const row = await db.prepare("SELECT outcome, candidates, fresh, sent FROM runs").first();
  assert.deepEqual(row, { outcome: "ok", candidates: 1, fresh: 0, sent: 0 });
});

test("a Telegram failure on part 2 keeps part 1 in KV and D1 and marks the run failed", async () => {
  const jobs = Array.from({ length: 80 }, (_, i) => ({
    ...remoteJob, id: 1000 + i,
    title: `Web Platform Manager ${i} ${"x".repeat(120)}`,
    redirect_url: `https://www.adzuna.com/land/ad/${1000 + i}`,
  }));
  const parts = formatMessages(jobs);
  fakeFetch({ results: jobs, telegramStatus: (i) => (i === 0 ? 200 : 500) });
  const kv = fakeKv();
  const db = fakeDb();
  await assert.rejects(run(makeEnv(kv, db)), /Telegram sendMessage failed: 500/);
  assert.deepEqual(kv.puts.map((p) => p.key).sort(), parts[0].jobs.map((j) => String(j.id)).sort());
  const { results } = await db.prepare("SELECT id FROM jobs ORDER BY id").all();
  assert.deepEqual(results.map((r) => r.id), parts[0].jobs.map((j) => String(j.id)).sort());
  const runRow = await db.prepare("SELECT outcome, fresh, sent, error FROM runs").first();
  assert.equal(runRow.outcome, "failed");
  assert.equal(runRow.fresh, 80);
  assert.equal(runRow.sent, parts[0].jobs.length);
  assert.match(runRow.error, /Telegram sendMessage failed: 500/);
});

test("partial Adzuna failure records terms_failed and outcome ok", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeFetch({ results: [remoteJob], adzunaStatus: (i) => (i < 2 ? 500 : 200) });
  const db = fakeDb();
  await run(makeEnv(fakeKv(), db));
  const row = await db.prepare("SELECT outcome, terms_failed FROM runs").first();
  assert.deepEqual(row, { outcome: "ok", terms_failed: 2 });
});

test("total Adzuna failure records a failed run with the error", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeFetch({ results: [remoteJob], adzunaStatus: 500 });
  const db = fakeDb();
  await assert.rejects(run(makeEnv(fakeKv(), db)), /All Adzuna searches failed/);
  const row = await db.prepare("SELECT outcome, terms_failed, error FROM runs").first();
  assert.deepEqual(row, { outcome: "failed", terms_failed: 7, error: "All Adzuna searches failed" });
});

test("a D1 outage does not stop the send or the KV write", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fakeFetch({ results: [remoteJob] });
  const kv = fakeKv();
  await run(makeEnv(kv, fakeDb({ broken: true })));
  assert.equal(calls.telegram.length, 1);
  assert.deepEqual(kv.puts.map((p) => p.key), ["101"]);
});

test("fetch handler serves the dashboard", async () => {
  const res = await worker.fetch(new Request("https://jobs.example/runs"), makeEnv(fakeKv()), { access: { aud: "test" }, waitUntil() {} });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("No runs yet"));
});
