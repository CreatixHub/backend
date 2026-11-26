// Today's date (YYYY-MM-DD) as the wall clock shows it in the given IANA timezone, e.g. "Asia/Kolkata".
// A school's "today" is not the server's UTC "today": at 20:00 UTC on the 24th it is already the 25th in India.
// An unknown timezone name falls back to UTC instead of throwing.
export function todayInTimezone(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}
