/**
 * Calendar periods for play streaks (pure; no DOM). Each period is a whole number counted in the
 * device's local time, so "consecutive" is a plain `last + 1`:
 *   day    days since 1970-01-01 (local date, so daylight-saving shifts never skip or repeat one)
 *   week   Monday-to-Sunday weeks (1970-01-01 was a Thursday)
 *   month  calendar months
 */
const DAY_MS = 86400000;

/** Local calendar date → day number (Date.UTC of the local Y/M/D, so DST never matters). */
export function dayIndex(at) {
  const d = new Date(at);
  return Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);
}

/** Day number → Monday-based week number. */
export const weekOfDay = (day) => Math.floor((day + 3) / 7);

export function monthIndex(at) {
  const d = new Date(at);
  return d.getFullYear() * 12 + d.getMonth();
}

/** The day, week and month a moment falls in, plus its local hour and weekday (0 = Sunday). */
export function periodsOf(at) {
  const d = new Date(at);
  const day = dayIndex(at);
  return { day, week: weekOfDay(day), month: monthIndex(at), hour: d.getHours(), weekday: d.getDay() };
}

export const STREAK_KINDS = Object.freeze(['day', 'week', 'month']);
