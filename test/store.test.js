import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./helpers.js";

test("fakeDb loads the migration", async () => {
  const db = fakeDb();
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'runs') ORDER BY name").all();
  assert.deepEqual(results.map((r) => r.name), ["jobs", "runs"]);
});

test("fakeDb({ broken: true }) throws on prepare", () => {
  assert.throws(() => fakeDb({ broken: true }).prepare("SELECT 1"), /fake D1 is down/);
});
