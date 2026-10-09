# job-watcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Cloudflare Worker on a cron that searches Adzuna for seven job titles, keeps new remote or Florida postings, and sends them to Telegram.

**Architecture:** Five small ESM modules under `src/`: `adzuna.js` fetches, `filters.js` decides keep or drop, `seen.js` diffs against KV, `telegram.js` formats and sends, and `index.js` wires them together in `run(env)` and exposes the `scheduled` handler. Every module takes `env` or a KV binding as an argument so tests pass fakes and never touch the network.

**Tech Stack:** Cloudflare Workers, wrangler 4, Workers KV, plain JavaScript (ESM, no bundler, no TypeScript), `node:test` + `node:assert/strict`, Node 20+.

**Spec:** `docs/superpowers/specs/2026-10-09-job-watcher-design.md`

## Global Constraints

- Plain JavaScript ESM. No TypeScript, no bundler, no test framework dependency. `package.json` has `"type": "module"`.
- Node 22+ locally (engines `>=22`; the test glob needs it). Only dev dependency is `wrangler`.
- Secrets `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` come from `env` only. Never in code, `wrangler.toml`, tests, or logs. Never log a URL that contains `app_key`.
- Cron is `0 */6 * * *`. Exactly seven search terms. Adding an eighth is forbidden (868 calls/month budget, cap 1,000).
- Adzuna call: `GET https://api.adzuna.com/v1/api/jobs/us/search/1` with `app_id`, `app_key`, `what`, `results_per_page=50`, `sort_by=date`, `content-type=application/json`.
- KV binding name `SEEN_JOBS`. Key is the Adzuna `id` as a string. TTL `expirationTtl: 5184000` (60 days).
- KV is written only after Telegram accepts the message.
- Telegram: plain text, no `parse_mode`, `disable_web_page_preview: true`, split at posting boundaries if over 4096 characters.
- Title filter is whole-word: `/\b(intern|junior)\b/i`.
- `CLAUDE.md` stays under 20 lines. README opens with exactly three sentences.
- `.gitignore` includes `.dev.vars`, `node_modules`, `.wrangler`, `.agents`, `skills-lock.json`.
- No em dashes in any file. Dates as YYYY-MM-DD.
- Commit after every task. Repo starts with `git init` in Task 1 (the folder is not a git repo yet).

## Review Focus

Inputs the spec implies but does not spell out. Each has a pinned test in the task named.

1. **Same posting returned by several searches** (very common: "website manager" and "web experience manager" overlap). It must appear once in the message and be written to KV once. Pinned in Task 6.
2. **Telegram rejects the message** (bad token, chat id, or outage). KV must stay untouched so the next run resends. Pinned in Task 6.
3. **Posting with no `location` object or no `company`** (Adzuna sometimes omits them). Filters and formatter must not throw. Pinned in Tasks 2 and 4.
4. **Numeric `id` from Adzuna** (ids arrive as numbers in some responses, strings in others). KV keys are strings, so `findNew` and `markSeen` must stringify consistently or the dedupe silently fails. Pinned in Task 3.
5. **Adzuna returns 200 with a body that has no `results`** (rate-limit and error bodies do this). `fetchSearch` must return `[]`, not throw. Pinned in Task 5.

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `.gitignore`, `wrangler.toml`, `.dev.vars.example`, `.claude/settings.json`, `LICENSE`
- Create (empty for now): `src/`, `test/`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm test` runs `node --test` (picks up `test/*.test.js`). `env.SEEN_JOBS` KV binding name. The four secret names.

- [ ] **Step 1: Initialize git**

```bash
cd /Users/anthonycalzadilla/Sites/job-watcher
git init -b main
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules
.wrangler
.dev.vars
.agents
skills-lock.json
```

- [ ] **Step 3: Write `package.json`**

```json
{
  "name": "job-watcher",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "license": "MIT",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "test": "node --test \"test/*.test.js\"",
    "dev": "wrangler dev --test-scheduled",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 4: Install wrangler**

Run: `npm install`
Expected: `node_modules/` and `package-lock.json` appear. Commit `package-lock.json`.

- [ ] **Step 5: Write `wrangler.toml`**

```toml
name = "job-watcher"
main = "src/index.js"
compatibility_date = "2026-09-01"
workers_dev = false

[triggers]
crons = ["0 */6 * * *"]

[[kv_namespaces]]
binding = "SEEN_JOBS"
id = "REPLACE_WITH_KV_NAMESPACE_ID"

[observability]
enabled = true
```

`workers_dev = false` because the Worker has no HTTP handler and needs no public URL. The KV id placeholder is replaced by the output of `wrangler kv namespace create SEEN_JOBS` at deploy time (README, Task 7).

- [ ] **Step 6: Write `.dev.vars.example`**

```
ADZUNA_APP_ID=
ADZUNA_APP_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

- [ ] **Step 7: Write `.claude/settings.json` (PostToolUse test hook)**

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|MultiEdit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && out=$(npm test --silent 2>&1) || { printf '%s\\n' \"$out\" | tail -n 40 >&2; exit 2; }"
          }
        ]
      }
    ]
  }
}
```

Exit code 2 feeds the failing output back to Claude. Exit 0 stays quiet. With no test files yet, `node --test` reports 0 tests and exits 0 (verified on Node 23).

- [ ] **Step 8: Write `LICENSE`**

```
MIT License

Copyright (c) 2026 Anthony Calzadilla

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 9: Create empty dirs and verify the test command**

```bash
mkdir -p src test
npm test
```
Expected: output ends with `pass 0`, `fail 0`, exit code 0.

- [ ] **Step 10: Commit**

```bash
git add .gitignore package.json package-lock.json wrangler.toml .dev.vars.example .claude/settings.json LICENSE docs
git commit -m "chore: scaffold job-watcher worker, test hook, license"
```

Confirm `git status` shows `.agents/` and `skills-lock.json` are not tracked.

---

### Task 2: Title and location filters

**Files:**
- Create: `src/filters.js`
- Test: `test/filters.test.js`

**Interfaces:**
- Consumes: Adzuna posting shape `{ title, location: { display_name, area: string[] } }`.
- Produces: `passesTitleFilter(job) => boolean` and `passesLocationFilter(job) => boolean`. `true` means keep.

- [ ] **Step 1: Write the failing tests**

`test/filters.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { passesTitleFilter, passesLocationFilter } from "../src/filters.js";

const job = (title, location) => ({ title, location });

test("title filter drops whole-word intern and junior, case-insensitive", () => {
  const dropped = [
    "Intern",
    "INTERN",
    "Junior Developer",
    "Web Manager (Intern)",
    "Marketing intern, remote",
  ];
  for (const title of dropped) {
    assert.equal(passesTitleFilter(job(title)), false, title);
  }
});

test("title filter keeps titles where intern is only part of a word", () => {
  const kept = [
    "Senior Web Manager",
    "International Web Manager",
    "Internal Tools Manager",
    "Internship Coordinator",
  ];
  for (const title of kept) {
    assert.equal(passesTitleFilter(job(title)), true, title);
  }
});

test("title filter keeps a job with no title", () => {
  assert.equal(passesTitleFilter({}), true);
});

test("location filter keeps remote in the title even when location is elsewhere", () => {
  const j = job("Web Manager (Remote)", {
    display_name: "Austin, Texas",
    area: ["US", "Texas", "Austin"],
  });
  assert.equal(passesLocationFilter(j), true);
});

test("location filter keeps remote in display_name, any case", () => {
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "Remote, US", area: ["US"] })), true);
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "REMOTE - United States", area: ["US"] })), true);
});

test("location filter keeps Florida in area", () => {
  const j = job("Web Manager", {
    display_name: "Miami, Miami-Dade County",
    area: ["US", "Florida", "Miami-Dade County", "Miami"],
  });
  assert.equal(passesLocationFilter(j), true);
});

test("location filter keeps a , FL suffix and Florida in display_name", () => {
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "Tampa, FL", area: [] })), true);
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "Orlando, Florida", area: [] })), true);
});

test("location filter drops a non-remote job outside Florida", () => {
  const j = job("Web Manager", {
    display_name: "Austin, Texas",
    area: ["US", "Texas", "Austin"],
  });
  assert.equal(passesLocationFilter(j), false);
});

test("location filter does not treat FL inside a word as Florida", () => {
  assert.equal(passesLocationFilter(job("Web Manager", { display_name: "Flint, Michigan", area: ["US", "Michigan"] })), false);
});

test("location filter handles a job with no location object", () => {
  assert.equal(passesLocationFilter({ title: "Web Manager" }), false);
  assert.equal(passesLocationFilter({ title: "Remote Web Manager" }), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL. Error mentions `Cannot find module '../src/filters.js'`.

- [ ] **Step 3: Write `src/filters.js`**

```js
const EXCLUDED_TITLE = /\b(intern|junior)\b/i;
const REMOTE = /remote/i;
const FLORIDA = /florida/i;
const FL_SUFFIX = /,\s*fl$/i;

export function passesTitleFilter(job) {
  return !EXCLUDED_TITLE.test(job.title ?? "");
}

export function passesLocationFilter(job) {
  const title = job.title ?? "";
  const display = job.location?.display_name ?? "";
  const area = Array.isArray(job.location?.area) ? job.location.area : [];

  if (REMOTE.test(title) || REMOTE.test(display)) return true;
  if (area.some((a) => String(a).toLowerCase() === "florida")) return true;
  return FLORIDA.test(display) || FL_SUFFIX.test(display);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all filter tests PASS, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/filters.js test/filters.test.js
git commit -m "feat: title and location filters"
```

---

### Task 3: KV diff (seen store)

**Files:**
- Create: `src/seen.js`
- Test: `test/seen.test.js`

**Interfaces:**
- Consumes: a KV binding with `get(key) => Promise<string|null>` and `put(key, value, { expirationTtl }) => Promise<void>`. Postings with an `id` (string or number).
- Produces: `findNew(jobs, kv) => Promise<job[]>` (only postings whose id is not in KV), `markSeen(jobs, kv) => Promise<void>` (never throws), `SEEN_TTL_SECONDS = 5184000`.

- [ ] **Step 1: Write the failing tests**

`test/seen.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { findNew, markSeen, SEEN_TTL_SECONDS } from "../src/seen.js";

function fakeKv(seenIds = []) {
  const store = new Map(seenIds.map((id) => [String(id), "1"]));
  const puts = [];
  return {
    store,
    puts,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      puts.push({ key, value, options });
      store.set(key, value);
    },
  };
}

test("TTL constant is 60 days in seconds", () => {
  assert.equal(SEEN_TTL_SECONDS, 5184000);
});

test("findNew returns only postings absent from KV, in original order", async () => {
  const kv = fakeKv(["b"]);
  const jobs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const fresh = await findNew(jobs, kv);
  assert.deepEqual(fresh.map((j) => j.id), ["a", "c"]);
});

test("findNew treats a numeric id and its string form as the same key", async () => {
  const kv = fakeKv(["12345"]);
  const fresh = await findNew([{ id: 12345 }, { id: 67890 }], kv);
  assert.deepEqual(fresh.map((j) => j.id), [67890]);
});

test("findNew with no jobs does not touch KV", async () => {
  const kv = fakeKv();
  let gets = 0;
  kv.get = async () => { gets += 1; return null; };
  assert.deepEqual(await findNew([], kv), []);
  assert.equal(gets, 0);
});

test("findNew propagates KV read errors", async () => {
  const kv = { get: async () => { throw new Error("kv down"); } };
  await assert.rejects(findNew([{ id: "a" }], kv), /kv down/);
});

test("markSeen writes each id as a string key with the 60-day TTL", async () => {
  const kv = fakeKv();
  await markSeen([{ id: "a" }, { id: 42 }], kv);
  assert.deepEqual(kv.puts, [
    { key: "a", value: "1", options: { expirationTtl: 5184000 } },
    { key: "42", value: "1", options: { expirationTtl: 5184000 } },
  ]);
});

test("markSeen logs and swallows a failing put so the run still succeeds", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const kv = { put: async () => { throw new Error("quota"); } };
  await markSeen([{ id: "a" }], kv);
  assert.equal(errors.mock.callCount(), 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/seen.js'`.

- [ ] **Step 3: Write `src/seen.js`**

```js
export const SEEN_TTL_SECONDS = 60 * 24 * 60 * 60; // 60 days = 5184000

export async function findNew(jobs, kv) {
  const hits = await Promise.all(jobs.map((job) => kv.get(String(job.id))));
  return jobs.filter((_, i) => hits[i] === null || hits[i] === undefined);
}

export async function markSeen(jobs, kv) {
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await kv.put(String(job.id), "1", { expirationTtl: SEEN_TTL_SECONDS });
      } catch (err) {
        console.error(`KV put failed for job ${job.id}`, err);
      }
    }),
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all seen tests PASS, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/seen.js test/seen.test.js
git commit -m "feat: KV diff for seen postings with 60-day TTL"
```

---

### Task 4: Telegram formatter, splitter, sender

**Files:**
- Create: `src/telegram.js`
- Test: `test/telegram.test.js`

**Interfaces:**
- Consumes: postings `{ title, company: { display_name }, location: { display_name }, salary_min, salary_max, redirect_url }`. `env.TELEGRAM_BOT_TOKEN`, `env.TELEGRAM_CHAT_ID`, global `fetch`.
- Produces: `formatJob(job) => string`, `formatMessage(jobs) => string`, `splitMessage(text, limit = 4096) => string[]`, `send(text, env) => Promise<void>` (throws on non-2xx).

Formatting rules (from the spec): header `New jobs (N)`, then per posting: title, company or `Unknown company`, location display name or `Location not listed`, salary line only if present, `redirect_url`. Postings separated by one blank line. Salary: both present and different gives `$90,000 to $120,000`; both present and equal, or only one present, gives a single `$90,000`. Whole dollars with thousands separators.

- [ ] **Step 1: Write the failing tests**

`test/telegram.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/telegram.js'`.

- [ ] **Step 3: Write `src/telegram.js`**

```js
const TELEGRAM_LIMIT = 4096;
const money = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function salaryLine(job) {
  const min = typeof job.salary_min === "number" ? job.salary_min : null;
  const max = typeof job.salary_max === "number" ? job.salary_max : null;
  if (min !== null && max !== null) {
    const lo = money.format(min);
    const hi = money.format(max);
    return lo === hi ? `$${lo}` : `$${lo} to $${hi}`;
  }
  if (min !== null) return `$${money.format(min)}`;
  if (max !== null) return `$${money.format(max)}`;
  return null;
}

export function formatJob(job) {
  const lines = [
    job.title ?? "Untitled",
    job.company?.display_name || "Unknown company",
    job.location?.display_name || "Location not listed",
  ];
  const salary = salaryLine(job);
  if (salary) lines.push(salary);
  lines.push(job.redirect_url ?? "");
  return lines.join("\n");
}

export function formatMessage(jobs) {
  return [`New jobs (${jobs.length})`, ...jobs.map(formatJob)].join("\n\n");
}

export function splitMessage(text, limit = TELEGRAM_LIMIT) {
  if (text.length <= limit) return [text];

  const [header, ...blocks] = text.split("\n\n");
  // Reserve room for the longest plausible part header, e.g. ", part 10 of 10".
  const headerBudget = header.length + ", part 00 of 00".length + 2;

  const groups = [];
  let current = [];
  let used = 0;
  for (const block of blocks) {
    const cost = block.length + 2;
    if (current.length > 0 && headerBudget + used + cost > limit) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(block);
    used += cost;
  }
  if (current.length > 0) groups.push(current);

  return groups.map((group, i) =>
    [`${header}, part ${i + 1} of ${groups.length}`, ...group].join("\n\n"),
  );
}

export async function send(text, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all telegram tests PASS, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/telegram.js test/telegram.test.js
git commit -m "feat: Telegram message formatter, splitter, and sender"
```

---

### Task 5: Adzuna client

**Files:**
- Create: `src/adzuna.js`
- Test: `test/adzuna.test.js`

**Interfaces:**
- Consumes: `env.ADZUNA_APP_ID`, `env.ADZUNA_APP_KEY`, global `fetch`.
- Produces: `buildUrl(term, env) => string`, `fetchSearch(term, env) => Promise<job[]>` (always resolves; `[]` on any failure, logged with `console.error` without the URL).

- [ ] **Step 1: Write the failing tests**

`test/adzuna.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildUrl, fetchSearch } from "../src/adzuna.js";

const env = { ADZUNA_APP_ID: "myid", ADZUNA_APP_KEY: "mykey" };

test("buildUrl targets the US search endpoint with every required parameter", () => {
  const url = new URL(buildUrl("website manager", env));
  assert.equal(url.origin + url.pathname, "https://api.adzuna.com/v1/api/jobs/us/search/1");
  assert.equal(url.searchParams.get("app_id"), "myid");
  assert.equal(url.searchParams.get("app_key"), "mykey");
  assert.equal(url.searchParams.get("what"), "website manager");
  assert.equal(url.searchParams.get("results_per_page"), "50");
  assert.equal(url.searchParams.get("sort_by"), "date");
  assert.equal(url.searchParams.get("content-type"), "application/json");
});

test("buildUrl URL-encodes the search term", () => {
  const raw = buildUrl("conversion rate optimization manager", env);
  assert.ok(raw.includes("what=conversion+rate+optimization+manager"), raw);
  assert.ok(!raw.includes(" "));
});

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; });

test("fetchSearch returns results on 200", async () => {
  const results = [{ id: "1", title: "Website Manager" }];
  globalThis.fetch = async () => new Response(JSON.stringify({ results }), { status: 200 });
  assert.deepEqual(await fetchSearch("website manager", env), results);
});

test("fetchSearch returns [] and logs on a non-2xx without leaking the key", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  globalThis.fetch = async () => new Response("rate limited", { status: 500 });
  assert.deepEqual(await fetchSearch("website manager", env), []);
  assert.equal(errors.mock.callCount(), 1);
  const logged = errors.mock.calls[0].arguments.map(String).join(" ");
  assert.ok(!logged.includes("mykey"), "app_key must not be logged");
});

test("fetchSearch returns [] when the 200 body has no results array", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ exception: "limit" }), { status: 200 });
  assert.deepEqual(await fetchSearch("website manager", env), []);
});

test("fetchSearch returns [] and logs when fetch itself throws", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  assert.deepEqual(await fetchSearch("website manager", env), []);
  assert.equal(errors.mock.callCount(), 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/adzuna.js'`.

- [ ] **Step 3: Write `src/adzuna.js`**

```js
const ENDPOINT = "https://api.adzuna.com/v1/api/jobs/us/search/1";

export function buildUrl(term, env) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("app_id", env.ADZUNA_APP_ID);
  url.searchParams.set("app_key", env.ADZUNA_APP_KEY);
  url.searchParams.set("what", term);
  url.searchParams.set("results_per_page", "50");
  url.searchParams.set("sort_by", "date");
  url.searchParams.set("content-type", "application/json");
  return url.toString();
}

export async function fetchSearch(term, env) {
  try {
    const res = await fetch(buildUrl(term, env));
    if (!res.ok) {
      console.error(`Adzuna returned ${res.status} for "${term}"`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    console.error(`Adzuna request failed for "${term}": ${err.message}`);
    return [];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all adzuna tests PASS, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add src/adzuna.js test/adzuna.test.js
git commit -m "feat: Adzuna search client"
```

---

### Task 6: Orchestration and scheduled handler

**Files:**
- Create: `src/index.js`
- Test: `test/index.test.js`

**Interfaces:**
- Consumes: `fetchSearch(term, env)` from Task 5, `passesTitleFilter` and `passesLocationFilter` from Task 2, `findNew(jobs, kv)` and `markSeen(jobs, kv)` from Task 3, `formatMessage(jobs)`, `splitMessage(text)`, `send(text, env)` from Task 4.
- Produces: `SEARCH_TERMS` (array of 7 strings), `run(env) => Promise<void>`, and a default export with `scheduled(controller, env, ctx)`.

Run order (from the spec): fetch all seven searches in parallel, flatten, dedupe by `id` within the run, title filter, location filter, KV diff, stop if empty, send each message part, then mark seen.

- [ ] **Step 1: Write the failing tests**

`test/index.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import worker, { run, SEARCH_TERMS } from "../src/index.js";

function fakeKv(seenIds = []) {
  const store = new Map(seenIds.map((id) => [String(id), "1"]));
  const puts = [];
  return {
    puts,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, options) { puts.push({ key, value, options }); store.set(key, value); },
  };
}

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL with `Cannot find module '../src/index.js'`.

- [ ] **Step 3: Write `src/index.js`**

```js
import { fetchSearch } from "./adzuna.js";
import { passesTitleFilter, passesLocationFilter } from "./filters.js";
import { findNew, markSeen } from "./seen.js";
import { formatMessage, splitMessage, send } from "./telegram.js";

// Seven terms. Do not add an eighth: 7 x 4 runs x 31 days = 868 of the 1,000 monthly Adzuna calls.
export const SEARCH_TERMS = [
  "web platform manager",
  "digital experience manager",
  "web experience manager",
  "website manager",
  "Optimizely",
  "conversion rate optimization manager",
  "WordPress manager",
];

function dedupeById(jobs) {
  const byId = new Map();
  for (const job of jobs) {
    const key = String(job.id);
    if (!byId.has(key)) byId.set(key, job);
  }
  return [...byId.values()];
}

export async function run(env) {
  const perTerm = await Promise.all(SEARCH_TERMS.map((term) => fetchSearch(term, env)));
  const candidates = dedupeById(perTerm.flat())
    .filter(passesTitleFilter)
    .filter(passesLocationFilter);

  const fresh = await findNew(candidates, env.SEEN_JOBS);
  if (fresh.length === 0) {
    console.log(`No new jobs (${candidates.length} candidates, all seen)`);
    return;
  }

  for (const part of splitMessage(formatMessage(fresh))) {
    await send(part, env);
  }
  await markSeen(fresh, env.SEEN_JOBS);
  console.log(`Sent ${fresh.length} new jobs`);
}

export default {
  async scheduled(controller, env, ctx) {
    await run(env);
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: every test file PASS, `fail 0`.

- [ ] **Step 5: Smoke the Worker locally (no real credentials needed for a dry run)**

```bash
npx wrangler deploy --dry-run --outdir /private/tmp/claude-501/-Users-anthonycalzadilla-Sites-job-watcher/c8faadfb-bf14-429f-8748-1ce1e21fd45f/scratchpad/wrangler-dry-run
```
Expected: "--dry-run: exiting now." with no errors. This proves `wrangler.toml` and the import graph are valid.

- [ ] **Step 6: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: scheduled run that searches, filters, dedupes, and alerts"
```

---

### Task 7: README and CLAUDE.md

**Files:**
- Create: `README.md`, `CLAUDE.md`

**Interfaces:**
- Consumes: commands from `package.json` (Task 1) and the KV binding name `SEEN_JOBS`.
- Produces: operator docs. No code.

- [ ] **Step 1: Write `README.md`**

```markdown
# job-watcher

job-watcher is a Cloudflare Worker that runs four times a day and searches the Adzuna jobs API for seven web platform and digital experience manager titles. It keeps only remote or Florida postings that are not interns or juniors and that it has not sent before, remembering sent ids in Workers KV for 60 days. When there is something new it sends one Telegram message with title, company, location, salary when listed, and a link.

## Setup

One time, create the KV namespace and paste the printed id into `wrangler.toml` under `[[kv_namespaces]]`:

    npx wrangler kv namespace create SEEN_JOBS

Set the four secrets (each command prompts for the value):

    npx wrangler secret put ADZUNA_APP_ID
    npx wrangler secret put ADZUNA_APP_KEY
    npx wrangler secret put TELEGRAM_BOT_TOKEN
    npx wrangler secret put TELEGRAM_CHAT_ID

## Deploy

    npx wrangler deploy

## Run locally

Copy `.dev.vars.example` to `.dev.vars` and fill in the values, then:

    npx wrangler dev --test-scheduled

In a second terminal, trigger the cron by hand:

    curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"

## Test

    npm test

## License

MIT
```

- [ ] **Step 2: Write `CLAUDE.md` (must stay under 20 lines)**

```markdown
# job-watcher

Cloudflare Worker on a cron (`0 */6 * * *`) that searches Adzuna and sends new remote or Florida jobs to Telegram.

## Commands
- `npm test` runs `node --test` over `test/*.test.js`. No framework, no build step.
- `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"` runs the cron locally.
- `npx wrangler deploy` deploys. `npx wrangler deploy --dry-run` validates config without deploying.

## Quirks
- Plain JS ESM. No bundler, no TypeScript. Every module takes `env` or a KV binding so tests pass fakes.
- Secrets only via `wrangler secret put` (prod) or `.dev.vars` (local, gitignored). Never in code or `wrangler.toml`. Never log an Adzuna URL (it carries the key).
- Adzuna free tier is about 1,000 calls a month. 7 terms x 4 runs x 31 days = 868. Do not add an 8th term without dropping to 3 runs a day.
- Seen ids live in the `SEEN_JOBS` KV namespace with a 60-day TTL. KV is written only after Telegram accepts the message, so a failed send retries next run.
- Title filter is whole-word (`/\b(intern|junior)\b/i`), so "International" is kept.
- `.claude/settings.json` has a PostToolUse hook that runs `npm test` after every Edit or Write.
```

- [ ] **Step 3: Verify line count and sentence count**

```bash
wc -l CLAUDE.md
```
Expected: 19 or fewer. The README's first paragraph must be exactly three sentences; count the periods.

- [ ] **Step 4: Run the full suite once more**

Run: `npm test`
Expected: `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: README with deploy steps and CLAUDE.md"
```

---

## Verification (end to end)

1. `npm test` passes with `fail 0` and at least 30 tests.
2. `npx wrangler deploy --dry-run --outdir <scratchpad>/wrangler-dry-run` exits cleanly.
3. `git status` is clean and `git ls-files` does not list `.dev.vars`, `.agents/`, `skills-lock.json`, or `node_modules/`.
4. `wc -l CLAUDE.md` is under 20. README opens with three sentences.
5. `grep -rn "app_key\|TELEGRAM_BOT_TOKEN" src/` shows only `env.` reads and the `searchParams.set` line, no literals.
6. Manual, by Anthony, after creating the KV namespace and setting secrets: `npx wrangler dev --test-scheduled` plus the curl above. A Telegram message arrives if any new matches exist. A second curl within a minute sends nothing because the ids are now in local KV.
7. After `npx wrangler deploy`, the Cloudflare dashboard shows the cron trigger `0 */6 * * *` and the next run's log line is either `Sent N new jobs` or `No new jobs (...)`.
