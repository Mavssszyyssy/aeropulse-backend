// Process-local, bounded reuse. Failures never become cached responses.
function createRequestCache({ ttlMs, maxEntries }) {
  const entries = new Map();
  const pending = new Map();

  return async (key, load) => {
    const entry = entries.get(key);
    if (entry?.expiresAt > Date.now()) return entry.value;
    entries.delete(key);

    if (pending.has(key)) return pending.get(key);
    if (pending.size >= maxEntries) return load();

    const request = Promise.resolve().then(load);
    pending.set(key, request);
    try {
      const value = await request;
      if (ttlMs > 0) {
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
        entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      }
      return value;
    } finally {
      pending.delete(key);
    }
  };
}

module.exports = { createRequestCache };
