# job-watcher

job-watcher is a Cloudflare Worker that runs four times a day and searches the Adzuna jobs API for seven web platform and digital experience manager titles. It keeps only remote or Florida postings that are not interns or juniors and that it has not sent before, remembering sent ids in Workers KV for 60 days. When there is something new it sends one Telegram message with title, company, location, salary when listed, and a link. Each run and every sent job is also recorded in a D1 database and shown on a private dashboard.

## Setup

One time, create the KV namespace and paste the printed id into `wrangler.toml` under `[[kv_namespaces]]`:

    npx wrangler kv namespace create SEEN_JOBS

One time, create the D1 database (already done; its id is in `wrangler.toml` under `[[d1_databases]]`):

    npx wrangler d1 create job-watcher

Apply the database migrations, locally and in production. Run these again after adding any new file in `migrations/`:

    npx wrangler d1 migrations apply job-watcher --local
    npx wrangler d1 migrations apply job-watcher --remote

Set the four secrets (each command prompts for the value):

    npx wrangler secret put ADZUNA_APP_ID
    npx wrangler secret put ADZUNA_APP_KEY
    npx wrangler secret put TELEGRAM_BOT_TOKEN
    npx wrangler secret put TELEGRAM_CHAT_ID

## Deploy

    npx wrangler deploy

## Dashboard

https://job-watcher.anthony-calzadilla.workers.dev

It sits behind Cloudflare Access, so it asks you to sign in with your Cloudflare login first. It has two pages:

- Jobs (`/`): every job sent to Telegram, filterable by status, with buttons to mark each one new, applied, or dismissed.
- Runs (`/runs`): the last 50 runs with their counts and outcome, and a Run now button. Run now does a real run (Adzuna search, Telegram send, D1 row). The page waits about 40 seconds, then shows the finished row. Each press costs 7 of the roughly 1,000 monthly Adzuna calls, and the cron already uses 868, so about 18 presses a month fit.

## Run locally

Copy `.dev.vars.example` to `.dev.vars` and fill in the values, then:

    npx wrangler dev --test-scheduled

The dashboard is at http://localhost:8787 (the `[access.dev]` block in `wrangler.toml` stands in for the Access login).

In a second terminal, trigger the cron by hand:

    curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"

## Test

Needs Node 22.13 or newer.

    npm test

## License

MIT
