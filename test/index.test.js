import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import worker, { run, SEARCH_TERMS } from "../src/index.js";
import { fakeKv } from "./helpers.js";

function fakeFetch({ results = [], telegramStatus = 200 } = {}) {
  const calls = { adzuna: [], telegram: [] };
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.startsWith("https://api.adzuna.com/")) {
      calls.adzuna.push(u);
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    if (u.startsWith("https://api.telegram.org/")) {
      calls.telegram.push(JSON.parse(options.body));
      return new Response(telegramStatus === 200 ? '{"ok":true}' : '{"ok":false}', { status: telegramStatus });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}

function makeEnv(kv) {
  return {
    ADZUNA_APP_ID: "id",
    ADZUNA_APP_KEY: "key",
    TELEGRAM_BOT_TOKEN: "tok",
    TELEGRAM_CHAT_ID: "chat",
    SEEN_JOBS: kv,
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
  assert.equal(calls.telegram.length, 1);
  const text = calls.telegram[0].text;
  assert.ok(text.startsWith("New jobs (1)\n\n"), text);
  assert.equal(text.split("https://www.adzuna.com/land/ad/101").length - 1, 1, "job listed once");
  assert.ok(!text.includes("Lone Star"), "Texas job filtered out");
  assert.ok(!text.includes("Intern"), "intern job filtered out");
  assert.deepEqual(kv.puts.map((p) => p.key), ["101"]);
  assert.equal(kv.puts[0].options.expirationTtl, 5184000);
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

test("run throws and leaves KV untouched when Telegram rejects the message", async () => {
  fakeFetch({ results: [remoteJob], telegramStatus: 500 });
  const kv = fakeKv();

  await assert.rejects(run(makeEnv(kv)), /Telegram sendMessage failed: 500/);
  assert.equal(kv.puts.length, 0);
});

test("scheduled handler awaits run", async () => {
  const calls = fakeFetch({ results: [remoteJob] });
  const kv = fakeKv();
  await worker.scheduled({ cron: "0 */6 * * *" }, makeEnv(kv), { waitUntil() {} });
  assert.equal(calls.telegram.length, 1);
});
