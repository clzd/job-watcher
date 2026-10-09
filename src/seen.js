export const SEEN_TTL_SECONDS = 60 * 24 * 60 * 60; // 60 days = 5184000

export async function findNew(jobs, kv) {
  const hits = await Promise.all(jobs.map((job) => kv.get(String(job.id))));
  return jobs.filter((_, i) => hits[i] === null || hits[i] === undefined);
}

export async function markSeen(jobs, kv) {
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await kv.put(String(job.id), "1", { expirationTtl: SEEN_TTL_SECONDS });
      } catch (err) {
        console.error(`KV put failed for job ${job.id}`, err);
      }
    }),
  );
}
