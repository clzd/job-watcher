const EXCLUDED_TITLE = /\b(intern|junior)\b/i;
const REMOTE = /remote/i;
const FLORIDA = /florida/i;
const FL_SUFFIX = /,\s*fl$/i;

export function passesTitleFilter(job) {
  return !EXCLUDED_TITLE.test(job.title ?? "");
}

export function passesLocationFilter(job) {
  const title = job.title ?? "";
  const display = job.location?.display_name ?? "";
  const area = Array.isArray(job.location?.area) ? job.location.area : [];

  if (REMOTE.test(title) || REMOTE.test(display)) return true;
  if (area.some((a) => String(a).toLowerCase() === "florida")) return true;
  return FLORIDA.test(display) || FL_SUFFIX.test(display);
}
