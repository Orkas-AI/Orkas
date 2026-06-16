function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatOffset(minutesBehindUtc: number): string {
  const total = -minutesBehindUtc;
  const sign = total >= 0 ? '+' : '-';
  const abs = Math.abs(total);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  return `${sign}${pad2(hours)}:${pad2(minutes)}`;
}

export function formatCurrentDate(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  return `${yyyy}-${mm}-${dd}`;
}

export function getRuntimeTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz || `UTC${formatOffset(new Date().getTimezoneOffset())}`;
}

export function buildRuntimeDatetimeBlock(date = new Date()): string {
  const currentDate = formatCurrentDate(date);
  return [
    '## Current date',
    '',
    `Timezone: ${getRuntimeTimezone()}`,
    `Current date: ${currentDate}`,
  ].join('\n');
}
