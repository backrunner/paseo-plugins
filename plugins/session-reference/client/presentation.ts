import type { RpcOutput } from '@getpaseo/plugin';
import type { searchSessions } from '../shared/contracts';

type Item = RpcOutput<typeof searchSessions>['items'][number];

// Paseo 0.15.4 places the title and subtitle on one line, with a non-shrinking
// title. Bound its visual width so long CJK titles leave room in a narrow picker.
export function compactTitle(value: string, budget = 26): string {
  const clean = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const units = (ch: string) =>
    /[\p{Mark}\u200d\ufe0f]/u.test(ch)
      ? 0
      : /[MW@#%]/.test(ch)
        ? 1.5
        : ch.codePointAt(0)! > 255
          ? 2
          : 1;
  const chars = Array.from(clean);
  if (chars.reduce((n, ch) => n + units(ch), 0) <= budget) return clean;
  let result = '',
    width = 0;
  for (const ch of chars) {
    if (width + units(ch) > budget - 2) break;
    result += ch;
    width += units(ch);
  }
  return result.replace(/[\s\u200d]+$/u, '') + '…';
}

function timeLabel(timestamp: string, locale: string, now: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '';
  const elapsed = Math.max(0, now - date.getTime());
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (elapsed < 60_000) return locale.startsWith('zh') ? '刚刚' : 'Just now';
  if (elapsed < 3_600_000) return relative.format(-Math.floor(elapsed / 60_000), 'minute');
  if (elapsed < 86_400_000) return relative.format(-Math.floor(elapsed / 3_600_000), 'hour');
  if (elapsed < 7 * 86_400_000) return relative.format(-Math.floor(elapsed / 86_400_000), 'day');
  return new Intl.DateTimeFormat(locale, {
    month: 'numeric',
    day: 'numeric',
    ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' as const } : {}),
  }).format(date);
}

export function presentSession(item: Item, language: string, now = Date.now()): Item {
  let locale = language;
  try {
    new Intl.DateTimeFormat(locale);
  } catch {
    locale = 'en';
  }
  const chinese = locale.startsWith('zh');
  const title = compactTitle(item.title || (chinese ? '未命名会话' : 'Untitled conversation'));
  if (!item.details) return { ...item, title };
  const directory = item.details.cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const project = directory.split('/').at(-1) || '/';
  const subtitle = [
    compactTitle(project, 20),
    timeLabel(item.details.timestamp, locale, now),
    item.details.archived ? (chinese ? '已归档' : 'Archived') : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { ...item, title, subtitle };
}
