import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { Launch } from '../shared/model';
import { LaunchNotStarted, LaunchQueue, type LaunchBridge } from './launches';
import { Store } from './store';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'evo-launch-'));
  let now = 1000;
  let outcome: 'normal' | 'lost' | 'workspace' = 'normal';
  let visible = true;
  const starts: Launch[] = [];
  const workspace = { name: 'Development', directory: '/workspace' };
  const bridge: LaunchBridge = {
    serverId: 'test-host',
    async launchWorkspace(id) {
      return id === 'target' ? workspace : null;
    },
    async createScheduledAgent(launch, allowed) {
      assert.ok(allowed());
      if (outcome === 'workspace') throw new LaunchNotStarted('workspace');
      starts.push(launch);
      if (outcome === 'lost') throw new Error('Reply lost after creation');
    },
    async confirmScheduledAgent(launch) {
      return visible && starts.some((record) => record.id === launch.id);
    },
  };
  // An existing 0.1.8 installation has no launch records in its state document.
  await writeFile(
    join(directory, 'state.json'),
    JSON.stringify({ version: 1, revision: 4, jobs: [], policies: {}, events: [] }),
  );
  let store = new Store(directory);
  await store.open();
  let queue = new LaunchQueue(store, bridge, () => now);
  t.after(async () => {
    await queue.stop();
    await store.close();
    await rm(directory, { force: true, recursive: true });
  });
  const input = {
    requestId: 'launch-receipt',
    workspaceId: 'target',
    directory: '/workspace',
    text: 'First message',
    at: 10_000,
    config: {
      provider: 'codex',
      model: 'model',
      mode: 'mode',
      thinking: 'high',
      options: { flag: true },
    },
  };
  return {
    get queue() {
      return queue;
    },
    get store() {
      return store;
    },
    input,
    starts,
    advance: (to: number) => {
      now = to;
    },
    loseReply: () => {
      outcome = 'lost';
    },
    removeWorkspace: () => {
      outcome = 'workspace';
    },
    setVisible: (value: boolean) => {
      visible = value;
    },
    async restart() {
      await queue.stop();
      await store.close();
      store = new Store(directory);
      await store.open();
      queue = new LaunchQueue(store, bridge, () => now);
    },
  };
}

test('a one-time schedule persists its draft and starts once after the deadline across reload', async (t) => {
  const f = await fixture(t);
  const [first, duplicate] = await Promise.all([f.queue.submit(f.input), f.queue.submit(f.input)]);
  assert.deepEqual(duplicate, first);
  await assert.rejects(f.queue.submit({ ...f.input, text: 'different' }), /already used/);
  assert.equal(f.store.state.launches.length, 1);
  const saved = f.store.state.launches[0]!;
  f.advance(9999);
  await f.queue.tick();
  assert.equal(f.starts.length, 0);
  await f.restart();
  f.advance(10_000);
  await Promise.all([f.queue.tick(), f.queue.tick()]);
  await f.queue.tick();
  assert.deepEqual(
    f.starts.map(({ config, text, agentId }) => ({ config, text, agentId })),
    [{ config: f.input.config, text: f.input.text, agentId: saved.agentId }],
  );
  assert.equal(f.store.state.launches[0]?.status, 'started');
});

test('paused, edited and withdrawn launches keep their authorization and reject stale revisions', async (t) => {
  const f = await fixture(t);
  await f.queue.submit(f.input);
  const { id } = f.store.state.launches[0]!;
  const paused = await f.queue.edit({ id, action: 'pause', revision: 0 });
  await assert.rejects(f.queue.edit({ id, action: 'cancel', revision: 0 }), /changed/);
  f.advance(f.input.at);
  await f.queue.tick();
  assert.equal(f.starts.length, 0);
  await assert.rejects(
    f.queue.edit({ id, action: 'resume', revision: paused.launch.revision }),
    /future/,
  );
  const { launch } = await f.queue.edit({
    id,
    action: 'update',
    revision: paused.launch.revision,
    details: { text: 'Revised', at: 20_000 },
  });
  assert.equal(launch.status, 'paused');
  assert.deepEqual(await f.queue.submit(f.input), { id }, 'late receipt cannot undo the edit');
  await f.queue.edit({ id, action: 'cancel', revision: launch.revision });
  f.advance(21_000);
  await f.queue.tick();
  assert.equal(f.starts.length, 0);
  assert.equal(f.store.state.launches[0]?.text, 'Revised');
});

test('an unconfirmed start is held through restart and can be verified without another start', async (t) => {
  const f = await fixture(t);
  await f.queue.submit(f.input);
  f.loseReply();
  f.advance(f.input.at);
  await f.queue.tick();
  assert.equal(f.store.state.launches[0]?.status, 'unknown');
  await f.restart();
  await f.queue.tick();
  const { id, revision } = f.store.state.launches[0]!;
  await assert.rejects(f.queue.edit({ id, revision, action: 'resume' }), /no longer/);
  f.setVisible(false);
  const request = { id, revision, action: 'check' as const };
  assert.equal((await f.queue.edit(request)).launch.status, 'unknown');
  f.setVisible(true);
  assert.equal((await f.queue.edit(request)).launch.status, 'started');
  assert.equal(f.starts.length, 1);
});

test('rejects an unavailable target and pauses a task whose workspace later disappears', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.queue.submit({ ...f.input, directory: '/other' }), {
    rejected: 'The selected workspace changed or is unavailable',
  });
  await f.queue.submit(f.input);
  f.removeWorkspace();
  f.advance(f.input.at);
  await f.queue.tick();
  assert.equal(f.store.state.launches[0]?.status, 'paused');
  assert.equal(f.store.state.launches[0]?.problem, 'workspace');
  assert.equal(f.starts.length, 0);
});

test('reload converts an interrupted start to an unconfirmed outcome before polling', async (t) => {
  const f = await fixture(t);
  await f.queue.submit(f.input);
  await f.store.change((state) => {
    state.launches[0]!.status = 'starting';
  });
  await f.restart();
  f.advance(f.input.at);
  await f.queue.tick();
  assert.equal(f.store.state.launches[0]?.status, 'unknown');
  assert.equal(f.starts.length, 0);
});
