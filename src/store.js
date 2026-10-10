// Every D1 statement lives here. The cron path (startRun, finishRun, saveJobs)
// logs errors and never throws; the read functions and setJobStatus throw.

const STATUSES = ["new", "applied", "dismissed"];

// finishRun field name -> runs column.
const RUN_COLUMNS = {
  outcome: "outcome",
  candidates: "candidates",
  fresh: "fresh",
  sent: "sent",
  termsFailed: "terms_failed",
  error: "error",
};

function now() {
  return new Date().toISOString();
}

function logFailure(what, err) {
  console.error(`D1 ${what} failed: ${err?.message ?? err}`);
}

function numberOrNull(value) {
  return typeof value === "number" ? value : null;
}

export async function startRun(db) {
  try {
    const { meta } = await db
      .prepare("INSERT INTO runs (started_at, outcome) VALUES (?, 'running')")
      .bind(now())
      .run();
    return meta.last_row_id;
  } catch (err) {
    logFailure("startRun", err);
    return null;
  }
}

export async function finishRun(runId, fields, db) {
  if (runId === null || runId === undefined) return;
  try {
    const sets = ["finished_at = ?"];
    const params = [now()];
    for (const [field, column] of Object.entries(RUN_COLUMNS)) {
      const value = fields?.[field];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(field === "error" && value !== null ? String(value).slice(0, 500) : value);
    }
    params.push(runId);
    await db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).bind(...params).run();
  } catch (err) {
    logFailure("finishRun", err);
  }
}

export async function saveJobs(jobs, runId, db) {
  try {
    if (!jobs?.length) return;
    const sentAt = now();
    const insert = db.prepare(
      "INSERT OR IGNORE INTO jobs (id, title, company, location, salary_min, salary_max, url, sent_at, run_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    await db.batch(
      jobs.map((job) =>
        insert.bind(
          String(job.id),
          job.title ?? "Untitled",
          job.company?.display_name ?? null,
          job.location?.display_name ?? null,
          numberOrNull(job.salary_min),
          numberOrNull(job.salary_max),
          job.redirect_url ?? null,
          sentAt,
          runId ?? null,
        ),
      ),
    );
  } catch (err) {
    logFailure("saveJobs", err);
  }
}

export async function latestRun(db) {
  return db.prepare("SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT 1").first();
}

export async function listRuns(limit, db) {
  const { results } = await db
    .prepare("SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?")
    .bind(limit)
    .all();
  return results;
}

export async function listJobs(status, db) {
  const stmt =
    status === "all"
      ? db.prepare("SELECT * FROM jobs ORDER BY sent_at DESC, rowid DESC LIMIT 200")
      : db.prepare("SELECT * FROM jobs WHERE status = ? ORDER BY sent_at DESC, rowid DESC LIMIT 200").bind(status);
  const { results } = await stmt.all();
  return results;
}

export async function countByStatus(db) {
  const { results } = await db.prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status").all();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const row of results) {
    if (row.status in counts) counts[row.status] = row.n;
  }
  return counts;
}

export async function setJobStatus(id, status, db) {
  const { meta } = await db
    .prepare("UPDATE jobs SET status = ?, status_at = ? WHERE id = ?")
    .bind(status, now(), id)
    .run();
  return meta.changes === 1;
}
