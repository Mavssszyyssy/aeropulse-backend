const { performance } = require("node:perf_hooks");

const boundedInteger = (value, fallback, minimum, maximum) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
};

const percentile = (values, ratio) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
};

const readOption = (name, fallback = "") => {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) || fallback;
};

const runReadBenchmark = async ({
  url,
  requests = 30,
  concurrency = 5,
  token = "",
  branch = "",
} = {}) => {
  const target = new URL(url);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new Error("Benchmark URL must use HTTP or HTTPS.");
  }

  const total = boundedInteger(requests, 30, 1, 500);
  const workers = boundedInteger(concurrency, 5, 1, 25);
  const timings = [];
  const statuses = new Map();
  let next = 0;
  let failures = 0;

  const runWorker = async () => {
    while (next < total) {
      next += 1;
      const startedAt = performance.now();
      try {
        const response = await fetch(target, {
          method: "GET",
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(branch ? { "X-Branch": branch } : {}),
          },
        });
        await response.arrayBuffer();
        statuses.set(response.status, (statuses.get(response.status) || 0) + 1);
        if (!response.ok) failures += 1;
      } catch (_error) {
        failures += 1;
        statuses.set("network_error", (statuses.get("network_error") || 0) + 1);
      } finally {
        timings.push(performance.now() - startedAt);
      }
    }
  };

  const benchmarkStartedAt = performance.now();
  await Promise.all(Array.from({ length: Math.min(workers, total) }, runWorker));
  const elapsedMs = performance.now() - benchmarkStartedAt;

  return {
    url: target.toString(),
    method: "GET",
    requests: total,
    concurrency: Math.min(workers, total),
    failures,
    statuses: Object.fromEntries(statuses),
    latencyMs: {
      minimum: Math.round(Math.min(...timings) * 10) / 10,
      median: Math.round(percentile(timings, 0.5) * 10) / 10,
      p95: Math.round(percentile(timings, 0.95) * 10) / 10,
      maximum: Math.round(Math.max(...timings) * 10) / 10,
    },
    throughputPerSecond: Math.round((total / Math.max(elapsedMs / 1000, 0.001)) * 100) / 100,
  };
};

const main = async () => {
  const result = await runReadBenchmark({
    url: readOption("url", process.env.BENCHMARK_URL || "http://localhost:5000/api/health"),
    requests: readOption("requests", process.env.BENCHMARK_REQUESTS || "30"),
    concurrency: readOption("concurrency", process.env.BENCHMARK_CONCURRENCY || "5"),
    token: process.env.BENCHMARK_TOKEN || "",
    branch: process.env.BENCHMARK_BRANCH || "",
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.failures > 0) process.exitCode = 1;
};

if (require.main === module) {
  main().catch((error) => {
    console.error("Read benchmark failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { boundedInteger, percentile, runReadBenchmark };
