'use strict';
// Opt-in, bounded attribution for the real persistence workload. Segments are
// exclusive main-thread wall time, not physical-disk latency or an optimization.
const fs = require('node:fs');
const { PerformanceObserver } = require('node:perf_hooks');

function profileContextSaves(Session) {
  const restore = [], stack = [], segments = [], phases = {}, gc = [];
  const maxSegments = 8192;
  let last = performance.now(), omitted = 0, segmentCount = 0, bytes = 0, saves = 0;
  let pulse = last, worst = { start: last, end: last, delayMs: 0, exclusivePhaseMs: {} };
  const account = now => {
    const phase = stack.at(-1);
    if (phase) {
      const elapsed = now - last;
      const row = phases[phase] ||= { calls: 0, exclusiveMs: 0 };
      row.exclusiveMs += elapsed;
      segmentCount++;
      if (segments.length < maxSegments) segments.push({ phase, start: last, end: now });
      else omitted++;
    }
    last = now;
  };
  function enter(phase, call) {
    account(performance.now()); stack.push(phase);
    (phases[phase] ||= { calls: 0, exclusiveMs: 0 }).calls++;
    try { return call(); }
    finally { account(performance.now()); stack.pop(); }
  }
  function replace(object, key, make) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key), original = object[key];
    object[key] = make(original);
    restore.push(() => descriptor ? Object.defineProperty(object, key, descriptor) : delete object[key]);
  }
  const byteLength = Buffer.byteLength;
  replace(Session.prototype, 'persistContext', original => function (...args) {
    saves++;
    return enter('persistence-other', () => Reflect.apply(original, this, args));
  });
  replace(Session.prototype, 'getSerializedContextState', original => function (...args) {
    return stack.length ? enter('clone-state', () => Reflect.apply(original, this, args)) : Reflect.apply(original, this, args);
  });
  replace(JSON, 'stringify', original => function (...args) {
    return stack.length ? enter('json-stringify', () => Reflect.apply(original, this, args)) : Reflect.apply(original, this, args);
  });
  for (const key of ['from', 'byteLength']) replace(Buffer, key, original => function (...args) {
    return stack.length ? enter('utf8-' + key, () => Reflect.apply(original, this, args)) : Reflect.apply(original, this, args);
  });
  for (const key of ['writeFileSync', 'renameSync', 'lstatSync', 'fstatSync', 'openSync', 'closeSync', 'readSync', 'existsSync']) {
    replace(fs, key, original => function (...args) {
      if (!stack.length) return Reflect.apply(original, this, args);
      return enter('fs-' + key, () => {
        const result = Reflect.apply(original, this, args);
        if (key === 'writeFileSync') bytes += typeof args[1] === 'string'
          ? Reflect.apply(byteLength, Buffer, [args[1]]) : args[1].byteLength;
        return result;
      });
    });
  }
  const observer = new PerformanceObserver(list => {
    for (const event of list.getEntries()) if (gc.length < 256) gc.push({ start: event.startTime, end: event.startTime + event.duration });
  });
  observer.observe({ entryTypes: ['gc'] });
  const timer = setInterval(() => {
    const now = performance.now(), delayMs = Math.max(0, now - pulse - 2);
    if (delayMs > worst.delayMs) {
      const exclusivePhaseMs = {};
      for (const segment of segments) exclusivePhaseMs[segment.phase] = (exclusivePhaseMs[segment.phase] || 0)
        + Math.max(0, Math.min(segment.end, now) - Math.max(segment.start, pulse));
      worst = { start: pulse, end: now, delayMs, exclusivePhaseMs };
    }
    segments.length = 0;
    pulse = now;
  }, 2);
  return { stop() {
    clearInterval(timer); observer.disconnect();
    for (const undo of restore.reverse()) undo();
    const overlap = segment => Math.max(0, Math.min(segment.end, worst.end) - Math.max(segment.start, worst.start));
    return { saves, contextWriteBytes: bytes, phases, worstGap: { delayMs: worst.delayMs, exclusivePhaseMs: worst.exclusivePhaseMs,
      gcMs: gc.reduce((sum, event) => sum + overlap(event), 0) }, segments: segmentCount, omitted,
      gcEvents: gc.length, gcMs: gc.reduce((sum, event) => sum + event.end - event.start, 0),
      scope: 'Save phase only; excludes independent reopen/oracles. GC overlaps phase wall time; never add it again. Instrumentation overhead and OS cache are included; no native UI or physical-disk attribution.' };
  } };
}
module.exports = { profileContextSaves };
