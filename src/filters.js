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

// Company feeds return every job a company has open, so ATS jobs must show a web signal
// in the title. Adzuna results are already keyword searches and skip this filter.
const ATS_TITLE =
  /\b(web|website|webmaster|digital experience|optimizely|episerver|wordpress|cms|conversion rate|cro|experimentation|martech|marketing technology)\b/i;

export function passesAtsTitleFilter(job) {
  return ATS_TITLE.test(job.title ?? "");
}
