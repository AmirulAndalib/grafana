// every timestamp in this file is a number which contains an unix-timestamp-in-millisecond format,
// like returned by `new Date().getTime()`. this is needed because the "math"
// has to be done on integer numbers.

import { chunk } from 'lodash';

// we are trying to be compatible with
// https://github.com/grafana/loki/blob/089ec1b05f5ec15a8851d0e8230153e0eeb4dcec/pkg/querier/queryrange/split_by_interval.go#L327-L336

function expandTimeRange(startTime: number, endTime: number, step: number): [number, number] {
  // startTime is decreased to the closes multiple-of-step, if necessary
  const newStartTime = startTime - (startTime % step);

  // endTime is increased to the closed multiple-of-step, if necessary
  let newEndTime = endTime;
  const endStepMod = endTime % step;
  if (endStepMod !== 0) {
    newEndTime += step - endStepMod;
  }

  return [newStartTime, newEndTime];
}

function getAllPoints(startTime: number, endTime: number, step: number): number[] {
  const result: number[] = [];
  // we get start&end times that are nicely aligned to `step`, meaning the distance
  // between them is an integer multiple of `step`
  const [alignedSart, alignedEnd] = expandTimeRange(startTime, endTime, step);
  for (let current = alignedSart; current <= alignedEnd; current += step) {
    result.push(current);
  }
  return result;
}

const MAX_CHUNK_COUNT = 50;

export function getRanges(
  startTime: number,
  endTime: number,
  step: number,
  idealRangeDuration: number
): Array<[number, number]> | null {
  if (idealRangeDuration < step) {
    // we cannot create chunks smaller than `step`
    return null;
  }

  // we must have at least 1 datapoint in the range
  const pointsInChunk = Math.max(Math.trunc(idealRangeDuration / step), 1);

  // FIXME: we can probably do this whole math-thing with a way
  // where we do not create this potentially-large array,
  // but this approach is easy to debug, so later:
  // 1. we add a lot more unit-tests for this
  // 2. we optimize the algorithm to be faster&smaller
  const allPoints = getAllPoints(startTime, endTime, step);

  const ranges: Array<[number, number]> = [];

  // we need the last chunk to be full-size, and the first-chunk to be the maybe-smaller,
  // `lodash.chunk` works the opposite way, so we will do some `.reverse()`
  allPoints.reverse();
  chunk(allPoints, pointsInChunk).forEach((range) => {
    // these ranges are reversed
    const start = range.at(-1);
    const end = range[0];

    // make sure the array is not-empty
    if (start !== undefined && end !== undefined) {
      ranges.push([start, end]);
    }
  });

  ranges.reverse();

  // safety check: if this creates too many items, we just return the whole time-range
  // as a single chunk.

  if (ranges.length > MAX_CHUNK_COUNT) {
    return null;
  }

  return ranges;
}
