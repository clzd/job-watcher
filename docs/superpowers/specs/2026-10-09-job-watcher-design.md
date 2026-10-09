# job-watcher design

Date: 2026-10-09

## Purpose

A Cloudflare Worker that runs on a cron trigger four times a day, searches the Adzuna jobs API for a fixed set of job titles, filters to remote or Florida postings, drops anything already seen, and sends one Telegram message listing the new matches. No message when nothing is new.

Success: Anthony gets a short Telegram message a few times a day with only genuinely new, relevant postings, and the Worker stays inside Adzuna's free tier.

## Out of scope

Email, polling company career boards, cover letters, scoring or ranking, any UI.

## Runtime and budget

- Cloudflare Worker, plain JavaScript (ESM), no bundler or TypeScript. Node 20+ locally for tests.
- Cron: `0 */6 * * *` (00:00, 06:00, 12:00, 18:00 UTC). That is 8pm, 2am, 8am, 2pm Eastern during daylight time, one hour later in standard time.
- Adzuna budget: 7 searches x 4 runs x 31 days = 868 calls a month, under the 1,000 free-tier cap. Adding an eighth search term would push a 31-day month to 992, so the search list is capped at 7 unless the schedule drops to 3 runs a day.

## Configuration

Secrets (set with `wrangler secret put`, never in code or config):

- `ADZUNA_APP_ID`
- `ADZUNA_APP_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Local development reads the same four names from `.dev.vars`, which is gitignored. A committed `.dev.vars.example` lists the names with empty values.

Bindings in `wrangler.toml`:

- `SEEN_JOBS`: KV namespace for dedupe.
- `triggers.crons = ["0 */6 * * *"]`.

Search terms live as a constant array in code:

```
"web platform manager"
"digital experience manager"
"web experience manager"
"website manager"
"Optimizely"
"conversion rate optimization manager"
"WordPress manager"
```

## Data flow per run

1. For each search term, call Adzuna once: `GET https://api.adzuna.com/v1/api/jobs/us/search/1` with `app_id`, `app_key`, `what=<term>`, `results_per_page=50`, `sort_by=date`, `content-type=application/json`.
2. Merge all results into one list and dedupe by Adzuna `id` within the run (the same posting often matches several terms).
3. Apply the title filter, then the location filter.
4. Diff against KV: keep only postings whose `id` is not a key in `SEEN_JOBS`.
5. If the new list is empty, stop.
6. Format and send one Telegram message.
7. Only after Telegram returns success, write each new `id` to KV with a 60-day TTL (`expirationTtl: 5184000`). Writing after sending means a failed send retries next run instead of silently losing postings.

## Filters

Title filter: drop a posting if its `title` contains the whole word `intern` or `junior`, case-insensitive. Whole word means bounded by start, end, space, or punctuation, so `Internship` and `International` are kept but `Intern`, `Junior Developer`, and `Web Manager (Intern)` are dropped. Implemented as `/\b(intern|junior)\b/i`.

Location filter: keep a posting if any of these is true:

- `title` contains `remote` (case-insensitive)
- `location.display_name` contains `remote` (case-insensitive)
- `location.area` (an array of strings from Adzuna, for example `["US", "Florida", "Miami-Dade County", "Miami"]`) contains `Florida` (exact string match, case-insensitive)
- `location.display_name` contains `Florida` or ends with `, FL` (case-insensitive)

Both filters are pure functions that take a posting object and return a boolean, so tests need no network.

## Telegram message

One `sendMessage` call per run to `https://api.telegram.org/bot<TOKEN>/sendMessage` with `chat_id`, `text`, and `disable_web_page_preview: true`. Plain text, no parse mode, so titles with `<`, `*`, or `_` cannot break formatting.

Format:

```
New jobs (3)

Web Platform Manager
Acme Corp
Remote
$90,000 to $120,000
https://www.adzuna.com/land/ad/...

Digital Experience Manager
Beta Inc
Tampa, Florida
https://www.adzuna.com/land/ad/...
```

Rules:

- Header line is `New jobs (N)`.
- Each posting is title, company (`company.display_name`, or `Unknown company` if missing), location (`location.display_name`, or `Location not listed` if missing), salary line, `redirect_url`.
- Salary line only when `salary_min` or `salary_max` is present. Both present and different: `$90,000 to $120,000`. Both present and equal (Adzuna often does this), or only one present: `$90,000`. Values are rounded to whole dollars with thousands separators.
- Postings separated by one blank line.
- Telegram caps a message at 4096 characters. If the text is longer, split it at posting boundaries into as many messages as needed, each starting with `New jobs (N), part X of Y`. In practice this should be rare.

## Error handling

- One Adzuna search failing (non-2xx or network error) is logged with `console.error` and skipped. The other searches still run.
- All seven searches failing ends the run with no message and nothing written to KV.
- Telegram failing (non-2xx) throws, so the run shows as failed in the Cloudflare dashboard and KV is not updated. The next run resends the same postings.
- KV read errors throw. KV write errors after a successful send are logged but do not throw, since the message already went out.

## Project layout

```
job-watcher/
  .claude/settings.json      PostToolUse hook, runs npm test after Edit or Write
  .dev.vars.example
  .gitignore                 .dev.vars, node_modules, .wrangler, .agents, skills-lock.json
  CLAUDE.md                  under 20 lines
  LICENSE                    MIT
  README.md
  package.json               "test": "node --test test/"
  wrangler.toml
  src/
    index.js                 scheduled() handler, orchestrates the run
    adzuna.js                buildUrl(term, env), fetchSearch(term, env)
    filters.js               passesTitleFilter(job), passesLocationFilter(job)
    seen.js                  findNew(jobs, kv), markSeen(jobs, kv)
    telegram.js              formatMessage(jobs), splitMessage(text), send(text, env)
  test/
    filters.test.js
    seen.test.js
    telegram.test.js
    adzuna.test.js
  docs/superpowers/specs/    this file
```

Each `src` module exports pure functions where possible and takes `env` or a KV binding as an argument, so tests pass in fakes instead of touching Cloudflare or the network.

## Tests

Runner: `node:test` with `node:assert/strict`, run with `npm test`. No test framework dependency.

Coverage required:

- `filters.test.js`: title filter drops `Intern`, `INTERN`, `Junior Developer`, `Web Manager (Intern)`; keeps `Senior Web Manager`, `International Web Manager`, `Internal Tools Manager`. Location filter keeps remote in title, remote in display_name, Florida in area, `, FL` suffix; drops `Austin, Texas` with no remote mention.
- `seen.test.js`: `findNew` returns only postings absent from a fake KV (an object with `get` and `put` backed by a `Map`). `markSeen` writes each id with `expirationTtl` of 5184000.
- `telegram.test.js`: `formatMessage` produces the exact expected text for a posting with full salary, one with only `salary_min`, one with no salary and no company. `splitMessage` leaves short text as one message and splits a long one at posting boundaries, each part under 4096 characters. `send` calls `fetch` with the right URL, method, and JSON body, and throws on non-2xx, using a mocked `globalThis.fetch`.
- `adzuna.test.js`: `buildUrl` includes every required query parameter and URL-encodes the search term. `fetchSearch` returns `results` on 200 and returns an empty array (after logging) on a 500, with `fetch` mocked.

`fetch` is mocked by assigning `globalThis.fetch` in a `before` hook and restoring it in `after`.

## Repo conventions

- `CLAUDE.md`, under 20 lines: commands (`npm test`, `wrangler dev --test-scheduled`, `wrangler deploy`), the test runner, and quirks (no bundler, secrets only via wrangler, the Adzuna monthly budget rule above).
- `.claude/settings.json` with a `PostToolUse` hook matching `Edit|Write` that runs `npm test`.
- `README.md`: three sentences on what it does, then the commands:
  - `wrangler kv namespace create SEEN_JOBS` (one time, paste the id into `wrangler.toml`)
  - `wrangler secret put ADZUNA_APP_ID`
  - `wrangler secret put ADZUNA_APP_KEY`
  - `wrangler secret put TELEGRAM_BOT_TOKEN`
  - `wrangler secret put TELEGRAM_CHAT_ID`
  - `wrangler deploy`
  - local test of the cron: `wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"`
- `.gitignore` includes `.dev.vars`, `node_modules`, `.wrangler`, `.agents`, `skills-lock.json`.
- `LICENSE` is MIT, copyright 2026 Anthony Calzadilla.

## Decisions made without asking

- Plain JavaScript, not TypeScript, to keep zero build step and match the node:test requirement.
- KV writes happen after the Telegram send, not before, so a failed send does not lose postings.
- `intern` and `junior` use whole-word matching so `international` and `internship` are not dropped.
- Long messages are split rather than truncated.
- Cron hours are UTC-fixed, so Eastern times shift by an hour at daylight saving changes. Not worth the complexity to avoid.
