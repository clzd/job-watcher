import file from "./companies.json" with { type: "json" };

// Short list of verified feeds, see the _notes key in the file. Every entry is fetched every run.
export const COMPANIES = file.companies;

// One Workday request per phrase per tenant. Workday search is full text and returns newest first.
// A single word like "web" matches thousands of merchandising jobs; two-word phrases stay tight.
// 4 phrases x 5 tenants = 20 units. Adding a phrase adds 5 units against the 35 cap.
export const WORKDAY_SEARCHES = ["website manager", "digital experience", "optimizely", "wordpress"];

// A unit is exactly one outbound HTTP request. Companies whose ATS has no fetcher yet produce none.
export function expandUnits(companies, supportedAts) {
  const units = [];
  for (const company of companies) {
    if (!supportedAts.includes(company.ats)) continue;
    if (company.ats === "workday") {
      for (const search of WORKDAY_SEARCHES) units.push({ company, search });
    } else {
      units.push({ company, search: null });
    }
  }
  return units;
}
