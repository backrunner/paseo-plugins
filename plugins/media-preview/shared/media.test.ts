import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTime, mediaFormat } from './media';

test('format selection is case insensitive and does not match inherited keys', () => {
  assert.deepEqual(mediaFormat('.MP4'), ['video', 'video/mp4']);
  assert.deepEqual(mediaFormat('OpUs'), ['audio', 'audio/ogg']);
  assert.equal(mediaFormat('constructor'), undefined);
  assert.equal(mediaFormat('html'), undefined);
});
test('metadata handles unknown durations and hours', () => {
  assert.equal(formatTime(Infinity), '—');
  assert.equal(formatTime(NaN), '—');
  assert.equal(formatTime(-1), '—');
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(3661.9), '1:01:01');
});
