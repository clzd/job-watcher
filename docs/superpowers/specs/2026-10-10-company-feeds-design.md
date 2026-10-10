# Company feeds design

Date: 2026-10-10

## Purpose

Adzuna is an aggregator. It hands back truncated descriptions, delayed postings, and nothing from career sites it does not crawl. The applicant tracking systems (ATS) behind enterprise career pages expose public, no-key JSON feeds. `src/companies.json` is a short, hand-picked list of 20 target companies (15 Greenhouse boards, 5 Workday tenants). Every run polls every one of them through the same filters, KV seen-ids, Telegram and D1 path as Adzuna.

The constraint is the Workers free plan: 50 outbound HTTP requests per invocation. KV and D1 calls do not count toward that 50 (they have a separate 1,000 cap). Adzuna uses 7 and Telegram uses one per message part.

Success: each cron run checks the 7 Adzuna terms and all 20 companies, and new matching jobs reach Telegram and the dashboard exactly as Adzuna jobs do.

## Scope decisions (settled 2026-10-10)

- **Short list, no rotation.** Decided 2026-10-10 over a 178-company rotating design. The full verified list stays in `docs/companies-verified-2026-10-10.json` for later. Adding a company means staying under the unit cap below or dropping another.
- **A unit is one outbound request.** Greenhouse: one unit per company (the feed returns every job). Workday: one unit per search phrase per tenant, because the feed pages 20 at a time and big boards have thousands of postings. Phrases are `website manager`, `digital experience`, `optimizely`, `wordpress`. Workday search is full text and returns newest first; a single word like `web` matches merchandising jobs by the thousand, two-word phrases stay tight (Lowe's: `web` 2,134 hits, `website manager` 1 hit).
- **Cap: 35 units.** 15 Greenhouse + 5 x 4 Workday = 35. 7 Adzuna + 35 = 42, leaving 8 Telegram parts (about 200 jobs) under 50. A data test fails the suite if the file ever expands past 35 units, and `ATS_BUDGET` (default 35) truncates at runtime as a second guard. Tests set it to 0 to stay on Adzuna only.
- **Greenhouse and Workday only.** The other ATS types in the research list (Ashby, Lever, SmartRecruiters, Workable, Rippling, BambooHR, Oracle, SuccessFactors, Radancy) have no fetcher. An entry with one of those stays in the file and produces no requests.
- **Adzuna down no longer aborts the run** when a feed answered. The run throws only when every Adzuna term and every unit failed. With no units attempted the old behavior and message stand.
- **Feeds return every job, so a positive title filter applies to ATS jobs only**: `web`, `website`, `webmaster`, `digital experience`, `optimizely`, `episerver`, `wordpress`, `cms`, `conversion rate`, `cro`, `experimentation`, `martech`, `marketing technology`, whole words, case-insensitive. The existing intern/junior and remote-or-Florida filters apply after it, unchanged. Adzuna results are already keyword-searched and skip this filter.
- **Normalized job shape is the Adzuna shape** so `filters.js`, `telegram.js`, `seen.js` and `store.js` do not change: `{ id, title, company: { display_name }, location: { display_name, area: [] }, redirect_url, description, source }`. `description` is always null for now: neither feed fetches job descriptions. Ids are `greenhouse:<slug>:<id>` and `workday:<tenant>:<requisition id>`, so they cannot collide with Adzuna's numbers.
- **Requests go one at a time**, `ATS_GAP_MS` (default 500) apart, after the Adzuna searches. 35 units add about 45 seconds to a run. Run now waits the same way it does today.
- **Two new run columns**, `ats_units` and `ats_failed`, via migration `0002`. The Runs page does not show them yet.

## Out of scope

Rotation across runs, the other seven ATS fetchers, showing the new counts on the dashboard, per-company keyword tuning, Workday facets, fetching Workday job descriptions (a second request per job), fit scoring, a send cap per run.

## Budget arithmetic

| Per run | Requests |
|---|---|
| Adzuna | 7 |
| Company feeds | 35 (15 Greenhouse + 5 Workday x 4 phrases) |
| Telegram | 1 per 4,096-character part, usually 1 |
| Free plan cap | 50 external, 1,000 internal (KV, D1) |

The free plan also allows 10 ms of CPU and 128 MB of memory per invocation, which is why the Greenhouse fetch omits job descriptions; the run time is about 90 seconds end to end.

If a run ever needs more than 8 Telegram parts the send loop throws "Too many subrequests" partway. Parts already sent were marked seen before the next send, so nothing is resent; the rest go out next run. On Workers Paid the cap is 10,000 and none of this matters.
