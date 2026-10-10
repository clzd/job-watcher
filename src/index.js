import { fetchSearch } from "./adzuna.js";
import { passesTitleFilter, passesLocationFilter } from "./filters.js";
import { findNew, markSeen } from "./seen.js";
import { formatMessages, send } from "./telegram.js";
import { startRun, finishRun, saveJobs } from "./store.js";
import { handleRequest } from "./http.js";

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

function dedupeById(jobs) {
  const byId = new Map();
  for (const job of jobs) {
    const key = String(job.id);
    if (!byId.has(key)) byId.set(key, job);
  }
  return [...byId.values()];
}

export async function run(env) {
  const runId = await startRun(env.DB);
  // Counts known so far, recorded on the run row whether the run succeeds or fails.
  const counts = {};
  try {
    const perTerm = await Promise.all(SEARCH_TERMS.map((term) => fetchSearch(term, env)));
    counts.termsFailed = perTerm.filter((results) => results === null).length;
    if (counts.termsFailed === perTerm.length) {
      throw new Error("All Adzuna searches failed");
    }
    const candidates = dedupeById(perTerm.flatMap((results) => results ?? []))
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
    return handleRequest(request, env, ctx);
  },
};
