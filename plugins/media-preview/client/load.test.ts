import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginFile, PluginFileEvent } from '@getpaseo/plugin/client';
import { observeFile, type FileState } from './load';
import { MAX_PREVIEW_BYTES } from '../shared/media';

function fixture() {
  let listener: ((event: PluginFileEvent) => void) | undefined;
  const reads: { resolve(url: string): void; reject(error: Error): void }[] = [];
  const states: FileState[] = [];
  const file = {
    size: 1024,
    extension: 'mp4',
    url() {
      return new Promise<string>((resolve, reject) => reads.push({ resolve, reject }));
    },
    watch(cb: typeof listener) {
      listener = cb;
      return () => {
        listener = undefined;
      };
    },
  } as unknown as PluginFile;
  return {
    file,
    reads,
    states,
    update: (state: FileState) => states.push(state),
    emit: (type: 'changed' | 'deleted') => listener?.({ type }),
    watching: () => !!listener,
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('large, empty and unsupported files are rejected before downloading', () => {
  for (const [size, extension, reason] of [
    [MAX_PREVIEW_BYTES + 1, 'mp4', 'large'],
    [0, 'mp3', 'empty'],
    [10, 'html', 'unsupported'],
  ] as const) {
    const f = fixture();
    Object.assign(f.file, { size, extension });
    const stop = observeFile(f.file, f.update);
    assert.equal(f.reads.length, 0);
    assert.deepEqual(f.states.at(-1), { status: 'blocked', reason });
    stop();
  }
});
test('deletion wins over a pending read and recreation reloads', async () => {
  const f = fixture(),
    stop = observeFile(f.file, f.update);
  f.emit('deleted');
  f.reads[0].resolve('blob:old');
  await flush();
  assert.deepEqual(f.states.at(-1), { status: 'blocked', reason: 'deleted' });
  f.emit('changed');
  f.reads[1].resolve('blob:new');
  await flush();
  assert.deepEqual(f.states.at(-1), { status: 'ready', url: 'blob:new' });
  stop();
});
test('latest change wins and unmount cancels updates and removes watcher', async () => {
  const f = fixture(),
    stop = observeFile(f.file, f.update);
  f.emit('changed');
  f.emit('changed');
  assert.equal(f.reads.length, 1, 'changes wait for the in-flight host read');
  f.reads[0].resolve('blob:old');
  await flush();
  assert.equal(f.reads.length, 2, 'rapid changes coalesce into one new read');
  assert.equal(
    f.states.some((s) => s.status === 'ready'),
    false,
  );
  f.reads[1].resolve('blob:new');
  await flush();
  assert.deepEqual(f.states.at(-1), { status: 'ready', url: 'blob:new' });
  f.emit('changed');
  stop();
  const count = f.states.length;
  f.reads[2].resolve('blob:unmounted');
  await flush();
  assert.equal(f.states.length, count);
  assert.equal(f.watching(), false);
});
test('files above the former limit and up to 1 GiB can be previewed', async () => {
  for (const size of [96 * 1024 * 1024, 1024 ** 3]) {
    const f = fixture();
    Object.assign(f.file, { size });
    const stop = observeFile(f.file, f.update);
    assert.equal(f.reads.length, 1);
    f.reads[0].resolve('blob:large');
    await flush();
    assert.deepEqual(f.states.at(-1), { status: 'ready', url: 'blob:large' });
    stop();
  }
});
test('deletion cancels a queued replacement read', async () => {
  const f = fixture(),
    stop = observeFile(f.file, f.update);
  f.emit('changed');
  f.emit('deleted');
  f.reads[0].resolve('blob:old');
  await flush();
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.states.at(-1), { status: 'blocked', reason: 'deleted' });
  stop();
});
test('a growing file stops playback without downloading the new large version', async () => {
  const f = fixture(),
    stop = observeFile(f.file, f.update);
  f.reads[0].resolve('blob:first');
  await flush();
  Object.assign(f.file, { size: MAX_PREVIEW_BYTES + 1 });
  f.emit('changed');
  assert.equal(f.reads.length, 1);
  assert.deepEqual(f.states.at(-1), { status: 'blocked', reason: 'large' });
  stop();
});
test('read failure can recover, and external URLs are rejected', async () => {
  const f = fixture(),
    stop = observeFile(f.file, f.update);
  f.reads[0].reject(new Error('Disconnected'));
  await flush();
  assert.deepEqual(f.states.at(-1), { status: 'error', message: 'Disconnected' });
  f.emit('changed');
  f.reads[1].resolve('https://example.com/media.mp4');
  await flush();
  assert.equal(f.states.at(-1)?.status, 'error');
  f.emit('changed');
  f.reads[2].resolve('blob:local');
  await flush();
  assert.equal(f.states.at(-1)?.status, 'ready');
  stop();
});
