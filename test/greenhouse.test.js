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
