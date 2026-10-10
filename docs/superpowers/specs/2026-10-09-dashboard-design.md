# job-watcher dashboard design

Date: 2026-10-09

## Purpose

A private web page, served by the existing job-watcher Worker, that shows two things: whether the cron runs are healthy (last run, outcome, counts) and the jobs that were sent to Telegram, with a status Anthony can set on each one (new, applied, dismissed).

Success: Anthony opens one URL on his phone or laptop, signs in with his Cloudflare account, sees at a glance that the last run worked, and can work through sent jobs marking them applied or dismissed. The cron keeps its current guarantees and the Adzuna budget is untouched.

## Scope decisions (settled 2026-10-09)

- Status means both run health and per-job status.
- Store and show sent jobs only. Jobs dropped by the title or location filter are not stored.
- The only editable thing is a job's status. Search terms, filters, and the schedule stay in code.
- Keep everything. No purge of jobs or runs.
- Storage is D1. Hosting is a `fetch` handler in this Worker. Auth is Cloudflare Access on the Worker. Rationale: one repo, one deploy, one binding to fake in tests, zero login code.

## Out of scope

Separate Pages site, editing search terms, muting companies, storing filtered-out jobs, charts, notifications from the dashboard, any client-side JavaScript framework.

## Cloudflare state (already done, nothing in the plan recreates these)

- D1 database `job-watcher`, id `511c1f46-4381-439d-840c-45b9696ae154`, region ENAM, bound as `env.DB` in `wrangler.toml`.
- `workers_dev = true`, `preview_urls = false`. URL: `https://job-watcher.anthony-calzadilla.workers.dev`.
- Worker-level Access policy: scope All traffic, policy Cloudflare account members, Allow, 24 hour session. Access AUD tag `9ae4158bb63c126a6bb4d299888e0add8d2ce8bfd49443188dad612524c36f5a`. Team domain `clzd-pages.cloudflareaccess.com`.
- Deployed as version `f7d82535-91e0-4d89-babd-424ebaa88fa4` with the binding but no `fetch` handler yet.

## Storage

One D1 database, two tables. Schema lives in `migrations/0001_init.sql` and is applied with `npx wrangler d1 migrations apply job-watcher --remote` (prod) or `--local` (dev). The Worker never creates tables at runtime.

```sql
CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  outcome TEXT NOT NULL DEFAULT 'running',
  candidates INTEGER,
  fresh INTEGER,
  sent INTEGER,
  terms_failed INTEGER,
  error TEXT
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  company TEXT,
  location TEXT,
  salary_min REAL,
  salary_max REAL,
  url TEXT,
  sent_at TEXT NOT NULL,
  run_id INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  status_at TEXT
);

CREATE INDEX jobs_status_sent ON jobs (status, sent_at DESC);
CREATE INDEX runs_started ON runs (started_at DESC);
```

Column meanings:

- `runs.outcome` is `running`, `ok`, or `failed`. A run with some Adzuna terms failing but at least one succeeding is `ok` with `terms_failed` greater than zero.
- `runs.candidates` is the count after dedupe and filters, before the seen diff. `fresh` is the count not already seen. `sent` is the count actually accepted by Telegram (equals `fresh` on a clean run, less on a partial failure).
- `runs.error` is the thrown error's `message`, cut to 500 characters. Error messages in this codebase name the search term or the Telegram status, never a URL, and that stays true.
- `jobs.url` is Adzuna's `redirect_url`, which is a public link and carries no key. No other URL is ever stored.
- `jobs.id` is the Adzuna id as a string, same as the KV key.
- All timestamps are ISO 8601 UTC strings from `new Date().toISOString()`. Conversion to Eastern happens only when rendering.

## Changes to the cron run

`run(env)` in `src/index.js` gains run and job recording. New module `src/store.js` owns every D1 statement; `index.js` never writes SQL.

Order of operations in `run(env)`:

1. `runId = await startRun(env.DB)` inserts a `runs` row with `outcome = 'running'`. Returns the new id, or `null` if the insert fails (logged, not thrown).
2. Fetch, dedupe, filter, diff exactly as today. Count `terms_failed` as the number of `null` results from `fetchSearch`.
3. For each message part: `await send(text, env)`, then `await markSeen(jobs, env.SEEN_JOBS)`, then `await saveJobs(jobs, runId, env.DB)`. `saveJobs` runs after `markSeen` and is `INSERT OR IGNORE`, so a job is only recorded once Telegram has accepted it, and a job that was somehow already stored is left alone. A D1 failure here is logged and does not throw, same as a KV failure today.
4. On success: `await finishRun(runId, { outcome: 'ok', candidates, fresh, sent, termsFailed }, env.DB)`.
5. On any thrown error: `await finishRun(runId, { outcome: 'failed', error: err.message, ...whatever counts are known }, env.DB)`, then rethrow so the Cloudflare dashboard still shows the invocation as failed. `finishRun` with a `null` runId is a no-op.

Guarantees that must survive:

- KV is still written only after Telegram accepts a part. D1 comes after KV.
- A Telegram failure still throws and still shows as a failed run in both Cloudflare and the dashboard.
- A D1 outage cannot stop a message from being sent or stop ids from being marked seen. Worst case the dashboard misses a run or some jobs, and the log says so.
- No Adzuna call is added. The dashboard reads D1 only.

## HTTP handler

New module `src/http.js` exports `handleRequest(request, env, ctx)`. `src/index.js` adds `fetch(request, env, ctx) { return handleRequest(request, env, ctx); }` to the default export next to `scheduled`.

Auth backstop, first thing in `handleRequest`: if `ctx.access` is undefined, return `401` with the plain text `Access required`. Cloudflare sets `ctx.access` only on requests it authenticated, so this catches any path that somehow bypasses Access. No JWT parsing.

Routes:

| Method | Path | Does |
| --- | --- | --- |
| GET | `/` | Jobs page. Query `?status=new` (default), `applied`, `dismissed`, or `all`. Newest `sent_at` first. Limit 200. |
| GET | `/runs` | Runs page. Last 50 runs, newest first. |
| POST | `/jobs/:id/status` | Form body `status=new`, `applied`, or `dismissed`. Updates `status` and `status_at`. Responds `303` to the `Referer` if it is same-origin, otherwise to `/`. |
| any | anything else | `404` plain text. |

POST protection: reject with `403` when the `Origin` header is missing or its host does not match the request host, and reject with `400` when `status` is not one of the three values or the id is unknown. Query and form values are read with `URL` and `request.formData()`, never string-spliced into SQL. Every D1 statement uses bound parameters.

## Pages

Server-rendered HTML from template literals, one shared layout function, one inline `<style>` block, no external assets, no client-side JavaScript. Every dynamic value goes through `escapeHtml` before it lands in markup, including job titles and company names, which come from Adzuna and can contain anything. Must read well on a phone, since the usual path to it is a tap from Telegram.

Layout: a header with the Worker name and two links, Jobs and Runs. Below it the page body.

Jobs page:

- A status line at the top: `Last run YYYY-MM-DD HH:mm ET, ok, 3 sent` or `Last run YYYY-MM-DD HH:mm ET, failed: <error>` or `No runs yet`.
- Filter links: New (count), Applied (count), Dismissed (count), All.
- One block per job: title as a link to `url` (opens in a new tab, `rel="noopener"`), company, location, salary (same formatting rules as the Telegram message, reuse `salaryLine` by exporting it from `telegram.js`), sent date, and a row of three small form buttons for New, Applied, Dismissed with the current one disabled.
- Empty state text when no jobs match.

Runs page:

- One row per run: started (Eastern), duration in seconds, outcome, candidates, fresh, sent, terms failed, error (empty when none). Failed runs are visibly marked.
- Empty state when there are no runs.

Dates: `YYYY-MM-DD HH:mm ET`, produced with `Intl.DateTimeFormat` for `America/New_York` from the stored UTC string. One helper `formatEastern(iso)` in `src/http.js`.

## Error handling in the handler

- A D1 read failure on a GET returns `500` with the plain text `Database error` and logs the error message. Never render a stack or an SQL string.
- An unknown job id on POST returns `400`.
- Nothing in the handler calls `fetch`.

## Project layout after this work

```
job-watcher/
  migrations/
    0001_init.sql            runs and jobs tables, indexes
  src/
    index.js                 run(env) with run and job recording; default export has scheduled and fetch
    adzuna.js                unchanged
    filters.js               unchanged
    seen.js                  unchanged
    telegram.js              exports salaryLine in addition to what it exports today
    store.js                 startRun, finishRun, saveJobs, listRuns, latestRun, listJobs, countByStatus, setJobStatus
    http.js                  handleRequest, formatEastern, escapeHtml, page renderers
  test/
    helpers.js               fakeKv (existing) plus fakeDb
    store.test.js
    http.test.js
    index.test.js            extended
    (other tests unchanged)
  docs/superpowers/specs/2026-10-09-dashboard-design.md   this file
```

`store.js` functions take the D1 binding as their last argument. `http.js` functions take `env` and `ctx`. Nothing imports a binding from module scope.

## Tests

Runner stays `node --test`, no new dependencies.

`fakeDb()` in `test/helpers.js` wraps `node:sqlite` (`DatabaseSync`, built into Node 22.13 and later, no install) and exposes the subset of the D1 API the code uses: `prepare(sql)` returning an object with `bind(...params)`, `run()`, `all()`, `first()`, plus `batch([...])`. It loads `migrations/0001_init.sql` on creation so tests run against the real schema. Result shapes mirror D1: `all()` resolves to `{ results }`, `first()` resolves to the row or `null`, `run()` resolves to `{ meta: { last_row_id, changes } }`. The plan's first step confirms the local Node version supports `node:sqlite`.

Required coverage:

- `store.test.js`: `startRun` inserts and returns an id. `finishRun` updates outcome, counts, `finished_at`, and truncates `error` to 500 characters. `saveJobs` inserts the right columns, stringifies a numeric id, ignores a duplicate id without throwing, and handles a job with no company, location, or salary. `listJobs` filters by status, orders newest first, and `all` returns every status. `countByStatus` returns counts for all three statuses including zero. `setJobStatus` updates `status` and `status_at` and returns `false` for an unknown id. `latestRun` returns `null` with no runs.
- `http.test.js`: `401` when `ctx.access` is missing. `/` renders a job title that contains `<script>` as escaped text. `/` default shows only `new` jobs; `?status=all` shows every job. `/runs` renders a failed run with its error and an ok run with its counts. `POST /jobs/:id/status` with a matching `Origin` updates the row and returns `303`; with no `Origin` returns `403`; with `status=bogus` returns `400`; with an unknown id returns `400`. Unknown path returns `404`. `formatEastern("2026-10-10T06:00:00.000Z")` returns `2026-10-10 02:00 ET`. A `fakeDb` whose `prepare` throws makes `/` return `500` with no SQL text in the body.
- `index.test.js` additions: a clean run writes one `runs` row with `outcome = 'ok'` and correct counts, and one `jobs` row per sent job with `run_id` set. A Telegram failure on part 2 of 2 leaves part 1's jobs in both KV and D1, part 2's in neither, and the run row `failed` with the Telegram error message. A `fakeDb` whose `prepare` throws does not stop the send or the KV write, and `run` still resolves. Two terms returning `null` records `terms_failed = 2` and `outcome = 'ok'`. All seven `null` records `outcome = 'failed'` with `All Adzuna searches failed`.

## Local development

- `npx wrangler d1 migrations apply job-watcher --local` once, and again after any new migration.
- `wrangler.toml` gains an `[access.dev]` block with `aud` set to the AUD tag above and `identity.email = "anthony.calzadilla@gmail.com"`, which makes `wrangler dev` populate `ctx.access`. Per Cloudflare's docs this block is ignored in production.
- `npx wrangler dev --test-scheduled`, then open `http://localhost:8787/` for the page and `curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"` to produce a local run (needs `.dev.vars` with real Adzuna and Telegram values, and it does send a real Telegram message and spend 7 Adzuna calls, so use sparingly).

## Deploy

1. `npx wrangler d1 migrations apply job-watcher --remote` (one time per migration, before the code that needs it).
2. `npx wrangler deploy`.
3. Open the URL, sign in through Access, confirm the Runs page loads with the empty state or the latest run.

The first production run of the cron is 2026-10-10 06:00 UTC. If this ships before that, the Runs page will show it. If after, earlier runs are not in D1 and only Workers Logs has them; that is acceptable.

## Repo conventions to update

- `CLAUDE.md`: add the `DB` binding, the migrations command, the `[access.dev]` block, and the rule that `store.js` is the only module with SQL. Stay under 20 lines; trim if needed.
- `README.md`: add the D1 create and migrate commands and the dashboard URL.
- No em dashes in any file. Dates YYYY-MM-DD. Times rendered in US Eastern.

## Decisions made without asking

- D1 migrations via wrangler's `migrations/` folder rather than `CREATE TABLE IF NOT EXISTS` at runtime, so the schema is versioned and the Worker never runs DDL on a request path.
- `INSERT OR IGNORE` for jobs rather than upsert, so re-sending after a partial failure cannot overwrite a status Anthony already set.
- `ctx.access` as the auth backstop instead of JWT verification, because Cloudflare already validated the token and the dev block makes it testable locally.
- Plain forms and a `303` redirect for status changes instead of fetch calls, so the page works with no JavaScript and no API surface.
- Limit of 200 jobs and 50 runs per page, no pagination. At the current volume that is months of data; add pagination when it is actually needed.
- Same-origin `Origin` check on POST rather than a CSRF token, since there is one user and Access already gates every request.
