import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function fakeKv(seenIds = []) {
  const store = new Map(seenIds.map((id) => [String(id), "1"]));
  const puts = [];
  return {
    store,
    puts,
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, options) {
      puts.push({ key, value, options });
      store.set(key, value);
    },
  };
}

const MIGRATION = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");

// In-memory stand-in for a D1 binding, backed by node:sqlite with the real migration.
// bind() returns a new statement (like D1), so one prepared statement can be bound
// several times for a batch. Rows come back as plain objects, as D1 returns them.
export function fakeDb({ broken = false } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(MIGRATION);

  function statement(sql, params = []) {
    return {
      bind(...next) {
        return statement(sql, next);
      },
      async run() {
        const { lastInsertRowid, changes } = db.prepare(sql).run(...params);
        return { success: true, meta: { last_row_id: lastInsertRowid, changes } };
      },
      async all() {
        return { results: db.prepare(sql).all(...params).map((row) => ({ ...row })) };
      },
      async first() {
        const row = db.prepare(sql).get(...params);
        return row ? { ...row } : null;
      },
    };
  }

  return {
    prepare(sql) {
      if (broken) throw new Error("fake D1 is down");
      return statement(sql);
    },
    // D1 runs a batch as one transaction, so a failing statement rolls back the rest.
    async batch(statements) {
      db.exec("BEGIN");
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        db.exec("COMMIT");
        return results;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
