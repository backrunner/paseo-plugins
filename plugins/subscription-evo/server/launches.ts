import { createHash, randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { launchEdit } from '../shared/contracts';
import type { Launch, LaunchInput } from '../shared/model';
import type { Store } from './store';
import { SubmissionRejected } from './rejection';

type Create = z.output<typeof LaunchInput>;
type Edit = z.output<typeof launchEdit.input>;
type Workspace = { name: string; directory: string };
type Problem = Exclude<Launch['problem'], null>;

export class LaunchNotStarted extends Error {
  constructor(readonly problem: Extract<Problem, 'workspace' | 'connection'>) {
    super(problem);
  }
}

export interface LaunchBridge {
  readonly serverId: string;
  launchWorkspace(id: string): Promise<Workspace | null>;
  createScheduledAgent(launch: Launch, allowed: () => boolean): Promise<void>;
  confirmScheduledAgent(launch: Launch): Promise<boolean>;
}

export class LaunchQueue {
  private stopped = false;
  private running: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly bridge: LaunchBridge,
    private readonly now: () => number,
  ) {}

  stop() {
    this.stopped = true;
    return this.running;
  }

  private requireOpen() {
    if (this.stopped || this.store.fault) throw new Error(this.store.fault ?? 'Scheduler stopped');
  }

  private validateTime(at: number) {
    const now = this.now();
    if (at <= now || at > now + 365 * 86_400_000)
      throw new SubmissionRejected('Choose a future time within one year');
  }

  async submit(input: Create) {
    const receipt = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const prior = (launches: Launch[]) => {
      const existing = launches.find((launch) => launch.requestId === input.requestId);
      if (!existing) return undefined;
      if (existing.receipt !== receipt)
        throw new Error('Request ID already used for different content');
      return { id: existing.id };
    };
    try {
      this.requireOpen();
      const existing = prior(this.store.state.launches);
      if (existing) return existing;
      this.validateTime(input.at);
      const workspace = await this.bridge.launchWorkspace(input.workspaceId).catch(() => {
        throw new SubmissionRejected('Could not verify the target workspace. Try again shortly.');
      });
      if (workspace?.directory !== input.directory)
        throw new SubmissionRejected('The selected workspace changed or is unavailable');
      return await this.store.change(({ launches }) => {
        this.requireOpen();
        const saved = prior(launches);
        if (saved) return saved;
        this.validateTime(input.at);
        if (launches.length >= 500)
          throw new SubmissionRejected('Scheduled conversation history is full');
        const launch: Launch = {
          ...input,
          id: randomUUID(),
          agentId: randomUUID(),
          serverId: this.bridge.serverId,
          workspaceName: workspace.name,
          revision: 0,
          status: 'scheduled',
          problem: null,
          receipt,
        };
        launches.push(launch);
        return { id: launch.id };
      });
    } catch (error) {
      if (error instanceof SubmissionRejected) return { rejected: error.message };
      throw error;
    }
  }

  async edit(input: Edit) {
    this.requireOpen();
    const current = this.store.state.launches.find((launch) => launch.id === input.id);
    const confirmed =
      input.action === 'check' &&
      current?.status === 'unknown' &&
      current.revision === input.revision &&
      (await this.bridge.confirmScheduledAgent(current));
    return this.store.change(({ launches }) => {
      this.requireOpen();
      const launch = launches.find((candidate) => candidate.id === input.id);
      if (!launch || launch.revision !== input.revision)
        throw new Error('The scheduled conversation changed. Refresh and try again.');
      if (input.action === 'check' && launch.status === 'unknown') {
        if (confirmed) {
          launch.status = 'started';
          launch.problem = null;
          launch.revision++;
        }
        return { launch };
      }
      if (launch.status !== 'scheduled' && launch.status !== 'paused')
        throw new Error('This scheduled conversation can no longer be changed');
      switch (input.action) {
        case 'begin-edit':
          if (launch.status === 'paused') return { launch };
          launch.status = 'paused';
          break;
        case 'pause':
          launch.status = 'paused';
          break;
        case 'cancel':
          launch.status = 'canceled';
          break;
        case 'resume':
          this.validateTime(launch.at);
          launch.status = 'scheduled';
          break;
        case 'update':
          if (launch.status !== 'paused' || !input.details)
            throw new Error('Pause this conversation before editing it');
          this.validateTime(input.details.at);
          Object.assign(launch, input.details);
          break;
        default:
          throw new Error('There is no start to verify');
      }
      launch.problem = null;
      launch.revision++;
      return { launch };
    });
  }

  tick() {
    if (this.running || this.stopped || this.store.fault) return;
    const now = this.now();
    if (
      !this.store.state.launches.some((launch) => launch.status === 'scheduled' && launch.at <= now)
    )
      return;
    this.running = this.startNext(now).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async startNext(now: number) {
    const launch = await this.store.change(({ launches }) => {
      if (this.stopped) return;
      const next = launches
        .filter((job) => job.status === 'scheduled' && job.at <= now)
        .sort((left, right) => left.at - right.at)[0];
      if (!next) return;
      next.status = 'starting';
      next.revision++;
      return next;
    });
    if (!launch) return;
    let status: Launch['status'] = 'started';
    let problem: Launch['problem'] = null;
    try {
      await this.bridge.createScheduledAgent(launch, () => !this.stopped && !this.store.fault);
    } catch (error) {
      status = error instanceof LaunchNotStarted ? 'paused' : 'unknown';
      problem = error instanceof LaunchNotStarted ? error.problem : 'unconfirmed';
    }
    await this.store.change(({ launches }) => {
      const saved = launches.find((job) => job.id === launch.id)!;
      saved.status = status;
      saved.problem = problem;
      saved.revision++;
    });
  }
}
