import { test } from "node:test";
import assert from "node:assert/strict";
import { findNew, markSeen, SEEN_TTL_SECONDS } from "../src/seen.js";
import { fakeKv } from "./helpers.js";

test("TTL constant is 60 days in seconds", () => {
  assert.equal(SEEN_TTL_SECONDS, 5184000);
});

test("findNew returns only postings absent from KV, in original order", async () => {
  const kv = fakeKv(["b"]);
  const jobs = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const fresh = await findNew(jobs, kv);
  assert.deepEqual(fresh.map((j) => j.id), ["a", "c"]);
});

test("findNew treats a numeric id and its string form as the same key", async () => {
  const kv = fakeKv(["12345"]);
  const fresh = await findNew([{ id: 12345 }, { id: 67890 }], kv);
  assert.deepEqual(fresh.map((j) => j.id), [67890]);
});

test("findNew with no jobs does not touch KV", async () => {
  const kv = fakeKv();
  let gets = 0;
  kv.get = async () => { gets += 1; return null; };
  assert.deepEqual(await findNew([], kv), []);
  assert.equal(gets, 0);
});

test("findNew propagates KV read errors", async () => {
  const kv = { get: async () => { throw new Error("kv down"); } };
  await assert.rejects(findNew([{ id: "a" }], kv), /kv down/);
});

test("markSeen writes each id as a string key with the 60-day TTL", async () => {
  const kv = fakeKv();
  await markSeen([{ id: "a" }, { id: 42 }], kv);
  assert.deepEqual(kv.puts, [
    { key: "a", value: "1", options: { expirationTtl: 5184000 } },
    { key: "42", value: "1", options: { expirationTtl: 5184000 } },
  ]);
});

test("markSeen logs and swallows a failing put so the run still succeeds", async (t) => {
  const errors = t.mock.method(console, "error", () => {});
  const kv = { put: async () => { throw new Error("quota"); } };
  await markSeen([{ id: "a" }], kv);
  assert.equal(errors.mock.callCount(), 1);
});
