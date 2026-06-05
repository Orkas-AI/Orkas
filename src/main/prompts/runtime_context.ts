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

export function formatCurrentDatetime(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${formatOffset(date.getTimezoneOffset())}`;
}

export function getRuntimeTimezone(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return tz || `UTC${formatOffset(new Date().getTimezoneOffset())}`;
}

export function buildRuntimeDatetimeBlock(date = new Date()): string {
  const currentDatetime = formatCurrentDatetime(date);
  return [
    '## Current datetime',
    '',
    `Current datetime: ${currentDatetime}`,
    `Timezone: ${getRuntimeTimezone()}`,
  ].join('\n');
}
