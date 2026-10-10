# Company feeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each cron run fetches every Greenhouse and Workday feed in the short `src/companies.json` list (35 requests), under the free plan's 50 outbound requests, and feeds the matches through the existing filter, KV, Telegram and D1 path.

**Architecture:** `companies.js` expands the company list into units (one outbound request each) and a data test caps the list at 35 units. `greenhouse.js` and `workday.js` fetch one unit and normalize postings to the Adzuna job shape. `ats.js` dispatches by ATS and runs units one at a time. `run()` in `index.js` fetches all units after the Adzuna searches, applies a positive ATS title filter, then merges into the existing candidates. No rotation, no cursor.

**Tech Stack:** Cloudflare Worker, plain JS ESM, no bundler, `node:test` with `node:sqlite` fakes. Run tests with `npm test` (Node 22.13+). JSON import uses `with { type: "json" }` (Node 22+ and wrangler's esbuild both support it).

**Spec:** `docs/superpowers/specs/2026-10-10-company-feeds-design.md`

## Global Constraints

- Plain JS ESM. No TypeScript, no build step, no new dependencies.
- `src/store.js` is the only module with SQL. This plan adds two columns through a migration and `RUN_COLUMNS`; no SQL anywhere else.
- `src/http.js` must not import `src/index.js`.
- Never log an Adzuna URL. The new fetchers log only status codes, slugs, tenants and `err.message`. Feed URLs carry no secrets but are not logged either.
- Every module takes `env` or a binding so tests pass fakes. Fetchers use `globalThis.fetch`, as `adzuna.js` does, and tests replace it.
- Free plan: 50 outbound requests per invocation. 7 Adzuna + 35 feed units + Telegram parts must stay under 50. The data test in Task 2 and `ATS_BUDGET` (default 35) both enforce the 35. Do not raise either.
- Workday search phrases are exactly `["website manager", "digital experience", "optimizely", "wordpress"]`. Four phrases x 5 tenants = 20 units. Adding a phrase adds 5 units and breaks the 35 cap unless a company goes.
- Normalized job ids are `greenhouse:<slug>:<id>` and `workday:<tenant>:<requisition id>`.
- `.claude/settings.json` runs `npm test` after every Edit or Write. Write the failing test first, expect the hook to report the failure, then implement.
- Dates in docs as YYYY-MM-DD. No em dashes in any text, code comments included.

## Review Focus

1. A `companies.json` entry with an ATS no fetcher supports, or a Greenhouse entry with no slug, or a Workday entry missing host, tenant or site. Expected: unsupported ATSes produce no units; a malformed supported entry fails the data test so it never deploys. Pinned in Task 2.
2. Someone adds a 21st company and the list passes 35 units. Expected: the data test fails before deploy, and at runtime `ATS_BUDGET` truncates so a run can never exceed the cap. Pinned in Task 2 and Task 7.
3. A Workday posting with no `bulletFields` and no underscore in `externalPath`. Expected: the id falls back to the path and is never `workday:<tenant>:`. Pinned in Task 4.
4. Every unit fails (outage). Expected: the run still sends Adzuna matches, records `ats_failed`, and throws only when every Adzuna term failed too. Pinned in Task 7.
5. The same Workday posting comes back from two phrase searches in one run. Expected: sent once, marked seen once. Pinned in Task 7.

---

### Task 1: Positive title filter for ATS jobs

**Files:**
- Modify: `src/filters.js`
- Test: `test/filters.test.js` (append)

**Interfaces:**
- Produces: `passesAtsTitleFilter(job) -> boolean`. Task 7 applies it to ATS jobs before the existing filters.

- [ ] **Step 1: Write the failing test**

Append to `test/filters.test.js` (add `passesAtsTitleFilter` to the import from `../src/filters.js`):

```js
test("passesAtsTitleFilter keeps web, digital experience, CMS and CRO titles", () => {
  const keep = [
    "Manager, Web Content",
    "Digital Experience Specialist",
    "Lead Optimizely Solutions Architect",
    "Senior WordPress Engineer",
    "Webmaster",
    "CRO Manager",
    "Conversion Rate Optimization Lead",
    "Head of Experimentation",
    "Sr Manager, Marketing Technology",
    "MarTech Platform Delivery Manager",
    "CMS Architect",
    "Senior Software Engineer, Web",
  ];
  for (const title of keep) assert.ok(passesAtsTitleFilter({ title }), title);
});

test("passesAtsTitleFilter drops titles with no web signal", () => {
  const drop = [
    "Full Time - Merchandising Service Associate - Day",
    "Technical Support Engineer I",
    "Registered Nurse",
    "Webinar Coordinator",
    "Customer Success Associate (Denver, CO)",
    "Chief Revenue Officer",
  ];
  for (const title of drop) assert.ok(!passesAtsTitleFilter({ title }), title);
  assert.ok(!passesAtsTitleFilter({}), "missing title");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="passesAtsTitleFilter"`
Expected: FAIL, `passesAtsTitleFilter` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `src/filters.js`:

```js
// Company feeds return every job a company has open, so ATS jobs must show a web signal
// in the title. Adzuna results are already keyword searches and skip this filter.
const ATS_TITLE =
  /\b(web|website|webmaster|digital experience|optimizely|episerver|wordpress|cms|conversion rate|cro|experimentation|martech|marketing technology)\b/i;

export function passesAtsTitleFilter(job) {
  return ATS_TITLE.test(job.title ?? "");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/filters.js test/filters.test.js
git commit -m "feat: positive title filter for company feed jobs"
```

---

### Task 2: Company list module and unit expansion

**Files:**
- Move: `companies.json` to `src/companies.json` (plain `mv`; the file is not tracked yet)
- Create: `src/companies.js`
- Test: `test/companies.test.js`

**Interfaces:**
- Produces: `COMPANIES` (array from the JSON file), `WORKDAY_SEARCHES` (the four phrases), `expandUnits(companies, supportedAts) -> Array<{ company, search: string | null }>`. A unit is one outbound request. Task 5 exports `SUPPORTED_ATS`; Task 7 passes it in.

- [ ] **Step 1: Move the data file**

```bash
mv companies.json src/companies.json
```

- [ ] **Step 2: Write the failing tests**

Create `test/companies.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { COMPANIES, WORKDAY_SEARCHES, expandUnits } from "../src/companies.js";

const greenhouse = { name: "Netlify", group: "saas", ats: "greenhouse", slug: "netlify" };
const workday = {
  name: "WP Engine", group: "saas", ats: "workday",
  host: "wpengine.wd1.myworkdayjobs.com", tenant: "wpengine", site: "WP_Engine",
};
const oracle = { name: "Hilton", group: "optimizely", ats: "oracle", host: "efet.fa.us2.oraclecloud.com", site: "CX_1" };

test("WORKDAY_SEARCHES is exactly the four phrases from the spec", () => {
  assert.deepEqual(WORKDAY_SEARCHES, ["website manager", "digital experience", "optimizely", "wordpress"]);
});

test("expandUnits makes one unit per Greenhouse company and one per phrase per Workday tenant", () => {
  const units = expandUnits([greenhouse, workday], ["greenhouse", "workday"]);
  assert.equal(units.length, 5);
  assert.deepEqual(units[0], { company: greenhouse, search: null });
  assert.deepEqual(units.slice(1).map((u) => u.search), WORKDAY_SEARCHES);
  assert.ok(units.slice(1).every((u) => u.company === workday));
});

test("expandUnits skips companies whose ATS has no fetcher and keeps file order", () => {
  const units = expandUnits([oracle, workday, greenhouse], ["greenhouse", "workday"]);
  assert.deepEqual(units.map((u) => u.company.name), ["WP Engine", "WP Engine", "WP Engine", "WP Engine", "Netlify"]);
  assert.deepEqual(expandUnits([greenhouse], []), []);
});

test("companies.json entries have what their fetcher needs", () => {
  assert.ok(COMPANIES.length >= 10 && COMPANIES.length <= 30, `${COMPANIES.length} companies; this is a short list`);
  const names = new Set();
  for (const c of COMPANIES) {
    assert.ok(typeof c.name === "string" && c.name, "name missing");
    assert.ok(!names.has(c.name), `duplicate ${c.name}`);
    names.add(c.name);
    assert.ok(["saas", "optimizely", "florida"].includes(c.group), `${c.name} group`);
    assert.ok(["greenhouse", "workday"].includes(c.ats), `${c.name}: ${c.ats} has no fetcher; see docs/companies-verified-2026-10-10.json`);
    if (c.ats === "greenhouse") assert.match(c.slug ?? "", /^[a-z0-9-]+$/, `${c.name} slug`);
    if (c.ats === "workday") {
      assert.match(c.host ?? "", /^[a-z0-9.-]+\.(myworkdayjobs|myworkdaysite)\.com$/, `${c.name} host`);
      assert.match(c.tenant ?? "", /^[a-z0-9]+$/, `${c.name} tenant`);
      assert.ok(typeof c.site === "string" && c.site, `${c.name} site`);
    }
  }
});

test("the whole list fits in one run under the free plan's request cap", () => {
  const units = expandUnits(COMPANIES, ["greenhouse", "workday"]);
  assert.ok(units.length <= 35, `${units.length} units; 7 Adzuna + 35 feeds + Telegram parts must stay under 50`);
  assert.equal(units.length, 35, "15 Greenhouse + 5 Workday x 4 phrases; update this and the spec together");
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="expandUnits|WORKDAY_SEARCHES|companies.json|request cap"`
Expected: FAIL, cannot find module `../src/companies.js`.

- [ ] **Step 4: Write minimal implementation**

Create `src/companies.js`:

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. If the data test fails on an entry, fix the entry in `src/companies.json`, not the test.

- [ ] **Step 6: Check wrangler bundles the JSON import**

Run: `npx wrangler deploy --dry-run`
Expected: "--dry-run: exiting now." with no error. If esbuild rejects `with { type: "json" }`, rename the file to `src/companies.data.js` with `export default { ...the object... }` and change the import; keep the tests unchanged.

- [ ] **Step 7: Commit**

```bash
git add src/companies.json src/companies.js test/companies.test.js
git commit -m "feat: short company feed list and unit expansion"
```

---

### Task 3: Greenhouse fetcher

**Files:**
- Create: `src/greenhouse.js`
- Test: `test/greenhouse.test.js`

**Interfaces:**
- Consumes: a unit `{ company: { name, slug, ats: "greenhouse" }, search: null }` from Task 2.
- Produces: `greenhouseUrl(slug) -> string`, `normalizeGreenhouse(job, company) -> job in Adzuna shape`, `fetchGreenhouse(unit) -> Promise<Array<job> | null>` (null on any failure, `[]` for a board with no jobs). Task 5 registers it.

The feed is `GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true` and answers `{ jobs: [{ id, title, absolute_url, location: { name }, content, updated_at, ... }] }`. A wrong slug answers 404.

- [ ] **Step 1: Write the failing tests**

Create `test/greenhouse.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { greenhouseUrl, normalizeGreenhouse, fetchGreenhouse } from "../src/greenhouse.js";

const netlify = { name: "Netlify", group: "saas", ats: "greenhouse", slug: "netlify" };
const unit = { company: netlify, search: null };
const posting = {
  id: 8806100002,
  title: "Manager, Web Content",
  absolute_url: "https://job-boards.greenhouse.io/netlify/jobs/8806100002",
  location: { name: "Remote" },
  content: "<p>Own netlify.com.</p>",
  updated_at: "2026-10-02T19:03:23-04:00",
};

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; });

function fakeFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return calls;
}

test("greenhouseUrl asks the board API for every job with content", () => {
  assert.equal(greenhouseUrl("netlify"), "https://boards-api.greenhouse.io/v1/boards/netlify/jobs?content=true");
});

test("normalizeGreenhouse maps a posting to the Adzuna job shape with a namespaced id", () => {
  assert.deepEqual(normalizeGreenhouse(posting, netlify), {
    id: "greenhouse:netlify:8806100002",
    title: "Manager, Web Content",
    company: { display_name: "Netlify" },
    location: { display_name: "Remote", area: [] },
    redirect_url: "https://job-boards.greenhouse.io/netlify/jobs/8806100002",
    description: "<p>Own netlify.com.</p>",
    source: "greenhouse",
  });
});

test("normalizeGreenhouse tolerates a bare posting", () => {
  const job = normalizeGreenhouse({ id: 1 }, netlify);
  assert.equal(job.id, "greenhouse:netlify:1");
  assert.equal(job.title, "Untitled");
  assert.equal(job.location.display_name, "");
  assert.equal(job.redirect_url, "");
  assert.equal(job.description, null);
});

test("fetchGreenhouse GETs the board and returns normalized jobs", async () => {
  const calls = fakeFetch(200, { jobs: [posting, { id: 2, title: "Customer Success Associate", absolute_url: "u", location: { name: "Remote" } }] });
  const jobs = await fetchGreenhouse(unit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, greenhouseUrl("netlify"));
  assert.equal(calls[0].options?.method ?? "GET", "GET");
  assert.deepEqual(jobs.map((j) => j.id), ["greenhouse:netlify:8806100002", "greenhouse:netlify:2"]);
});

test("fetchGreenhouse returns an empty array for a board with no open jobs", async () => {
  fakeFetch(200, { jobs: [] });
  assert.deepEqual(await fetchGreenhouse(unit), []);
});

test("fetchGreenhouse returns null on a non-200, a malformed body, or a network error", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeFetch(404, { error: "not found" });
  assert.equal(await fetchGreenhouse(unit), null);
  fakeFetch(200, "<html>nginx</html>");
  assert.equal(await fetchGreenhouse(unit), null);
  fakeFetch(200, { meta: {} });
  assert.equal(await fetchGreenhouse(unit), null);
  globalThis.fetch = async () => { throw new Error("socket hang up"); };
  assert.equal(await fetchGreenhouse(unit), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="Greenhouse|greenhouseUrl"`
Expected: FAIL, cannot find module `../src/greenhouse.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/greenhouse.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/greenhouse.js test/greenhouse.test.js
git commit -m "feat: Greenhouse board fetcher"
```

---

### Task 4: Workday fetcher

**Files:**
- Create: `src/workday.js`
- Test: `test/workday.test.js`

**Interfaces:**
- Consumes: a unit `{ company: { name, tenant, host, site, ats: "workday" }, search: "website manager" }` from Task 2.
- Produces: `workdayUrl(company) -> string`, `workdayJobUrl(company, externalPath) -> string`, `normalizeWorkday(posting, company) -> job in Adzuna shape`, `fetchWorkday(unit) -> Promise<Array<job> | null>`. Task 5 registers it.

The feed is `POST https://{host}/wday/cxs/{tenant}/{site}/jobs` with JSON `{"appliedFacets":{},"limit":20,"offset":0,"searchText":"<phrase>"}` and headers `content-type: application/json`, `accept: application/json`. It answers `{ total, jobPostings: [{ title, externalPath, locationsText, postedOn, bulletFields: ["JR102868"] }] }`, newest first. A phrase with no hits answers `total: 0, jobPostings: []`, which is a normal result. The public job page is `https://{host}/en-US/{site}{externalPath}`, except on `myworkdaysite.com` hosts where it is `https://{host}/recruiting/{tenant}/{site}{externalPath}`.

- [ ] **Step 1: Write the failing tests**

Create `test/workday.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { workdayUrl, workdayJobUrl, normalizeWorkday, fetchWorkday } from "../src/workday.js";

const wpengine = {
  name: "WP Engine", group: "saas", ats: "workday",
  host: "wpengine.wd1.myworkdayjobs.com", tenant: "wpengine", site: "WP_Engine",
};
const mazda = {
  name: "Mazda USA", group: "optimizely", ats: "workday",
  host: "wd5.myworkdaysite.com", tenant: "mazdausa", site: "Mazda",
};
const unit = { company: wpengine, search: "website manager" };
const posting = {
  title: "Website Manager",
  externalPath: "/job/Remote---US/Website-Manager_JR102868",
  locationsText: "Remote - US",
  postedOn: "Posted 9 Days Ago",
  bulletFields: ["JR102868"],
};

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; });

function fakeFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return calls;
}

test("workdayUrl points at the tenant's cxs jobs endpoint", () => {
  assert.equal(workdayUrl(wpengine), "https://wpengine.wd1.myworkdayjobs.com/wday/cxs/wpengine/WP_Engine/jobs");
});

test("workdayJobUrl builds the public job page for both host styles", () => {
  assert.equal(
    workdayJobUrl(wpengine, "/job/Remote---US/Website-Manager_JR102868"),
    "https://wpengine.wd1.myworkdayjobs.com/en-US/WP_Engine/job/Remote---US/Website-Manager_JR102868",
  );
  assert.equal(
    workdayJobUrl(mazda, "/job/Irvine/Web-Manager_R123"),
    "https://wd5.myworkdaysite.com/recruiting/mazdausa/Mazda/job/Irvine/Web-Manager_R123",
  );
});

test("normalizeWorkday maps a posting to the Adzuna shape keyed by requisition id", () => {
  assert.deepEqual(normalizeWorkday(posting, wpengine), {
    id: "workday:wpengine:JR102868",
    title: "Website Manager",
    company: { display_name: "WP Engine" },
    location: { display_name: "Remote - US", area: [] },
    redirect_url: "https://wpengine.wd1.myworkdayjobs.com/en-US/WP_Engine/job/Remote---US/Website-Manager_JR102868",
    description: null,
    source: "workday",
  });
});

test("normalizeWorkday falls back to the path suffix, then the whole path, for the id", () => {
  const noBullets = normalizeWorkday({ title: "X", externalPath: "/job/Miami-FL/X_R77" }, wpengine);
  assert.equal(noBullets.id, "workday:wpengine:R77");
  const noUnderscore = normalizeWorkday({ title: "X", externalPath: "/job/Miami-FL/X" }, wpengine);
  assert.equal(noUnderscore.id, "workday:wpengine:/job/Miami-FL/X");
  const bare = normalizeWorkday({}, wpengine);
  assert.equal(bare.title, "Untitled");
  assert.equal(bare.location.display_name, "");
  assert.notEqual(bare.id, "workday:wpengine:");
});

test("fetchWorkday POSTs the search phrase as JSON and returns normalized jobs", async () => {
  const calls = fakeFetch(200, { total: 1, jobPostings: [posting] });
  const jobs = await fetchWorkday(unit);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, workdayUrl(wpengine));
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.equal(calls[0].options.headers.accept, "application/json");
  assert.deepEqual(JSON.parse(calls[0].options.body), { appliedFacets: {}, limit: 20, offset: 0, searchText: "website manager" });
  assert.deepEqual(jobs.map((j) => j.id), ["workday:wpengine:JR102868"]);
});

test("fetchWorkday treats a phrase with no hits as an empty result, not a failure", async () => {
  fakeFetch(200, { total: 0, jobPostings: [] });
  assert.deepEqual(await fetchWorkday(unit), []);
});

test("fetchWorkday returns null on a non-200, a malformed body, or a network error", async (t) => {
  t.mock.method(console, "error", () => {});
  fakeFetch(422, "");
  assert.equal(await fetchWorkday(unit), null);
  fakeFetch(200, "<html>Cloudflare challenge</html>");
  assert.equal(await fetchWorkday(unit), null);
  fakeFetch(200, { total: 3 });
  assert.equal(await fetchWorkday(unit), null);
  globalThis.fetch = async () => { throw new Error("socket hang up"); };
  assert.equal(await fetchWorkday(unit), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="Workday|workdayUrl|workdayJobUrl"`
Expected: FAIL, cannot find module `../src/workday.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/workday.js`:

```js
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
    location: { display_name: posting.locationsText ?? "", area: [] },
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
```

Note on the `noUnderscore` test: `path.lastIndexOf("_")` is -1, so `slice(0)` is the whole path, which is what the test expects.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/workday.js test/workday.test.js
git commit -m "feat: Workday tenant search fetcher"
```

---

### Task 5: Dispatcher and sequential slice fetch

**Files:**
- Create: `src/ats.js`
- Test: `test/ats.test.js`

**Interfaces:**
- Consumes: `fetchGreenhouse` (Task 3), `fetchWorkday` (Task 4), units (Task 2).
- Produces: `FETCHERS` (`{ greenhouse, workday }`), `SUPPORTED_ATS` (`Object.keys(FETCHERS)`), `fetchUnit(unit) -> Promise<Array<job> | null>`, `fetchSlice(slice, env) -> Promise<Array<Array<job> | null>>` (one entry per unit, same order, `env.ATS_GAP_MS` between requests, default 500). Task 7 uses `SUPPORTED_ATS` and `fetchSlice`.

- [ ] **Step 1: Write the failing tests**

Create `test/ats.test.js`:

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FETCHERS, SUPPORTED_ATS, fetchUnit, fetchSlice } from "../src/ats.js";

const greenhouse = { company: { name: "Netlify", ats: "greenhouse", slug: "netlify" }, search: null };
const workday = {
  company: { name: "WP Engine", ats: "workday", host: "wpengine.wd1.myworkdayjobs.com", tenant: "wpengine", site: "WP_Engine" },
  search: "optimizely",
};
const oracle = { company: { name: "Hilton", ats: "oracle", host: "efet.fa.us2.oraclecloud.com", site: "CX_1" }, search: null };

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; });

test("SUPPORTED_ATS is exactly the fetchers this plan ships", () => {
  assert.deepEqual(SUPPORTED_ATS, ["greenhouse", "workday"]);
  assert.deepEqual(Object.keys(FETCHERS), SUPPORTED_ATS);
});

test("fetchUnit dispatches on the company's ATS and answers null for one it cannot fetch", async () => {
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ jobs: [], jobPostings: [] }), { status: 200 });
  };
  assert.deepEqual(await fetchUnit(greenhouse), []);
  assert.deepEqual(await fetchUnit(workday), []);
  assert.equal(await fetchUnit(oracle), null);
  assert.deepEqual(urls, [
    "https://boards-api.greenhouse.io/v1/boards/netlify/jobs?content=true",
    "https://wpengine.wd1.myworkdayjobs.com/wday/cxs/wpengine/WP_Engine/jobs",
  ]);
});

test("fetchSlice runs one request at a time, ATS_GAP_MS apart, and keeps unit order", async (t) => {
  t.mock.method(console, "error", () => {});
  let inFlight = 0;
  let maxInFlight = 0;
  const startedAt = [];
  globalThis.fetch = async (url) => {
    startedAt.push(Date.now());
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;
    if (String(url).includes("greenhouse")) return new Response("down", { status: 503 });
    return new Response(JSON.stringify({ total: 0, jobPostings: [] }), { status: 200 });
  };

  const results = await fetchSlice([workday, greenhouse, workday], { ATS_GAP_MS: "30" });

  assert.deepEqual(results, [[], null, []]);
  assert.equal(startedAt.length, 3);
  assert.equal(maxInFlight, 1);
  for (let i = 1; i < startedAt.length; i++) {
    assert.ok(startedAt[i] - startedAt[i - 1] >= 30, `gap before request ${i} was too short`);
  }
});

test("fetchSlice with an empty slice makes no requests", async () => {
  globalThis.fetch = async () => { throw new Error("should not fetch"); };
  assert.deepEqual(await fetchSlice([], { ATS_GAP_MS: "0" }), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="SUPPORTED_ATS|fetchUnit|fetchSlice"`
Expected: FAIL, cannot find module `../src/ats.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/ats.js`:

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ats.js test/ats.test.js
git commit -m "feat: ATS dispatcher and sequential slice fetch"
```

---

### Task 6: Run columns for feed counts

**Files:**
- Create: `migrations/0002_ats_counts.sql`
- Modify: `src/store.js` (`RUN_COLUMNS`, around line 8)
- Test: `test/store.test.js` (append)

**Interfaces:**
- Produces: `finishRun(runId, { atsUnits, atsFailed, ... }, db)` writes `runs.ats_units` and `runs.ats_failed`. Task 7 passes both.

- [ ] **Step 1: Write the failing test**

Append to `test/store.test.js`:

```js
test("finishRun records the company feed counts", async () => {
  const db = fakeDb();
  const id = await startRun(db);
  await finishRun(id, { outcome: "ok", candidates: 3, atsUnits: 35, atsFailed: 2 }, db);
  const row = await latestRun(db);
  assert.equal(row.ats_units, 35);
  assert.equal(row.ats_failed, 2);
  assert.equal(row.candidates, 3);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern="company feed counts"`
Expected: FAIL, `row.ats_units` is undefined.

- [ ] **Step 3: Add the migration and the column mapping**

Create `migrations/0002_ats_counts.sql`:

```sql
ALTER TABLE runs ADD COLUMN ats_units INTEGER;
ALTER TABLE runs ADD COLUMN ats_failed INTEGER;
```

In `src/store.js`, extend `RUN_COLUMNS`:

```js
const RUN_COLUMNS = {
  outcome: "outcome",
  candidates: "candidates",
  fresh: "fresh",
  sent: "sent",
  termsFailed: "terms_failed",
  atsUnits: "ats_units",
  atsFailed: "ats_failed",
  error: "error",
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS. `fakeDb` applies every file in `migrations/` in name order, so the new columns exist.

- [ ] **Step 5: Apply the migration locally**

Run: `npx wrangler d1 migrations apply job-watcher --local`
Expected: `0002_ats_counts.sql` listed as applied. The remote apply happens in Task 7 Step 9, right before deploy.

- [ ] **Step 6: Commit**

```bash
git add migrations/0002_ats_counts.sql src/store.js test/store.test.js
git commit -m "feat: runs table records company feed unit counts"
```

---

### Task 7: Wire the feeds into the run, docs, deploy

**Files:**
- Modify: `src/index.js` (imports, `run`)
- Modify: `test/index.test.js` (`fakeFetch`, `makeEnv`, new tests)
- Modify: `wrangler.toml` (add `[vars]`)
- Modify: `CLAUDE.md` (first line and Quirks)
- Check: `test/http.test.js` (it uses a fake `deps.run`, so nothing to change; confirm)

**Interfaces:**
- Consumes: `expandUnits`, `COMPANIES` (Task 2); `fetchSlice`, `SUPPORTED_ATS` (Task 5); `passesAtsTitleFilter` (Task 1); `finishRun` with `atsUnits`, `atsFailed` (Task 6).
- Produces: `run(env, deps = {})` where `deps.companies` overrides the company list (tests). `env.ATS_BUDGET` (default 35, 0 disables feeds), `env.ATS_GAP_MS` (default 500). `index.js`'s `fetch` handler keeps passing `run: () => run(env)`.

- [ ] **Step 1: Keep the existing tests on Adzuna only**

In `test/index.test.js`, add two lines to `makeEnv` so every existing test fetches no company feeds:

```js
function makeEnv(kv, db = fakeDb()) {
  return {
    ADZUNA_APP_ID: "id",
    ADZUNA_APP_KEY: "key",
    TELEGRAM_BOT_TOKEN: "tok",
    TELEGRAM_CHAT_ID: "chat",
    SEEN_JOBS: kv,
    DB: db,
    SEARCH_GAP_MS: "0",
    ATS_GAP_MS: "0",
    ATS_BUDGET: "0",
  };
}
```

Then extend `fakeFetch` to answer Greenhouse and Workday. Replace the whole function:

```js
// adzunaStatus, telegramStatus and greenhouseStatus may each be a number or a function of the 0-based call index.
function fakeFetch({
  results = [],
  telegramStatus = 200,
  adzunaStatus = 200,
  greenhouseJobs = [],
  greenhouseStatus = 200,
  workdayPostings = [],
} = {}) {
  const calls = { adzuna: [], telegram: [], greenhouse: [], workday: [] };
  globalThis.fetch = async (url, options) => {
    const u = String(url);
    if (u.startsWith("https://api.adzuna.com/")) {
      const status = typeof adzunaStatus === "function" ? adzunaStatus(calls.adzuna.length) : adzunaStatus;
      calls.adzuna.push(u);
      if (status !== 200) return new Response("server error", { status });
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    if (u.startsWith("https://api.telegram.org/")) {
      const status = typeof telegramStatus === "function" ? telegramStatus(calls.telegram.length) : telegramStatus;
      calls.telegram.push(JSON.parse(options.body));
      return new Response(status === 200 ? '{"ok":true}' : '{"ok":false}', { status });
    }
    if (u.startsWith("https://boards-api.greenhouse.io/")) {
      const status = typeof greenhouseStatus === "function" ? greenhouseStatus(calls.greenhouse.length) : greenhouseStatus;
      calls.greenhouse.push(u);
      if (status !== 200) return new Response("server error", { status });
      return new Response(JSON.stringify({ jobs: greenhouseJobs }), { status: 200 });
    }
    if (u.includes("/wday/cxs/")) {
      calls.workday.push({ url: u, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ total: workdayPostings.length, jobPostings: workdayPostings }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  return calls;
}
```

Run: `npm test`
Expected: PASS (nothing uses the new fields yet; `ATS_BUDGET` is ignored until Step 4).

- [ ] **Step 2: Write the failing tests**

Append to `test/index.test.js`:

```js
import { WORKDAY_SEARCHES } from "../src/companies.js";
import { latestRun } from "../src/store.js";

const netlify = { name: "Netlify", group: "saas", ats: "greenhouse", slug: "netlify" };
const wpengine = {
  name: "WP Engine", group: "saas", ats: "workday",
  host: "wpengine.wd1.myworkdayjobs.com", tenant: "wpengine", site: "WP_Engine",
};
// 1 Greenhouse unit + 4 Workday units = 5 units in this order:
// [netlify, wpengine "website manager", wpengine "digital experience", wpengine "optimizely", wpengine "wordpress"]
const twoCompanies = [netlify, wpengine];

const webContentPosting = {
  id: 1, title: "Manager, Web Content", location: { name: "Remote" },
  absolute_url: "https://job-boards.greenhouse.io/netlify/jobs/1", content: "<p>x</p>",
};
const successPosting = {
  id: 2, title: "Customer Success Associate", location: { name: "Remote" },
  absolute_url: "https://job-boards.greenhouse.io/netlify/jobs/2",
};
const miamiWebsiteManager = {
  title: "Website Manager", externalPath: "/job/Miami-FL/Website-Manager_JR1",
  locationsText: "Miami, FL", postedOn: "Posted Today", bulletFields: ["JR1"],
};

test("run fetches every feed after Adzuna, sends the web jobs that pass the filters, and records the counts", async () => {
  const calls = fakeFetch({
    results: [],
    greenhouseJobs: [webContentPosting, successPosting],
    workdayPostings: [miamiWebsiteManager],
  });
  const kv = fakeKv();
  const env = { ...makeEnv(kv), ATS_BUDGET: "35" };

  await run(env, { companies: twoCompanies });

  assert.equal(calls.adzuna.length, 7);
  assert.equal(calls.greenhouse.length, 1);
  assert.deepEqual(calls.workday.map((c) => c.body.searchText), WORKDAY_SEARCHES);
  assert.equal(calls.telegram.length, 1);
  const text = calls.telegram[0].text;
  assert.ok(text.startsWith("New jobs (2)\n\n"), text);
  assert.ok(text.includes("Manager, Web Content\nNetlify\nRemote\nhttps://job-boards.greenhouse.io/netlify/jobs/1"), text);
  assert.ok(!text.includes("Customer Success"), "no web signal, filtered out");
  assert.equal(
    text.split("https://wpengine.wd1.myworkdayjobs.com/en-US/WP_Engine/job/Miami-FL/Website-Manager_JR1").length - 1,
    1,
    "same Workday posting from four searches listed once",
  );
  assert.deepEqual(kv.puts.map((p) => p.key).sort(), ["greenhouse:netlify:1", "workday:wpengine:JR1"]);
  const row = await latestRun(env.DB);
  assert.equal(row.outcome, "ok");
  assert.equal(row.ats_units, 5);
  assert.equal(row.ats_failed, 0);
  assert.equal(row.candidates, 2);
});

test("run makes no feed requests when ATS_BUDGET is 0", async () => {
  const calls = fakeFetch({ results: [remoteJob] });
  const kv = fakeKv();
  const env = makeEnv(kv);
  await run(env, { companies: twoCompanies });
  assert.equal(calls.greenhouse.length, 0);
  assert.equal(calls.workday.length, 0);
  assert.equal(calls.telegram.length, 1, "Adzuna path unchanged");
  const row = await latestRun(env.DB);
  assert.equal(row.ats_units, 0);
  assert.equal(row.ats_failed, 0);
});

test("ATS_BUDGET truncates the unit list in file order", async () => {
  const calls = fakeFetch({ results: [] });
  const kv = fakeKv();
  await run({ ...makeEnv(kv), ATS_BUDGET: "3" }, { companies: twoCompanies });
  assert.equal(calls.greenhouse.length, 1);
  assert.deepEqual(calls.workday.map((c) => c.body.searchText), WORKDAY_SEARCHES.slice(0, 2));
});

test("run keeps going when Adzuna is down but a feed answers", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fakeFetch({ adzunaStatus: 500, greenhouseJobs: [webContentPosting] });
  const kv = fakeKv();
  const env = { ...makeEnv(kv), ATS_BUDGET: "35" };

  await run(env, { companies: [netlify] });

  assert.equal(calls.telegram.length, 1);
  const row = await latestRun(env.DB);
  assert.equal(row.outcome, "ok");
  assert.equal(row.terms_failed, 7);
  assert.equal(row.ats_units, 1);
  assert.equal(row.ats_failed, 0);
});

test("run throws when Adzuna and every feed fail", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fakeFetch({ adzunaStatus: 500, greenhouseStatus: 503 });
  const kv = fakeKv();
  const env = { ...makeEnv(kv), ATS_BUDGET: "35" };

  await assert.rejects(run(env, { companies: [netlify] }), /All Adzuna searches and ATS feeds failed/);

  assert.equal(calls.greenhouse.length, 1);
  assert.equal(calls.telegram.length, 0);
  assert.equal(kv.puts.length, 0);
  const row = await latestRun(env.DB);
  assert.equal(row.outcome, "failed");
  assert.equal(row.ats_units, 1);
  assert.equal(row.ats_failed, 1);
});

test("run still sends Adzuna matches when every feed fails, and counts the failures", async (t) => {
  t.mock.method(console, "error", () => {});
  const calls = fakeFetch({ results: [remoteJob], greenhouseStatus: 503, workdayPostings: [] });
  const kv = fakeKv();
  const env = { ...makeEnv(kv), ATS_BUDGET: "35" };

  await run(env, { companies: [netlify] });

  assert.equal(calls.greenhouse.length, 1);
  assert.equal(calls.telegram.length, 1);
  const row = await latestRun(env.DB);
  assert.equal(row.outcome, "ok");
  assert.equal(row.ats_units, 1);
  assert.equal(row.ats_failed, 1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- --test-name-pattern="every feed|ATS_BUDGET|Adzuna is down|every feed fail"`
Expected: FAIL. The first test fails with `unexpected fetch` or an empty Telegram list, because `run` ignores `deps` and never fetches feeds.

- [ ] **Step 4: Implement the feed fetch in `run`**

In `src/index.js`, add the imports after the existing ones (merge `passesAtsTitleFilter` into the existing `./filters.js` import line):

```js
import { passesAtsTitleFilter } from "./filters.js";
import { COMPANIES, expandUnits } from "./companies.js";
import { SUPPORTED_ATS, fetchSlice } from "./ats.js";
```

Add after the `SEARCH_GAP_MS` constant:

```js
// Company feed requests per run. The Workers free plan allows 50 outbound requests per
// invocation: 7 go to Adzuna, 35 here, which leaves 8 Telegram parts. The data test in
// test/companies.test.js keeps the list at 35 units; this is the runtime guard. 0 disables feeds.
const ATS_BUDGET = 35;
```

Add after `dedupeById`:

```js
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
```

Change the top of `run`:

```js
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
```

The rest of `run` (findNew, the send loop, finishRun) stays as it is. The `scheduled` and `fetch` handlers stay as they are; `run(env)` with no second argument uses `COMPANIES`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, every suite. The existing test `run throws, sends nothing, and writes nothing when every Adzuna search fails` still passes because `ATS_BUDGET` is 0 there, so the message is unchanged.

- [ ] **Step 6: Config and docs**

Append to `wrangler.toml`:

```toml
[vars]
# Company feed requests per run. 35 fits the free plan's 50 outbound requests next to
# 7 Adzuna calls and a few Telegram parts. 0 turns the feeds off without a deploy of code.
ATS_BUDGET = "35"
```

In `CLAUDE.md`, change the first line to:

```
Cloudflare Worker on a cron (`0 */6 * * *`) that searches Adzuna plus 20 company career feeds (Greenhouse, Workday), sends new remote or Florida jobs to Telegram, and serves a D1-backed dashboard.
```

Add to Quirks:

```
- Company feeds come from `src/companies.json`: 15 Greenhouse boards and 5 Workday tenants, all fetched every run. A unit is one outbound request: one per Greenhouse board, one per phrase in `WORKDAY_SEARCHES` per Workday tenant. The list must stay at or under 35 units (a test enforces it) because the free plan allows 50 outbound requests per invocation and Adzuna uses 7. KV and D1 calls do not count. `ATS_BUDGET` in `wrangler.toml` is the runtime guard; tests set it to "0". The full 178-company research list is `docs/companies-verified-2026-10-10.json`.
- Only `greenhouse` and `workday` have fetchers (`src/ats.js`). ATS jobs pass `passesAtsTitleFilter` (web, website, digital experience, optimizely, wordpress, cms, cro, ...) before the usual filters, because feeds return every job a company has open. Job ids are `greenhouse:<slug>:<id>` and `workday:<tenant>:<req id>`.
- A Workday phrase search returns newest first, 20 per request, no description. Single words like "web" match thousands of postings; keep phrases two words.
```

Run: `npm test` (the hook runs anyway).

- [ ] **Step 7: Dry run the deploy**

Run: `npx wrangler deploy --dry-run`
Expected: no errors, bundle includes `src/companies.json`.

- [ ] **Step 8: Commit**

```bash
git add src/index.js test/index.test.js wrangler.toml CLAUDE.md
git commit -m "feat: fetch the short list of company feeds every run"
```

- [ ] **Step 9: Local end-to-end, then ship**

1. `npx wrangler dev --test-scheduled` in one terminal, `curl "http://localhost:8787/__scheduled?cron=0+*/6+*+*+*"` in another. Expected in the dev log: 7 Adzuna searches, then 35 feed requests one at a time, a Telegram message if anything new matched, and the run row on `/runs` with `ats_units` 35.
2. `npx wrangler d1 migrations apply job-watcher --remote` (adds two nullable columns; nothing else changes).
3. `npx wrangler deploy`.
4. Press Run now on the dashboard once and confirm the Runs page shows the new row. Expect the first run to be noisy: every matching job on every feed is new to KV. After that only new postings arrive.
