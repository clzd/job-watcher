// Private dashboard served behind Cloudflare Access. Server-rendered HTML, no
// client-side JavaScript, no external assets, and no outbound fetch.

import { latestRun, listRuns, listJobs, countByStatus, setJobStatus } from "./store.js";
import { salaryLine } from "./telegram.js";

const STATUSES = ["new", "applied", "dismissed"];
const FILTERS = [...STATUSES, "all"];
const LABELS = { new: "New", applied: "Applied", dismissed: "Dismissed", all: "All" };
const RUNS_LIMIT = 50;
// A "running" row older than this is treated as crashed, so a stuck row cannot block Run now.
const RUN_IN_PROGRESS_MS = 10 * 60_000;

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

const easternParts = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatEastern(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const p = Object.fromEntries(easternParts.formatToParts(date).map(({ type, value }) => [type, value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ET`;
}

function text(body, status) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

// No form-action: a POST after the Access session expires is redirected to the
// Access login on another origin, and form-action 'self' would block it.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'";

function html(body) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": CSP },
  });
}

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#1a1a1a;background:#f6f6f4}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 16px;padding:12px 16px;background:#1f2933;color:#fff}
header strong{font-size:1.05rem;margin-right:auto}
header a{color:#fff}
main{max-width:760px;margin:0 auto;padding:16px}
a{color:#0b5cad}
.status-line{margin:0 0 12px;color:#444}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;padding:0;list-style:none}
.filters a{display:inline-block;padding:4px 10px;border:1px solid #c8c8c4;border-radius:999px;background:#fff;text-decoration:none}
.filters a[aria-current]{background:#1f2933;border-color:#1f2933;color:#fff}
.job{margin:0 0 12px;padding:12px;border:1px solid #deded9;border-radius:8px;background:#fff}
.job h2{margin:0 0 4px;font-size:1.05rem;overflow-wrap:anywhere}
.job p{margin:0;color:#444;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.actions form{margin:0}
.actions button{font:inherit;font-size:.9rem;min-height:44px;padding:6px 12px;border:1px solid #c8c8c4;border-radius:6px;background:#fff;color:#1a1a1a}
.actions button:disabled{background:#e8e8e4;color:#777}
.empty{color:#666}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;background:#fff;font-size:.9rem}
th,td{padding:6px 8px;border-bottom:1px solid #e4e4e0;text-align:left;vertical-align:top}
td.num{text-align:right}
tr.failed td{background:#fdecec}
tr.failed .outcome{color:#a61b1b;font-weight:600}
`;

function layout(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} | job-watcher</title>
<style>${STYLE}</style>
</head>
<body>
<header><strong>job-watcher</strong><a href="/">Jobs</a><a href="/runs">Runs</a></header>
<main>
${bodyHtml}
</main>
</body>
</html>
`;
}

function statusLine(latest) {
  if (!latest) return "No runs yet";
  const when = `Last run ${formatEastern(latest.started_at)}`;
  if (latest.outcome === "ok") return `${when}, ok, ${latest.sent ?? 0} sent`;
  if (latest.outcome === "failed") return `${when}, failed: ${latest.error ?? "unknown error"}`;
  return `${when}, ${latest.outcome}`;
}

function filterLinks(counts, status) {
  const items = FILTERS.map((key) => {
    const label = key === "all" ? LABELS[key] : `${LABELS[key]} (${counts[key] ?? 0})`;
    const current = key === status ? ' aria-current="page"' : "";
    return `<li><a href="/?status=${escapeHtml(key)}"${current}>${escapeHtml(label)}</a></li>`;
  });
  return `<ul class="filters">${items.join("")}</ul>`;
}

function jobBlock(job) {
  // Adzuna data can contain anything, so only http(s) urls become links.
  const title = /^https?:\/\//i.test(job.url ?? "")
    ?`<a href="${escapeHtml(job.url)}" target="_blank" rel="noopener">${escapeHtml(job.title)}</a>`
    : escapeHtml(job.title);
  const details = [job.company, job.location, salaryLine(job)]
    .filter((part) => part !== null && part !== undefined && part !== "")
    .map(escapeHtml)
    .join(" · ");
  const action = `/jobs/${encodeURIComponent(job.id)}/status`;
  const buttons = STATUSES.map((value) => {
    const disabled = value === job.status ? " disabled" : "";
    return `<form method="post" action="${escapeHtml(action)}"><input type="hidden" name="status" value="${escapeHtml(value)}"><button type="submit"${disabled}>${escapeHtml(LABELS[value])}</button></form>`;
  });
  return `<article class="job">
<h2>${title}</h2>
${details ? `<p>${details}</p>` : ""}
<p>Sent ${escapeHtml(formatEastern(job.sent_at))}</p>
<div class="actions">${buttons.join("")}</div>
</article>`;
}

function jobsPage({ latest, counts, jobs, status }) {
  const list = jobs.length
    ? jobs.map(jobBlock).join("\n")
    : `<p class="empty">No ${status === "all" ? "" : `${escapeHtml(LABELS[status].toLowerCase())} `}jobs.</p>`;
  return layout(
    "Jobs",
    `<p class="status-line">${escapeHtml(statusLine(latest))}</p>
${filterLinks(counts, status)}
${list}`,
  );
}

function durationSeconds(run) {
  if (!run.started_at || !run.finished_at) return "";
  const ms = new Date(run.finished_at).getTime() - new Date(run.started_at).getTime();
  return Number.isFinite(ms) ? String(Math.round(ms / 1000)) : "";
}

function runRow(run) {
  const cls = run.outcome === "failed" ? ' class="failed"' : "";
  const cells = [
    `<td>${escapeHtml(formatEastern(run.started_at))}</td>`,
    `<td class="num">${escapeHtml(durationSeconds(run))}</td>`,
    `<td class="outcome">${escapeHtml(run.outcome)}</td>`,
    `<td class="num">${escapeHtml(run.candidates)}</td>`,
    `<td class="num">${escapeHtml(run.fresh)}</td>`,
    `<td class="num">${escapeHtml(run.sent)}</td>`,
    `<td class="num">${escapeHtml(run.terms_failed)}</td>`,
    `<td>${escapeHtml(run.error)}</td>`,
  ];
  return `<tr${cls}>${cells.join("")}</tr>`;
}

function runsPage(runs) {
  if (!runs.length) return layout("Runs", `<p class="empty">No runs yet</p>`);
  return layout(
    "Runs",
    `<div class="table-wrap"><table>
<thead><tr><th>Started</th><th>Duration (s)</th><th>Outcome</th><th>Candidates</th><th>Fresh</th><th>Sent</th><th>Terms failed</th><th>Error</th></tr></thead>
<tbody>
${runs.map(runRow).join("\n")}
</tbody>
</table></div>`,
  );
}

async function route(request, env, ctx, deps) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/") {
    const q = url.searchParams.get("status");
    const status = FILTERS.includes(q) ? q : "new";
    const [latest, counts, jobs] = await Promise.all([
      latestRun(env.DB),
      countByStatus(env.DB),
      listJobs(status, env.DB),
    ]);
    return html(jobsPage({ latest, counts, jobs, status }));
  }
  if (request.method === "GET" && url.pathname === "/runs") {
    return html(runsPage(await listRuns(RUNS_LIMIT, env.DB)));
  }
  if (url.pathname === "/runs/now") {
    // A GET here is a POST replayed by the Access login after a session expired. Change nothing.
    if (request.method !== "POST") {
      return new Response(null, { status: 303, headers: { location: `${url.origin}/runs` } });
    }
    return startRunNow(request, env, ctx, deps, url);
  }
  const statusMatch = url.pathname.match(/^\/jobs\/([^/]+)\/status$/);
  if (statusMatch && request.method === "POST") return updateStatus(request, env, url, statusMatch[1]);
  // A GET here is a POST replayed by the Access login after a session expired. Change nothing.
  if (statusMatch && request.method === "GET") {
    return new Response(null, { status: 303, headers: { location: `${url.origin}/` } });
  }
  return text("Not found", 404);
}

// Parses a header value as a URL, or returns null when it is missing or malformed.
function parseUrl(value) {
  if (!value) return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

async function updateStatus(request, env, url, rawId) {
  // CSRF guard: the form must come from this host.
  if (parseUrl(request.headers.get("origin"))?.host !== url.host) return text("Forbidden", 403);
  let form;
  try {
    form = await request.formData();
  } catch {
    return text("Bad request", 400);
  }
  const status = form.get("status");
  if (!STATUSES.includes(status)) return text("Bad request", 400);
  let id;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    return text("Bad request", 400);
  }
  if (!(await setJobStatus(id, status, env.DB))) return text("Bad request", 400);
  const referer = parseUrl(request.headers.get("referer"));
  const location = referer?.origin === url.origin ? referer.href : `${url.origin}/`;
  return new Response(null, { status: 303, headers: { location } });
}

function runInProgress(latest) {
  if (latest?.outcome !== "running") return false;
  const startedAt = new Date(latest.started_at).getTime();
  if (Number.isNaN(startedAt)) return false;
  return Date.now() - startedAt < RUN_IN_PROGRESS_MS;
}

// Starts a real run (same as the cron) in the background and sends the browser
// back to the Runs page, where the new row shows as running.
async function startRunNow(request, env, ctx, deps, url) {
  // CSRF guard: the form must come from this host.
  if (parseUrl(request.headers.get("origin"))?.host !== url.host) return text("Forbidden", 403);
  const redirect = new Response(null, { status: 303, headers: { location: `${url.origin}/runs` } });
  if (typeof deps?.run !== "function") return redirect;
  if (runInProgress(await latestRun(env.DB))) return redirect;
  const pending = deps.run().catch((err) => {
    console.error(`Run now failed: ${err?.message ?? err}`);
  });
  if (typeof ctx?.waitUntil === "function") ctx.waitUntil(pending);
  return redirect;
}

export async function handleRequest(request, env, ctx, deps = {}) {
  if (!ctx?.access) return text("Access required", 401);
  try {
    return await route(request, env, ctx, deps);
  } catch (err) {
    console.error(`Dashboard request failed: ${err?.message ?? err}`);
    return text("Database error", 500);
  }
}
