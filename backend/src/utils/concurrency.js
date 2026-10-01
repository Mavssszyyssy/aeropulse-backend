const forEachWithConcurrency = async (items = [], limit = 5, worker) => {
  const values = Array.from(items || []);
  if (!values.length) return;
  const concurrency = Math.min(
    values.length,
    Math.max(1, Math.trunc(Number(limit) || 1)),
  );
  let nextIndex = 0;

  const run = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(values[index], index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, run));
};

module.exports = { forEachWithConcurrency };
