import type { PluginServerContext, PluginSettingsState } from '@getpaseo/plugin/server';
import { join } from 'node:path';
import * as rpc from './shared/contracts';
import { freshState, LaunchSummary } from './shared/model';
import { inspectBinding, LocalBridge } from './server/bridge';
import { Store } from './server/store';
import { Engine } from './server/engine';

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(rpc.connection);
  let engine: Engine | null = null;
  let error: string | null = null;
  let home = '';
  let closed = false;
  let generation = 0;
  let configuration: Promise<void> = Promise.resolve();
  const configure = (state: PluginSettingsState<typeof rpc.connection.schema>) => {
    const token = ++generation;
    engine?.fence();
    engine?.launches.stop();
    configuration = configuration
      .catch(() => {})
      .then(async () => {
        const old = engine;
        engine = null;
        await old?.stop();
        if (closed || token !== generation) return;
        home = '';
        error = null;
        if (state.status !== 'ready') {
          error = 'Connection settings are invalid';
          return;
        }
        if (!state.values.home || !state.values.serverId) return;
        let store: Store | null = null;
        try {
          const binding = await inspectBinding(state.values.home);
          if (binding.serverId !== state.values.serverId) throw new Error('Wrong daemon');
          home = binding.home;
          store = new Store(join(home, 'subscription-evo'));
          await store.open();
          if (closed || token !== generation) {
            await store.close();
            return;
          }
          engine = new Engine(store, new LocalBridge(home, binding.serverId));
          engine.start();
        } catch {
          await store?.close();
          error =
            'Connection, version or queue storage could not be verified. Delivery is stopped.';
        }
      });
    return configuration;
  };
  const unsubscribe = settings.subscribe(configure);
  void settings
    .read()
    .then((state) => {
      if (generation === 0) return configure(state);
    })
    .catch(() => {
      error = 'Unable to read connection settings';
    });
  const requireEngine = async () => {
    await configuration;
    if (!engine || closed) throw new Error(error ?? 'Connect SubscriptionEvo to this host first');
    return engine;
  };
  server.handle(rpc.inspectConnection, async (input, { paseo }) => {
    const agent = paseo.agents.ref(input.agentId);
    await agent.refresh();
    const binding = await inspectBinding(input.home);
    if (binding.serverId !== agent.address.serverId)
      throw new Error('The directory belongs to a different host');
    return binding;
  });
  server.handle(rpc.view, async ({ agentId }) => {
    await configuration;
    return {
      state: engine?.snapshot(agentId) ?? freshState(),
      connected: Boolean(engine && !engine.store.fault),
      error: engine?.store.fault ?? engine?.error ?? error,
      home,
      now: Date.now(),
    };
  });
  server.handle(rpc.counts, async () => {
    await configuration;
    const counts: Record<string, number> = Object.create(null);
    for (const job of engine?.store.state.jobs ?? []) {
      if (['queued', 'dispatching', 'unknown'].includes(job.status))
        counts[job.agentId] = (counts[job.agentId] ?? 0) + 1;
    }
    return counts;
  });
  server.handle(rpc.launchList, async () => {
    await configuration;
    return {
      launches: (engine?.store.state.launches ?? []).map((launch) =>
        LaunchSummary.parse({
          ...launch,
          preview: launch.text.length > 320 ? `${launch.text.slice(0, 320)}…` : launch.text,
        }),
      ),
      connected: Boolean(engine && !engine.store.fault),
      error: engine?.store.fault ?? error,
    };
  });
  server.handle(rpc.launchConnect, async ({ home }, { paseo }) => {
    const binding = await inspectBinding(home);
    if (binding.serverId !== (await paseo.hosts.list()).self.serverId)
      throw new Error('The directory belongs to a different host');
    return binding;
  });
  server.handle(rpc.launchSubmit, async (input) => (await requireEngine()).launches.submit(input));
  server.handle(rpc.launchEdit, async (input) => (await requireEngine()).launches.edit(input));
  server.handle(rpc.add, async (input) => (await requireEngine()).add(input));
  server.handle(rpc.submit, async (input) => (await requireEngine()).submit(input));
  server.handle(rpc.edit, async (input) => (await requireEngine()).edit(input));
  server.handle(rpc.revise, async (input) => (await requireEngine()).revise(input));
  server.handle(rpc.policy, async (input) => (await requireEngine()).save(input));
  server.handle(rpc.goal, async (input) => (await requireEngine()).goal(input));
  server.handle(rpc.pause, async ({ agentId }) => {
    await (await requireEngine()).pauseAgent(agentId, 'user-paused');
    return { ok: true };
  });
  const guard = async (operation: () => Promise<unknown> | undefined) => {
    try {
      await operation();
    } catch {
      if (engine) engine.error = 'Event processing failed. Review the queue before continuing.';
    }
  };
  const remove = [
    server.addHook('agent.turn.before', async () => {
      engine?.fence();
    }),
    server.addHook('agent.turn.after', (event) => guard(() => engine?.ended(event))),
    server.addHook('agent.permission.before', ({ agent }) =>
      guard(() => engine?.pauseAgent(agent.id, 'permission')),
    ),
    server.addHook('agent.archive.after', ({ agent }) =>
      guard(() => engine?.pauseAgent(agent.id, 'archived')),
    ),
    server.addHook('agent.close.after', ({ agent }) =>
      guard(() => engine?.pauseAgent(agent.id, 'session-closed')),
    ),
  ];
  return async () => {
    closed = true;
    generation++;
    unsubscribe();
    remove.forEach((off) => off());
    engine?.fence();
    await configuration.catch(() => {});
    await engine?.stop();
    engine = null;
  };
}
