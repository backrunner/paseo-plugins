import type { PluginClientContext } from '@getpaseo/plugin/client';
import { QueuePanel, GoalPanel } from './client/panel';
import { AutomationSettings } from './client/settings';
import { registerEntries } from './client/entries';
import { messages } from './client/messages';
import {
  clearClientState,
  drafts,
  commandRequests,
  retain,
  focus,
  requestId,
  queueChanged,
  settingsTargets,
} from './client/drafts';
import { parseSend } from './shared/commands';
import * as api from './shared/contracts';

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: 'automation',
    title: messages.message('automation'),
    icon: 'SlidersHorizontal',
    Component: AutomationSettings,
  });
  client.addAgentPanel({
    id: 'goal',
    title: messages.message('goal'),
    icon: 'Flag',
    Component: GoalPanel,
  });
  client.addAgentPanel({
    id: 'queue',
    title: messages.message('queue'),
    icon: 'ListOrdered',
    Component: QueuePanel,
  });
  client.addCommandCenterItem({
    id: 'queue',
    title: messages.message('queue'),
    icon: 'ListOrdered',
    context: 'agent',
    onSelect: ({ openPanel }) => openPanel('queue'),
  });
  client.addSlashCommand({
    name: 'evo-queue',
    description: messages.message('queue'),
    argumentHint: '',
    context: 'agent',
    onSubmit({ agent, paseo, openPanel }) {
      focus(`${paseo.agents.ref(agent.id).address.serverId}:${agent.id}`, { section: 'queue' });
      openPanel('queue');
    },
  });
  client.addSlashCommand({
    name: 'evo-send',
    description: messages.message('send'),
    argumentHint: 'idle|at <ISO>|after-quota <2-5m> -- message',
    context: 'agent',
    async onSubmit({ args, agent, paseo, rpc, openPanel }) {
      const key = `${paseo.agents.ref(agent.id).address.serverId}:${agent.id}`;
      retain(key, `/evo-send ${args}`);
      focus(key, { section: 'queue' });
      openPanel('queue');
      const input = parseSend(args);
      if (commandRequests.get(key)?.payload !== args)
        commandRequests.set(key, { payload: args, id: requestId() });
      await rpc(api.add, { agentId: agent.id, requestId: commandRequests.get(key)!.id, ...input });
      drafts.delete(key);
      commandRequests.delete(key);
      queueChanged();
    },
  });
  client.addSlashCommand({
    name: 'evo-retry',
    description: messages.message('retry'),
    argumentHint: '',
    context: 'agent',
    onSubmit({ agent, paseo, openSettings }) {
      settingsTargets.set(paseo.agents.ref(agent.id).address.serverId, agent.id);
      openSettings('automation');
    },
  });
  client.addSlashCommand({
    name: 'evo-goal',
    description: messages.message('goal'),
    argumentHint: '[objective]',
    context: 'agent',
    onSubmit({ args, agent, paseo, openPanel }) {
      focus(`${paseo.agents.ref(agent.id).address.serverId}:${agent.id}`, {
        section: 'goal',
        objective: args,
      });
      openPanel('goal');
    },
  });
  const removeEntries = registerEntries(client);
  return () => {
    removeEntries();
    clearClientState();
  };
}
