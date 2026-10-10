# Run now button design

Date: 2026-10-10

## Purpose

A button on the dashboard Runs page that starts a job search on demand, so Anthony can confirm the Worker works (for example after a deploy) without waiting up to six hours for the next cron run.

Success: Anthony presses Run now on his phone or laptop, lands back on the Runs page with a new "running" row at the top, refreshes about 45 seconds later, and sees the row finished with the same counts a cron run would show. New jobs reach Telegram exactly as they do from the cron.

## Scope decisions (settled 2026-10-10)

- A manual run is a real run: same `run(env)` as the cron, same Telegram sends, same KV marking, same D1 rows. Not a preview.
- The cron stays at 4 runs a day. Each press costs 7 Adzuna calls, so about 18 presses a month fit inside the roughly 130 calls the cron leaves free. The budget is Anthony's to watch; the Worker does not count presses.
- The run happens in the background via `ctx.waitUntil`. The response is an immediate redirect, not a 40 second wait.
- One run at a time: a press while a run is in progress is ignored.
- Manual runs are not marked as manual. No new column, no migration.

## Out of scope

Preview mode, a monthly press cap, auto-refreshing the page, client-side JavaScript, a button on the Jobs page, triggering runs from outside the dashboard.

## Routes

`POST /runs/now`

1. Origin check, same as the status route: the `origin` header must match the request host, otherwise `403 Forbidden`.
2. In-progress check: read the latest run (`latestRun`). If its `outcome` is `running` and `started_at` is under 10 minutes ago, skip the start. 10 minutes is well above the run's normal 40 seconds and below the cron's 6 hour spacing, so a crashed run that never got its `finished_at` cannot block the button for long.
3. Otherwise hand `run(env)` to `ctx.waitUntil`, wrapped so a rejection is logged with `console.error` and never surfaces as an unhandled rejection. `run()` already records a failed row with the error text, so nothing else is needed for failures.
4. Either way respond `303` to `/runs`.

`GET /runs/now` responds `303` to `/runs` and changes nothing. This is the Access login replaying a POST as a GET after a session expired, the same case the status route already handles.

## Wiring

`http.js` must not import `index.js` (that would be a circular import, since `index.js` imports `http.js`). Instead `index.js`'s `fetch` handler passes the run function in:

```js
async fetch(request, env, ctx) {
  return handleRequest(request, env, ctx, { run: () => run(env) });
},
```

`handleRequest(request, env, ctx, deps = {})` passes `deps.run` through to `route`. Tests supply a fake `deps.run` and a fake `ctx.waitUntil` and assert on both.

## Page

The Runs page gets one form above the table, rendered by `runsPage`, in both the empty and non-empty states:

```html
<form method="post" action="/runs/now" class="run-now"><button type="submit">Run now</button></form>
```

Styling matches the existing `.actions button` rule (44px minimum height for touch). No CSP change: the existing policy has no `form-action` directive, and the form posts to the same origin.

No success or "already running" message. The "running" row at the top of the table is the feedback, and a press during a run reloads a page that already shows it.

## Error handling

- `latestRun` throwing (D1 down) is caught by the existing `handleRequest` try/catch and returns `500 Database error`, same as every other page.
- `run()` failing inside `waitUntil` is logged and recorded on the run row by `run()` itself. The dashboard shows it as a failed row.
- A press when `latestRun` returns `null` (no runs yet) starts a run.

## Testing

All tests are plain `node:test` with the existing fakes in `test/helpers.js`.

`test/http.test.js`

- Runs page renders the Run now form (empty and non-empty states).
- `POST /runs/now` with a matching origin calls `ctx.waitUntil` with the promise from `deps.run`, calls `deps.run` once, and returns 303 to `/runs`.
- `POST /runs/now` with a missing or foreign origin returns 403 and does not call `deps.run`.
- `POST /runs/now` when the latest run is `running` and started 1 minute ago returns 303 and does not call `deps.run`.
- `POST /runs/now` when the latest run is `running` and started 11 minutes ago starts a run.
- `POST /runs/now` when `deps.run` rejects logs with `console.error` and the `waitUntil` promise resolves.
- `GET /runs/now` returns 303 to `/runs` and does not call `deps.run`.

`test/index.test.js`

- The exported `fetch` handler, given a POST to `/runs/now` with a good origin and a fake Adzuna, ends up calling Adzuna (proves `run` is wired through).

## Docs

- `README.md` and `CLAUDE.md`: one line each noting the button, that it is a real run, and the 7 calls per press.
- `docs/handoff/2026-10-09-dashboard.md`: add the route to the route list.
