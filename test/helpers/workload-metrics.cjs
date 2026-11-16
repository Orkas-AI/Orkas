'use strict';
// Headless caller metrics. Timer delay is event-loop service delay, not disk
// latency. Endpoint memory is deliberately not reported as peak memory.
async function measureWorkload(work) {
  const intervalMs = 2;
  let last = performance.now(), maxGapMs = 0, ticks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last); last = now; ticks++;
  }, intervalMs);
  try {
    await new Promise(resolve => setTimeout(resolve, 5));
    const cpu = process.cpuUsage(), memoryBefore = process.memoryUsage();
    last = performance.now(); ticks = 0; maxGapMs = 0;
    const start = performance.now();
    const value = await work();
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu), memoryAfter = process.memoryUsage();
    // A resolved Promise can monopolize microtasks. Drain a timer turn so a
    // completed blocking burst cannot disappear before its pulse is serviced.
    await new Promise(resolve => setTimeout(resolve, 5));
    return { value, metrics: { elapsedMs, maxGapMs,
      eventLoopDelayMs: Math.max(0, maxGapMs - intervalMs), ticks,
      cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000,
      rssBefore: memoryBefore.rss, rssAfter: memoryAfter.rss,
      externalBefore: memoryBefore.external, externalAfter: memoryAfter.external } };
  } finally { clearInterval(timer); }
}
module.exports = { measureWorkload };
