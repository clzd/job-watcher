const BOARDS = "https://boards-api.greenhouse.io/v1/boards";

export function greenhouseUrl(slug) {
  return `${BOARDS}/${encodeURIComponent(slug)}/jobs?content=true`;
}

// Adzuna job shape, so filters, Telegram, KV and D1 need no changes.
export function normalizeGreenhouse(job, company) {
  return {
    id: `greenhouse:${company.slug}:${job.id}`,
    title: job.title ?? "Untitled",
    company: { display_name: company.name },
    location: { display_name: job.location?.name ?? "", area: [] },
    redirect_url: job.absolute_url ?? "",
    description: typeof job.content === "string" ? job.content : null,
    source: "greenhouse",
  };
}

// Normalized jobs on success (an empty board gives []), null on any failure.
export async function fetchGreenhouse(unit) {
  const { company } = unit;
  try {
    const res = await fetch(greenhouseUrl(company.slug));
    if (!res.ok) {
      console.error(`Greenhouse returned ${res.status} for ${company.slug}`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data?.jobs)) {
      console.error(`Greenhouse returned no jobs array for ${company.slug}`);
      return null;
    }
    return data.jobs.map((job) => normalizeGreenhouse(job, company));
  } catch (err) {
    console.error(`Greenhouse request failed for ${company.slug}: ${err.message}`);
    return null;
  }
}
