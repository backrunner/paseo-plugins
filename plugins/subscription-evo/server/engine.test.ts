import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PluginHookPayload } from '@getpaseo/plugin/server';
import { Engine } from './engine';
import { Store } from './store';
import { PreconditionChanged, fingerprint, idle, type Agent, type Bridge } from './bridge';
import { freshPolicy, State, type Policy, type Trigger } from '../shared/model';
import type { QuotaReport } from '../shared/policy';

/** No sockets, real provider, Paseo home, or child process is used by this fixture. */
class SimulatedDaemon implements Bridge {
  agent: Agent = {
    id: 'agent-1',
    provider: 'codex',
    model: 'test',
    persistence: null,
    lastUserMessageAt: null,
    pendingPermissions: [],
    status: 'idle',
    activeTurn: null,
    archivedAt: null,
    cwd: '/fixture',
    internal: false,
    createdAt: '2026-11-15T00:00Z',
    updatedAt: '2026-11-15T00:00Z',
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    },
    currentModeId: null,
    availableModes: [],
    title: null,
    labels: {},
  };
  sent: { id: string; text: string }[] = [];
  reports: QuotaReport[] = [];
  latest = '';
  text = '';
  sendError = false;
  snapshotError = false;
  usageCalls = 0;
  beforeSend: (() => void) | null = null;
  onSnapshot: (() => Promise<void>) | null = null;
  closed = false;
  constructor(readonly clock: () => number) {}
  async snapshot() {
    if (this.snapshotError) throw new Error('Disconnected');
    await this.onSnapshot?.();
    return structuredClone(this.agent);
  }
  async usage() {
    this.usageCalls++;
    return structuredClone(this.reports);
  }
  async turnText() {
    return this.text;
  }
  async hasMessage(_agentId: string, id: string) {
    return this.sent.some((s) => s.id === id);
  }
  async latestIs(_agentId: string, id: string) {
    return this.latest === id;
  }
  async send(_agentId: string, text: string, id: string, expected: Agent, allowed: () => boolean) {
    this.beforeSend?.();
    if (!allowed() || !idle(this.agent) || fingerprint(expected) !== fingerprint(this.agent))
      throw new PreconditionChanged();
    if (!this.sent.some((s) => s.id === id)) this.sent.push({ id, text });
    this.latest = id;
    this.agent.lastUserMessageAt = new Date(this.clock()).toISOString();
    this.agent.status = 'running';
    if (this.sendError) throw new Error('Response lost after acceptance');
  }
  async close() {
    this.closed = true;
  }
  quota(remaining: number, id = 'account-1') {
    this.reports = [
      { id, fetchedAt: this.clock(), available: true, windows: [{ id: 'weekly', remaining }] },
    ];
  }
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'evo-simulation-'));
  let clock = Date.parse('2026-11-15T00:00Z');
  const store = new Store(directory);
  await store.open();
  const daemon = new SimulatedDaemon(() => clock);
  let engine = new Engine(
    store,
    daemon,
    () => clock,
    () => 0.5,
  );
  t.after(async () => {
    await engine.stop();
    await rm(directory, { recursive: true, force: true });
  });
  const id = daemon.agent.id;
  const add = (
    trigger: Trigger = { kind: 'idle' },
    text = 'hello',
    requestId: string = randomUUID(),
  ) => engine.add({ agentId: id, trigger, text, requestId });
  const policy = (values: Partial<Policy> = {}) =>
    engine.save({
      agentId: id,
      revision: store.state.revision,
      values: { ...(store.state.policies[id] ?? freshPolicy()), nativeGoalOff: true, ...values },
    });
  const ready = async () => {
    await engine.tick();
    clock += 2500;
    await engine.tick();
  };
  const end = async (
    kind: 'completed' | 'failed' | 'canceled',
    message = '503 overloaded',
    turnId = randomUUID(),
  ) => {
    daemon.agent.status = kind === 'failed' ? 'error' : 'idle';
    const outcome =
      kind === 'failed'
        ? { kind, error: { message } }
        : kind === 'canceled'
          ? { kind, reason: 'user' }
          : { kind };
    await engine.ended({
      agent: { id, provider: 'codex' },
      turnId,
      outcome,
    } as PluginHookPayload<'agent.turn.after'>);
    return turnId;
  };
  return {
    store,
    daemon,
    directory,
    get engine() {
      return engine;
    },
    id,
    add,
    policy,
    ready,
    end,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
    restart: async () => {
      await engine.stop();
      const next = new Store(directory);
      await next.open();
      engine = new Engine(
        next,
        daemon,
        () => clock,
        () => {
          throw new Error('Delay must not be sampled twice');
        },
      );
      return next;
    },
  };
}

test('scheduling authorizes one message atomically, keeps automation off and deduplicates after pause', async (t) => {
  const f = await fixture(t);
  const input = {
    agentId: f.id,
    text: 'scheduled once',
    requestId: 'schedule-1',
    trigger: { kind: 'at' as const, at: f.now() + 60_000 },
    allowDelivery: true,
  };
  const created = await f.engine.add(input);
  const job = f.store.state.jobs[0]!;
  assert.equal(job.manual, true);
  assert.equal(f.store.state.policies[f.id]!.automatic, false);
  assert.equal(f.store.state.policies[f.id]!.retry, false);
  assert.equal(f.store.state.policies[f.id]!.quotaResume, false);
  assert.equal(f.store.state.policies[f.id]!.goal, null);
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  await f.engine.edit({
    agentId: f.id,
    id: created.id,
    revision: f.store.state.jobs[0]!.revision,
    action: 'pause',
  });
  assert.deepEqual(await f.engine.add(input), created);
  assert.equal(f.store.state.jobs.length, 1);
  assert.equal(f.store.state.jobs[0]!.manual, false, 'Retry cannot restore revoked authorization');
  await assert.rejects(f.engine.add({ ...input, allowDelivery: false }), /different content/);
  const current = f.store.state.jobs[0]!;
  await f.engine.edit({
    agentId: f.id,
    id: current.id,
    revision: current.revision,
    action: 'release',
  });
  f.advance(60_000);
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
  assert.equal(f.daemon.sent[0]!.text, input.text);
  await f.end('completed');
  await f.add({ kind: 'idle' }, 'still queue only');
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
});

test('queue-only default, explicit one-message delivery and strict FIFO', async (t) => {
  const f = await fixture(t);
  const first = await f.add({ kind: 'at', at: f.now() + 60_000 });
  await f.add();
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  await f.policy({ automatic: true });
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  f.advance(60_000);
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
  assert.equal(f.store.state.jobs.find((j) => j.id === first.id)?.status, 'sent');
  await f.engine.tick();
  assert.equal(f.daemon.sent.length, 1, 'Never interrupt a running turn');
});

test('submission distinguishes rejection before a write from uncertain storage failures', async (t) => {
  const f = await fixture(t);
  const input = {
    agentId: f.id,
    text: 'review',
    requestId: 'review-request',
    trigger: { kind: 'at' as const, at: f.now() - 1 },
  };
  assert.ok('rejected' in (await f.engine.submit(input)));
  assert.equal(f.store.state.jobs.length, 0);
  f.daemon.snapshotError = true;
  assert.ok('rejected' in (await f.engine.submit({ ...input, trigger: { kind: 'idle' } })));
  assert.equal(f.store.state.jobs.length, 0);
  f.daemon.snapshotError = false;
  f.store.fault = 'uncertain write';
  await assert.rejects(f.engine.submit({ ...input, trigger: { kind: 'idle' } }), /uncertain write/);
});

test('explicit queue-without-sending remains held even when the session already has automatic delivery on', async (t) => {
  const f = await fixture(t);
  await f.policy({ automatic: true });
  const input = {
    agentId: f.id,
    text: 'hold this',
    requestId: 'held',
    trigger: { kind: 'idle' as const },
    allowDelivery: false,
  };
  const created = await f.engine.add(input);
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  assert.equal(f.store.state.jobs[0]!.paused, true);
  assert.deepEqual(await f.engine.add(input), created);
  const job = f.store.state.jobs[0]!;
  await f.engine.edit({ agentId: f.id, id: job.id, revision: job.revision, action: 'release' });
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
});
test('all automation defaults off and events from existing unmanaged sessions remain inert', async (t) => {
  const f = await fixture(t);
  const defaults = freshPolicy();
  assert.equal(defaults.automatic, false);
  assert.equal(defaults.retry, false);
  assert.equal(defaults.quotaResume, false);
  assert.equal(defaults.goal, null);
  for (const message of ['503 overloaded', 'usage limit reached']) {
    await f.end('failed', message);
    await f.ready();
  }
  assert.deepEqual(f.store.state.policies, {});
  assert.equal(f.store.state.jobs.length, 0);
  assert.equal(f.daemon.sent.length, 0);
  assert.equal(f.daemon.usageCalls, 0);
});

test('single-message permission preserves its time condition', async (t) => {
  const f = await fixture(t);
  const { id } = await f.add({ kind: 'at', at: f.now() + 60_000 });
  await f.engine.edit({ agentId: f.id, id, revision: 0, action: 'release' });
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  f.advance(60_000);
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
});

test('idempotent adds, conflicting requests and stale edits', async (t) => {
  const f = await fixture(t);
  const first = await f.add({ kind: 'idle' }, 'one', 'request');
  assert.deepEqual(await f.add({ kind: 'idle' }, 'one', 'request'), first);
  await assert.rejects(f.add({ kind: 'idle' }, 'two', 'request'), /different content/);
  await f.engine.edit({ agentId: f.id, id: first.id, revision: 0, action: 'pause' });
  await assert.rejects(
    f.engine.edit({ agentId: f.id, id: first.id, revision: 0, action: 'cancel' }),
    /changed/,
  );
  assert.equal(f.store.state.jobs.length, 1);
});

test('quota requires fresh positive values in every window and persists random delay', async (t) => {
  const f = await fixture(t);
  await f.add({ kind: 'quota', delay: { min: 2, max: 4 } });
  await f.policy({ automatic: true });
  f.daemon.quota(0);
  await f.engine.tick();
  assert.equal(f.store.state.jobs[0].dueAt, null);
  f.advance(60_000);
  f.daemon.quota(50);
  f.daemon.reports[0].windows.push({ id: 'daily', remaining: 0 });
  await f.engine.tick();
  assert.equal(f.store.state.jobs[0].dueAt, null);
  f.advance(60_000);
  f.daemon.quota(50);
  await f.engine.tick();
  const due = f.store.state.jobs[0].dueAt!;
  assert.equal(due, f.now() + 180_000);
  const nextStore = await f.restart();
  assert.equal(nextStore.state.jobs[0].dueAt, due);
  f.advance(180_000);
  f.daemon.quota(50);
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
  assert.equal(nextStore.state.jobs[0].sampledDelayMs, 180_000);
});

test('quota unknown, stale, and changed account never authorize delivery', async (t) => {
  const f = await fixture(t);
  await f.add({ kind: 'quota', delay: { min: 0, max: 0 } });
  await f.policy({ automatic: true });
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  f.advance(60_000);
  f.daemon.quota(0);
  await f.engine.tick();
  f.advance(180_000);
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  f.advance(60_000);
  f.daemon.quota(80, 'other-account');
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  assert.equal(f.store.state.policies[f.id].paused, true);
});

test('failed usage reads are rate limited and do not become recovery', async (t) => {
  const f = await fixture(t);
  await f.add({ kind: 'quota', delay: { min: 0, max: 0 } });
  await f.policy({ automatic: true });
  f.daemon.usage = async () => {
    f.daemon.usageCalls++;
    throw new Error('offline');
  };
  await f.ready();
  await f.ready();
  assert.equal(f.daemon.usageCalls, 1);
  assert.equal(f.daemon.sent.length, 0);
});

test('a quota failure holds existing user messages without changing their text or adding duplicate continue', async (t) => {
  const f = await fixture(t);
  const scheduled = f.now() + 600_000;
  await f.add({ kind: 'at', at: scheduled }, 'review the result');
  await f.policy({ automatic: true, quotaResume: true, delay: { min: 1, max: 1 } });
  await f.end('failed', 'usage limit reached');
  assert.equal(f.store.state.jobs.length, 1);
  assert.equal(f.store.state.jobs[0].quotaHold, true);
  f.daemon.quota(0);
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  f.advance(60_000);
  f.daemon.quota(80);
  await f.engine.tick();
  assert.equal(f.store.state.jobs[0].dueAt, scheduled, 'Original later schedule remains effective');
  f.advance(600_000);
  f.daemon.quota(80);
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
  assert.equal(f.daemon.sent[0].text, 'review the result');
});

test('queue-only mode observes quota recovery but does not send without explicit approval', async (t) => {
  const f = await fixture(t);
  await f.add({ kind: 'quota', delay: { min: 1, max: 1 } });
  f.daemon.quota(0);
  await f.engine.tick();
  f.advance(60_000);
  f.daemon.quota(70);
  await f.engine.tick();
  const due = f.store.state.jobs[0].dueAt;
  assert.equal(due, f.now() + 60_000);
  f.advance(60_000);
  f.daemon.quota(70);
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  const job = f.store.state.jobs[0];
  await f.engine.edit({ agentId: f.id, id: job.id, revision: job.revision, action: 'release' });
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
  assert.equal(f.store.state.jobs[0].dueAt, due);
});

test('authentication failure with queued user content pauses instead of draining the queue', async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.policy({ automatic: true });
  await f.end('failed', '401 unauthorized');
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  assert.equal(f.store.state.policies[f.id].paused, true);
});

test('a positive report from before the latest quota failure cannot release queued messages', async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.policy({ automatic: true, quotaResume: true });
  f.daemon.quota(80);
  f.advance(30_000);
  await f.end('failed', 'usage limit reached');
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  assert.equal(f.store.state.jobs[0].dueAt, null);
  assert.equal(f.store.state.jobs[0].wait, 'quota-unknown');
});

test('bounded transient retries deduplicate hooks and quota uses recovery path', async (t) => {
  const f = await fixture(t);
  await f.policy({ automatic: true, retry: true, quotaResume: true, maxRetries: 2 });
  const turn = await f.end('failed');
  await f.end('failed', '503 overloaded', turn);
  assert.equal(f.store.state.jobs.length, 1);
  assert.equal(f.store.state.jobs[0].dueAt, f.now() + 33_000);
  f.advance(40_000);
  await f.ready();
  await f.end('failed', 'quota exhausted');
  assert.equal(f.store.state.jobs[1].trigger.kind, 'quota');
  f.daemon.quota(70);
  await f.engine.tick();
  f.advance(300_000);
  f.daemon.quota(70);
  await f.ready();
  await f.end('failed');
  assert.equal(f.store.state.policies[f.id].paused, true);
  assert.equal(f.store.state.jobs.filter((j) => j.status === 'queued').length, 0);
});

test('manual input, permission requests, provider changes and cancellation stop delivery', async (t) => {
  for (const mutation of ['input', 'permission', 'provider', 'cancel'] as const) {
    const f = await fixture(t);
    await f.add();
    await f.policy({ automatic: true });
    await f.engine.tick();
    if (mutation === 'input')
      f.daemon.agent.lastUserMessageAt = new Date(f.now() + 1).toISOString();
    if (mutation === 'permission')
      f.daemon.agent.pendingPermissions = [{ id: 'permission' }] as Agent['pendingPermissions'];
    if (mutation === 'provider') f.daemon.agent.model = 'other';
    if (mutation === 'cancel') await f.end('canceled');
    f.advance(3000);
    await f.engine.tick();
    assert.equal(f.daemon.sent.length, 0, mutation);
  }
});

test('pre-send race and a queued edit invalidate delivery without an ambiguous resend', async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.policy({ automatic: true });
  f.daemon.beforeSend = () => {
    f.daemon.agent.status = 'running';
  };
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  assert.equal(f.store.state.jobs[0].status, 'queued');
  f.daemon.agent.status = 'idle';
  f.daemon.beforeSend = () => f.engine.fence();
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
});

test('editing holds one queued message durably and preserves its place and quota timing', async (t) => {
  const f = await fixture(t);
  await f.add({ kind: 'quota', delay: { min: 2, max: 5 } }, 'original');
  await f.add({ kind: 'idle' }, 'second');
  await f.policy({ automatic: true });
  await f.store.change((s) =>
    Object.assign(s.jobs[0], {
      dueAt: f.now() + 210_000,
      sampledDelayMs: 210_000,
      sawExhausted: true,
      quotaIds: ['account-1'],
    }),
  );
  const original = structuredClone(f.store.state.jobs[0]);
  const held = await f.engine.edit({
    agentId: f.id,
    id: original.id,
    revision: original.revision,
    action: 'begin-edit',
  });
  assert.equal(held.job.paused, true);
  assert.equal(held.job.manual, false);
  f.advance(240_000);
  await f.ready();
  assert.equal(
    f.daemon.sent.length,
    0,
    'Neither the original nor a later FIFO item escapes while editing',
  );
  const saved = await f.engine.revise({
    agentId: f.id,
    id: original.id,
    revision: held.job.revision,
    action: 'edit',
    requestId: 'edit-1',
    text: 'revised',
    trigger: original.trigger,
    allowDelivery: false,
  });
  assert.ok('ok' in saved);
  assert.equal(f.store.state.jobs[0].id, original.id);
  assert.equal(f.store.state.jobs[0].text, 'revised');
  assert.equal(f.store.state.jobs[0].sampledDelayMs, original.sampledDelayMs);
  assert.equal(f.store.state.jobs[0].dueAt, original.dueAt);
  assert.deepEqual(f.store.state.jobs[0].quotaIds, original.quotaIds);
  const reopened = await f.restart();
  assert.equal(reopened.state.jobs[0].paused, true);
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
});

test('an acknowledged edit or lost acknowledgement can be retried without restoring delivery authorization', async (t) => {
  const f = await fixture(t);
  await f.add();
  const j = f.store.state.jobs[0];
  const held = await f.engine.edit({
    agentId: f.id,
    id: j.id,
    revision: j.revision,
    action: 'begin-edit',
  });
  const input = {
    agentId: f.id,
    id: j.id,
    revision: held.job.revision,
    action: 'edit' as const,
    requestId: 'edit-once',
    text: 'one revised message',
    trigger: { kind: 'idle' as const },
    allowDelivery: true,
  };
  await f.engine.revise(input);
  const rev = f.store.state.jobs[0].revision;
  await f.engine.revise(input);
  assert.equal(f.store.state.jobs[0].revision, rev);
  assert.equal(f.store.state.policies[f.id].automatic, false);
  await f.engine.edit({ agentId: f.id, id: j.id, revision: rev, action: 'pause' });
  await f.engine.revise(input);
  assert.equal(f.store.state.jobs[0].manual, false);
  assert.equal(f.store.state.jobs[0].paused, true);
  assert.ok('rejected' in (await f.engine.revise({ ...input, text: 'different payload' })));
  const reopened = await f.restart();
  await f.engine.revise(input);
  assert.equal(reopened.state.jobs[0].manual, false);
  await f.engine.edit({
    agentId: f.id,
    id: j.id,
    revision: reopened.state.jobs[0].revision,
    action: 'release',
  });
  await f.ready();
  assert.equal(f.daemon.sent[0].text, input.text);
  await f.engine.revise(input);
  assert.equal(f.daemon.sent.length, 1);
  assert.equal(reopened.state.jobs[0].status, 'sent');
});

test('rescheduling updates expiry, rejects stale edits, and does not reset an unchanged elapsed time', async (t) => {
  const f = await fixture(t);
  await f.add({ kind: 'at', at: f.now() + 60_000 });
  const j = f.store.state.jobs[0];
  const held = await f.engine.edit({ agentId: f.id, id: j.id, revision: 0, action: 'begin-edit' });
  const input = {
    agentId: f.id,
    id: j.id,
    revision: held.job.revision,
    action: 'edit' as const,
    requestId: 'edit-time',
    text: 'changed',
    trigger: j.trigger,
    allowDelivery: false,
  };
  assert.ok('rejected' in (await f.engine.revise({ ...input, revision: 0 })));
  f.advance(120_000);
  assert.ok('ok' in (await f.engine.revise(input)));
  const at = f.now() + 30 * 86_400_000;
  assert.ok(
    'ok' in
      (await f.engine.revise({
        ...input,
        requestId: 'edit-time-2',
        revision: f.store.state.jobs[0].revision,
        trigger: { kind: 'at', at },
      })),
  );
  assert.equal(f.store.state.jobs[0].dueAt, at);
  assert.ok(f.store.state.jobs[0].expiresAt > at);
});

test('withdrawing during an idle check fences delivery and retains the original in history', async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.policy({ automatic: true });
  await f.engine.tick();
  f.advance(2500);
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => {
    entered = r;
  });
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.daemon.onSnapshot = async () => {
    entered();
    await gate;
  };
  const tick = f.engine.tick();
  await reached;
  const j = f.store.state.jobs[0];
  const withdrawal = f.engine.edit({
    agentId: f.id,
    id: j.id,
    revision: j.revision,
    action: 'withdraw',
  });
  release();
  await tick;
  await withdrawal;
  f.daemon.onSnapshot = null;
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  assert.equal(f.store.state.jobs[0].status, 'canceled');
  assert.equal(f.store.state.jobs[0].wait, 'withdrawn');
  assert.equal(f.store.state.jobs[0].text, 'hello');
});

test('only unsent messages can be withdrawn or opened for editing, and identities stay scoped', async (t) => {
  const f = await fixture(t);
  await f.add();
  const j = f.store.state.jobs[0];
  await assert.rejects(
    f.engine.edit({ agentId: 'other', id: j.id, revision: 0, action: 'withdraw' }),
    /Queue changed/,
  );
  for (const status of ['dispatching', 'unknown', 'sent', 'canceled', 'expired'] as const) {
    await f.store.change((s) => {
      s.jobs[0].status = status;
    });
    for (const action of ['withdraw', 'begin-edit'] as const)
      await assert.rejects(
        f.engine.edit({ agentId: f.id, id: j.id, revision: 0, action }),
        /already being delivered/,
      );
  }
  assert.equal(f.daemon.sent.length, 0);
});

test('lost send acknowledgement is not resent, and later messages stay blocked', async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.add();
  await f.policy({ automatic: true });
  f.daemon.sendError = true;
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
  assert.equal(f.store.state.jobs[0].status, 'unknown');
  await f.engine.tick();
  assert.equal(f.store.state.jobs[0].status, 'sent');
  assert.equal(f.store.state.policies[f.id].paused, true);
  assert.equal(f.daemon.sent.length, 1);
});

test('crash after persisting dispatch state recovers as unknown and does not resend', async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.policy({ automatic: true });
  await f.store.change((s) => {
    s.jobs[0].status = 'dispatching';
    s.jobs[0].frozenText = s.jobs[0].text;
  });
  const next = await f.restart();
  assert.equal(next.state.jobs[0].status, 'unknown');
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
});

test('a clean reload preserves every queued task, its order, conditions, authorization and policy', async (t) => {
  const f = await fixture(t);
  await f.engine.add({
    agentId: f.id,
    text: 'scheduled',
    requestId: 'timed',
    trigger: { kind: 'at', at: f.now() + 60_000 },
    allowDelivery: true,
  });
  await f.engine.add({
    agentId: f.id,
    text: 'waiting for quota',
    requestId: 'quota',
    trigger: { kind: 'quota', delay: { min: 2, max: 5 } },
    allowDelivery: true,
  });
  await f.engine.add({
    agentId: f.id,
    text: 'keep paused',
    requestId: 'paused',
    trigger: { kind: 'idle' },
    allowDelivery: false,
  });
  await f.store.change((s) =>
    Object.assign(s.jobs[1], {
      quotaIds: ['subscription-a'],
      sawExhausted: true,
      quotaObservedAt: f.now(),
      sampledDelayMs: 210_000,
      dueAt: f.now() + 210_000,
    }),
  );
  // Compare the durable contract; add's input-only allowDelivery is not a Job field.
  const before = State.parse(f.store.state);
  const persisted = await readFile(join(f.directory, 'state.json'), 'utf8');
  const next = await f.restart();
  assert.deepEqual(next.state, before);
  assert.equal(
    await readFile(join(f.directory, 'state.json'), 'utf8'),
    persisted,
    'Reload does not rewrite a settled queue',
  );
  await f.ready();
  assert.equal(f.daemon.sent.length, 0, 'A reload does not accelerate scheduled work');
  f.advance(60_000);
  await f.ready();
  assert.equal(f.daemon.sent.length, 1);
  assert.equal(f.daemon.sent[0].text, 'scheduled');
  assert.equal(next.state.jobs[0].messageId, before.jobs[0].messageId);
  assert.equal(next.state.jobs[1].dueAt, before.jobs[1].dueAt);
  assert.equal(next.state.jobs[1].sampledDelayMs, before.jobs[1].sampledDelayMs);
  assert.equal(next.state.jobs[2].paused, true);
});

test('a clean reload retains a goal budget and progress without creating another continuation', async (t) => {
  const f = await fixture(t);
  await f.policy({ automatic: true, retry: true, quotaResume: true });
  await f.engine.goal({
    agentId: f.id,
    revision: f.store.state.revision,
    action: 'create',
    objective: 'Finish the existing task',
    maxTurns: 8,
    hours: 2,
    nativeGoalOff: true,
  });
  await f.store.change((s) => {
    Object.assign(s.policies[f.id].goal!, {
      turns: 3,
      progress: 'Existing progress',
      evidence: ['Saved evidence'],
    });
    s.jobs[0].dueAt = f.now() + 300_000;
  });
  const before = structuredClone(f.store.state);
  const next = await f.restart();
  assert.deepEqual(next.state, before);
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  assert.equal(next.state.jobs.length, before.jobs.length);
  assert.deepEqual(next.state.policies[f.id].goal, before.policies[f.id].goal);
});

test('goal report nonce, progress, completion evidence and turn budget', async (t) => {
  const f = await fixture(t);
  await f.policy({ automatic: true });
  await assert.rejects(
    f.engine.goal({
      agentId: f.id,
      revision: f.store.state.revision,
      action: 'create',
      objective: 'Build',
      maxTurns: 2,
      hours: 1,
      nativeGoalOff: false,
    }),
    /native/,
  );
  await f.engine.goal({
    agentId: f.id,
    revision: f.store.state.revision,
    action: 'create',
    objective: 'Build',
    maxTurns: 2,
    hours: 1,
    nativeGoalOff: true,
  });
  await f.ready();
  const report = (status: string, evidence: string[] = []) => {
    f.daemon.text = `<evo-report>${JSON.stringify({ nonce: f.store.state.policies[f.id].goal!.nonce, status, progress: 'Tests added', evidence })}</evo-report>`;
  };
  report('continue');
  await f.end('completed');
  await f.ready();
  assert.equal(f.daemon.sent.length, 2);
  report('completed', ['Tests passed']);
  await f.end('completed');
  assert.equal(f.store.state.policies[f.id].goal?.status, 'completed');
  await f.ready();
  assert.equal(f.daemon.sent.length, 2);
});

test('missing goal reports and exhausted budgets stop the loop', async (t) => {
  for (const withReport of [true, false]) {
    const f = await fixture(t);
    await f.policy({ automatic: true });
    await f.engine.goal({
      agentId: f.id,
      revision: f.store.state.revision,
      action: 'create',
      objective: 'Build',
      maxTurns: 1,
      hours: 1,
      nativeGoalOff: true,
    });
    await f.ready();
    if (withReport)
      f.daemon.text = `<evo-report>${JSON.stringify({ nonce: f.store.state.policies[f.id].goal!.nonce, status: 'continue', progress: 'More work', evidence: [] })}</evo-report>`;
    await f.end('completed');
    await f.ready();
    assert.equal(f.daemon.sent.length, 1);
    assert.equal(f.store.state.policies[f.id].goal?.status, withReport ? 'budget' : 'paused');
  }
});

test('custom providers use the same goal loop and repeated pre-send failures do not duplicate instructions', async (t) => {
  const f = await fixture(t);
  f.daemon.agent.provider = 'custom-provider';
  await f.policy({ automatic: true, retry: true, nativeGoalOff: false });
  await f.engine.goal({
    agentId: f.id,
    revision: f.store.state.revision,
    action: 'create',
    objective: 'Build',
    maxTurns: 5,
    hours: 1,
    nativeGoalOff: false,
  });
  await f.ready();
  await f.end('failed');
  f.advance(40_000);
  f.daemon.beforeSend = () => f.engine.fence();
  await f.ready();
  await f.ready();
  assert.equal(f.store.state.jobs.at(-1)?.text, 'continue');
  f.daemon.beforeSend = null;
  await f.ready();
  assert.equal(f.daemon.sent.at(-1)?.text.match(/Objective:/g)?.length, 1);
  assert.equal(f.store.state.policies[f.id].goal?.turns, 2);
});

test('teardown fences a pending idle check before it can deliver', async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.policy({ automatic: true });
  await f.engine.tick();
  f.advance(3000);
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((r) => {
    enter = r;
  });
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  f.daemon.onSnapshot = async () => {
    enter();
    await blocked;
  };
  const tick = f.engine.tick();
  await entered;
  const stopped = f.engine.stop();
  release();
  await Promise.all([tick, stopped]);
  assert.equal(f.daemon.sent.length, 0);
});

test('storage refuses concurrent writers and corrupt data without overwriting it', async (t) => {
  const f = await fixture(t);
  await f.add();
  const other = new Store(f.directory);
  await assert.rejects(other.open());
  assert.equal((await stat(join(f.directory, 'state.json'))).mode & 0o777, 0o600);
  await f.engine.stop();
  await writeFile(join(f.directory, 'state.json'), '{broken');
  await assert.rejects(other.open());
  assert.equal(await readFile(join(f.directory, 'state.json'), 'utf8'), '{broken');
});

test('storage failure prevents sending, disconnect prevents sending, and teardown closes resources', async (t) => {
  const f = await fixture(t);
  await f.add();
  await f.policy({ automatic: true });
  f.daemon.snapshotError = true;
  await f.ready();
  assert.equal(f.daemon.sent.length, 0);
  f.daemon.snapshotError = false;
  f.store.fault = 'lost lock';
  await assert.rejects(f.engine.tick());
  assert.equal(f.daemon.sent.length, 0);
  await f.engine.stop();
  assert.equal(f.daemon.closed, true);
});
