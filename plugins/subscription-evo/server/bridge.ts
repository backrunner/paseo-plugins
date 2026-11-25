import { createHostClient } from '@getpaseo/client/node';
import type { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import { readFileSync } from 'node:fs';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentSnapshotPayload } from '@getpaseo/protocol/messages';
import { classifyError, type QuotaReport } from '../shared/policy';
import type { Launch } from '../shared/model';
import { LaunchNotStarted, type LaunchBridge } from './launches';

export type Agent = AgentSnapshotPayload;
export type DeliveryMode = 'idle' | 'at';
export interface Bridge {
  snapshot(id: string): Promise<Agent>;
  usage(id: string): Promise<QuotaReport[]>;
  turnText(id: string, turnId: string): Promise<string | null>;
  hasMessage(id: string, messageId: string): Promise<boolean>;
  latestIs(id: string, messageId: string): Promise<boolean>;
  send(
    id: string,
    text: string,
    messageId: string,
    expected: Agent,
    allowed: () => boolean,
    mode?: DeliveryMode,
  ): Promise<void>;
  close(): Promise<void>;
}
export const providerKey = (a: Agent) => JSON.stringify([a.provider, a.model, a.persistence]);
export const idle = (a: Agent) =>
  !a.archivedAt &&
  !a.internal &&
  !a.providerUnavailable &&
  !a.activeTurn &&
  !a.pendingPermissions.length &&
  ['idle', 'error'].includes(a.status);
export const fingerprint = (a: Agent) =>
  JSON.stringify([
    a.lastUserMessageAt,
    a.activeTurn,
    a.status,
    a.pendingPermissions.map((p) => p.id),
    a.archivedAt,
    providerKey(a),
  ]);
export const canSend = (expected: Agent, current: Agent, mode: DeliveryMode) =>
  !current.archivedAt &&
  !current.internal &&
  !current.providerUnavailable &&
  !current.pendingPermissions.length &&
  (mode === 'at'
    ? providerKey(expected) === providerKey(current)
    : idle(current) && fingerprint(expected) === fingerprint(current));
export class PreconditionChanged extends Error {}

const sdkVersion = '0.17.4';
const supportedDaemonVersions = ['0.16.2', sdkVersion];

export async function inspectLocal(homeInput: string) {
  const home = await realpath(
    resolve(homeInput.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), '.paseo')),
  );
  const lock = JSON.parse(await readFile(join(home, 'paseo.pid'), 'utf8')) as { listen?: string };
  const endpoint = lock.listen;
  if (!endpoint || !/^(127\.0\.0\.1|\[::1\]):\d+$/.test(endpoint))
    throw new Error('Only the selected local daemon is supported');
  const info = await lstat(join(home, 'local-credential'));
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
  )
    throw new Error('Unsafe local credential file');
  return { home, endpoint };
}
type ClientFactory = typeof createHostClient;
async function connect(
  home: string,
  endpoint: string,
  expectedId: string | null,
  write: boolean,
  factory: ClientFactory,
) {
  const permissions = write
    ? (['daemon.read', 'workspace.read', 'workspace.write'] as const)
    : (['daemon.read', 'workspace.read'] as const);
  const client = factory(endpoint, {
    clientId: `subscription-evo-${randomUUID()}`,
    clientType: 'cli',
    appVersion: sdkVersion,
    sessionPermissions: [...permissions],
    localCredential: () => {
      const lock = JSON.parse(readFileSync(join(home, 'paseo.pid'), 'utf8')) as { listen?: string };
      if (lock.listen !== endpoint) throw new Error('Local daemon endpoint changed');
      const token = readFileSync(join(home, 'local-credential'), 'utf8').trim();
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid local credential');
      return token;
    },
    connectTimeoutMs: 5000,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    const info = client.getLastServerInfoMessage();
    if (
      !info ||
      !info.version ||
      !supportedDaemonVersions.includes(info.version) ||
      (expectedId && info.serverId !== expectedId)
    )
      throw new Error('Daemon identity or version mismatch');
    if (
      !info.permissions ||
      info.permissions.length !== permissions.length ||
      permissions.some((p) => !info.permissions!.includes(p))
    )
      throw new Error('Daemon permission ceiling not confirmed');
    return { client, serverId: info.serverId };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
export async function inspectBinding(homeInput: string, factory: ClientFactory = createHostClient) {
  const local = await inspectLocal(homeInput);
  const { client, serverId } = await connect(local.home, local.endpoint, null, false, factory);
  await client.close();
  return { home: local.home, serverId };
}
export class LocalBridge implements Bridge, LaunchBridge {
  private reader: DaemonClient | null = null;
  private openingReader: Promise<DaemonClient> | null = null;
  private writers = new Set<DaemonClient>();
  private stopped = false;
  constructor(
    readonly home: string,
    readonly serverId: string,
    private readonly factory: ClientFactory = createHostClient,
  ) {}
  private async readClient() {
    if (this.stopped) throw new Error('Connection stopped');
    if (this.reader?.getConnectionState().status === 'connected') return this.reader;
    this.openingReader ??= this.openReader().finally(() => {
      this.openingReader = null;
    });
    return this.openingReader;
  }
  private async openReader() {
    await this.reader?.close().catch(() => {});
    const local = await inspectLocal(this.home);
    const { client } = await connect(
      local.home,
      local.endpoint,
      this.serverId,
      false,
      this.factory,
    );
    if (this.stopped) {
      await client.close();
      throw new Error('Connection stopped');
    }
    this.reader = client;
    return client;
  }
  async snapshot(id: string) {
    const result = await (await this.readClient()).fetchAgent({ agentId: id, timeout: 5000 });
    if (!result || result.agent.id !== id) throw new Error('Agent unavailable');
    return result.agent;
  }
  async launchWorkspace(id: string) {
    const workspace = await (await this.readClient()).findWorkspace(id);
    const directory = workspace?.workspaceDirectory;
    if (
      !workspace ||
      !directory ||
      workspace.archivingAt ||
      workspace.background ||
      workspace.internal
    )
      return null;
    return { name: workspace.name, directory };
  }
  async createScheduledAgent(launch: Launch, allowed: () => boolean) {
    if (launch.serverId !== this.serverId) throw new LaunchNotStarted('workspace');
    const client = await this.launchWriter();
    try {
      let workspace;
      try {
        workspace = await client.findWorkspace(launch.workspaceId);
      } catch {
        throw new LaunchNotStarted('connection');
      }
      if (
        !workspace ||
        workspace.workspaceDirectory !== launch.directory ||
        workspace.archivingAt ||
        workspace.background ||
        workspace.internal
      )
        throw new LaunchNotStarted('workspace');
      if (this.stopped || !allowed()) throw new LaunchNotStarted('connection');
      const { provider, model, mode, thinking, options } = launch.config;
      // The SDK's provider/model shorthand requires an explicit model. The daemon
      // accepts an omitted model and resolves the provider's default at launch.
      const agent = await client.createAgent({
        workspaceId: launch.workspaceId,
        idempotencyKey: launch.id,
        agentId: launch.agentId,
        clientMessageId: launch.id,
        initialPrompt: launch.text,
        config: {
          cwd: launch.directory,
          provider,
          model: model ?? undefined,
          modeId: mode ?? undefined,
          thinkingOptionId: thinking ?? undefined,
          providerOptions: options,
        },
      });
      if (agent.id !== launch.agentId) throw new Error('Unexpected scheduled agent identity');
    } finally {
      this.writers.delete(client);
      await client.close().catch(() => {});
    }
  }
  private async launchWriter() {
    if (this.stopped) throw new LaunchNotStarted('connection');
    try {
      const local = await inspectLocal(this.home);
      const { client } = await connect(
        local.home,
        local.endpoint,
        this.serverId,
        true,
        this.factory,
      );
      if (this.stopped) {
        await client.close();
        throw new Error('Connection stopped');
      }
      this.writers.add(client);
      return client;
    } catch {
      throw new LaunchNotStarted('connection');
    }
  }
  async confirmScheduledAgent(launch: Launch) {
    if (launch.serverId !== this.serverId) return false;
    const client = await this.readClient();
    const result = await client.fetchAgent({ agentId: launch.agentId, timeout: 5000 });
    return (
      result?.agent.workspaceId === launch.workspaceId &&
      (await this.hasMessage(launch.agentId, launch.id))
    );
  }
  async usage(id: string): Promise<QuotaReport[]> {
    const { reports } = await (
      await this.readClient()
    ).listUsageReports({ agentId: id, forceRefresh: true });
    return reports.map((entry) => ({
      id: entry.id,
      fetchedAt: Date.parse(entry.fetchedAt),
      available: entry.report.status === 'available',
      problem:
        entry.report.status === 'unavailable'
          ? entry.report.problem.kind === 'expired' ||
            (entry.report.problem.kind === 'rejected' &&
              [401, 403].includes(entry.report.problem.status))
            ? ('auth' as const)
            : ('unavailable' as const)
          : entry.report.status === 'error'
            ? classifyError(entry.report.error) === 'auth'
              ? ('auth' as const)
              : ('unavailable' as const)
            : undefined,
      windows:
        entry.report.status === 'available'
          ? entry.report.windows.map((w) => ({
              id: w.id,
              remaining: remainingCapacity(w),
            }))
          : [],
    }));
  }
  private async history(id: string) {
    const page = await (
      await this.readClient()
    ).fetchAgentTimeline(id, { direction: 'tail', limit: 100, wholeTurns: true, timeout: 5000 });
    if (page.error || page.gap || page.staleCursor) throw new Error('History is incomplete');
    return page.entries;
  }
  async turnText(id: string, turnId: string) {
    const entries = (await this.history(id)).filter((e) => e.turnId === turnId);
    const text = entries.flatMap((e) => (e.item.type === 'assistant_message' ? [e.item.text] : []));
    return text.length ? text.join('\n') : null;
  }
  async hasMessage(id: string, messageId: string) {
    return (await this.history(id)).some(
      (e) =>
        e.item.type === 'user_message' &&
        (e.item.messageId === messageId || e.item.clientMessageId === messageId),
    );
  }
  async latestIs(id: string, messageId: string) {
    const item = (await this.history(id))
      .filter((e) => e.item.type === 'user_message')
      .at(-1)?.item;
    return (
      item?.type === 'user_message' &&
      (item.messageId === messageId || item.clientMessageId === messageId)
    );
  }
  async send(
    id: string,
    text: string,
    messageId: string,
    expected: Agent,
    allowed: () => boolean,
    mode: DeliveryMode = 'idle',
  ) {
    const local = await inspectLocal(this.home);
    const { client } = await connect(local.home, local.endpoint, this.serverId, true, this.factory);
    this.writers.add(client);
    try {
      const current = await client.fetchAgent({ agentId: id, timeout: 5000 });
      if (
        this.stopped ||
        !allowed() ||
        !current ||
        expected.id !== id ||
        current.agent.id !== id ||
        !canSend(expected, current.agent, mode)
      )
        throw new PreconditionChanged('Delivery precondition changed');
      // Timed messages steer an active turn immediately. Idle-only delivery still has a race
      // with other clients because Paseo offers no atomic idle-only send.
      await client.sendAgentMessage(id, text, { messageId, activeTurnBehavior: 'steer' });
    } finally {
      this.writers.delete(client);
      await client.close().catch(() => {});
    }
  }
  async close() {
    this.stopped = true;
    await Promise.allSettled([
      this.openingReader,
      this.reader?.close(),
      ...[...this.writers].map((c) => c.close()),
    ]);
  }
}

function remainingCapacity(window: { remainingPct?: number | null; usedPct?: number | null }) {
  const { remainingPct, usedPct } = window;
  for (const value of [remainingPct, usedPct])
    if (value != null && (!Number.isFinite(value) || value < 0 || value > 100)) return null;
  if (remainingPct != null && usedPct != null && Math.abs(remainingPct + usedPct - 100) > 0.01)
    return null;
  return remainingPct ?? (usedPct == null ? null : 100 - usedPct);
}
