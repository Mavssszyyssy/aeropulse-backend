const DEFAULT_SLOW_REQUEST_MS = 1200;

const resolveSlowRequestMs = (value = process.env.SLOW_REQUEST_WARNING_MS) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SLOW_REQUEST_MS;
  return Math.min(60000, Math.max(250, Math.trunc(parsed)));
};

const createPerformanceTiming = ({ slowRequestMs = resolveSlowRequestMs() } = {}) => (
  req,
  res,
  next,
) => {
  const startedAt = process.hrtime.bigint();
  const originalEnd = res.end;
  let durationMs = null;

  const elapsed = () => {
    if (durationMs === null) {
      durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    }
    return durationMs;
  };

  res.end = function endWithPerformanceTiming(...args) {
    const milliseconds = elapsed();
    if (!res.headersSent) {
      res.setHeader("Server-Timing", `app;dur=${milliseconds.toFixed(1)}`);
    }
    return originalEnd.apply(this, args);
  };

  res.once("finish", () => {
    const milliseconds = elapsed();
    if (milliseconds < slowRequestMs) return;
    const route = String(req.originalUrl || req.url || "").split("?", 1)[0];
    console.warn("Slow API request", {
      method: String(req.method || "GET").toUpperCase(),
      route,
      status: Number(res.statusCode || 0),
      durationMs: Math.round(milliseconds),
    });
  });

  next();
};

module.exports = {
  DEFAULT_SLOW_REQUEST_MS,
  createPerformanceTiming,
  resolveSlowRequestMs,
};
