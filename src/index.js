import { fetchSearch } from "./adzuna.js";
import { passesTitleFilter, passesLocationFilter, passesAtsTitleFilter } from "./filters.js";
import { findNew, markSeen } from "./seen.js";
import { formatMessages, send } from "./telegram.js";
import { startRun, finishRun, saveJobs } from "./store.js";
import { handleRequest } from "./http.js";
import { COMPANIES, expandUnits } from "./companies.js";
import { SUPPORTED_ATS, fetchSlice } from "./ats.js";

// Seven terms. Do not add an eighth: 7 x 4 runs x 31 days = 868 of the 1,000 monthly Adzuna calls.
export const SEARCH_TERMS = [
  "web platform manager",
  "digital experience manager",
  "web experience manager",
  "website manager",
  "Optimizely",
  "conversion rate optimization manager",
  "WordPress manager",
];

// Adzuna answers 429 and 503 when several searches land at once, so search one term at a time.
// env.SEARCH_GAP_MS overrides the pause (tests set it to 0).
const SEARCH_GAP_MS = 2000;

// Company feed requests per run. The Workers free plan allows 50 outbound requests per
// invocation: 7 go to Adzuna, 35 here, which leaves 8 Telegram parts. The data test in
// test/companies.test.js keeps the list at 35 units; this is the runtime guard. 0 disables feeds.
const ATS_BUDGET = 35;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function searchAll(env) {
  const gapMs = Number(env.SEARCH_GAP_MS ?? SEARCH_GAP_MS);
  const perTerm = [];
  for (const [i, term] of SEARCH_TERMS.entries()) {
    if (i > 0) await sleep(gapMs);
    perTerm.push(await fetchSearch(term, env));
  }
  return perTerm;
}

function dedupeById(jobs) {
  const byId = new Map();
  for (const job of jobs) {
    const key = String(job.id);
    if (!byId.has(key)) byId.set(key, job);
  }
  return [...byId.values()];
}

// Fetches every company feed unit (capped by ATS_BUDGET) and keeps the jobs with a web signal
// in the title. Returns the counts for the run row and the jobs for the candidate list.
async function searchAts(env, companies) {
  const budget = Number(env.ATS_BUDGET ?? ATS_BUDGET);
  const units = expandUnits(companies, SUPPORTED_ATS).slice(0, Math.max(0, budget));
  if (units.length === 0) return { units: 0, failed: 0, jobs: [] };

  const results = await fetchSlice(units, env);
  const failed = results.filter((r) => r === null).length;
  const jobs = results.flatMap((r) => r ?? []).filter(passesAtsTitleFilter);
  return { units: units.length, failed, jobs };
}

export async function run(env, deps = {}) {
  const companies = deps.companies ?? COMPANIES;
  const runId = await startRun(env.DB);
  // Counts known so far, recorded on the run row whether the run succeeds or fails.
  const counts = {};
  try {
    const perTerm = await searchAll(env);
    counts.termsFailed = perTerm.filter((results) => results === null).length;

    const ats = await searchAts(env, companies);
    counts.atsUnits = ats.units;
    counts.atsFailed = ats.failed;

    if (counts.termsFailed === perTerm.length && ats.failed === ats.units) {
      throw new Error(ats.units > 0 ? "All Adzuna searches and ATS feeds failed" : "All Adzuna searches failed");
    }
    const candidates = dedupeById([...perTerm.flatMap((results) => results ?? []), ...ats.jobs])
      .filter(passesTitleFilter)
      .filter(passesLocationFilter);
    counts.candidates = candidates.length;

    const fresh = await findNew(candidates, env.SEEN_JOBS);
    counts.fresh = fresh.length;
    counts.sent = 0;
    if (fresh.length === 0) {
      console.log(`No new jobs (${candidates.length} candidates)`);
    } else {
      // Mark each part seen right after it is sent, so a failure on a later part
      // does not cause an already delivered part to be resent next run.
      // KV first, then D1, so a D1 outage can never block the seen marking.
      for (const { text, jobs } of formatMessages(fresh)) {
        await send(text, env);
        await markSeen(jobs, env.SEEN_JOBS);
        counts.sent += jobs.length;
        await saveJobs(jobs, runId, env.DB);
      }
      console.log(`Sent ${fresh.length} new jobs`);
    }
  } catch (err) {
    await finishRun(runId, { outcome: "failed", error: err.message, ...counts }, env.DB);
    throw err;
  }
  await finishRun(runId, { outcome: "ok", ...counts }, env.DB);
}

export default {
  async scheduled(controller, env, ctx) {
    await run(env);
  },
  async fetch(request, env, ctx) {
    return handleRequest(request, env, ctx, { run: () => run(env) });
  },
};
