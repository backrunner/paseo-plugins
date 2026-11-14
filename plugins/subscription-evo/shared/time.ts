/** Local wall time for the compact editor; slash commands keep their explicit ISO timezone. */
export function localTime(value: number) {
  const date = new Date(value);
  const part = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}`;
}
export function parseLocalTime(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error('Use YYYY-MM-DD HH:mm');
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(year!, month! - 1, day!, hour!, minute!);
  // Reject rollover, including nonexistent local times at a daylight-saving transition.
  if (
    date.getFullYear() !== year ||
    date.getMonth() + 1 !== month ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  )
    throw new Error('Choose a valid local date and time');
  const offsets = [new Date(date.getTime() - 86_400_000), new Date(date.getTime() + 86_400_000)];
  for (const neighbor of offsets) {
    const difference = neighbor.getTimezoneOffset() - date.getTimezoneOffset();
    if (difference && localTime(date.getTime() + difference * 60_000) === localTime(date.getTime()))
      throw new Error('This local time occurs twice. Choose a time outside the clock change.');
  }
  return date.getTime();
}
