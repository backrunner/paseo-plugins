import test from 'node:test';
import assert from 'node:assert/strict';
import { localTime, parseLocalTime } from './time';

test('local schedule time round-trips and rejects rolled-over or ambiguous input formats', () => {
  const time = new Date(2026, 10, 16, 9, 30).getTime();
  assert.equal(localTime(time), '2026-11-16 09:30');
  assert.equal(parseLocalTime(localTime(time)), time);
  for (const input of [
    '2026-02-30 10:00',
    '2026-13-01 10:00',
    '2026-11-16 24:00',
    'tomorrow',
    '2026-11-16T09:30Z',
  ])
    assert.throws(() => parseLocalTime(input));
  const timezone = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.throws(() => parseLocalTime('2026-03-08 02:30'), /valid/);
    assert.throws(() => parseLocalTime('2026-11-01 01:30'), /twice/);
    assert.equal(localTime(parseLocalTime('2026-11-01 03:30')), '2026-11-01 03:30');
  } finally {
    if (timezone === undefined) delete process.env.TZ;
    else process.env.TZ = timezone;
  }
});
