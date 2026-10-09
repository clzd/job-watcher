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
