import { defineRpc, defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';
import {
  State,
  Trigger,
  Policy,
  Job,
  Launch,
  LaunchSummary,
  LaunchInput,
  LaunchDetails,
} from './model';

export const connection = defineSettings({
  id: 'connection',
  scope: 'host',
  version: 1,
  schema: z.object({
    home: z.string().max(4096).default(''),
    serverId: z.string().max(200).default(''),
  }),
});
const id = z.string().min(1).max(200);
export const inspectConnection = defineRpc({
  name: 'connection.inspect',
  input: z.object({ home: z.string().max(4096), agentId: id }),
  output: z.object({ home: z.string(), serverId: z.string() }),
});
export const view = defineRpc({
  name: 'queue.view',
  input: z.object({ agentId: id }),
  output: z.object({
    state: State,
    connected: z.boolean(),
    error: z.string().nullable(),
    home: z.string(),
    now: z.number(),
  }),
});
/** Counts only; opening or refreshing an entry never reads provider state. */
export const counts = defineRpc({
  name: 'queue.counts',
  input: z.object({}),
  output: z.record(z.string(), z.number().int().nonnegative()),
});
export const launchList = defineRpc({
  name: 'launch.list',
  input: z.object({}),
  output: z.object({
    launches: z.array(LaunchSummary),
    connected: z.boolean(),
    error: z.string().nullable(),
  }),
});
export const launchConnect = defineRpc({
  name: 'launch.connect',
  input: z.object({ home: z.string().max(4096) }),
  output: inspectConnection.output,
});
export const launchSubmit = defineRpc({
  name: 'launch.submit',
  input: LaunchInput,
  output: z.union([z.object({ id }), z.object({ rejected: z.string() })]),
});
export const launchEdit = defineRpc({
  name: 'launch.edit',
  input: z.object({
    id,
    revision: z.number().int().nonnegative(),
    action: z.enum(['pause', 'begin-edit', 'resume', 'cancel', 'update', 'check']),
    details: LaunchDetails.optional(),
  }),
  output: z.object({ launch: Launch }),
});
export const add = defineRpc({
  name: 'queue.add',
  input: z.object({
    agentId: id,
    requestId: id,
    text: z.string().trim().min(1).max(16000),
    trigger: Trigger,
    allowDelivery: z.boolean().optional(),
  }),
  output: z.object({ id: z.string() }),
});
/** Explicit rejection can unlock an editor; an RPC failure cannot. Keep queue.add compatible. */
export const submit = defineRpc({
  name: 'queue.submit',
  input: add.input,
  output: z.union([add.output, z.object({ rejected: z.string() })]),
});
export const edit = defineRpc({
  name: 'queue.edit',
  input: z.object({
    agentId: id,
    id,
    revision: z.number().int(),
    action: z.enum([
      'cancel',
      'withdraw',
      'begin-edit',
      'pause',
      'resume',
      'release',
      'up',
      'edit',
    ]),
    text: z.string().trim().min(1).max(16000).optional(),
    trigger: Trigger.optional(),
    requestId: id.optional(),
    allowDelivery: z.boolean().optional(),
  }),
  output: z.object({ ok: z.boolean(), job: Job.optional() }),
});
/** Editing uses a receipt so a lost acknowledgement cannot schedule the message twice. */
export const revise = defineRpc({
  name: 'queue.revise',
  input: edit.input.extend({
    action: z.literal('edit'),
    requestId: id,
    text: z.string().trim().min(1).max(16000),
    trigger: Trigger,
    allowDelivery: z.boolean(),
  }),
  output: z.union([edit.output, z.object({ rejected: z.string() })]),
});
export const policy = defineRpc({
  name: 'policy.save',
  input: z.object({
    agentId: id,
    revision: z.number().int(),
    values: Policy.pick({
      automatic: true,
      paused: true,
      nativeGoalOff: true,
      retry: true,
      quotaResume: true,
      continueText: true,
      delay: true,
      maxRetries: true,
    }),
  }),
  output: z.object({ ok: z.boolean() }),
});
export const pause = defineRpc({
  name: 'queue.pause',
  input: z.object({ agentId: id }),
  output: z.object({ ok: z.boolean() }),
});
export const goal = defineRpc({
  name: 'goal.change',
  input: z.object({
    agentId: id,
    revision: z.number().int(),
    action: z.enum(['create', 'pause', 'resume', 'clear']),
    objective: z.string().trim().min(1).max(8000).optional(),
    maxTurns: z.number().int().min(1).max(100).default(10),
    hours: z.number().min(0.1).max(168).default(24),
    nativeGoalOff: z.boolean().default(false),
  }),
  output: z.object({ ok: z.boolean() }),
});
