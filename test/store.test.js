import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeDb } from "./helpers.js";
import {
  startRun,
  finishRun,
  saveJobs,
  latestRun,
  listRuns,
  listJobs,
  countByStatus,
  setJobStatus,
} from "../src/store.js";

const remoteJob = {
  id: 101,
  title: "Web Platform Manager",
  company: { display_name: "Acme" },
  location: { display_name: "Remote", area: ["US"] },
  redirect_url: "https://www.adzuna.com/land/ad/101",
  salary_min: 90000,
  salary_max: 120000,
};
const bareJob = { id: 202, title: "Website Manager" };
const stringSalaryJob = { id: 303, title: "X", salary_min: "85000" };

test("fakeDb loads the migration", async () => {
  const db = fakeDb();
  const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'runs') ORDER BY name").all();
  assert.deepEqual(results.map((r) => r.name), ["jobs", "runs"]);
});

test("fakeDb({ broken: true }) throws on prepare", () => {
  assert.throws(() => fakeDb({ broken: true }).prepare("SELECT 1"), /fake D1 is down/);
});

test("startRun inserts a running row and returns its id", async () => {
  const db = fakeDb();
  const id = await startRun(db);
  assert.equal(id, 1);
  const row = await db.prepare("SELECT outcome, started_at, finished_at FROM runs WHERE id = ?").bind(id).first();
  assert.equal(row.outcome, "running");
  assert.match(row.started_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(row.finished_at, null);
});

test("startRun returns null and logs when D1 is down", async (t) => {
  const err = t.mock.method(console, "error", () => {});
  assert.equal(await startRun(fakeDb({ broken: true })), null);
  assert.equal(err.mock.callCount(), 1);
});

test("finishRun writes outcome, counts, finished_at, and truncates error to 500", async () => {
  const db = fakeDb();
  const id = await startRun(db);
  await finishRun(id, { outcome: "failed", candidates: 5, fresh: 2, sent: 1, termsFailed: 3, error: "x".repeat(600) }, db);
  const row = await db.prepare("SELECT * FROM runs WHERE id = ?").bind(id).first();
  assert.equal(row.outcome, "failed");
  assert.deepEqual([row.candidates, row.fresh, row.sent, row.terms_failed], [5, 2, 1, 3]);
  assert.equal(row.error.length, 500);
  assert.ok(row.finished_at);
});

test("finishRun with a null runId is a no-op", async () => {
  const db = fakeDb();
  await finishRun(null, { outcome: "ok" }, db);
  const { results } = await db.prepare("SELECT id FROM runs").all();
  assert.equal(results.length, 0);
});

test("saveJobs stores the mapped columns and stringifies a numeric id", async () => {
  const db = fakeDb();
  await saveJobs([remoteJob], 7, db);
  const row = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind("101").first();
  assert.equal(row.title, "Web Platform Manager");
  assert.equal(row.company, "Acme");
  assert.equal(row.location, "Remote");
  assert.equal(row.salary_min, 90000);
  assert.equal(row.salary_max, 120000);
  assert.equal(row.url, "https://www.adzuna.com/land/ad/101");
  assert.equal(row.run_id, 7);
  assert.equal(row.status, "new");
});

test("saveJobs stores null for missing company, location, salary, and string salaries", async () => {
  const db = fakeDb();
  await saveJobs([bareJob, stringSalaryJob], 1, db);
  const bare = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind("202").first();
  assert.deepEqual([bare.company, bare.location, bare.salary_min, bare.salary_max, bare.url], [null, null, null, null, null]);
  const str = await db.prepare("SELECT salary_min FROM jobs WHERE id = ?").bind("303").first();
  assert.equal(str.salary_min, null);
});

test("saveJobs ignores a duplicate id and keeps the existing status", async () => {
  const db = fakeDb();
  await saveJobs([remoteJob], 1, db);
  await setJobStatus("101", "applied", db);
  await saveJobs([remoteJob], 2, db);
  const row = await db.prepare("SELECT status, run_id FROM jobs WHERE id = ?").bind("101").first();
  assert.deepEqual([row.status, row.run_id], ["applied", 1]);
});

test("saveJobs logs and does not throw when D1 is down", async (t) => {
  t.mock.method(console, "error", () => {});
  await saveJobs([remoteJob], 1, fakeDb({ broken: true }));
});

test("listJobs filters by status, newest first, and all returns everything", async () => {
  const db = fakeDb();
  await saveJobs([{ ...remoteJob, id: 1 }], 1, db);
  await new Promise((r) => setTimeout(r, 5));
  await saveJobs([{ ...remoteJob, id: 2 }, { ...remoteJob, id: 3 }], 1, db);
  await setJobStatus("2", "dismissed", db);
  assert.deepEqual((await listJobs("new", db)).map((j) => j.id), ["3", "1"]);
  assert.deepEqual((await listJobs("dismissed", db)).map((j) => j.id), ["2"]);
  assert.equal((await listJobs("all", db)).length, 3);
});

test("countByStatus returns zeros for empty statuses", async () => {
  const db = fakeDb();
  await saveJobs([remoteJob], 1, db);
  assert.deepEqual(await countByStatus(db), { new: 1, applied: 0, dismissed: 0 });
});

test("setJobStatus updates status_at and returns false for an unknown id", async () => {
  const db = fakeDb();
  await saveJobs([remoteJob], 1, db);
  assert.equal(await setJobStatus("101", "applied", db), true);
  const row = await db.prepare("SELECT status, status_at FROM jobs WHERE id = ?").bind("101").first();
  assert.equal(row.status, "applied");
  assert.ok(row.status_at);
  assert.equal(await setJobStatus("999", "applied", db), false);
});

test("latestRun is null with no runs and listRuns is newest first", async () => {
  const db = fakeDb();
  assert.equal(await latestRun(db), null);
  await startRun(db);
  await new Promise((r) => setTimeout(r, 5));
  const second = await startRun(db);
  assert.equal((await latestRun(db)).id, second);
  assert.deepEqual((await listRuns(50, db)).map((r) => r.id), [second, 1]);
});
