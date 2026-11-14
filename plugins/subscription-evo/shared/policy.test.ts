import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyError, quotaState, retryAfter, retryDelay } from './policy';
import { parseReport } from './model';
import { parseSend } from './commands';

test('classification never treats bare 429, auth, context or tool errors as a transient failure', () => {
  for (const error of ['HTTP 429', 'command failed', 'payment required', 'unknown error'])
    assert.equal(classifyError(error), 'unknown');
  assert.equal(classifyError('Usage limit reached'), 'quota');
  assert.equal(classifyError('401 authentication failed'), 'auth');
  assert.equal(classifyError('context window exceeded'), 'context');
  assert.equal(classifyError('ECONNRESET'), 'transient');
  assert.equal(classifyError('HTTP 503 overloaded'), 'transient');
  assert.equal(retryDelay(1, 0.5), 33_000);
  assert.equal(retryDelay(10, 0), 600_000);
  assert.equal(retryDelay(1, 0, retryAfter('Retry-After: 120')), 120_000);
});
test('quota freshness and invalid data fail closed', () => {
  const report = {
    id: 'a',
    fetchedAt: 100_000,
    available: true,
    windows: [{ id: 'all', remaining: 20 }],
  };
  assert.equal(quotaState([report], 100_000).kind, 'available');
  for (const remaining of [null, NaN, Infinity, -1, 101])
    assert.equal(
      quotaState([{ ...report, windows: [{ id: 'a', remaining }] }], 100_000).kind,
      'unknown',
    );
  for (const fetchedAt of [NaN, -50_000, 200_000])
    assert.equal(quotaState([{ ...report, fetchedAt }], 100_000).kind, 'unknown');
  assert.equal(quotaState([], 100_000).kind, 'unknown');
  assert.equal(quotaState([report, { ...report, id: 'another-account' }], 100_000).kind, 'unknown');
});
test('commands retain message separators, require timezones and validate delays', () => {
  assert.deepEqual(parseSend('idle -- hello -- world'), {
    text: 'hello -- world',
    trigger: { kind: 'idle' },
  });
  assert.deepEqual(parseSend('after-quota 2-5m -- continue').trigger, {
    kind: 'quota',
    delay: { min: 2, max: 5 },
  });
  assert.throws(() => parseSend('after-quota 5-2m -- continue'));
  assert.throws(() => parseSend('at 2026-11-16T09:30 -- continue'));
  assert.throws(() => parseSend('at 2026-02-30T09:30Z -- continue'));
  assert.equal(parseSend('at 2026-11-16T09:30:00.000Z -- continue').trigger.kind, 'at');
  assert.throws(() => parseSend('idle -- '));
});
test('goal reports must be valid, end the reply and match this goal turn', () => {
  const good =
    '<evo-report>{"nonce":"n","status":"continue","progress":"a","evidence":[]}</evo-report>';
  assert.equal(parseReport(good, 'n')?.status, 'continue');
  assert.equal(parseReport(good, 'wrong'), null);
  assert.equal(parseReport(`${good} more text`, 'n'), null);
  assert.equal(parseReport('<evo-report>not json</evo-report>', 'n'), null);
});
