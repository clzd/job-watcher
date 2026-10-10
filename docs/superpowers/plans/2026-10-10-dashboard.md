# job-watcher Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Model requirement (from Anthony):** every subagent dispatched for this plan, implementer and reviewer alike, must run on Claude Opus 5.5. Pass `model: "opus"` on each Agent call. Do not fall back to a smaller model for any task.

**Goal:** Record each cron run and each sent job in D1, and serve a private Jobs and Runs dashboard from the same Worker where Anthony can mark jobs new, applied, or dismissed.

**Architecture:** Two new modules. `src/store.js` owns every SQL statement and takes the D1 binding as its last argument. `src/http.js` owns routing and HTML rendering and takes `(request, env, ctx)`. `src/index.js` calls `store.js` at the start and end of `run(env)` and after each sent Telegram part, and adds a `fetch` export that delegates to `http.js`. Tests use a fake D1 built on Node's `node:sqlite` so the real schema runs with no new dependency.

**Tech Stack:** Cloudflare Workers, wrangler 4, Workers KV, D1 (SQLite), Cloudflare Access (`ctx.access`), plain JavaScript ESM, `node:test`, `node:sqlite` (Node 22.13+).

**Spec:** `docs/superpowers/specs/2026-10-09-dashboard-design.md`

## Global Constraints

- Plain JavaScript ESM. No TypeScript, no bundler, no new npm dependencies. `wrangler` stays the only devDependency.
- Node 22.13 or newer locally (`node:sqlite` is built in from 22.13). Task 0 verifies this.
- Every module takes `env` or a binding as an argument. `store.js` is the only module that contains SQL. All SQL uses bound parameters (`?`), never string concatenation.
- KV is written only after Telegram accepts a part. D1 is written after KV. A D1 failure in the cron path is logged with `console.error` and never thrown.
- The dashboard never calls `fetch`. No Adzuna call is added anywhere.
- Never log, store, or render an Adzuna or Telegram URL. `jobs.url` is only ever Adzuna's `redirect_url`.
- D1 binding name is `DB`. Database name `job-watcher`, id `511c1f46-4381-439d-840c-45b9696ae154` (already in `wrangler.toml`).
- Access AUD tag: `9ae4158bb63c126a6bb4d299888e0add8d2ce8bfd49443188dad612524c36f5a`.
- Timestamps stored as ISO 8601 UTC from `new Date().toISOString()`. Rendered as `YYYY-MM-DD HH:mm ET` in `America/New_York`.
- Job status values are exactly `new`, `applied`, `dismissed`. Run outcomes are exactly `running`, `ok`, `failed`.
- `runs.error` is cut to 500 characters.
- Page limits: 200 jobs, 50 runs.
- `CLAUDE.md` stays under 20 lines. No em dashes in any file. Dates YYYY-MM-DD.
- `npm test` must pass after every Edit or Write (the PostToolUse hook runs it). During a "write the failing test" step the hook will report that test failing; that is the expected red state, and the next step turns it green. Commit after every task.
- Steps marked **PAUSE** touch production. Stop and get Anthony's OK before running them.

## Review Focus

Inputs the spec implies but does not spell out. Each has a pinned test in the task named.

1. **Adzuna sends `salary_min` as a string or omits `company`/`location` entirely.** `saveJobs` must store `null`, not `"85000"` or throw. Pinned in Task 2.
2. **`finishRun` is called with a `null` runId** (D1 was down at `startRun`, up later). Must be a no-op, no throw, no stray row. Pinned in Task 2.
3. **A job title or company containing `"`, `&`, or `<script>`.** Must render as escaped text, including inside the `href` attribute. Pinned in Task 4.
4. **`?status=bogus` on the jobs page.** Must fall back to `new`, not 500 and not leak the value into SQL. Pinned in Task 4.
5. **POST with a `Referer` on another origin, or no `status` field at all.** Redirect must go to `/`, never off-site; a missing field is `400`. Pinned in Task 5.

---

### Task 0: Preflight and commit tonight's config

**Files:**
- Modify: `wrangler.toml` (add `[access.dev]`), `package.json` (test script flag)
- Commit: `wrangler.toml`, `docs/handoff/2026-10-09-dashboard.md`, `docs/superpowers/specs/2026-10-09-dashboard-design.md`, `docs/superpowers/plans/2026-10-10-dashboard.md`

**Interfaces:**
- Consumes: nothing.
- Produces: a working tree where `node:sqlite` loads and `wrangler dev` will populate `ctx.access`.

- [ ] **Step 1: Verify Node supports `node:sqlite`**

Run: `node --version && node -e "import('node:sqlite').then(() => console.log('sqlite ok'))"`
Expected: a version of `v22.13.0` or newer and the line `sqlite ok`. If the import fails, stop and tell Anthony to upgrade Node (for example `nvm install 22 && nvm use 22`) before continuing.

- [ ] **Step 2: Silence the experimental warning in the test script**

In `package.json`, change the test script to:

```
"test": "node --disable-warning=ExperimentalWarning --test \"test/*.test.js\""
```

- [ ] **Step 3: Add the Access dev block to `wrangler.toml`**

Append after the `[[d1_databases]]` block:

```toml
# Lets wrangler dev populate ctx.access so the dashboard works locally. Ignored in production.
[access.dev]
aud = "9ae4158bb63c126a6bb4d299888e0add8d2ce8bfd49443188dad612524c36f5a"

  [access.dev.identity]
  email = "anthony.calzadilla@gmail.com"
```

- [ ] **Step 4: Validate config and run tests**

Run: `npx wrangler deploy --dry-run && npm test`
Expected: dry run lists `env.DB (job-watcher)` and `env.SEEN_JOBS`, and all existing tests pass with no `ExperimentalWarning` lines.

- [ ] **Step 5: Commit**

```bash
git add wrangler.toml package.json docs/handoff docs/superpowers/specs/2026-10-09-dashboard-design.md docs/superpowers/plans/2026-10-10-dashboard.md
git commit -m "chore: bind D1, enable workers.dev, add dashboard spec and plan"
```

---

### Task 1: Migration and fake D1

**Files:**
- Create: `migrations/0001_init.sql`
- Modify: `test/helpers.js` (add `fakeDb`)
- Test: `test/store.test.js` (schema smoke test only; Task 2 fills it out)

**Interfaces:**
- Consumes: nothing.
- Produces: `fakeDb({ broken = false } = {})` returning an object with `prepare(sql)` and `batch(statements)`. `prepare(sql)` returns a statement with `bind(...params)` (returns itself), `run()` resolving to `{ success: true, meta: { last_row_id, changes } }`, `all()` resolving to `{ results }`, `first()` resolving to the row or `null`. `batch(statements)` resolves to an array of `run()` results in order. With `broken: true`, `prepare` throws `new Error("fake D1 is down")`. The fake loads `migrations/0001_init.sql` into an in-memory `DatabaseSync` on creation.

- [ ] **Step 1: Write the migration**

`migrations/0001_init.sql` contains exactly the schema from the spec's Storage section: `runs`, `jobs`, index `jobs_status_sent ON jobs (status, sent_at DESC)`, index `runs_started ON runs (started_at DESC)`.

- [ ] **Step 2: Write the failing schema test**

```js
// test/store.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./helpers.js";

test("fakeDb loads the migration", async () => {
  const db = fakeDb();
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'runs') ORDER BY name").all();
  assert.deepEqual(results.map((r) => r.name), ["jobs", "runs"]);
});

test("fakeDb({ broken: true }) throws on prepare", () => {
  assert.throws(() => fakeDb({ broken: true }).prepare("SELECT 1"), /fake D1 is down/);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL, `fakeDb` is not exported.

- [ ] **Step 4: Implement `fakeDb` in `test/helpers.js`**

Use `DatabaseSync` from `node:sqlite` with `":memory:"`, `readFileSync` the migration (resolve the path from `import.meta.url`), and `db.exec(sql)`. Map `run()` to the sqlite statement's `.run(...params)` (`lastInsertRowid` becomes `meta.last_row_id`, `changes` becomes `meta.changes`), `all()` to `.all(...params)`, `first()` to `.get(...params) ?? null`. Bound params default to `[]` when `bind` was not called.

- [ ] **Step 5: Run to verify it passes**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/0001_init.sql test/helpers.js test/store.test.js
git commit -m "feat: D1 migration and sqlite-backed fake for tests"
```

---

### Task 2: Store module

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: `fakeDb` from Task 1.
- Produces, all in `src/store.js`, each taking the D1 binding `db` as the last argument:
  - `startRun(db) -> Promise<number|null>`: inserts a `runs` row with `started_at` now and `outcome = 'running'`; returns `meta.last_row_id`. On any error: `console.error`, return `null`.
  - `finishRun(runId, fields, db) -> Promise<void>`: `fields` is `{ outcome, candidates, fresh, sent, termsFailed, error }`, any of which may be undefined. Sets `finished_at` now and every provided column; `error` truncated to 500 chars. No-op when `runId` is `null`. Errors logged, never thrown.
  - `saveJobs(jobs, runId, db) -> Promise<void>`: `jobs` are Adzuna job objects. One `INSERT OR IGNORE` per job via `db.batch`. Columns: `id` as `String(job.id)`, `title` (`job.title ?? "Untitled"`), `company` (`job.company?.display_name ?? null`), `location` (`job.location?.display_name ?? null`), `salary_min` and `salary_max` (the value only when `typeof === "number"`, else `null`), `url` (`job.redirect_url ?? null`), `sent_at` now, `run_id`. Errors logged, never thrown.
  - `latestRun(db) -> Promise<Run|null>`: newest by `started_at`. Throws on DB error.
  - `listRuns(limit, db) -> Promise<Run[]>`: newest first. Throws.
  - `listJobs(status, db) -> Promise<Job[]>`: `status` is one of the three values or `"all"`; newest `sent_at` first; `LIMIT 200`. Throws.
  - `countByStatus(db) -> Promise<{ new: number, applied: number, dismissed: number }>`: zeros for missing statuses. Throws.
  - `setJobStatus(id, status, db) -> Promise<boolean>`: updates `status` and `status_at` now; returns `meta.changes === 1`. Throws on DB error.
  - `Run` and `Job` are plain row objects with the column names from the migration.

- [ ] **Step 1: Write the failing tests**

Append to `test/store.test.js` (import every store function; use `fakeDb()` per test). Fixtures: `remoteJob` as in `test/index.test.js` plus `salary_min: 90000, salary_max: 120000`; `bareJob` with only `id: 202, title: "Website Manager"`; `stringSalaryJob` with `id: 303, title: "X", salary_min: "85000"`.

```js
test("startRun inserts a running row and returns its id", async () => {
  const db = fakeDb();
  const id = await startRun(db);
  assert.equal(id, 1);
  const row = await db.prepare("SELECT outcome, started_at, finished_at FROM runs WHERE id = ?").bind(id).first();
  assert.equal(row.outcome, "running");
  assert.match(row.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.finished_at, null);
});

test("startRun returns null and logs when D1 is down", async (t) => {
  const err = t.mock.method(console, "error", () => {});
  assert.equal(await startRun(fakeDb({ broken: true })), null);
  assert.equal(err.mock.callCount(), 1);
});

test("finishRun writes outcome, counts, finished_at, and truncates error to 500", async () => {
  const db = fakeDb();
  const id = await startRun(db);
  await finishRun(id, { outcome: "failed", candidates: 5, fresh: 2, sent: 1, termsFailed: 3, error: "x".repeat(600) }, db);
  const row = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
  assert.equal(row.outcome, "failed");
  assert.deepEqual([row.candidates, row.fresh, row.sent, row.terms_failed], [5, 2, 1, 3]);
  assert.equal(row.error.length, 500);
  assert.ok(row.finished_at);
});

test("finishRun with a null runId is a no-op", async () => {
  const db = fakeDb();
  await finishRun(null, { outcome: "ok" }, db);
  const { results } = await db.prepare("SELECT id FROM runs").all();
  assert.equal(results.length, 0);
});

test("saveJobs stores the mapped columns and stringifies a numeric id", async () => {
  const db = fakeDb();
  await saveJobs([remoteJob], 7, db);
  const row = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind("101").first();
  assert.equal(row.title, "Web Platform Manager");
  assert.equal(row.company, "Acme");
  assert.equal(row.location, "Remote");
  assert.equal(row.salary_min, 90000);
  assert.equal(row.salary_max, 120000);
  assert.equal(row.url, "https://www.adzuna.com/land/ad/101");
  assert.equal(row.run_id, 7);
  assert.equal(row.status, "new");
});

test("saveJobs stores null for missing company, location, salary, and string salaries", async () => {
  const db = fakeDb();
  await saveJobs([bareJob, stringSalaryJob], 1, db);
  const bare = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind("202").first();
  assert.deepEqual([bare.company, bare.location, bare.salary_min, bare.salary_max, bare.url], [null, null, null, null, null]);
  const str = await db.prepare("SELECT salary_min FROM jobs WHERE id = ?").bind("303").first();
  assert.equal(str.salary_min, null);
});

test("saveJobs ignores a duplicate id and keeps the existing status", async () => {
  const db = fakeDb();
  await saveJobs([remoteJob], 1, db);
  await setJobStatus("101", "applied", db);
  await saveJobs([remoteJob], 2, db);
  const row = await db.prepare("SELECT status, run_id FROM jobs WHERE id = ?").bind("101").first();
  assert.deepEqual([row.status, row.run_id], ["applied", 1]);
});

test("saveJobs logs and does not throw when D1 is down", async (t) => {
  t.mock.method(console, "error", () => {});
  await saveJobs([remoteJob], 1, fakeDb({ broken: true }));
});

test("listJobs filters by status, newest first, and all returns everything", async () => {
  const db = fakeDb();
  await saveJobs([{ ...remoteJob, id: 1 }], 1, db);
  await new Promise((r) => setTimeout(r, 5));
  await saveJobs([{ ...remoteJob, id: 2 }, { ...remoteJob, id: 3 }], 1, db);
  await setJobStatus("2", "dismissed", db);
  assert.deepEqual((await listJobs("new", db)).map((j) => j.id), ["3", "1"]);
  assert.deepEqual((await listJobs("dismissed", db)).map((j) => j.id), ["2"]);
  assert.equal((await listJobs("all", db)).length, 3);
});

test("countByStatus returns zeros for empty statuses", async () => {
  const db = fakeDb();
  await saveJobs([remoteJob], 1, db);
  assert.deepEqual(await countByStatus(db), { new: 1, applied: 0, dismissed: 0 });
});

test("setJobStatus updates status_at and returns false for an unknown id", async () => {
  const db = fakeDb();
  await saveJobs([remoteJob], 1, db);
  assert.equal(await setJobStatus("101", "applied", db), true);
  const row = await db.prepare("SELECT status, status_at FROM jobs WHERE id = ?").bind("101").first();
  assert.equal(row.status, "applied");
  assert.ok(row.status_at);
  assert.equal(await setJobStatus("999", "applied", db), false);
});

test("latestRun is null with no runs and listRuns is newest first", async () => {
  const db = fakeDb();
  assert.equal(await latestRun(db), null);
  await startRun(db);
  await new Promise((r) => setTimeout(r, 5));
  const second = await startRun(db);
  assert.equal((await latestRun(db)).id, second);
  assert.deepEqual((await listRuns(50, db)).map((r) => r.id), [second, 1]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/store.test.js`
Expected: FAIL, module `../src/store.js` not found.

- [ ] **Step 3: Implement `src/store.js`**

One exported function per interface line above. A private `now()` returns `new Date().toISOString()`. For `countByStatus`, one `GROUP BY status` query folded into an object seeded with zeros. For `finishRun`, build the `SET` list only from provided fields so a partial update does not null out counts.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: D1 store for runs and sent jobs"
```

---

### Task 3: Record runs and jobs from the cron

**Files:**
- Modify: `src/index.js` (`run(env)`)
- Test: `test/index.test.js`

**Interfaces:**
- Consumes: `startRun`, `finishRun`, `saveJobs` from Task 2. `fakeDb` from Task 1.
- Produces: `run(env)` now expects `env.DB`. Behavior per the spec's "Changes to the cron run" section. The default export is unchanged in this task.

- [ ] **Step 1: Update the test helper and write the failing tests**

In `test/index.test.js`, change `makeEnv(kv)` to `makeEnv(kv, db = fakeDb())` and add `DB: db` to the returned object. Import `fakeDb` alongside `fakeKv`. Then add:

```js
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
```

- [ ] **Step 2: Run to verify they fail**

Run: `node --test test/index.test.js`
Expected: the six new tests FAIL (no rows in `runs`); existing tests still pass.

- [ ] **Step 3: Implement the recording in `run(env)`**

Wrap the existing body: `startRun` first, then a `try` around fetch, filter, diff, and the send loop, with `sent` incremented after each `markSeen`, and `saveJobs(jobs, runId, env.DB)` after each `markSeen`. `termsFailed` is `perTerm.filter((r) => r === null).length`. On success call `finishRun(runId, { outcome: "ok", candidates, fresh, sent, termsFailed }, env.DB)`. In `catch`, call `finishRun(runId, { outcome: "failed", error: err.message, candidates, fresh, sent, termsFailed }, env.DB)` with whichever of those are defined so far, then rethrow. Keep the existing `console.log` lines.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: record runs and sent jobs in D1"
```

---

### Task 4: HTTP handler, GET pages

**Files:**
- Create: `src/http.js`
- Modify: `src/telegram.js` (export `salaryLine`)
- Test: `test/http.test.js`

**Interfaces:**
- Consumes: `latestRun`, `listRuns`, `listJobs`, `countByStatus` from Task 2. `salaryLine(job)` from `telegram.js`, which takes an object with optional numeric `salary_min` and `salary_max` (D1 rows fit this shape as-is).
- Produces, in `src/http.js`:
  - `escapeHtml(value) -> string`: escapes `&`, `<`, `>`, `"`, `'`; `null` and `undefined` become `""`.
  - `formatEastern(iso) -> string`: `YYYY-MM-DD HH:mm ET` in `America/New_York`. Use `Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts` and assemble from parts (`hourCycle: "h23"` avoids `24:00`). Returns `""` for a falsy input.
  - `handleRequest(request, env, ctx) -> Promise<Response>`: routes per the spec table. This task implements `401`, `GET /`, `GET /runs`, `404`, and the `500` path. POST comes in Task 5.
  - Private: `layout(title, bodyHtml)`, `jobsPage({ latest, counts, jobs, status })`, `runsPage(runs)`.

- [ ] **Step 1: Export `salaryLine` from `src/telegram.js`**

Change `function salaryLine(job)` to `export function salaryLine(job)`. Run `npm test`, expected PASS.

- [ ] **Step 2: Write the failing tests**

```js
// test/http.test.js
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
```

- [ ] **Step 3: Run to verify they fail**

Run: `node --test test/http.test.js`
Expected: FAIL, `../src/http.js` not found.

- [ ] **Step 4: Implement `src/http.js` for the GET routes**

Follow the spec's Pages section for content. `handleRequest` checks `ctx?.access` first, parses `new URL(request.url)`, dispatches on `request.method` and `pathname`, and wraps the dispatch in `try/catch` that logs `err.message` and returns `500 Database error`. Status query handling: `const status = ["new", "applied", "dismissed", "all"].includes(q) ? q : "new"`. Job blocks include the three status forms now (`<form method="post" action="/jobs/<id>/status">` with a hidden `status` input and a button, current status disabled); Task 5 makes them work. Every interpolated value passes through `escapeHtml`, including `href` values.

- [ ] **Step 5: Run to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/http.js src/telegram.js test/http.test.js
git commit -m "feat: dashboard Jobs and Runs pages"
```

---

### Task 5: Status POST and fetch wiring

**Files:**
- Modify: `src/http.js`, `src/index.js` (default export)
- Test: `test/http.test.js`, `test/index.test.js`

**Interfaces:**
- Consumes: `setJobStatus` from Task 2. `handleRequest` from Task 4.
- Produces: `POST /jobs/:id/status` per the spec. Default export of `src/index.js` gains `async fetch(request, env, ctx) { return handleRequest(request, env, ctx); }`.

- [ ] **Step 1: Write the failing tests**

Append to `test/http.test.js`:

```js
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
```

Append to `test/index.test.js`:

```js
test("fetch handler serves the dashboard", async () => {
  const res = await worker.fetch(new Request("https://jobs.example/runs"), makeEnv(fakeKv()), { access: { aud: "test" }, waitUntil() {} });
  assert.equal(res.status, 200);
  assert.ok((await res.text()).includes("No runs yet"));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test`
Expected: the new POST tests FAIL with 404 and the fetch test FAILS because `worker.fetch` is not a function.

- [ ] **Step 3: Implement the POST route and the fetch export**

In `handleRequest`, match `^/jobs/([^/]+)/status$` on POST. Order of checks: Access (already first), Origin host equals `url.host` else `403`, `await request.formData()` and `status` in the three values else `400`, `setJobStatus` returned `true` else `400`, then `303` to the `Referer` when `new URL(referer).origin === url.origin`, else to `url.origin + "/"`. Add the `fetch` method to the default export in `src/index.js`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/http.js src/index.js test/http.test.js test/index.test.js
git commit -m "feat: job status updates and fetch handler"
```

---

### Task 6: Docs, local check, deploy

**Files:**
- Modify: `CLAUDE.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: a deployed dashboard and docs that match it.

- [ ] **Step 1: Update `CLAUDE.md`**

Add, staying under 20 lines (merge or trim existing lines as needed):
- Command: `npx wrangler d1 migrations apply job-watcher --local` (and `--remote` for prod) after any new file in `migrations/`.
- Quirk: `src/store.js` is the only module with SQL; `DB` is the D1 binding; cron writes D1 after KV and never throws on D1 errors.
- Quirk: dashboard auth is Cloudflare Access on the Worker; `ctx.access` is the backstop; `[access.dev]` in `wrangler.toml` fakes it for `wrangler dev`.
- Quirk: tests use `node:sqlite`, so Node 22.13+.

- [ ] **Step 2: Update `README.md`**

Under Setup add the D1 create command (`npx wrangler d1 create job-watcher`, already done, id in `wrangler.toml`) and the migrate commands. Add a Dashboard section with the URL `https://job-watcher.anthony-calzadilla.workers.dev`, that it requires a Cloudflare login, and the two pages. Keep the opening paragraph; add one sentence about the dashboard.

- [ ] **Step 3: Local smoke test**

Run: `npx wrangler d1 migrations apply job-watcher --local`, then `npx wrangler dev` in one terminal and `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/runs` in another.
Expected: `200`. Open `http://localhost:8787/` in a browser and confirm the empty Jobs page renders with the Jobs and Runs links. Do not hit `/__scheduled` locally; it spends Adzuna calls and sends a real Telegram message.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: dashboard, D1 migrations, and Access notes"
```

- [ ] **Step 5: PAUSE, then apply the migration in production**

Get Anthony's OK. Run: `npx wrangler d1 migrations apply job-watcher --remote`
Expected: `0001_init.sql` listed as applied, no errors.

- [ ] **Step 6: PAUSE, then deploy**

Get Anthony's OK. Run: `npx wrangler deploy`
Expected: bindings list shows `env.DB` and `env.SEEN_JOBS`, URL `https://job-watcher.anthony-calzadilla.workers.dev`, schedule `0 */6 * * *`.

- [ ] **Step 7: Verify in the browser**

Anthony opens `https://job-watcher.anthony-calzadilla.workers.dev/runs`, signs in through Cloudflare Access, and sees either `No runs yet` or the runs since deploy. Then `/` shows the Jobs page. After the next cron run (every 6 hours at 00:00, 06:00, 12:00, 18:00 UTC), refresh `/runs` and confirm a row appears with counts, and `/` lists any sent jobs. Mark one applied and confirm it moves to the Applied filter.

- [ ] **Step 8: Push**

```bash
git push
```
