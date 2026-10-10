# job-watcher

Cloudflare Worker on a cron (`0 */6 * * *`) that searches Adzuna, sends new remote or Florida jobs to Telegram, and serves a D1-backed dashboard.

## Commands
- `npm test` runs `node --disable-warning=ExperimentalWarning --test "test/*.test.js"`. Needs Node 22.13+ (tests use `node:sqlite`). No framework, no build step.
- `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"` runs the cron locally.
- `npx wrangler d1 migrations apply job-watcher --local` (and `--remote` for prod) after any new file in `migrations/`.
- `npx wrangler deploy` deploys. `npx wrangler deploy --dry-run` validates config without deploying.

## Quirks
- Plain JS ESM. No bundler, no TypeScript. Every module takes `env` or a binding so tests pass fakes.
- Secrets only via `wrangler secret put` (prod) or `.dev.vars` (local, gitignored). Never in code or `wrangler.toml`. Never log an Adzuna URL (it carries the key).
- Adzuna free tier is about 1,000 calls a month. 7 terms x 4 runs x 31 days = 868. Do not add an 8th term without dropping to 3 runs a day.
- Seen ids live in the `SEEN_JOBS` KV namespace with a 60-day TTL. KV is written only after Telegram accepts the message, so a failed send retries next run. Cron writes D1 after KV and never throws on D1 errors.
- `src/store.js` is the only module with SQL. `DB` is the D1 binding.
- Dashboard auth is Cloudflare Access on the Worker. `ctx.access` is the backstop. `[access.dev]` in `wrangler.toml` fakes it for `wrangler dev`.
- Title filter is whole-word (`/\b(intern|junior)\b/i`), so "International" is kept. `.claude/settings.json` has a PostToolUse hook that runs `npm test` after every Edit or Write.
