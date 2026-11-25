import { randomUUID, createHash } from 'node:crypto';
import type { PluginHookPayload } from '@getpaseo/plugin/server';
import type { z } from 'zod';
import * as rpc from '../shared/contracts';
import {
  freshPolicy,
  queued,
  timedMessage,
  scheduledMessage,
  goalPrompt,
  parseReport,
  type Job,
  type State,
  type Policy,
  type Trigger,
} from '../shared/model';
import {
  classifyError,
  retryDelay,
  retryAfter,
  quotaState,
  type QuotaReport,
} from '../shared/policy';
import {
  fingerprint,
  idle,
  providerKey,
  PreconditionChanged,
  type Agent,
  type Bridge,
} from './bridge';
import { Store } from './store';
import { SubmissionRejected } from './rejection';
import { LaunchQueue, type LaunchBridge } from './launches';

type Add = z.output<typeof rpc.add.input>;
type Edit = z.output<typeof rpc.edit.input>;
type Save = z.output<typeof rpc.policy.input>;
type GoalChange = z.output<typeof rpc.goal.input>;
type End = PluginHookPayload<'agent.turn.after'>;
const DAY = 86_400_000;

/** One serialized scheduler per installation. No host queue or provider configuration is mutated. */
export class Engine {
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private epoch = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stable = new Map<string, { value: string; at: number }>();
  private usage = new Map<string, { key: string; at: number; reports: QuotaReport[] }>();
  private lastUsageAttempt = -Infinity;
  readonly launches: LaunchQueue;
  error: string | null = null;
  constructor(
    readonly store: Store,
    readonly bridge: Bridge & LaunchBridge,
    readonly now = Date.now,
    readonly random = Math.random,
  ) {
    this.launches = new LaunchQueue(store, bridge, now);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(() => {
      if (this.stopped) throw new Error('Scheduler stopped');
      return operation();
    });
    this.tail = task.catch(() => {});
    return task;
  }
  start() {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => {
      void this.launches.tick()?.catch(() => {
        this.error = 'Connection or storage unavailable. Delivery stopped.';
      });
      if (this.ticking) return;
      this.ticking = true;
      void this.tickMessages()
        .catch(() => {
          this.error = 'Connection or storage unavailable. Delivery stopped.';
        })
        .finally(() => {
          this.ticking = false;
        });
    }, 2500);
    this.timer.unref?.();
  }
  fence() {
    this.epoch++;
  }
  async stop() {
    this.stopped = true;
    this.fence();
    if (this.timer) clearInterval(this.timer);
    const launching = this.launches.stop();
    await this.bridge.close();
    await Promise.allSettled([this.tail, launching]);
    await this.store.close();
  }
  snapshot(agentId: string): State {
    const state = structuredClone(this.store.state);
    state.jobs = state.jobs.filter((j) => j.agentId === agentId);
    state.launches = [];
    state.policies = state.policies[agentId] ? { [agentId]: state.policies[agentId] } : {};
    state.events = [];
    return state;
  }
  private policy(state: State, agent: Agent) {
    if (!state.policies[agent.id]) {
      if (Object.keys(state.policies).length >= 100)
        throw new SubmissionRejected('Session limit reached');
      state.policies[agent.id] = {
        ...freshPolicy(),
        observedUserAt: agent.lastUserMessageAt,
        providerKey: providerKey(agent),
      };
    }
    return state.policies[agent.id];
  }
  private newJob(state: State, input: Add, source: Job['source'], goalId: string | null = null) {
    if (state.jobs.length >= 500)
      throw new SubmissionRejected(
        'Queue history is full. Export and reset the plugin store before adding more.',
      );
    const now = this.now();
    const job: Job = {
      ...input,
      id: randomUUID(),
      source,
      goalId,
      createdAt: now,
      expiresAt: Math.max(now + 7 * DAY, input.trigger.kind === 'at' ? input.trigger.at + DAY : 0),
      dueAt:
        input.trigger.kind === 'at' ? input.trigger.at : input.trigger.kind === 'idle' ? now : null,
      status: 'queued',
      paused: source === 'user' && input.allowDelivery === false,
      manual: source === 'user' && input.allowDelivery === true,
      deliveryRequested: source === 'user' && input.allowDelivery === true,
      lastEdit: null,
      revision: 0,
      wait: 'queued',
      messageId: randomUUID(),
      frozenText: null,
      quotaIds: [],
      quotaWindowIds: [],
      sawExhausted: source === 'quota',
      sampledDelayMs: null,
      quotaHold: false,
      quotaObservedAt: source === 'quota' ? now : null,
    };
    state.jobs.push(job);
    return job;
  }
  private validateTrigger(trigger: Trigger) {
    if (trigger.kind === 'at' && (trigger.at <= this.now() || trigger.at > this.now() + 365 * DAY))
      throw new SubmissionRejected('Choose a future time within one year');
  }
  async submit(input: Add) {
    try {
      return await this.add(input);
    } catch (error) {
      if (error instanceof SubmissionRejected) return { rejected: error.message };
      // A storage or transport error can mean the write already happened.
      throw error;
    }
  }
  add(input: Add) {
    this.fence();
    return this.serial(async () => {
      const existing = this.store.state.jobs.find(
        (j) => j.requestId === input.requestId && j.agentId === input.agentId,
      );
      if (existing) {
        if (
          existing.text !== input.text ||
          existing.deliveryRequested !== (input.allowDelivery === true) ||
          JSON.stringify(existing.trigger) !== JSON.stringify(input.trigger)
        )
          throw new Error('Request ID already used for different content');
        return { id: existing.id };
      }
      this.validateTrigger(input.trigger);
      let agent: Agent;
      try {
        agent = await this.bridge.snapshot(input.agentId);
      } catch {
        throw new SubmissionRejected('Session unavailable. Refresh and try again.');
      }
      if (agent.archivedAt || agent.internal)
        throw new SubmissionRejected('This session cannot accept queued messages');
      return this.store.change((s) => {
        this.policy(s, agent);
        return { id: this.newJob(s, input, 'user').id };
      });
    });
  }
  edit(input: Edit) {
    this.fence();
    return this.serial(async () => {
      return this.store.change((s) => {
        const j = s.jobs.find((j) => j.id === input.id && j.agentId === input.agentId);
        const signature = createHash('sha256')
          .update(
            JSON.stringify({
              revision: input.revision,
              text: input.text,
              trigger: input.trigger,
              allowDelivery: input.allowDelivery,
            }),
          )
          .digest('hex');
        if (j && input.action === 'edit' && input.requestId && j.lastEdit?.id === input.requestId) {
          if (j.lastEdit.signature !== signature)
            throw new SubmissionRejected('Edit ID already used for different content');
          return { ok: true, job: structuredClone(j) };
        }
        if (!j || j.revision !== input.revision)
          throw new SubmissionRejected('Queue changed. Refresh before editing.');
        if (j.status === 'unknown' && input.action === 'cancel') {
          j.status = 'canceled';
          j.revision++;
          return { ok: true, job: structuredClone(j) };
        }
        if (!queued(j))
          throw new SubmissionRejected('Message is already being delivered or has finished');
        if (input.action === 'cancel' || input.action === 'withdraw') {
          j.status = 'canceled';
          j.manual = false;
          j.wait = 'withdrawn';
        }
        if (input.action === 'begin-edit' && j.source !== 'user')
          throw new SubmissionRejected('Only your queued messages can be edited');
        if (input.action === 'pause' || input.action === 'begin-edit') {
          j.paused = true;
          j.manual = false;
          j.wait = 'paused';
        }
        if (input.action === 'resume') {
          j.paused = false;
          this.usage.delete(j.agentId);
          if (j.wait.startsWith('quota-') && s.policies[j.agentId].notice === j.wait)
            s.policies[j.agentId].notice = '';
        }
        if (input.action === 'release') {
          j.manual = true;
          j.paused = false;
          this.usage.delete(j.agentId);
          if (j.wait.startsWith('quota-') && s.policies[j.agentId].notice === j.wait)
            s.policies[j.agentId].notice = '';
        }
        if (input.action === 'up') {
          const index = s.jobs.indexOf(j);
          const previous = s.jobs
            .slice(0, index)
            .findLastIndex((x) => x.agentId === j.agentId && queued(x));
          if (previous >= 0) {
            s.jobs[previous].revision++;
            [s.jobs[previous], s.jobs[index]] = [s.jobs[index], s.jobs[previous]];
          }
        }
        if (input.action === 'edit') {
          if (j.source !== 'user')
            throw new SubmissionRejected('Only your queued messages can be edited');
          if (input.text) j.text = input.text;
          j.frozenText = null;
          if (input.trigger && JSON.stringify(input.trigger) !== JSON.stringify(j.trigger)) {
            this.validateTrigger(input.trigger);
            const keepQuota =
              (j.trigger.kind === 'quota' || j.quotaHold) &&
              (input.trigger.kind === 'quota' || j.quotaHold);
            j.trigger = input.trigger;
            j.expiresAt = Math.max(
              this.now() + 7 * DAY,
              input.trigger.kind === 'at' ? input.trigger.at + DAY : 0,
            );
            j.dueAt =
              input.trigger.kind === 'at'
                ? input.trigger.at
                : input.trigger.kind === 'idle'
                  ? this.now()
                  : null;
            if (!keepQuota) {
              j.quotaIds = [];
              j.quotaWindowIds = [];
            }
            j.sawExhausted = j.quotaHold;
            j.sampledDelayMs = null;
            if (j.quotaHold) j.dueAt = null;
          }
          j.manual = input.allowDelivery === true;
          j.paused = input.allowDelivery !== true;
          if (j.manual) this.usage.delete(j.agentId);
          j.wait = j.paused ? 'paused' : 'queued';
          if (input.requestId) j.lastEdit = { id: input.requestId, signature };
        }
        j.revision++;
        return { ok: true, job: structuredClone(j) };
      });
    });
  }
  async revise(input: z.output<typeof rpc.revise.input>) {
    try {
      return await this.edit(input);
    } catch (error) {
      if (error instanceof SubmissionRejected) return { rejected: error.message };
      throw error;
    }
  }
  save(input: Save) {
    this.fence();
    return this.serial(async () => {
      const agent = await this.bridge.snapshot(input.agentId);
      if (agent.provider === 'codex' && input.values.automatic && !input.values.nativeGoalOff)
        throw new Error('Confirm native /goal is off before enabling automatic delivery');
      await this.store.change((s) => {
        if (s.revision !== input.revision)
          throw new Error('Settings changed. Refresh before saving.');
        const p = this.policy(s, agent);
        const wasPaused = p.paused;
        if (p.observedUserAt !== agent.lastUserMessageAt) p.retryCount = 0;
        Object.assign(p, input.values, {
          observedUserAt: agent.lastUserMessageAt,
          providerKey: providerKey(agent),
          notice: '',
        });
        const pausing = p.paused && !wasPaused;
        if (pausing || !p.automatic)
          for (const j of s.jobs)
            if (j.agentId === agent.id && queued(j) && (pausing || !scheduledMessage(j)))
              j.manual = false;
        if (!p.retry) this.cancelAuto(s, agent.id, 'retry');
        if (!p.quotaResume) this.cancelAuto(s, agent.id, 'quota');
      });
      this.stable.delete(input.agentId);
      return { ok: true };
    });
  }
  goal(input: GoalChange) {
    this.fence();
    return this.serial(async () => {
      const agent = await this.bridge.snapshot(input.agentId);
      await this.store.change((s) => {
        if (s.revision !== input.revision) throw new Error('Goal changed. Refresh before saving.');
        const p = this.policy(s, agent);
        this.cancelAuto(s, agent.id);
        if (input.action === 'clear') {
          p.goal = null;
          return;
        }
        if (input.action === 'create') {
          if (!input.objective) throw new Error('Enter an objective');
          if (agent.provider === 'codex' && !input.nativeGoalOff)
            throw new Error('Turn off native /goal before starting an Evo goal');
          p.retryCount = 0;
          p.goal = {
            id: randomUUID(),
            objective: input.objective,
            status: 'active',
            turns: 0,
            maxTurns: input.maxTurns,
            expiresAt: this.now() + input.hours * 3_600_000,
            nonce: randomUUID(),
            progress: '',
            evidence: [],
            noProgress: 0,
            nativeGoalOff: input.nativeGoalOff,
          };
        } else {
          if (!p.goal || ['completed', 'budget'].includes(p.goal.status))
            throw new Error('Create a new goal to continue');
          p.goal.status = input.action === 'pause' ? 'paused' : 'active';
        }
        p.observedUserAt = agent.lastUserMessageAt;
        p.providerKey = providerKey(agent);
        p.notice = '';
        if (p.goal?.status === 'active') this.enqueueGoal(s, agent.id, p);
      });
      return { ok: true };
    });
  }
  private cancelAuto(s: State, agentId: string, source?: Job['source']) {
    for (const j of s.jobs)
      if (
        j.agentId === agentId &&
        queued(j) &&
        j.source !== 'user' &&
        (!source || source === j.source)
      ) {
        j.status = 'canceled';
        j.revision++;
      }
  }
  private pause(s: State, agentId: string, reason: string) {
    const p = s.policies[agentId];
    if (!p) return;
    p.paused = true;
    p.notice = reason;
    if (p.goal?.status === 'active') p.goal.status = 'paused';
    this.cancelAuto(s, agentId);
    const keepScheduled = [
      'manual-input',
      'permission',
      'session-closed',
      'turn-canceled',
    ].includes(reason);
    for (const j of s.jobs)
      if (j.agentId === agentId && queued(j) && !(keepScheduled && scheduledMessage(j)))
        j.manual = false;
    this.stable.delete(agentId);
  }
  pauseAgent(agentId: string, reason: string) {
    this.fence();
    return this.serial(() => this.store.change((s) => this.pause(s, agentId, reason)));
  }
  private enqueueGoal(s: State, agentId: string, p: Policy) {
    const g = p.goal;
    if (!g || g.status !== 'active') return;
    if (g.turns >= g.maxTurns || this.now() >= g.expiresAt) {
      g.status = 'budget';
      return;
    }
    if (s.jobs.some((j) => j.agentId === agentId && queued(j))) {
      g.status = 'paused';
      p.notice = 'goal-queue-conflict';
      return;
    }
    g.nonce = randomUUID();
    this.newJob(
      s,
      {
        agentId,
        requestId: `goal:${g.nonce}`,
        text: goalPrompt(g, p.continueText),
        trigger: { kind: 'idle' },
      },
      'goal',
      g.id,
    );
  }
  private async observe(agent: Agent) {
    const p = this.store.state.policies[agent.id];
    if (!p) return false;
    if (p.providerKey !== providerKey(agent) || agent.archivedAt || agent.internal) {
      await this.store.change((s) => this.pause(s, agent.id, 'session-changed'));
      return false;
    }
    if (p.observedUserAt !== agent.lastUserMessageAt) {
      await this.store.change((s) => {
        this.pause(s, agent.id, 'manual-input');
        s.policies[agent.id].observedUserAt = agent.lastUserMessageAt;
      });
      return false;
    }
    return true;
  }
  ended(event: End) {
    this.fence();
    return this.serial(async () => {
      const id = event.agent.id;
      if (!event.turnId || !this.store.state.policies[id]) return;
      const key = `${id}:${event.turnId}`;
      if (this.store.state.events.includes(key)) return;
      const agent = await this.bridge.snapshot(id);
      if (!(await this.observe(agent))) return;
      const p = this.store.state.policies[id];
      // Observe cancellation even when automatic delivery is off.
      if (event.outcome.kind === 'canceled') {
        await this.store.change((s) => {
          this.remember(s, key);
          this.pause(s, id, 'turn-canceled');
        });
        return;
      }
      if (p.paused) return;
      const last = this.store.state.jobs
        .filter((j) => j.agentId === id && j.status === 'sent')
        .at(-1);
      const ownsGoal =
        p.goal?.status === 'active' &&
        last?.goalId === p.goal.id &&
        (await this.bridge.latestIs(id, last.messageId));
      let report: ReturnType<typeof parseReport> = null;
      if (event.outcome.kind === 'completed' && ownsGoal) {
        const text = await this.bridge.turnText(id, event.turnId);
        report = text ? parseReport(text, p.goal!.nonce) : null;
      }
      await this.store.change((s) => {
        this.remember(s, key);
        const policy = s.policies[id];
        if (event.outcome.kind === 'failed') {
          const { message, code } = event.outcome.error;
          const kind = classifyError(message, code);
          const pending = s.jobs.filter((j) => j.agentId === id && queued(j));
          if (pending.length) {
            const recover = policy.quotaResume && policy.retryCount < policy.maxRetries;
            if (
              kind === 'quota' &&
              (recover || pending.some((j) => j.source === 'user' && j.trigger.kind === 'quota'))
            ) {
              if (recover) policy.retryCount++;
              for (const j of pending) {
                if (!recover && !(j.source === 'user' && j.trigger.kind === 'quota')) continue;
                j.quotaHold = true;
                j.sawExhausted = true;
                j.quotaObservedAt = this.now();
                j.dueAt = null;
                j.sampledDelayMs = null;
                j.wait = 'quota-exhausted';
                j.revision++;
              }
            } else if (kind !== 'transient') this.pause(s, id, `error-${kind}`);
            else policy.notice = 'queue-already-pending';
            return;
          }
          if (kind === 'quota' && policy.quotaResume && policy.retryCount < policy.maxRetries) {
            policy.retryCount++;
            const j = this.newJob(
              s,
              {
                agentId: id,
                requestId: key,
                text: policy.continueText,
                trigger: { kind: 'quota', delay: policy.delay },
              },
              'quota',
              ownsGoal ? policy.goal!.id : null,
            );
            j.sawExhausted = true;
          } else if (
            kind === 'transient' &&
            policy.retry &&
            policy.retryCount < policy.maxRetries
          ) {
            policy.retryCount++;
            this.newJob(
              s,
              {
                agentId: id,
                requestId: key,
                text: policy.continueText,
                trigger: {
                  kind: 'at',
                  at:
                    this.now() + retryDelay(policy.retryCount, this.random(), retryAfter(message)),
                },
              },
              'retry',
              ownsGoal ? policy.goal!.id : null,
            );
          } else {
            this.pause(
              s,
              id,
              ['transient', 'quota'].includes(kind) && policy.retryCount >= policy.maxRetries
                ? 'retry-budget'
                : `error-${kind}`,
            );
          }
        } else if (event.outcome.kind === 'completed') {
          policy.retryCount = 0;
          const g = policy.goal;
          if (!ownsGoal || !g) return;
          if (!report) {
            g.status = 'paused';
            policy.notice = 'goal-report-missing';
            return;
          }
          g.noProgress = report.progress === g.progress ? g.noProgress + 1 : 0;
          g.progress = report.progress;
          g.evidence = report.evidence;
          if (report.status === 'completed' && report.evidence.length) g.status = 'completed';
          else if (report.status !== 'continue' || g.noProgress >= 2) {
            g.status = 'blocked';
            policy.notice = 'goal-needs-review';
          } else this.enqueueGoal(s, id, policy);
        }
      });
    });
  }
  private remember(s: State, key: string) {
    s.events = [...s.events.slice(-299), key];
  }
  private async wait(jobId: string, reason: string) {
    await this.store.change((s) => {
      const j = s.jobs.find((j) => j.id === jobId);
      if (j && j.wait !== reason) {
        j.wait = reason;
        j.revision++;
      }
    });
  }
  private async pauseQuota(jobId: string, reason: string) {
    await this.store.change((s) => {
      const j = s.jobs.find((j) => j.id === jobId)!;
      j.paused = true;
      j.manual = false;
      j.dueAt = null;
      j.wait = reason;
      j.revision++;
      s.policies[j.agentId].notice = reason;
    });
    this.stable.delete(this.store.state.jobs.find((j) => j.id === jobId)!.agentId);
  }
  private async quota(job: Job, agent: Agent, force = false) {
    const key = providerKey(agent);
    let cached = this.usage.get(job.agentId);
    if (force || !cached || cached.key !== key || this.now() - cached.at >= 60_000) {
      if (this.now() - this.lastUsageAttempt < 5000) {
        await this.wait(job.id, 'quota-poll-wait');
        return false;
      }
      this.lastUsageAttempt = this.now();
      // Record the attempt before awaiting so failures never cause a rapid polling loop.
      cached = { key, at: this.now(), reports: [] };
      this.usage.set(job.agentId, cached);
      try {
        cached.reports = await this.bridge.usage(job.agentId);
      } catch (error) {
        await this.pauseQuota(
          job.id,
          error instanceof Error && classifyError(error.message) === 'auth'
            ? 'quota-auth'
            : 'quota-check-failed',
        );
        return false;
      }
    }
    const result = quotaState(
      cached.reports.some((r) => r.fetchedAt < Math.max(job.createdAt, job.quotaObservedAt ?? 0))
        ? []
        : cached.reports,
      this.now(),
      job.quotaWindowIds,
    );
    if (result.kind === 'unknown') {
      await this.pauseQuota(job.id, result.reason);
      return false;
    }
    await this.store.change((s) => {
      const j = s.jobs.find((j) => j.id === job.id)!;
      if (j.quotaIds.length && JSON.stringify(j.quotaIds) !== JSON.stringify(result.ids)) {
        this.pause(s, j.agentId, 'quota-account-changed');
        return;
      }
      j.quotaIds = result.ids;
      j.quotaWindowIds = result.windowIds;
      if (result.kind === 'exhausted') {
        j.sawExhausted = true;
        j.quotaObservedAt = Math.max(
          j.quotaObservedAt ?? 0,
          ...cached!.reports.map((r) => r.fetchedAt),
        );
        j.dueAt = null;
        j.wait = 'quota-exhausted';
        return;
      }
      if (!j.sawExhausted && !(j.source === 'user' && j.trigger.kind === 'quota')) {
        j.wait = 'quota-awaiting-exhaustion';
        return;
      }
      if (j.dueAt === null && (j.trigger.kind === 'quota' || j.quotaHold)) {
        const delay = j.trigger.kind === 'quota' ? j.trigger.delay : s.policies[j.agentId].delay;
        j.sampledDelayMs ??= Math.round(
          (delay.min + (delay.max - delay.min) * this.random()) * 60_000,
        );
        j.dueAt = Math.max(
          this.now() + j.sampledDelayMs,
          j.trigger.kind === 'at' ? j.trigger.at : 0,
        );
      }
      j.wait = 'time';
    });
    return result.kind === 'available';
  }
  async tick() {
    await Promise.all([this.launches.tick(), this.tickMessages()]);
  }
  private tickMessages() {
    return this.serial(async () => {
      if (this.store.fault) throw new Error(this.store.fault);
      const ids = [
        ...new Set([
          ...this.store.state.jobs
            .filter((j) => queued(j) || j.status === 'unknown')
            .map((j) => j.agentId),
          ...Object.entries(this.store.state.policies)
            .filter(([, p]) => p.goal?.status === 'active')
            .map(([id]) => id),
        ]),
      ];
      for (const id of ids) {
        if (this.stopped) return;
        try {
          await this.step(id);
          this.error = null;
        } catch {
          this.error = 'Connection or storage unavailable. Delivery stopped.';
          this.stable.delete(id);
        }
      }
    });
  }
  private async step(id: string) {
    const epoch = this.epoch;
    const agent = await this.bridge.snapshot(id);
    // An ambiguous send blocks this session, even if later queued messages are ready.
    const unknown = this.store.state.jobs.find((j) => j.agentId === id && j.status === 'unknown');
    if (unknown) {
      if (await this.bridge.hasMessage(id, unknown.messageId))
        await this.store.change((s) => {
          const j = s.jobs.find((j) => j.id === unknown.id)!;
          j.status = 'sent';
          j.wait = 'receipt-found';
          j.revision++;
          this.pause(s, id, 'receipt-found-review');
        });
      return;
    }
    const observed = await this.observe(agent);
    const goal = this.store.state.policies[id]?.goal;
    if (goal?.status === 'active' && goal.expiresAt <= this.now()) {
      await this.store.change((s) => {
        s.policies[id].goal!.status = 'budget';
        this.cancelAuto(s, id);
      });
    }
    const p = this.store.state.policies[id];
    if (!p || agent.archivedAt || agent.internal) return;
    const first = this.store.state.jobs.find((j) => j.agentId === id && queued(j));
    // Explicit deadlines must not wait behind idle, paused, quota or later-timed messages.
    // Preserve queue order among ready deadlines; other work retains FIFO semantics.
    let job =
      this.store.state.jobs.find(
        (j) =>
          j.agentId === id &&
          queued(j) &&
          timedMessage(j) &&
          !j.paused &&
          !j.quotaHold &&
          (j.manual || (p.automatic && !p.paused)) &&
          j.dueAt !== null &&
          j.dueAt <= this.now(),
      ) ?? (observed || (first && scheduledMessage(first) && first.manual) ? first : undefined);
    if (!job) return;
    const timed = timedMessage(job);
    const authorized = scheduledMessage(job) && job.manual;
    if (job.expiresAt <= this.now()) {
      await this.store.change((s) => {
        const j = s.jobs.find((j) => j.id === job!.id)!;
        j.status = 'expired';
        j.revision++;
      });
      return;
    }
    if ((p.paused && !authorized) || job.paused) {
      await this.wait(
        job.id,
        job.paused ? (job.wait.startsWith('quota-') ? job.wait : 'paused') : p.notice || 'paused',
      );
      return;
    }
    if (job.goalId) {
      const g = p.goal;
      if (
        !g ||
        g.id !== job.goalId ||
        g.status !== 'active' ||
        g.turns >= g.maxTurns ||
        g.expiresAt <= this.now()
      ) {
        await this.store.change((s) => {
          this.cancelAuto(s, id);
          if (s.policies[id].goal?.status === 'active') s.policies[id].goal!.status = 'budget';
        });
        return;
      }
    }
    if ((job.trigger.kind === 'quota' || job.quotaHold) && !(await this.quota(job, agent))) return;
    job = this.store.state.jobs.find((j) => j.id === job!.id)!;
    if (
      (this.store.state.policies[id].paused && !(scheduledMessage(job) && job.manual)) ||
      job.dueAt === null ||
      job.dueAt > this.now()
    ) {
      await this.wait(job.id, 'time');
      return;
    }
    if (!p.automatic && !job.manual) {
      await this.wait(job.id, 'approval');
      return;
    }
    if (agent.providerUnavailable || agent.pendingPermissions.length || (!timed && !idle(agent))) {
      this.stable.delete(id);
      await this.wait(
        job.id,
        agent.pendingPermissions.length
          ? 'permission'
          : agent.providerUnavailable
            ? 'provider-unavailable'
            : 'busy',
      );
      return;
    }
    if (!timed) {
      const value = fingerprint(agent);
      const prior = this.stable.get(id);
      if (!prior || prior.value !== value) {
        this.stable.set(id, { value, at: this.now() });
        await this.wait(job.id, 'idle-check');
        return;
      }
      if (this.now() - prior.at < 2000) return;
    }
    // Re-check every quota window immediately before dispatch. A countdown or an older
    // positive report cannot establish that all limits are still available now.
    if (job.trigger.kind === 'quota' || job.quotaHold) {
      if (!(await this.quota(job, agent, true))) return;
      job = this.store.state.jobs.find((j) => j.id === job!.id)!;
      if (
        job.paused ||
        (this.store.state.policies[id].paused && !(scheduledMessage(job) && job.manual)) ||
        job.dueAt === null ||
        job.dueAt > this.now()
      )
        return;
    }
    if (this.epoch !== epoch || this.stopped) return;
    const jobId = job.id;
    await this.store.change((s) => {
      const j = s.jobs.find((j) => j.id === jobId)!;
      const goal = j.goalId ? s.policies[id].goal : null;
      // The exact payload and stable message ID are durable before any send is attempted.
      if (goal && j.source !== 'goal') goal.nonce = randomUUID();
      j.frozenText = goal && j.source !== 'goal' ? goalPrompt(goal, j.text) : j.text;
      j.status = 'dispatching';
      j.wait = 'sending';
      j.revision++;
      if (goal) goal.turns++;
    });
    job = this.store.state.jobs.find((j) => j.id === jobId)!;
    try {
      await this.bridge.send(
        id,
        job.frozenText!,
        job.messageId,
        agent,
        () => !this.stopped && !this.store.fault && this.epoch === epoch,
        timed ? 'at' : 'idle',
      );
      await this.store.change((s) => {
        const j = s.jobs.find((j) => j.id === jobId)!;
        j.status = 'sent';
        j.wait = 'sent';
        j.revision++;
      });
      const after = await this.bridge.snapshot(id);
      if (!(await this.bridge.latestIs(id, job.messageId))) {
        await this.store.change((s) => this.pause(s, id, 'session-changed'));
        return;
      }
      await this.store.change((s) => {
        s.policies[id].observedUserAt = after.lastUserMessageAt;
        s.policies[id].providerKey = providerKey(after);
      });
    } catch (error) {
      await this.store.change((s) => {
        const j = s.jobs.find((j) => j.id === jobId)!;
        if (j.status === 'sent') {
          this.pause(s, id, 'delivery-review');
          return;
        }
        if (error instanceof PreconditionChanged) {
          j.status = 'queued';
          j.wait = timed ? 'queued' : 'idle-check';
          if (j.goalId && s.policies[id].goal) s.policies[id].goal!.turns--;
        } else {
          j.status = 'unknown';
          j.wait = 'outcome-unknown';
          this.pause(s, id, 'outcome-unknown');
        }
        j.revision++;
      });
    } finally {
      this.stable.delete(id);
    }
  }
}
