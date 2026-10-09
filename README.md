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
