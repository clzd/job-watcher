import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { formatJob, formatMessage, splitMessage, send } from "../src/telegram.js";

const full = {
  id: 1,
  title: "Web Platform Manager",
  company: { display_name: "Acme Corp" },
  location: { display_name: "Remote" },
  salary_min: 90000,
  salary_max: 120000,
  redirect_url: "https://www.adzuna.com/land/ad/1",
};

const minOnly = {
  id: 2,
  title: "Digital Experience Manager",
  company: { display_name: "Beta Inc" },
  location: { display_name: "Tampa, Florida" },
  salary_min: 85000,
  redirect_url: "https://www.adzuna.com/land/ad/2",
};

const bare = {
  id: 3,
  title: "Website Manager",
  location: { display_name: "Miami, Miami-Dade County" },
  redirect_url: "https://www.adzuna.com/land/ad/3",
};

test("formatMessage produces the exact spec layout", () => {
  const expected = [
    "New jobs (3)",
    "",
    "Web Platform Manager",
    "Acme Corp",
    "Remote",
    "$90,000 to $120,000",
    "https://www.adzuna.com/land/ad/1",
    "",
    "Digital Experience Manager",
    "Beta Inc",
    "Tampa, Florida",
    "$85,000",
    "https://www.adzuna.com/land/ad/2",
    "",
    "Website Manager",
    "Unknown company",
    "Miami, Miami-Dade County",
    "https://www.adzuna.com/land/ad/3",
  ].join("\n");
  assert.equal(formatMessage([full, minOnly, bare]), expected);
});

test("formatJob collapses equal min and max to one figure and rounds to whole dollars", () => {
  const j = { ...full, salary_min: 100000.4, salary_max: 100000.4 };
  assert.match(formatJob(j), /^\$100,000$/m);
  assert.doesNotMatch(formatJob(j), / to /);
});

test("formatJob shows salary_max alone when only max is present", () => {
  const j = { ...bare, salary_max: 70000 };
  assert.match(formatJob(j), /^\$70,000$/m);
});

test("formatJob survives a posting with no location and no company", () => {
  const text = formatJob({ id: 9, title: "Web Manager", redirect_url: "https://x" });
  assert.equal(text, "Web Manager\nUnknown company\nLocation not listed\nhttps://x");
});

test("splitMessage returns a single part when the text fits", () => {
  const text = formatMessage([full, minOnly]);
  assert.deepEqual(splitMessage(text), [text]);
});

test("splitMessage splits at posting boundaries with part headers and keeps every posting", () => {
  const jobs = Array.from({ length: 80 }, (_, i) => ({
    ...full,
    id: i,
    title: `Web Platform Manager ${i} ${"x".repeat(120)}`,
    redirect_url: `https://www.adzuna.com/land/ad/${i}`,
  }));
  const text = formatMessage(jobs);
  assert.ok(text.length > 4096, "fixture must exceed the limit");

  const parts = splitMessage(text);
  assert.ok(parts.length > 1);

  const originalBlocks = new Set(text.split("\n\n").slice(1));
  let seenBlocks = 0;
  parts.forEach((part, i) => {
    assert.ok(part.length <= 4096, `part ${i + 1} is ${part.length} chars`);
    const [header, ...blocks] = part.split("\n\n");
    assert.equal(header, `New jobs (80), part ${i + 1} of ${parts.length}`);
    for (const block of blocks) {
      assert.ok(originalBlocks.has(block), "block was cut mid-posting");
      seenBlocks += 1;
    }
  });
  assert.equal(seenBlocks, 80);
});

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; });

const env = { TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_CHAT_ID: "555" };

test("send posts JSON to the bot sendMessage endpoint with previews disabled", async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('{"ok":true}', { status: 200 });
  };

  await send("hello", env);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/bot123:abc/sendMessage");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    chat_id: "555",
    text: "hello",
    disable_web_page_preview: true,
  });
});

test("send throws on a non-2xx response and includes the status", async () => {
  globalThis.fetch = async () => new Response('{"ok":false,"description":"chat not found"}', { status: 400 });
  await assert.rejects(send("hello", env), /400.*chat not found/);
});
