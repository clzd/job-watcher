import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildUrl, fetchSearch } from "../src/adzuna.js";

const env = { ADZUNA_APP_ID: "myid", ADZUNA_APP_KEY: "mykey" };

test("buildUrl targets the US search endpoint with every required parameter", () => {
  const url = new URL(buildUrl("website manager", env));
  assert.equal(url.origin + url.pathname, "https://api.adzuna.com/v1/api/jobs/us/search/1");
  assert.equal(url.searchParams.get("app_id"), "myid");
  assert.equal(url.searchParams.get("app_key"), "mykey");
  assert.equal(url.searchParams.get("what"), "website manager");
  assert.equal(url.searchParams.get("results_per_page"), "50");
  assert.equal(url.searchParams.get("sort_by"), "date");
  assert.equal(url.searchParams.get("content-type"), "application/json");
});

test("buildUrl URL-encodes the search term", () => {
  const raw = buildUrl("conversion rate optimization manager", env);
  assert.ok(raw.includes("what=conversion+rate+optimization+manager"), raw);
  assert.ok(!raw.includes(" "));
});

let realFetch;
before(() => { realFetch = globalThis.fetch; });
after(() => { globalThis.fetch = realFetch; });

test("fetchSearch returns results on 200", async () => {
  const results = [{ id: "1", title: "Website Manager" }];
  globalThis.fetch = async () => new Response(JSON.stringify({ results }), { status: 200 });
  assert.deepEqual(await fetchSearch("website manager", env), results);
});

test("fetchSearch returns [] and logs on a non-2xx without leaking the key", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  globalThis.fetch = async () => new Response("rate limited", { status: 500 });
  assert.deepEqual(await fetchSearch("website manager", env), []);
  assert.equal(errors.mock.callCount(), 1);
  const logged = errors.mock.calls[0].arguments.map(String).join(" ");
  assert.ok(!logged.includes("mykey"), "app_key must not be logged");
});

test("fetchSearch returns [] when the 200 body has no results array", async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({ exception: "limit" }), { status: 200 });
  assert.deepEqual(await fetchSearch("website manager", env), []);
});

test("fetchSearch returns [] and logs when fetch itself throws", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  assert.deepEqual(await fetchSearch("website manager", env), []);
  assert.equal(errors.mock.callCount(), 1);
});
