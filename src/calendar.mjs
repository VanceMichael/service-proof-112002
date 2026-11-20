// 当地日历与工作日计算。只处理 YYYY-MM-DD 日期与 ±HH:MM 时区偏移。

export function parseOffsetMinutes(zone) {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(zone ?? '');
  if (!match) throw new Error(`无法识别的时区偏移: ${zone}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

function offsetOfTimestamp(timestamp) {
  const match = /([+-]\d{2}:\d{2})$/.exec(timestamp);
  return match ? parseOffsetMinutes(match[1]) : 0;
}

export function toDateString(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 送达事件的本地日期：按登记联系信息上的当地时区取日，不用录入时间、也不用 UTC 日。
export function localDateOf(timestamp, zone) {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) throw new Error(`无法识别的时间戳: ${timestamp}`);
  const offset = zone ? parseOffsetMinutes(zone) : offsetOfTimestamp(timestamp);
  return toDateString(new Date(ms + offset * 60000));
}

export function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return toDateString(date);
}

export function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isWorkday(dateStr, rule) {
  const day = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return rule.workDays.includes(day) && !(rule.holiday ?? []).includes(dateStr);
}

// 期限按送达日后 n 个工作日：从送达日次日起数 n 个工作日，节假日不计入。
export function addWorkdays(dateStr, count, rule) {
  let remaining = count;
  let cursor = dateStr;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    if (isWorkday(cursor, rule)) remaining -= 1;
  }
  return cursor;
}
