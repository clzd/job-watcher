# job-watcher

Cloudflare Worker on a cron (`0 */6 * * *`) that searches Adzuna and sends new remote or Florida jobs to Telegram.

## Commands
- `npm test` runs `node --test "test/*.test.js"` (needs Node 22+). No framework, no build step.
- `npx wrangler dev --test-scheduled`, then `curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"` runs the cron locally.
- `npx wrangler deploy` deploys. `npx wrangler deploy --dry-run` validates config without deploying.

## Quirks
- Plain JS ESM. No bundler, no TypeScript. Every module takes `env` or a KV binding so tests pass fakes.
- Secrets only via `wrangler secret put` (prod) or `.dev.vars` (local, gitignored). Never in code or `wrangler.toml`. Never log an Adzuna URL (it carries the key).
- Adzuna free tier is about 1,000 calls a month. 7 terms x 4 runs x 31 days = 868. Do not add an 8th term without dropping to 3 runs a day.
- Seen ids live in the `SEEN_JOBS` KV namespace with a 60-day TTL. KV is written only after Telegram accepts the message, so a failed send retries next run.
- Title filter is whole-word (`/\b(intern|junior)\b/i`), so "International" is kept.
- `.claude/settings.json` has a PostToolUse hook that runs `npm test` after every Edit or Write.
