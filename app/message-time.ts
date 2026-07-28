const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export function formatMessageTime(value: Date | string, now = new Date()): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return "";

  const dayDifference = localCalendarDay(now) - localCalendarDay(date);
  if (dayDifference === 0) {
    return formatClockTime(date);
  }
  if (dayDifference === 1) return `昨天 ${formatClockTime(date)}`;
  if (dayDifference === 2) return `前天 ${formatClockTime(date)}`;

  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${formatClockTime(date)}`;
}

export function formatMessageTimeTitle(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localCalendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_IN_MILLISECONDS;
}

function formatClockTime(date: Date): string {
  return date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
