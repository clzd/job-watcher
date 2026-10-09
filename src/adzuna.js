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

export async function fetchSearch(term, env) {
  try {
    const res = await fetch(buildUrl(term, env));
    if (!res.ok) {
      console.error(`Adzuna returned ${res.status} for "${term}"`);
      return [];
    }
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  } catch (err) {
    console.error(`Adzuna request failed for "${term}": ${err.message}`);
    return [];
  }
}
