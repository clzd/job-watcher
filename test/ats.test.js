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

test("fetchUnit dispatches on the company's ATS and answers null for one it cannot fetch", async (t) => {
  t.mock.method(console, "error", () => {});
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ jobs: [], jobPostings: [] }), { status: 200 });
  };
  assert.deepEqual(await fetchUnit(greenhouse), []);
  assert.deepEqual(await fetchUnit(workday), []);
  assert.equal(await fetchUnit(oracle), null);
  assert.deepEqual(urls, [
    "https://boards-api.greenhouse.io/v1/boards/netlify/jobs",
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
