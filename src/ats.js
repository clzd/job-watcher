import { fetchGreenhouse } from "./greenhouse.js";
import { fetchWorkday } from "./workday.js";

// One fetcher per ATS. companies.json entries with any other ats produce no units (see companies.js).
export const FETCHERS = { greenhouse: fetchGreenhouse, workday: fetchWorkday };
export const SUPPORTED_ATS = Object.keys(FETCHERS);

// Different hosts, so no need for Adzuna's 2s. env.ATS_GAP_MS overrides (tests set it to 0).
const ATS_GAP_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchUnit(unit) {
  const fetcher = FETCHERS[unit.company.ats];
  if (!fetcher) {
    console.error(`No fetcher for ${unit.company.ats} (${unit.company.name})`);
    return null;
  }
  return fetcher(unit);
}

// One request at a time. Returns one entry per unit, in order: the jobs array or null on failure.
export async function fetchSlice(slice, env) {
  const gapMs = Number(env.ATS_GAP_MS ?? ATS_GAP_MS);
  const results = [];
  for (const [i, unit] of slice.entries()) {
    if (i > 0) await sleep(gapMs);
    results.push(await fetchUnit(unit));
  }
  return results;
}
