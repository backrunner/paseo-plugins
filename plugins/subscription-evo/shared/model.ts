import { z } from 'zod';

export const Delay = z
  .object({ min: z.number().int().min(0).max(1440), max: z.number().int().min(0).max(1440) })
  .refine((x) => x.max >= x.min, 'Invalid delay range');
export const Trigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('idle') }),
  z.object({ kind: z.literal('at'), at: z.number().finite().nonnegative() }),
  z.object({ kind: z.literal('quota'), delay: Delay }),
]);
export const Goal = z.object({
  id: z.string(),
  objective: z.string().min(1).max(8000),
  status: z.enum(['active', 'paused', 'blocked', 'completed', 'budget']),
  turns: z.number().int().nonnegative(),
  maxTurns: z.number().int().min(1).max(100),
  expiresAt: z.number(),
  nonce: z.string(),
  progress: z.string(),
  evidence: z.array(z.string()).max(20),
  noProgress: z.number().int().nonnegative(),
  nativeGoalOff: z.boolean(),
});
export const Policy = z.object({
  automatic: z.boolean().default(false),
  paused: z.boolean().default(false),
  nativeGoalOff: z.boolean().default(false),
  retry: z.boolean().default(false),
  quotaResume: z.boolean().default(false),
  continueText: z.string().trim().min(1).max(4000).default('continue'),
  delay: Delay.default({ min: 2, max: 5 }),
  maxRetries: z.number().int().min(1).max(10).default(5),
  retryCount: z.number().int().nonnegative().default(0),
  observedUserAt: z.string().nullable().default(null),
  providerKey: z.string().default(''),
  goal: Goal.nullable().default(null),
  notice: z.string().default(''),
});
export const Job = z.object({
  id: z.string(),
  requestId: z.string(),
  agentId: z.string(),
  text: z.string().min(1).max(16000),
  trigger: Trigger,
  source: z.enum(['user', 'retry', 'quota', 'goal']),
  goalId: z.string().nullable(),
  createdAt: z.number(),
  expiresAt: z.number(),
  dueAt: z.number().nullable(),
  status: z.enum(['queued', 'dispatching', 'sent', 'unknown', 'canceled', 'expired']),
  paused: z.boolean(),
  manual: z.boolean().default(false),
  deliveryRequested: z.boolean().default(false),
  lastEdit: z.object({ id: z.string(), signature: z.string() }).nullable().default(null),
  revision: z.number().int(),
  wait: z.string(),
  messageId: z.string(),
  frozenText: z.string().nullable(),
  quotaIds: z.array(z.string()),
  quotaWindowIds: z.array(z.string()).default([]),
  sawExhausted: z.boolean(),
  sampledDelayMs: z.number().nullable(),
  quotaHold: z.boolean().default(false),
  quotaObservedAt: z.number().nullable().default(null),
});
export const LaunchConfig = z.object({
  provider: z.string().min(1).max(200),
  model: z.string().min(1).max(500).nullable(),
  mode: z.string().min(1).max(200).nullable(),
  thinking: z.string().min(1).max(200).nullable(),
  options: z.record(z.string(), z.json()),
});
export const LaunchDetails = z.object({
  text: z.string().trim().min(1).max(16000),
  at: z.number().int().nonnegative().max(8_640_000_000_000_000),
});
export const LaunchInput = LaunchDetails.extend({
  requestId: z.string().min(1).max(200),
  workspaceId: z.string().min(1).max(500),
  directory: z.string().min(1).max(4096),
  config: LaunchConfig,
});
export const Launch = LaunchInput.extend({
  id: z.uuid(),
  agentId: z.uuid(),
  serverId: z.string(),
  workspaceName: z.string(),
  revision: z.number().int().nonnegative(),
  status: z.enum(['scheduled', 'paused', 'starting', 'started', 'unknown', 'canceled']),
  problem: z.enum(['workspace', 'connection', 'unconfirmed']).nullable(),
  receipt: z.string(),
});
export const LaunchSummary = Launch.pick({
  id: true,
  requestId: true,
  serverId: true,
  agentId: true,
  workspaceName: true,
  at: true,
  revision: true,
  status: true,
  problem: true,
}).extend({ preview: z.string() });
export const State = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  jobs: z.array(Job).max(500),
  launches: z.array(Launch).max(500).default([]),
  policies: z.record(z.string(), Policy),
  events: z.array(z.string()).max(300),
});
export type State = z.infer<typeof State>;
export type Job = z.infer<typeof Job>;
export type Launch = z.infer<typeof Launch>;
export type LaunchSummary = z.infer<typeof LaunchSummary>;
export type Policy = z.infer<typeof Policy>;
export type Trigger = z.infer<typeof Trigger>;
export type Goal = z.infer<typeof Goal>;
export const freshState = (): State => ({
  version: 1,
  revision: 0,
  jobs: [],
  launches: [],
  policies: {},
  events: [],
});
export const freshPolicy = (): Policy => Policy.parse({});
export const queued = (job: Job) => job.status === 'queued';
export const timedMessage = (job: Job) => job.source === 'user' && job.trigger.kind === 'at';
export const scheduledMessage = (job: Job) => job.source === 'user' && job.trigger.kind !== 'idle';

export const GoalReport = z.object({
  nonce: z.string(),
  status: z.enum(['continue', 'completed', 'blocked', 'waiting-user']),
  progress: z.string().min(1).max(2000),
  evidence: z.array(z.string().min(1).max(1000)).max(20),
});
export function parseReport(text: string, nonce: string) {
  const match = /<evo-report>\s*(\{[\s\S]*?\})\s*<\/evo-report>\s*$/.exec(text);
  if (!match) return null;
  try {
    const result = GoalReport.parse(JSON.parse(match[1]));
    return result.nonce === nonce ? result : null;
  } catch {
    return null;
  }
}
export function goalPrompt(goal: Goal, prefix: string) {
  return `${prefix}\n\nObjective: ${goal.objective}\nPrevious progress: ${goal.progress || 'None recorded'}\nWork within the existing user instructions and permissions. Stop for questions, permissions, or blockers. Verify completion with concrete evidence. End this turn with exactly one report:\n<evo-report>{"nonce":"${goal.nonce}","status":"continue|completed|blocked|waiting-user","progress":"What changed and what remains","evidence":["Specific test result or artifact"]}</evo-report>\nUse one status value. Use completed only if the objective is achieved with evidence. Do not start another native goal loop.`;
}
