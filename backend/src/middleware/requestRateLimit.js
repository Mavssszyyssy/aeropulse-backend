const buckets = new Map();

const requestKey = (req, scope) => {
  // Express resolves forwarded addresses using the application's trusted proxy
  // configuration. Do not let a caller pick a bucket with a forged header.
  return `${scope}:${req.ip || req.socket?.remoteAddress || "unknown"}`;
};

const createMemoryRateLimit = ({ scope, windowMs, max, message, keyGenerator }) => (req, res, next) => {
  const now = Date.now();
  const key = keyGenerator ? `${scope}:${keyGenerator(req)}` : requestKey(req, scope);
  const current = buckets.get(key);
  const bucket = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : current;
  bucket.count += 1;
  buckets.set(key, bucket);

  if (buckets.size > 5000) {
    for (const [bucketKey, value] of buckets.entries()) {
      if (value.resetAt <= now) buckets.delete(bucketKey);
    }
  }

  res.set("RateLimit-Limit", String(max));
  res.set("RateLimit-Remaining", String(Math.max(0, max - bucket.count)));
  res.set("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
  if (bucket.count > max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    res.set("Retry-After", String(retryAfterSeconds));
    return res.status(429).json({ message, retryAfterSeconds });
  }
  return next();
};

module.exports = { createMemoryRateLimit };
