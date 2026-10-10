export function workdayUrl(company) {
  return `https://${company.host}/wday/cxs/${company.tenant}/${company.site}/jobs`;
}

// The public job page. myworkdaysite.com tenants (Mazda) nest the site under /recruiting/<tenant>/.
export function workdayJobUrl(company, externalPath) {
  const prefix = company.host.endsWith("myworkdaysite.com")
    ? `https://${company.host}/recruiting/${company.tenant}/${company.site}`
    : `https://${company.host}/en-US/${company.site}`;
  return prefix + externalPath;
}

// bulletFields[0] is the requisition id (JR102868). Older tenants omit it, so fall back to the
// path suffix after the last underscore, then to the whole path, so the id is never empty.
function requisitionId(posting) {
  const bullet = Array.isArray(posting.bulletFields) ? posting.bulletFields[0] : null;
  if (bullet) return String(bullet);
  const path = posting.externalPath ?? "";
  const suffix = path.slice(path.lastIndexOf("_") + 1);
  return suffix || path || "unknown";
}

export function normalizeWorkday(posting, company) {
  return {
    id: `workday:${company.tenant}:${requisitionId(posting)}`,
    title: posting.title ?? "Untitled",
    company: { display_name: company.name },
    // Accenture's postings carry no locationsText; their location is bulletFields[1].
    location: { display_name: posting.locationsText ?? posting.bulletFields?.[1] ?? "", area: [] },
    redirect_url: workdayJobUrl(company, posting.externalPath ?? ""),
    description: null,
    source: "workday",
  };
}

// Normalized postings on success ([] when the phrase has no hits), null on any failure.
export async function fetchWorkday(unit) {
  const { company, search } = unit;
  try {
    const res = await fetch(workdayUrl(company), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: search ?? "" }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`Workday returned ${res.status} for ${company.tenant}`);
      return null;
    }
    const data = await res.json();
    if (!Array.isArray(data?.jobPostings)) {
      console.error(`Workday returned no jobPostings for ${company.tenant}`);
      return null;
    }
    return data.jobPostings.map((posting) => normalizeWorkday(posting, company));
  } catch (err) {
    console.error(`Workday request failed for ${company.tenant}: ${err.message}`);
    return null;
  }
}
