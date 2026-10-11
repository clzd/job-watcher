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
  assert.equal(units.length, 21, "9 Greenhouse + 3 Workday x 4 phrases; update this and the spec together");
});
