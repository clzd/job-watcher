const TELEGRAM_LIMIT = 4096;
const money = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export function salaryLine(job) {
  const min = typeof job.salary_min === "number" ? job.salary_min : null;
  const max = typeof job.salary_max === "number" ? job.salary_max : null;
  if (min !== null && max !== null) {
    const lo = money.format(min);
    const hi = money.format(max);
    return lo === hi ? `$${lo}` : `$${lo} to $${hi}`;
  }
  if (min !== null) return `$${money.format(min)}`;
  if (max !== null) return `$${money.format(max)}`;
  return null;
}

export function formatJob(job) {
  const lines = [
    job.title ?? "Untitled",
    job.company?.display_name || "Unknown company",
    job.location?.display_name || "Location not listed",
  ];
  const salary = salaryLine(job);
  if (salary) lines.push(salary);
  lines.push(job.redirect_url ?? "");
  return lines.join("\n");
}

export function formatMessage(jobs) {
  return [`New jobs (${jobs.length})`, ...jobs.map(formatJob)].join("\n\n");
}

// Greedily packs blocks into groups that fit under limit once a part header is added.
// Returns arrays of block indexes so callers can map them back to blocks or jobs.
function packBlocks(header, blocks, limit) {
  // Reserve room for the longest plausible part header, e.g. ", part 10 of 10".
  const headerBudget = header.length + ", part 00 of 00".length + 2;

  const groups = [];
  let current = [];
  let used = 0;
  blocks.forEach((block, index) => {
    const cost = block.length + 2;
    if (current.length > 0 && headerBudget + used + cost > limit) {
      groups.push(current);
      current = [];
      used = 0;
    }
    current.push(index);
    used += cost;
  });
  if (current.length > 0) groups.push(current);
  return groups;
}

function partText(header, blocks, i, total) {
  return [`${header}, part ${i + 1} of ${total}`, ...blocks].join("\n\n");
}

export function splitMessage(text, limit = TELEGRAM_LIMIT) {
  if (text.length <= limit) return [text];

  const [header, ...blocks] = text.split("\n\n");
  const groups = packBlocks(header, blocks, limit);
  return groups.map((group, i) =>
    partText(header, group.map((index) => blocks[index]), i, groups.length),
  );
}

// Like splitMessage(formatMessage(jobs)), but each part also carries the jobs it lists,
// so the caller can mark exactly those jobs seen once that part is sent.
export function formatMessages(jobs, limit = TELEGRAM_LIMIT) {
  const text = formatMessage(jobs);
  if (text.length <= limit) return [{ text, jobs: [...jobs] }];

  const header = `New jobs (${jobs.length})`;
  const blocks = jobs.map(formatJob);
  const groups = packBlocks(header, blocks, limit);
  return groups.map((group, i) => ({
    text: partText(header, group.map((index) => blocks[index]), i, groups.length),
    jobs: group.map((index) => jobs[index]),
  }));
}

export async function send(text, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Telegram sendMessage failed: ${res.status} ${body}`);
  }
}
