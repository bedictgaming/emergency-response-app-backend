import { MANILA_UTC_OFFSET_MS } from "@/lib/manila-calendar";

export const DAILY_CITIZEN_REPORT_LIMIT = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Returns the UTC boundaries of the calendar day in Asia/Manila. */
export function getManilaDayRange(now = new Date()) {
  const manilaNow = new Date(now.getTime() + MANILA_UTC_OFFSET_MS);
  const startMs = Date.UTC(
    manilaNow.getUTCFullYear(),
    manilaNow.getUTCMonth(),
    manilaNow.getUTCDate(),
  ) - MANILA_UTC_OFFSET_MS;

  return {
    start: new Date(startMs),
    end: new Date(startMs + DAY_MS),
  };
}

export const DAILY_REPORT_LIMIT_MESSAGE =
  'You have reached the daily limit of 2 emergency reports. You can submit again after midnight (Asia/Manila).';

export class DailyReportLimitExceeded extends Error {}
