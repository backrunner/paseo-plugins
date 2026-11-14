import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createHostClient } from '@getpaseo/client/node';
import {
  inspectBinding,
  inspectLocal,
  LocalBridge,
  PreconditionChanged,
  type Agent,
} from './bridge';

async function temporaryHome(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'evo-adapter-simulation-'));
  await writeFile(join(home, 'paseo.pid'), JSON.stringify({ pid: 123, listen: '127.0.0.1:42424' }));
  await writeFile(join(home, 'local-credential'), 'a'.repeat(43), { mode: 0o600 });
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
function clientFactory() {
  let identity = 'simulation',
    version = '0.15.4',
    overprivileged = false,
    closes = 0;
  const clients: { endpoint: unknown; options: Parameters<typeof createHostClient>[1] }[] = [];
  const sent: unknown[][] = [];
  const agent = {
    id: 'a',
    provider: 'custom',
    model: null,
    persistence: null,
    lastUserMessageAt: null,
    pendingPermissions: [],
    activeTurn: null,
    status: 'idle',
  } as unknown as Agent;
  const factory: typeof createHostClient = (endpoint, options) => {
    clients.push({ endpoint, options });
    return {
      connect: async () => {
        assert.equal(options.localCredential?.(), 'a'.repeat(43));
      },
      close: async () => {
        closes++;
      },
      getConnectionState: () => ({ status: 'connected' }),
      getLastServerInfoMessage: () => ({
        serverId: identity,
        version,
        permissions: overprivileged
          ? [...options.sessionPermissions!, 'daemon.manage']
          : options.sessionPermissions,
      }),
      fetchAgent: async () => ({ agent: structuredClone(agent) }),
      listUsageReports: async (options: unknown) => {
        assert.deepEqual(options, { agentId: 'a', forceRefresh: true });
        return {
          reports: [
            {
              id: 'opaque-account',
              fetchedAt: '2026-11-15T00:00:00Z',
              report: { status: 'available', windows: [{ id: 'weekly', usedPct: 75 }] },
            },
          ],
        };
      },
      fetchAgentTimeline: async () => ({
        entries: [
          { turnId: 't', item: { type: 'user_message', text: 'x', clientMessageId: 'm' } },
          { turnId: 't', item: { type: 'assistant_message', text: 'done' } },
        ],
      }),
      sendAgentMessage: async (...args: unknown[]) => {
        sent.push(args);
      },
    } as unknown as ReturnType<typeof createHostClient>;
  };
  return {
    factory,
    clients,
    sent,
    agent,
    closes: () => closes,
    setIdentity: (value: string) => {
      identity = value;
    },
    setVersion: (value: string) => {
      version = value;
    },
    elevate: () => {
      overprivileged = true;
    },
  };
}

test('adapter restricts identity, version and exact permission ceilings with simulated clients', async (t) => {
  const home = await temporaryHome(t);
  for (const change of ['identity', 'version', 'permissions']) {
    const mock = clientFactory();
    if (change === 'identity') mock.setIdentity('different');
    if (change === 'version') mock.setVersion('0.16.0');
    if (change === 'permissions') mock.elevate();
    const bridge = new LocalBridge(home, 'simulation', mock.factory);
    await assert.rejects(bridge.snapshot('a'));
    assert.equal(mock.sent.length, 0);
    assert.ok(mock.closes() > 0);
    await bridge.close();
  }
});
test('adapter normalizes quota, verifies history and uses an isolated writer with a stable message ID', async (t) => {
  const home = await temporaryHome(t);
  const mock = clientFactory();
  assert.deepEqual(await inspectBinding(home, mock.factory), {
    home: await realpath(home),
    serverId: 'simulation',
  });
  const bridge = new LocalBridge(home, 'simulation', mock.factory);
  assert.equal((await bridge.usage('a'))[0].windows[0].remaining, 25);
  assert.equal(await bridge.turnText('a', 't'), 'done');
  assert.equal(await bridge.latestIs('a', 'm'), true);
  const snapshot = await bridge.snapshot('a');
  await bridge.send('a', 'hello', 'stable-id', snapshot, () => true);
  assert.deepEqual(mock.sent, [
    ['a', 'hello', { messageId: 'stable-id', activeTurnBehavior: 'steer' }],
  ]);
  assert.deepEqual(mock.clients.at(-1)?.options.sessionPermissions, [
    'daemon.read',
    'workspace.read',
    'workspace.write',
  ]);
  assert.deepEqual(mock.clients[0].options.sessionPermissions, ['daemon.read', 'workspace.read']);
  await bridge.close();
  assert.equal(mock.closes(), mock.clients.length);
});
test('adapter rejects a busy session, a changed fingerprint and a revoked send', async (t) => {
  const home = await temporaryHome(t);
  const mock = clientFactory();
  const bridge = new LocalBridge(home, 'simulation', mock.factory);
  const snapshot = await bridge.snapshot('a');
  mock.agent.status = 'running';
  await assert.rejects(
    bridge.send('a', 'x', 'm', snapshot, () => true),
    PreconditionChanged,
  );
  mock.agent.status = 'idle';
  mock.agent.lastUserMessageAt = 'new';
  await assert.rejects(
    bridge.send('a', 'x', 'm', snapshot, () => true),
    PreconditionChanged,
  );
  mock.agent.lastUserMessageAt = null;
  await assert.rejects(
    bridge.send('a', 'x', 'm', snapshot, () => false),
    PreconditionChanged,
  );
  assert.equal(mock.sent.length, 0);
  await bridge.close();
});
test('delivery refuses a snapshot from another conversation even when all other fields match', async (t) => {
  const home = await temporaryHome(t);
  const mock = clientFactory();
  const bridge = new LocalBridge(home, 'simulation', mock.factory);
  const snapshot = await bridge.snapshot('a');
  await assert.rejects(
    bridge.send('a', 'x', 'm', { ...snapshot, id: 'other' }, () => true),
    PreconditionChanged,
  );
  mock.agent.id = 'other';
  await assert.rejects(
    bridge.send('a', 'x', 'm', snapshot, () => true),
    PreconditionChanged,
  );
  assert.equal(mock.sent.length, 0);
  await bridge.close();
});
test('local binding refuses remote addresses, readable credentials and symlinks without opening a client', async (t) => {
  const home = await temporaryHome(t);
  await writeFile(join(home, 'paseo.pid'), JSON.stringify({ listen: 'example.com:42424' }));
  await assert.rejects(inspectLocal(home), /local daemon/);
  await writeFile(join(home, 'paseo.pid'), JSON.stringify({ listen: '127.0.0.1:42424' }));
  await chmod(join(home, 'local-credential'), 0o644);
  await assert.rejects(inspectLocal(home), /credential/);
  await rm(join(home, 'local-credential'));
  await writeFile(join(home, 'other'), 'a'.repeat(43), { mode: 0o600 });
  await symlink(join(home, 'other'), join(home, 'local-credential'));
  await assert.rejects(inspectLocal(home), /credential/);
});
