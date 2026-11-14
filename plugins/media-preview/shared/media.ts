export const formats = {
  mp4: ['video', 'video/mp4'],
  m4v: ['video', 'video/mp4'],
  webm: ['video', 'video/webm'],
  mov: ['video', 'video/quicktime'],
  ogv: ['video', 'video/ogg'],
  mp3: ['audio', 'audio/mpeg'],
  wav: ['audio', 'audio/wav'],
  m4a: ['audio', 'audio/mp4'],
  aac: ['audio', 'audio/aac'],
  ogg: ['audio', 'audio/ogg'],
  oga: ['audio', 'audio/ogg'],
  opus: ['audio', 'audio/ogg'],
  flac: ['audio', 'audio/flac'],
  aif: ['audio', 'audio/aiff'],
  aiff: ['audio', 'audio/aiff'],
} as const;
export type MediaKind = 'audio' | 'video';
// file.url() downloads the entire file, including on a remote host.
export const MAX_PREVIEW_BYTES = 1024 * 1024 * 1024;
export function mediaFormat(extension: string) {
  const key = extension.replace(/^\./, '').toLowerCase();
  return Object.hasOwn(formats, key) ? formats[key as keyof typeof formats] : undefined;
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${Number((bytes / 1024 ** 3).toFixed(2))} GiB`;
}
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const whole = Math.floor(seconds),
    s = String(whole % 60).padStart(2, '0');
  const minutes = Math.floor(whole / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${s}`
    : `${minutes}:${s}`;
}
