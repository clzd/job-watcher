# Handoff: job-watcher dashboard

Date: 2026-10-09
From: Claude (Opus) session that shipped v1
To: Fable, to produce a plan for Anthony to review before any code is written

## Goal

Anthony wants a web dashboard to view job entries and status. Your job is to come back with a plan, not an implementation. Use the brainstorming skill to pin down scope with him, then write the plan in `docs/superpowers/plans/`.

## Current state (live as of 2026-10-09)

- Deployed to Cloudflare. Version `882681f0-a76f-4a57-a062-b6c8a541fd20`, account `507bfa35f9202219d14a081ea535ad64`.
- Cron `0 */6 * * *` (UTC). First production run is 2026-10-10 06:00 UTC, which is 02:00 Eastern. It has not run yet, so there is no production data.
- Secrets set in prod: `ADZUNA_APP_ID`, `ADZUNA_APP_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Wrangler on Anthony's Mac is logged in via OAuth. `npx wrangler deploy`, `tail`, `secret list` all work. He wants that left in place.
- 218 lines of source across 5 modules, plain JS ESM, tests use `node --test` with fakes. Read `CLAUDE.md`, then the spec and plan in `docs/superpowers/`.

## How a run works

`src/index.js` `run(env)`: fetch 7 Adzuna terms in parallel, fail only if all 7 fail, dedupe by id, filter by title and location, drop ids already in KV, send to Telegram in parts under 4096 chars, mark each part's ids seen right after that part sends.

## What the dashboard has to deal with

These are the facts that shape the design:

1. **No job data is stored.** `SEEN_JOBS` KV holds `<adzuna id> -> "1"` with a 60-day TTL. Title, company, location, salary, URL, and send time are all thrown away after the Telegram send. A dashboard needs a new store.
2. **No run history.** The only record of a run is `console.log` / `console.error`, visible through Workers Logs (observability is on). Nothing records "run at X, N candidates, M sent, Adzuna term Y failed".
3. **No HTTP handler.** The Worker only exports `scheduled`. A dashboard needs a `fetch` handler (or a separate Worker or Pages project).
4. **No public URL.** `wrangler.toml` has `workers_dev = false`. Something has to be exposed, and it must be behind auth, because the page will show his job search.
5. **Adzuna budget is tight.** 868 of about 1,000 calls a month are already spoken for. The dashboard must read stored data only and never call Adzuna.
6. **Secrets in URLs.** Adzuna and Telegram URLs carry keys. Traces are off on purpose (`[observability.traces] enabled = false`). Do not log, store, or render any of those URLs. Job `redirect_url` values from Adzuna are fine.
7. **Seen-marking order matters.** KV is written only after Telegram accepts a part, so a failed send retries next run. Any new write (job details, run record) must not break that guarantee or make a Telegram failure look like success.

## Open questions to settle with Anthony

- "Status" could mean run health (last run, success or failure, counts) or his own per-job status (new, applied, dismissed). Maybe both. Ask.
- Should the dashboard show only jobs that were sent, or also jobs that were filtered out (useful for tuning filters)?
- Read only, or can he change things from it (mark applied, mute a company, edit search terms)? Editing search terms runs into the 7-term budget.
- How long to keep history. Seen ids expire at 60 days today.

## Options worth weighing in the plan

- Storage: D1 (SQL, good for listing and filtering jobs and runs) vs more KV keys (simple, poor for listing). D1 looks like the better fit, but justify it.
- Hosting: add a `fetch` handler to this Worker vs a separate Pages site that reads the same store. Anthony knows Astro and Cloudflare Pages well.
- Auth: Cloudflare Access (no code, free for one user) vs a secret token checked in the Worker. Access is likely simpler and safer.

## Constraints to keep

- Plain JS ESM, no bundler, no TypeScript in the Worker. Every module takes `env` or a binding so tests can pass fakes.
- `npm test` must stay green. A PostToolUse hook runs it after every Edit or Write.
- Secrets only via `wrangler secret put` or `.dev.vars`.
- Dates YYYY-MM-DD, times shown in US Eastern.

## How Anthony wants the plan delivered

Short. Lead with the recommendation. Numbered steps, one action each, and pause for his OK between hands-on steps. No em dashes. Ask one question at a time when something is unclear.
