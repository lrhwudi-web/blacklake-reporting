const DAY_MS = 86400000, OFFSET_MS = 8 * 3600000;

export function timestampMs(value) {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  const text = String(value || '').trim().replace(' ', 'T');
  return Date.parse(text + (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text) ? '' : '+08:00'));
}

// Subtract each task's pauses before unioning parallel tasks in daily totals.
export function workingIntervalsBetween(start, end, pauses = []) {
  const a = timestampMs(start), b = timestampMs(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  const excluded = pauses.map(p => [Math.max(a, timestampMs(p.startedAt)),
    Math.min(b, p.endedAt ? timestampMs(p.endedAt) : b)])
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s)
    .sort((x, y) => x[0] - y[0]);
  const result = []; let cursor = a;
  for (const [s, e] of excluded) {
    if (s > cursor) result.push([cursor, s]);
    cursor = Math.max(cursor, e);
  }
  if (cursor < b) result.push([cursor, b]);
  return result;
}

function lunchMilliseconds(a, b) {
  let total = 0;
  for (let day = Math.floor((a + OFFSET_MS) / DAY_MS); day <= Math.floor((b + OFFSET_MS) / DAY_MS); day++) {
    const midnight = day * DAY_MS - OFFSET_MS;
    total += Math.max(0, Math.min(b, midnight + 13.5 * 3600000) - Math.max(a, midnight + 12 * 3600000));
  }
  return total;
}

export function workTimeBreakdown(start, end, pauses = []) {
  const a = timestampMs(start), b = timestampMs(end);
  const intervals = workingIntervalsBetween(start, end, pauses);
  if (!intervals) return { effectiveSeconds: NaN, elapsedSeconds: NaN, lunchSeconds: NaN, pauseSeconds: NaN, lunchActive: false };
  const elapsed = b - a, lunch = lunchMilliseconds(a, b);
  const effective = intervals.reduce((total, [s, e]) => total + e - s - lunchMilliseconds(s, e), 0);
  const localTime = ((b + OFFSET_MS) % DAY_MS + DAY_MS) % DAY_MS;
  return { effectiveSeconds: Math.floor(effective / 1000), elapsedSeconds: Math.floor(elapsed / 1000),
    lunchSeconds: Math.floor(lunch / 1000), pauseSeconds: Math.floor((elapsed - lunch - effective) / 1000),
    lunchActive: localTime >= 12 * 3600000 && localTime < 13.5 * 3600000 };
}

export function effectiveWorkSecondsBetween(start, end, pauses = []) {
  return workTimeBreakdown(start, end, pauses).effectiveSeconds;
}
