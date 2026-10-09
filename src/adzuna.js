const ENDPOINT = "https://api.adzuna.com/v1/api/jobs/us/search/1";

export function buildUrl(term, env) {
  const url = new URL(ENDPOINT);
  url.searchParams.set("app_id", env.ADZUNA_APP_ID);
  url.searchParams.set("app_key", env.ADZUNA_APP_KEY);
  url.searchParams.set("what", term);
  url.searchParams.set("results_per_page", "50");
  url.searchParams.set("sort_by", "date");
  url.searchParams.set("content-type", "application/json");
  return url.toString();
}

// Returns the results array on success (possibly empty) and null on any failure,
// so the caller can tell a quiet day from a dead API key.
export async function fetchSearch(term, env) {
  try {
    const res = await fetch(buildUrl(term, env));
    if (!res.ok) {
      console.error(`Adzuna returned ${res.status} for "${term}"`);
      return null;
    }
    const data = await res.json();
    return Array.isArray(data?.results) ? data.results : [];
  } catch (err) {
    console.error(`Adzuna request failed for "${term}": ${err.message}`);
    return null;
  }
}
