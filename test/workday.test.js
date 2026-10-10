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

test("normalizeWorkday falls back to bulletFields[1] for the location when locationsText is missing", () => {
  const accenture = normalizeWorkday({ title: "X", externalPath: "/job/London/X_R1", bulletFields: ["R1", "London"] }, wpengine);
  assert.equal(accenture.location.display_name, "London");
  assert.equal(normalizeWorkday({}, wpengine).location.display_name, "");
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

test("fetchWorkday passes an abort signal so a hung tenant times out", async () => {
  const calls = fakeFetch(200, { total: 0, jobPostings: [] });
  await fetchWorkday(unit);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
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
