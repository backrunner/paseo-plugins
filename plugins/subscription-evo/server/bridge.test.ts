import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, chmod, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { createHostClient } from '@getpaseo/client/node';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import type { UsageReportEntry } from '@getpaseo/protocol/messages';
import type { Launch } from '../shared/model';
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
    version = '0.16.2',
    overprivileged = false,
    closes = 0;
  const clients: { endpoint: unknown; options: Parameters<typeof createHostClient>[1] }[] = [];
  const sent: unknown[][] = [];
  const created: Parameters<DaemonClient['createAgent']>[0][] = [];
  const usageRequests: { agentId: string; forceRefresh: boolean }[] = [];
  const usageReports = new Map<string, UsageReportEntry[]>([
    [
      'a',
      [
        {
          id: 'opaque-account',
          account: {},
          sourceId: 'custom',
          sourceLabel: 'Custom',
          fetchedAt: '2026-11-15T00:00:00Z',
          report: {
            status: 'available',
            windows: [{ id: 'weekly', label: 'Weekly', usedPct: 75 }],
          },
        },
      ],
    ],
  ]);
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
      findWorkspace: async (id: string) => ({ id, name: 'Workspace', workspaceDirectory: '/qa' }),
      createAgent: async (options: Parameters<DaemonClient['createAgent']>[0]) => {
        created.push(options);
        return { id: options.agentId };
      },
      listUsageReports: async (options: { agentId: string; forceRefresh: boolean }) => {
        usageRequests.push(options);
        assert.equal(options.forceRefresh, true);
        assert.ok(usageReports.has(options.agentId), 'Usage must be scoped to a known session');
        return { reports: usageReports.get(options.agentId)! };
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
    created,
    usageRequests,
    usageReports,
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

test('adapter verifies a connection to each daemon version declared by the plugin', async (t) => {
  const home = await temporaryHome(t);
  const manifest = JSON.parse(
    await readFile(new URL('../paseo-plugin.json', import.meta.url), 'utf8'),
  );
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const version of manifest.requirements.paseo.split(' || ')) {
    const mock = clientFactory();
    mock.setVersion(version);
    assert.deepEqual(await inspectBinding(home, mock.factory), {
      home: await realpath(home),
      serverId: 'simulation',
    });
    assert.equal(mock.clients[0].options.appVersion, pkg.dependencies['@getpaseo/client']);
    assert.equal(mock.closes(), 1);
  }
});

test('adapter restricts identity, version and exact permission ceilings with simulated clients', async (t) => {
  const home = await temporaryHome(t);
  for (const change of ['identity', 'version', 'permissions']) {
    const mock = clientFactory();
    if (change === 'identity') mock.setIdentity('different');
    if (change === 'version') mock.setVersion('0.17.3');
    if (change === 'permissions') mock.elevate();
    const bridge = new LocalBridge(home, 'simulation', mock.factory);
    await assert.rejects(bridge.snapshot('a'));
    assert.equal(mock.sent.length, 0);
    assert.ok(mock.closes() > 0);
    await bridge.close();
  }
});

test('scheduled creation preserves default and explicit models, workspace and stable IDs', async (t) => {
  const home = await temporaryHome(t);
  const mock = clientFactory();
  const bridge = new LocalBridge(home, 'simulation', mock.factory);
  t.after(() => bridge.close());
  const launch: Launch = {
    id: '62de1179-bdde-486f-b05b-919578ce58a5',
    agentId: '240bd302-dc49-4475-869c-13380fa75790',
    requestId: 'create-test',
    serverId: 'simulation',
    workspaceId: 'workspace',
    workspaceName: 'Workspace',
    directory: '/qa',
    text: 'Start the test',
    at: 0,
    config: {
      provider: 'custom',
      model: null,
      mode: 'plan',
      thinking: 'high',
      options: { safe: true },
    },
    status: 'starting',
    revision: 0,
    problem: null,
    receipt: '',
  };
  for (const model of [null, 'vendor/model']) {
    await bridge.createScheduledAgent(
      { ...launch, config: { ...launch.config, model } },
      () => true,
    );
    assert.deepEqual(mock.created.at(-1), {
      workspaceId: launch.workspaceId,
      agentId: launch.agentId,
      clientMessageId: launch.id,
      idempotencyKey: launch.id,
      initialPrompt: launch.text,
      config: {
        cwd: launch.directory,
        provider: 'custom',
        model: model ?? undefined,
        modeId: 'plan',
        thinkingOptionId: 'high',
        providerOptions: { safe: true },
      },
    });
  }
  assert.equal(mock.closes(), 2);
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
test('quota requests select each target session rather than another session or all providers', async (t) => {
  const home = await temporaryHome(t);
  const mock = clientFactory();
  for (const [provider, remaining] of [
    ['codex', 0],
    ['claude', 86],
  ] as const) {
    mock.usageReports.set(`${provider}-session`, [
      {
        id: `${provider}:account`,
        account: {},
        sourceId: provider,
        sourceLabel: provider,
        fetchedAt: '2026-11-15T00:00:00Z',
        report: {
          status: 'available',
          windows: [{ id: 'weekly', label: 'Weekly', remainingPct: remaining }],
        },
      },
    ]);
  }
  const bridge = new LocalBridge(home, 'simulation', mock.factory);
  assert.equal((await bridge.usage('codex-session'))[0].windows[0].remaining, 0);
  const claude = await bridge.usage('claude-session');
  assert.equal(claude.length, 1);
  assert.equal(claude[0].id, 'claude:account');
  assert.equal(claude[0].windows[0].remaining, 86);
  assert.deepEqual(mock.usageRequests, [
    { agentId: 'codex-session', forceRefresh: true },
    { agentId: 'claude-session', forceRefresh: true },
  ]);
  await bridge.close();
});

test('adapter retains every scoped limit, supports week-only reports and does not infer recovery from reset time', async (t) => {
  const home = await temporaryHome(t);
  const mock = clientFactory();
  const entry = mock.usageReports.get('a')![0];
  entry.report = {
    status: 'available',
    windows: [
      { id: 'five_hour', label: '5h', usedPct: 0, resetsAt: '2000-01-01T00:00:00Z' },
      { id: 'weekly', label: 'Week', remainingPct: 50 },
      {
        id: 'weekly_model_fable',
        label: 'Weekly · Fable',
        usedPct: 100,
        resetsAt: '2000-01-01T00:00:00Z',
      },
      { id: 'weekly_surface_code', label: 'Weekly · Code', usedPct: 10 },
    ],
  };
  const bridge = new LocalBridge(home, 'simulation', mock.factory);
  assert.deepEqual((await bridge.usage('a'))[0].windows, [
    { id: 'five_hour', remaining: 100 },
    { id: 'weekly', remaining: 50 },
    { id: 'weekly_model_fable', remaining: 0 },
    { id: 'weekly_surface_code', remaining: 90 },
  ]);
  entry.report.windows = [{ id: 'weekly', label: 'Week', remainingPct: 50 }];
  assert.deepEqual((await bridge.usage('a'))[0].windows, [{ id: 'weekly', remaining: 50 }]);
  for (const window of [
    { usedPct: 100, remainingPct: 80 },
    { usedPct: -1, remainingPct: 80 },
    { usedPct: 50, remainingPct: 101 },
    { usedPct: NaN },
    {},
  ]) {
    entry.report.windows = [{ id: 'weekly', label: 'Week', ...window }];
    assert.equal((await bridge.usage('a'))[0].windows[0].remaining, null);
  }
  await bridge.close();
});

test('adapter preserves typed authentication failures and never reuses a last successful report', async (t) => {
  const home = await temporaryHome(t);
  const mock = clientFactory();
  const entry = mock.usageReports.get('a')![0];
  assert.equal(entry.report.status, 'available');
  entry.lastSuccessful = { fetchedAt: entry.fetchedAt, report: entry.report };
  const bridge = new LocalBridge(home, 'simulation', mock.factory);
  for (const problem of [
    { kind: 'expired', expiresAt: '2026-11-14T00:00:00Z' },
    { kind: 'rejected', status: 401 },
    { kind: 'rejected', status: 403 },
  ] as const) {
    entry.report = { status: 'unavailable', problem };
    const report = (await bridge.usage('a'))[0];
    assert.equal(report.available, false);
    assert.equal(report.problem, 'auth');
    assert.deepEqual(report.windows, []);
  }
  for (const report of [
    { status: 'unavailable', problem: { kind: 'no_quota', detail: 'No report' } },
    { status: 'error', error: 'Timeout' },
  ] as const) {
    entry.report = report;
    const quota = (await bridge.usage('a'))[0];
    assert.equal(quota.problem, 'unavailable');
    assert.deepEqual(quota.windows, []);
  }
  entry.report = { status: 'error', error: 'HTTP 401 authentication failed' };
  assert.equal((await bridge.usage('a'))[0].problem, 'auth');
  await bridge.close();
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
test('timed delivery steers a busy conversation despite new input, without clearing permissions', async (t) => {
  const home = await temporaryHome(t);
  const mock = clientFactory();
  const bridge = new LocalBridge(home, 'simulation', mock.factory);
  const snapshot = await bridge.snapshot('a');
  mock.agent.status = 'running';
  mock.agent.activeTurn = { turnId: 'active', startedAt: null };
  mock.agent.lastUserMessageAt = 'new input';
  await bridge.send('a', 'deadline', 'timed-id', snapshot, () => true, 'at');
  assert.deepEqual(mock.sent, [
    ['a', 'deadline', { messageId: 'timed-id', activeTurnBehavior: 'steer' }],
  ]);
  for (const change of [
    'permission',
    'model',
    'revoked',
    'identity',
    'archived',
    'internal',
    'unavailable',
  ]) {
    const original = structuredClone(mock.agent);
    if (change === 'permission')
      mock.agent.pendingPermissions = [{ id: 'p' }] as Agent['pendingPermissions'];
    if (change === 'model') mock.agent.model = 'other';
    if (change === 'identity') mock.agent.id = 'other';
    if (change === 'archived') mock.agent.archivedAt = 'now';
    if (change === 'internal') mock.agent.internal = true;
    if (change === 'unavailable') mock.agent.providerUnavailable = true;
    await assert.rejects(
      bridge.send('a', 'x', 'm', snapshot, () => change !== 'revoked', 'at'),
      PreconditionChanged,
      change,
    );
    Object.assign(mock.agent, original);
  }
  assert.equal(mock.sent.length, 1);
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
