import type { PluginClientContext, PluginButtonRegistration } from '@getpaseo/plugin/client';
import type { PluginText } from '@getpaseo/plugin';
import { SchedulePopover, QueuePopover } from './panel';
import { messages } from './messages';
import { watchQueue } from './drafts';
import * as api from '../shared/contracts';

/** One lightweight count request per host, not one provider query per conversation. */
export function registerEntries(client: PluginClientContext) {
  const lifetime = new AbortController();
  const entries = new Map<
    string,
    {
      workspaceId: string;
      schedule: PluginButtonRegistration<PluginText>;
      queue: PluginButtonRegistration<PluginText>;
    }
  >();
  let counts: Record<string, number> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let refreshAgain = false;
  const remove = (id: string) => {
    const item = entries.get(id);
    item?.schedule.remove();
    item?.queue.remove();
    entries.delete(id);
  };
  const present = (id: string) => {
    const count = counts[id] ?? 0;
    entries.get(id)?.queue.update({
      visible: count > 0,
      label: messages.message('pending', { count }),
    });
  };
  const refresh = async () => {
    if (lifetime.signal.aborted) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    clearTimeout(timer);
    try {
      if (entries.size) {
        const result = await client.rpc(api.counts, {});
        if (!lifetime.signal.aborted) {
          counts = result;
          entries.forEach((_item, id) => present(id));
        }
      }
    } catch {
      // An unavailable host is not proof that a previously visible queue is empty.
    } finally {
      refreshing = false;
      if (!lifetime.signal.aborted) {
        if (refreshAgain) {
          refreshAgain = false;
          void refresh();
        } else timer = setTimeout(() => void refresh(), 5000);
      }
    }
  };
  const register = (agent: {
    id: string;
    workspaceId?: string | null;
    archivedAt?: string | null;
  }) => {
    if (lifetime.signal.aborted) return;
    if (!agent.workspaceId || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    if (entries.get(agent.id)?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    const { id: agentId, workspaceId } = agent;
    const schedule = client.addComposerPill({
      id: 'schedule',
      workspaceId,
      agentId,
      button: {
        title: messages.message('later'),
        label: messages.message('later'),
        icon: 'Clock',
        behavior: { kind: 'popover', Content: SchedulePopover },
      },
    });
    try {
      const queue = client.addComposerPill({
        id: 'queue',
        workspaceId,
        agentId,
        button: {
          title: messages.message('queue'),
          label: messages.message('queue'),
          icon: 'ListOrdered',
          visible: false,
          behavior: { kind: 'popover', Content: QueuePopover },
        },
      });
      entries.set(agentId, { workspaceId, schedule, queue });
      present(agentId);
    } catch (error) {
      schedule.remove();
      throw error;
    }
  };
  const unwatch = watchQueue(() => void refresh());
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      if (lifetime.signal.aborted) return;
      subscription.subscribe({
        snapshot: ({ entries: agents }) => {
          if (lifetime.signal.aborted) return;
          const ids = new Set(agents.map(({ agent }) => agent.id));
          for (const id of entries.keys()) if (!ids.has(id)) remove(id);
          agents.forEach(({ agent }) => register(agent));
          void refresh();
        },
        update: (event) => {
          if (lifetime.signal.aborted || event.type !== 'agent_update') return;
          if (event.payload.kind === 'upsert') register(event.payload.agent);
          else remove(event.payload.agentId);
        },
      });
    })
    .catch(() => {
      if (!lifetime.signal.aborted)
        console.error(
          'SubscriptionEvo composer controls unavailable. Open Evo from the Command Center.',
        );
    });
  return () => {
    lifetime.abort();
    clearTimeout(timer);
    unwatch();
    for (const id of entries.keys()) remove(id);
  };
}
