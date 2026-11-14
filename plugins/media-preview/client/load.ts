import type { PluginFile } from '@getpaseo/plugin/client';
import { MAX_PREVIEW_BYTES, mediaFormat } from '../shared/media';

export type FileState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'blocked'; reason: 'large' | 'empty' | 'unsupported' | 'deleted' }
  | { status: 'error'; message: string };

// Stop old reads from reviving a deleted/replaced file or an unmounted player.
// URLs belong to Paseo. The plugin must never revoke them.
export function observeFile(file: PluginFile, update: (state: FileState) => void) {
  let active = true,
    generation = 0,
    reading = false,
    pending = false;
  const load = async () => {
    if (!active) return;
    const current = ++generation;
    pending = false;
    if (!mediaFormat(file.extension)) {
      update({ status: 'blocked', reason: 'unsupported' });
      return;
    }
    if (file.size > MAX_PREVIEW_BYTES) {
      update({ status: 'blocked', reason: 'large' });
      return;
    }
    if (file.size === 0) {
      update({ status: 'blocked', reason: 'empty' });
      return;
    }
    update({ status: 'loading' });
    // The host cannot cancel file.url(). Coalesce changes instead of holding
    // several full-size transfers in memory at the same time.
    if (reading) {
      pending = true;
      return;
    }
    reading = true;
    pending = false;
    try {
      const url = await file.url();
      if (active && current === generation) {
        if (file.size > MAX_PREVIEW_BYTES) update({ status: 'blocked', reason: 'large' });
        else if (!url.startsWith('blob:'))
          update({ status: 'error', message: 'Expected a local media URL' });
        else update({ status: 'ready', url });
      }
    } catch (error) {
      if (active && current === generation)
        update({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
    } finally {
      reading = false;
      if (active && pending) void load();
    }
  };
  const unwatch = file.watch((event) => {
    if (!active) return;
    if (event.type === 'deleted') {
      generation++;
      pending = false;
      update({ status: 'blocked', reason: 'deleted' });
    } else if (event.type === 'changed') void load();
  });
  void load();
  return () => {
    active = false;
    generation++;
    unwatch();
  };
}
