import { CronExpressionParser } from 'cron-parser';
import type { Config } from './types.js';

export function validTimezone(value: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format();
  } catch {
    throw new Error(
      'Choose a timezone such as Europe/London or America/Los_Angeles.',
    );
  }
  if (!value) throw new Error('Choose a timezone.');
  return value;
}
export function effectiveTimezone(
  config: Pick<Config, 'timezone'>,
  override?: string,
): string {
  return validTimezone(override || config.timezone || 'UTC');
}
export function timezoneLabel(zone: string): string {
  return zone.split('/').at(-1)!.replaceAll('_', ' ');
}
export function completedPeriod(
  at: Date,
  zone: string,
  days: number,
): { from: Date; to: Date } {
  const midnight = CronExpressionParser.parse('0 0 * * *', {
    tz: validTimezone(zone),
    currentDate: new Date(at.getTime() + 1),
  })
    .prev()
    .toDate();
  const cursor = CronExpressionParser.parse('0 0 * * *', {
    tz: zone,
    currentDate: midnight,
  });
  let from = midnight;
  for (let i = 0; i < days; i++) from = cursor.prev().toDate();
  return { from, to: midnight };
}

// GitHub contribution calendars use the date in the supplied offset timestamp.
// Preserve that offset instead of shifting the calendar boundary into a neighbouring UTC date.
export function zonedTimestamp(at: Date, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const minutes = Math.round(
    (Date.parse(local + 'Z') - Math.floor(at.getTime() / 1000) * 1000) / 60000,
  );
  const offset = `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, '0')}:${String(Math.abs(minutes) % 60).padStart(2, '0')}`;
  return local + offset;
}
