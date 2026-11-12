export function eventSchedule(article) {
  const event = article.event;
  const match = event?.time
    ?.trim()
    .match(/^(\d{1,2})[:h](\d{2})\s*[-–—]\s*(\d{1,2})[:h](\d{2})$/);
  if (!match || !/^\d{4}-\d{2}-\d{2}$/.test(event.date)) return null;
  const startClock = match[1].padStart(2, "0") + ":" + match[2];
  const endClock = match[3].padStart(2, "0") + ":" + match[4];
  const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (
    !clock.test(startClock) ||
    !clock.test(endClock) ||
    endClock <= startClock
  )
    return null;
  const start = new Date(event.date + "T" + startClock + ":00+07:00");
  const end = new Date(event.date + "T" + endClock + ":00+07:00");
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()))
    return null;
  return { start, end, remindAt: new Date(start.getTime() - 30 * 60 * 1000) };
}
export function participationStatus(row, article, now) {
  if (row.checkedAt) return "attended";
  const schedule = eventSchedule(article);
  return row.registeredAt && schedule && now >= schedule.end
    ? "absent"
    : "registered";
}
