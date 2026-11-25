export type ErrorKind = 'quota' | 'transient' | 'auth' | 'context' | 'unknown';
export function classifyError(message: string, code = ''): ErrorKind {
  const value = `${code} ${message}`.toLowerCase();
  if (
    /unauthori[sz]ed|authentication|invalid.?api.?key|token.{0,8}expired|\b401\b|\b403\b/.test(
      value,
    )
  )
    return 'auth';
  if (
    /usage[_ -]?limit|quota[_ -]?(exceeded|exhausted)|insufficient[_ -]quota|out of credits|subscription limit|hit your limit.{0,120}reset|额度.{0,8}(用尽|耗尽|上限)/.test(
      value,
    )
  )
    return 'quota';
  if (/context.{0,12}(length|window|limit)|too many tokens/.test(value)) return 'context';
  if (
    /econnreset|etimedout|eai_again|socket hang up|network error|connection reset|timed out|request timeout|temporarily unavailable|internal server error|overloaded|\b50[0234]\b/.test(
      value,
    )
  )
    return 'transient';
  // A bare 429 has no trustworthy subscription/throughput distinction.
  return 'unknown';
}
export function retryDelay(attempt: number, random: number, retryAfterMs = 0) {
  return Math.max(
    retryAfterMs,
    Math.min(600_000, 30_000 * 2 ** Math.max(0, attempt - 1)) *
      (1 + Math.max(0, Math.min(1, random)) * 0.2),
  );
}
export function retryAfter(message: string): number {
  const m = /retry[- ]after\s*[:=]?\s*(\d+)\s*(s|seconds?)?\b/i.exec(message);
  return m ? Math.min(86_400_000, Number(m[1]) * 1000) : 0;
}
export interface QuotaReport {
  id: string;
  fetchedAt: number;
  available: boolean;
  problem?: 'auth' | 'unavailable';
  windows: { id: string; remaining: number | null }[];
}
export function quotaState(reports: QuotaReport[], now: number, requiredWindows: string[] = []) {
  const ids = reports.map((r) => r.id).sort();
  if (reports.some((r) => !r.available && r.problem === 'auth'))
    return { kind: 'unknown' as const, ids, reason: 'quota-auth' };
  if (
    reports.length !== 1 ||
    reports.some(
      (r) =>
        !r.available ||
        !r.id.trim() ||
        !Number.isFinite(r.fetchedAt) ||
        now - r.fetchedAt > 120_000 ||
        r.fetchedAt > now + 30_000 ||
        !r.windows.length ||
        new Set(r.windows.map((w) => w.id)).size !== r.windows.length ||
        r.windows.some(
          (w) =>
            !w.id.trim() ||
            w.remaining === null ||
            !Number.isFinite(w.remaining) ||
            w.remaining < 0 ||
            w.remaining > 100,
        ),
    )
  )
    return { kind: 'unknown' as const, ids, reason: 'quota-unknown' };
  const windowIds = reports[0]!.windows.map((w) => w.id).sort();
  if (requiredWindows.some((id) => !windowIds.includes(id)))
    return { kind: 'unknown' as const, ids, reason: 'quota-windows-missing' };
  return {
    kind: reports.some((r) => r.windows.some((w) => w.remaining! <= 0))
      ? ('exhausted' as const)
      : ('available' as const),
    ids,
    windowIds,
  };
}
