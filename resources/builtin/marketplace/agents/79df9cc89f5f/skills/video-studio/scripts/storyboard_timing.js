'use strict';

// VideoStudio-owned read-only timing adapter and estimator snapshot.
// Assess corresponding Studio copies when changing the core calculation.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { estimateNarrationDuration } = require('./lib/narration-timing.cjs');

const MAX_BYTES = 1024 * 1024;
const MAX_SEGMENTS = 1000;
const round2 = value => Number(value.toFixed(2));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);

function validateKeys(value, allowed, label) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new Error(`${label} has an invalid shape or unsupported fields.`);
  }
}

function readInput(filename) {
  let fd;
  try {
    fd = fs.openSync(filename, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > MAX_BYTES) throw new Error();
    return JSON.parse(buffer.subarray(0, length).toString('utf8'));
  } catch {
    throw new Error('Input must be the path of a JSON file no larger than 1 MiB. Write the JSON to a file in the production (for example lamp-ad/timing.json), pass that path, and run it again.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

module.exports = async function storyboardTiming({ args }) {
  try {
    if (args.length !== 2 || args[0] !== '--input' || !args[1]) {
      throw new Error('Usage: storyboard_timing --input timing.json');
    }
    const input = readInput(args[1]);
    validateKeys(input, ['duration_sec', 'speed', 'segments'], 'Input');
    if (!finite(input.duration_sec) || input.duration_sec <= 0) {
      throw new Error('duration_sec must be a positive finite number.');
    }
    const speed = input.speed === undefined ? 1 : input.speed;
    if (!finite(speed) || speed < 0.5 || speed > 2) {
      throw new Error('speed must be a number between 0.5 and 2.');
    }
    if (!Array.isArray(input.segments) || !input.segments.length || input.segments.length > MAX_SEGMENTS) {
      throw new Error('segments must contain between 1 and 1000 shots.');
    }
    let previousEnd = 0;
    let previousId;
    let totalSpeech = 0;
    const ids = new Set();
    const segments = input.segments.map(segment => {
      validateKeys(segment, ['id', 'text', 'start_sec', 'target_sec'], 'Segment');
      if (typeof segment.id !== 'string' || !segment.id.trim() || segment.id.length > 100 || ids.has(segment.id)) {
        throw new Error('Every segment needs a unique nonempty id of at most 100 characters.');
      }
      ids.add(segment.id);
      if (typeof segment.text !== 'string') throw new Error('Segment text must be a string; use an empty string for silence.');
      const label = `Segment ${JSON.stringify(segment.id)}`;
      if (!finite(segment.start_sec) || segment.start_sec < 0) {
        throw new Error(`${label}: start_sec must be a finite nonnegative start time in seconds.`);
      }
      if (!finite(segment.target_sec) || segment.target_sec <= 0 || !Number.isFinite(segment.start_sec + segment.target_sec)) {
        throw new Error(`${label}: target_sec must be a finite positive duration in seconds, not an end time; end = start_sec + target_sec must be finite.`);
      }
      if (segment.start_sec < previousEnd - 1e-9) {
        throw new Error(`${label}: start_sec overlaps previous segment ${JSON.stringify(previousId)} ending at ${previousEnd}s. target_sec is a duration in seconds (end - start), not an end time.`);
      }
      previousEnd = segment.start_sec + segment.target_sec;
      previousId = segment.id;
      const estimate = estimateNarrationDuration(segment.text, speed);
      totalSpeech += estimate.estimatedSec;
      return {
        id: segment.id,
        start_sec: segment.start_sec,
        target_sec: segment.target_sec,
        text_sha256: crypto.createHash('sha256').update(segment.text).digest('hex'),
        estimated_sec: estimate.estimatedSec,
        remaining_sec: round2(segment.target_sec - estimate.estimatedSec),
      };
    });
    const crowded = segments.filter(segment => segment.remaining_sec < 0)
      .map(segment => ({ id: segment.id, over_by_sec: round2(-segment.remaining_sec) }));
    const timelineOver = round2(Math.max(0, previousEnd - input.duration_sec));
    return {
      ok: true,
      kind: 'estimate',
      speed,
      duration_sec: input.duration_sec,
      planned_end_sec: round2(previousEnd),
      remaining_timeline_sec: round2(input.duration_sec - previousEnd),
      sum_estimated_speech_sec: round2(totalSpeech),
      timing_review: {
        advisory: true,
        status: crowded.length || timelineOver > 0 ? 'has_findings' : 'no_findings',
        crowded_segments: crowded,
        timeline_over_by_sec: timelineOver,
      },
      segments,
    };
  } catch (error) {
    return { ok: false, errorCode: 'E_STORYBOARD_TIMING_INPUT', message: error.message };
  }
};
