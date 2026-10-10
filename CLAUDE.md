# job-watcher

Cloudflare Worker on a cron (`0 */6 * * *`) that searches Adzuna plus 20 company career feeds (Greenhouse, Workday), sends new remote or Florida jobs to Telegram, and serves a D1-backed dashboard.

## Commands
- `npm test` runs `node --disable-warning=ExperimentalWarning --test "test/*.test.js"`. Needs Node 22.13+ (tests use `node:sqlite`). No framework, no build step.
- `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"` runs the cron locally.
- `npx wrangler d1 migrations apply job-watcher --local` (and `--remote` for prod) after any new file in `migrations/`.
- `npx wrangler deploy` deploys. `npx wrangler deploy --dry-run` validates config without deploying.

## Quirks
- Plain JS ESM. No bundler, no TypeScript. Every module takes `env` or a binding so tests pass fakes.
- Secrets only via `wrangler secret put` (prod) or `.dev.vars` (local, gitignored). Never in code or `wrangler.toml`. Never log an Adzuna URL (it carries the key).
- Adzuna free tier is about 1,000 calls a month. 7 terms x 4 runs x 31 days = 868. Do not add an 8th term without dropping to 3 runs a day.
- Searches run one at a time, 2s apart (`SEARCH_GAP_MS`). Firing them in parallel gets 429 and 503 HTML pages from Adzuna's nginx. Tests set `SEARCH_GAP_MS` to "0".
- `POST /runs/now` (the dashboard Run now button) is a real run. It answers at once with a streamed Running page and keeps the body open until the run settles (about 40s), then a meta refresh goes to `/runs`. Streaming keeps the Worker alive; `ctx.waitUntil` alone is cancelled after 30s. `cache-control: no-transform` stops compression buffering the stream. `index.js` passes `run` into `handleRequest` as `deps.run`; `http.js` must never import `index.js`. A `running` row under 10 minutes old blocks a second start.
- Seen ids live in the `SEEN_JOBS` KV namespace with a 60-day TTL. KV is written only after Telegram accepts the message, so a failed send retries next run. Cron writes D1 after KV and never throws on D1 errors.
- `src/store.js` is the only module with SQL. `DB` is the D1 binding.
- Dashboard auth is Cloudflare Access on the Worker. `ctx.access` is the backstop. `[access.dev]` in `wrangler.toml` fakes it for `wrangler dev`.
- Title filter is whole-word (`/\b(intern|junior)\b/i`), so "International" is kept. `.claude/settings.json` has a PostToolUse hook that runs `npm test` after every Edit or Write.
- Company feeds come from `src/companies.json`: 15 Greenhouse boards and 5 Workday tenants, all fetched every run. A unit is one outbound request: one per Greenhouse board, one per phrase in `WORKDAY_SEARCHES` per Workday tenant. The list must stay at or under 35 units (a test enforces it) because the free plan allows 50 outbound requests per invocation and Adzuna uses 7. KV and D1 calls do not count. `ATS_BUDGET` in `wrangler.toml` is the runtime guard; tests set it to "0". The full 178-company research list is `docs/companies-verified-2026-10-10.json`.
- Only `greenhouse` and `workday` have fetchers (`src/ats.js`). ATS jobs pass `passesAtsTitleFilter` (web, website, digital experience, optimizely, wordpress, cms, cro, ...) before the usual filters, because feeds return every job a company has open. Job ids are `greenhouse:<slug>:<id>` and `workday:<tenant>:<req id>`.
- A Workday phrase search returns newest first, 20 per request, no description. Single words like "web" match thousands of postings; keep phrases two words.
