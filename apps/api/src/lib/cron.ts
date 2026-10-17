/** Minimal five-field cron matching (minute hour day month weekday, UTC) for the built-in scheduler. */

function fieldMatches(field: string, value: number, min: number, max: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepText] = part.split("/") as [string, string | undefined];
    const step = stepText ? Number(stepText) : 1;
    if (!Number.isInteger(step) || step < 1) return false;
    let lo = min;
    let hi = max;
    if (range !== "*") {
      const [a, b] = range.split("-");
      lo = Number(a);
      hi = b === undefined ? (stepText ? max : lo) : Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return false;
    }
    return value >= lo && value <= hi && (value - lo) % step === 0;
  });
}

/** Does `expression` fire at this minute? Day-of-month and weekday combine with AND (fine for our schedules). */
export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const dow = date.getUTCDay();
  return (
    fieldMatches(minute, date.getUTCMinutes(), 0, 59) &&
    fieldMatches(hour, date.getUTCHours(), 0, 23) &&
    fieldMatches(day, date.getUTCDate(), 1, 31) &&
    fieldMatches(month, date.getUTCMonth() + 1, 1, 12) &&
    (fieldMatches(weekday, dow, 0, 7) || (dow === 0 && fieldMatches(weekday, 7, 0, 7)))
  );
}
