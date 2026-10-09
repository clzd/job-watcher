import { fetchSearch } from "./adzuna.js";
import { passesTitleFilter, passesLocationFilter } from "./filters.js";
import { findNew, markSeen } from "./seen.js";
import { formatMessage, splitMessage, send } from "./telegram.js";

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
  const perTerm = await Promise.all(SEARCH_TERMS.map((term) => fetchSearch(term, env)));
  if (perTerm.every((results) => results === null)) {
    throw new Error("All Adzuna searches failed");
  }
  const candidates = dedupeById(perTerm.flatMap((results) => results ?? []))
    .filter(passesTitleFilter)
    .filter(passesLocationFilter);

  const fresh = await findNew(candidates, env.SEEN_JOBS);
  if (fresh.length === 0) {
    console.log(`No new jobs (${candidates.length} candidates)`);
    return;
  }

  for (const part of splitMessage(formatMessage(fresh))) {
    await send(part, env);
  }
  await markSeen(fresh, env.SEEN_JOBS);
  console.log(`Sent ${fresh.length} new jobs`);
}

export default {
  async scheduled(controller, env, ctx) {
    await run(env);
  },
};
