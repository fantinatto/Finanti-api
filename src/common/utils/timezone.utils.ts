function getUTCOffsetMinutes(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parseInt(parts.find(p => p.type === t)!.value);
  const h = get('hour') % 24; // guard against midnight returning 24
  const tzDate = new Date(Date.UTC(get('year'), get('month') - 1, get('day'), h, get('minute'), get('second')));
  return (tzDate.getTime() - date.getTime()) / 60_000;
}

export function tz_formatHHmm(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function tz_toMinuteOfDay(date: Date, tz: string): number {
  const [h, m] = tz_formatHHmm(date, tz).split(':').map(Number);
  return h * 60 + m;
}

export function tz_dateStr(date: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date);
}

export function tz_hhmm2utc(dateStr: string, hhmm: string, tz: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  const noon = new Date(`${dateStr}T12:00:00Z`);
  const offsetMin = getUTCOffsetMinutes(noon, tz);
  const [y, mo, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h, m, 0) - offsetMin * 60_000);
}

export function tz_startOfDay(date: Date, tz: string): Date {
  const dateStr = tz_dateStr(date, tz);
  return tz_hhmm2utc(dateStr, '00:00', tz);
}
