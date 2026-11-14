import { Trigger, type Trigger as TriggerType } from './model';
import { z } from 'zod';

export function parseSend(args: string): { text: string; trigger: TriggerType } {
  const delimiter = /\s--(?:\s|$)/.exec(args);
  if (!delimiter)
    throw new Error('Use: /evo-send idle|at <ISO time>|after-quota <2-5m> -- message');
  const condition = args.slice(0, delimiter.index).trim();
  const text = args.slice(delimiter.index + delimiter[0].length).trim();
  if (!text || text.length > 16000) throw new Error('Enter a message of 1–16000 characters');
  if (condition === 'idle') return { text, trigger: { kind: 'idle' } };
  if (condition.startsWith('at ')) {
    const time = condition.slice(3).trim();
    if (
      !z.iso.datetime({ offset: true }).safeParse(time).success ||
      !Number.isFinite(Date.parse(time))
    )
      throw new Error('Use an ISO date with timezone, for example 2026-11-16T09:30+08:00');
    return { text, trigger: Trigger.parse({ kind: 'at', at: Date.parse(time) }) };
  }
  const match = /^after-quota (\d+)(?:-(\d+))?m$/.exec(condition);
  if (match)
    return {
      text,
      trigger: Trigger.parse({
        kind: 'quota',
        delay: { min: Number(match[1]), max: Number(match[2] ?? match[1]) },
      }),
    };
  throw new Error('Choose idle, at <ISO time>, or after-quota <2-5m>');
}
