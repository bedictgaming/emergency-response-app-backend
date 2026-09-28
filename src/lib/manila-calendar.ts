export const MANILA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Returns UTC instants bounding a calendar month in Asia/Manila. */
export function getManilaMonthRange(month: number, year: number) {
  const start = new Date(Date.UTC(year, month - 1, 1) - MANILA_UTC_OFFSET_MS);
  const end = new Date(Date.UTC(year, month, 1) - MANILA_UTC_OFFSET_MS);
  return { start, end };
}

/** Returns the current calendar month/year in Asia/Manila. */
export function getCurrentManilaMonth(now = new Date()) {
  const manilaNow = new Date(now.getTime() + MANILA_UTC_OFFSET_MS);
  return { month: manilaNow.getUTCMonth() + 1, year: manilaNow.getUTCFullYear() };
}
