import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import Renderer, { act } from 'react-test-renderer';
import { evaluate, bundle, pluginRequire } from './bundles.mjs';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('server bundle initializes, exposes typed RPCs, stays inert until bound, and cleans up', async () => {
  const contribute = await evaluate('server');
  const handlers = new Map(),
    hooks = new Map();
  let subscribed = false;
  const settings = { status: 'ready', revision: '0', values: { home: '', serverId: '' } };
  const cleanup = contribute({
    registerSettings: () => ({
      read: async () => settings,
      subscribe: () => {
        subscribed = true;
        return () => {
          subscribed = false;
        };
      },
    }),
    handle: (contract, handler) => {
      handlers.set(contract.name, { contract, handler });
    },
    addHook: (name, handler) => {
      hooks.set(name, handler);
      return () => hooks.delete(name);
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const read = handlers.get('queue.view');
  const view = await read.handler({ agentId: 'simulation' });
  assert.equal(view.connected, false);
  assert.equal(view.state.jobs.length, 0);
  assert.ok(read.contract.output.safeParse(view).success);
  await assert.rejects(handlers.get('queue.add').handler({}), /Connect/);
  assert.equal(hooks.has('agent.open.before'), false);
  for (const handler of hooks.values()) {
    await handler({
      agent: { id: 'existing-running-session' },
      turnId: 'current-turn',
      outcome: { kind: 'failed', error: { message: 'usage limit reached' } },
    });
  }
  const afterEvents = await read.handler({ agentId: 'existing-running-session' });
  assert.equal(afterEvents.state.jobs.length, 0);
  assert.equal(Object.keys(afterEvents.state.policies).length, 0);
  await cleanup();
  assert.equal(subscribed, false);
  assert.equal(hooks.size, 0);
});

async function clientFixture({
  compact = false,
  dark = false,
  connected = true,
  surface = 'schedule',
  locale = 'en',
} = {}) {
  const translationSdk = pluginRequire('@getpaseo/plugin/client');
  const { PluginTranslationRuntime, PluginTranslationProvider } = pluginRequire(
    '@getpaseo/plugin/client/host',
  );
  const localeListeners = new Set();
  const translations = new PluginTranslationRuntime({
    getLocale: () => locale,
    subscribe: (fn) => {
      localeListeners.add(fn);
      return () => localeListeners.delete(fn);
    },
  });
  const query = pluginRequire('@tanstack/react-query');
  const queryClient = new query.QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  let panel,
    observer,
    countFailure = false;
  let openedPanels = 0;
  const panels = new Map(),
    settingsScreens = new Map(),
    openedSettings = [];
  let rejected = null;
  const slash = new Map(),
    pills = [],
    commands = [];
  let fail = false,
    request;
  const mutations = [],
    copied = [];
  const theme = {
    colors: {
      foreground: dark ? '#ededed' : '#111111',
      foregroundMuted: dark ? '#999999' : '#666666',
      surface0: dark ? '#111111' : '#ffffff',
      surface1: dark ? '#181818' : '#f9f9f9',
      surface2: dark ? '#242424' : '#eeeeee',
      border: dark ? '#333333' : '#dddddd',
      statusDanger: '#b93434',
      accent: '#6252cf',
      accentForeground: '#ffffff',
    },
  };
  const state = { version: 1, revision: 0, jobs: [], policies: {}, events: [] };
  const rpc = async (contract, input) => {
    if (contract.name === 'queue.counts') {
      if (countFailure) throw new Error('Host unavailable');
      const counts = {};
      for (const job of state.jobs)
        if (['queued', 'dispatching', 'unknown'].includes(job.status))
          counts[job.agentId] = (counts[job.agentId] ?? 0) + 1;
      return counts;
    }
    if (contract.name === 'queue.view')
      return {
        state: structuredClone({
          ...state,
          jobs: state.jobs.filter((j) => j.agentId === input.agentId),
        }),
        connected,
        error: null,
        home: '/fixture',
        now: Date.now(),
      };
    if (contract.name === 'queue.add' || contract.name === 'queue.submit') {
      request = input;
      if (rejected) return { rejected };
      if (fail === true) throw new Error('Simulated disconnect');
      let job = state.jobs.find((j) => j.requestId === input.requestId);
      if (!job) {
        job = {
          ...input,
          id: `job-${state.jobs.length}`,
          source: 'user',
          status: 'queued',
          revision: 0,
          wait: 'queued',
          manual: input.allowDelivery === true,
          paused: input.allowDelivery === false,
          dueAt: null,
        };
        state.jobs.push(job);
      }
      if (fail === 'after-write') throw new Error('Simulated lost acknowledgement');
      return { id: job.id };
    }
    if (contract.name === 'queue.edit' || contract.name === 'queue.revise') {
      mutations.push(input);
      if (fail === true) throw new Error('Simulated disconnect');
      const job = state.jobs.find((j) => j.id === input.id && j.agentId === input.agentId);
      if (!job || job.revision !== input.revision || job.status !== 'queued')
        throw new Error('Queue changed');
      if (input.action === 'begin-edit') {
        job.paused = true;
        job.manual = false;
      } else if (input.action === 'withdraw') {
        job.status = 'canceled';
        job.wait = 'withdrawn';
      } else if (input.action === 'pause') {
        job.paused = true;
        job.manual = false;
      } else if (input.action === 'release') {
        job.paused = false;
        job.manual = true;
      } else if (input.action === 'edit') {
        Object.assign(job, {
          text: input.text,
          trigger: input.trigger,
          manual: input.allowDelivery,
          paused: !input.allowDelivery,
          lastEdit: { id: input.requestId, signature: 'fixture' },
        });
      } else throw new Error(`Unexpected action: ${input.action}`);
      job.revision++;
      if (fail === 'after-write') throw new Error('Simulated lost acknowledgement');
      return { ok: true, job: structuredClone(job) };
    }
    throw new Error(`Unexpected mock RPC: ${contract.name}`);
  };
  const paseo = {
    agents: {
      ref: () => ({ address: { serverId: 'simulation' } }),
      list: async () => ({
        subscription: {
          subscribe: (value) => {
            observer = value;
            value.snapshot({ entries: [{ agent: { id: 'a', workspaceId: 'w' } }] });
          },
        },
      }),
    },
  };
  const text = (value) => (typeof value === 'string' ? value : 'Evo queue');
  const sdk = {
    defineTranslations: translationSdk.defineTranslations,
    useTranslation: translationSdk.useTranslation,
    useAgent: (_id, select) => select({ provider: 'codex' }),
    usePaseo: () => paseo,
    useRpc: (contract) => React.useCallback((input) => rpc(contract, input), [contract]),
    useSettings: () => ({
      status: 'ready',
      values: { home: '', serverId: '' },
      revision: '0',
      save: async () => true,
    }),
  };
  const primitive = (name) =>
    function Mock(props) {
      return React.createElement(name, props, props.children);
    };
  const native = Object.fromEntries(
    ['View', 'Text', 'Pressable'].map((name) => [name, primitive(name)]),
  );
  const ui = Object.fromEntries(
    [
      'ScrollView',
      'TextInput',
      'SettingsSection',
      'SettingsSwitch',
      'SettingsInput',
      'SettingsSelect',
      'Icon',
    ].map((name) => [name, primitive(name)]),
  );
  ui.copyText = async (value) => {
    copied.push(value);
  };
  const contribute = await evaluate('client', (name) =>
    name === '@getpaseo/plugin/client'
      ? sdk
      : name === '@getpaseo/plugin/client/ui'
        ? ui
        : name === 'react-native'
          ? native
          : pluginRequire(name),
  );
  const cleanup = contribute({
    paseo,
    rpc,
    addAgentPanel: (contribution) => {
      panels.set(contribution.id, contribution.Component);
      if (contribution.id === 'queue') panel = contribution.Component;
    },
    addSettingsScreen: (value) => settingsScreens.set(value.id, value.Component),
    addCommandCenterItem: (value) => commands.push(value),
    addSlashCommand: (value) => slash.set(value.name, value),
    addComposerPill: (value) => {
      pills.push(value);
      return {
        remove() {
          value.removed = true;
        },
        update(patch) {
          Object.assign(value.button, patch);
        },
      };
    },
    openPanel() {
      openedPanels++;
    },
  });
  await Promise.resolve();
  let renderer;
  let mountedTarget = surface;
  const tree = (target, agentId) => {
    const Component =
      target === 'settings'
        ? settingsScreens.get('automation')
        : target === 'goal'
          ? panels.get('goal')
          : target === 'panel'
            ? panel
            : pills.find((p) => p.id === target).button.behavior.Content;
    return React.createElement(
      query.QueryClientProvider,
      { client: queryClient },
      React.createElement(
        PluginTranslationProvider,
        { runtime: translations },
        React.createElement(Component, {
          theme,
          layout: { compact, platform: 'web' },
          host: { id: 'h' },
          context: 'agent',
          workspaceId: 'w',
          agentId,
          params: { agentId },
          close() {},
        }),
      ),
    );
  };
  const mount = async (target = surface, agentId = 'a') => {
    mountedTarget = target;
    await act(async () => {
      renderer = Renderer.create(tree(target, agentId));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  await mount();
  return {
    get renderer() {
      return renderer;
    },
    theme,
    state,
    settingsScreens,
    openedSettings,
    invokeSlash: async (name, args = '') => {
      await act(async () => {
        await slash.get(name).onSubmit({
          args,
          agent: { id: 'a' },
          paseo,
          rpc,
          openPanel: () => openedPanels++,
          openSettings: (id) => openedSettings.push(id),
        });
      });
    },
    setRejected: (value) => {
      rejected = value;
    },
    retarget: async (agentId) => {
      await act(async () => renderer.update(tree(mountedTarget, agentId)));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
    openCount: () => openedPanels,
    reopen: async (target = surface, agentId = 'a') => {
      await act(async () => renderer.unmount());
      await mount(target, agentId);
    },
    refresh: async (failCounts = false) => {
      countFailure = failCounts;
      await act(async () => {
        observer.snapshot({ entries: [{ agent: { id: 'a', workspaceId: 'w' } }] });
        await queryClient.invalidateQueries({ queryKey: ['evo-queue'] });
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
    slash,
    pills,
    commands,
    setFail: (v) => {
      fail = v;
    },
    request: () => request,
    mutations,
    copied,
    resolveText: translations.resolve,
    setLocale: async (value) => {
      await act(async () => {
        locale = value;
        localeListeners.forEach((fn) => fn());
      });
    },
    press: async (label) => {
      const button = renderer.root
        .findAllByType('Pressable')
        .find((n) => n.props.accessibilityLabel === label);
      assert.ok(button, label);
      await act(async () => {
        await button.props.onPress();
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    },
    dispose: async () => {
      await act(async () => renderer.unmount());
      cleanup();
      queryClient.clear();
      translations.dispose();
    },
  };
}

test('client bundle uses native themed controls in wide/compact and light/dark simulations', async () => {
  assert.ok((await bundle('client')).length > 0);
  for (const compact of [false, true])
    for (const dark of [false, true]) {
      const f = await clientFixture({ compact, dark });
      try {
        assert.equal(f.pills.length, 2);
        assert.equal(f.pills.find((p) => p.id === 'queue').button.visible, false);
        assert.ok(f.pills.every((p) => p.button.behavior.kind === 'popover'));
        assert.equal(f.openCount(), 0);
        assert.deepEqual([...f.slash.keys()], ['evo-queue', 'evo-send', 'evo-retry', 'evo-goal']);
        for (const text of f.renderer.root.findAllByType('Text'))
          assert.ok(text.props.style?.color, 'Every text uses theme color');
        assert.equal(
          f.renderer.root.findAllByType('ScrollView').length,
          0,
          'Host owns popup scrolling',
        );
        assert.equal(
          f.renderer.root
            .findAllByType('TextInput')
            .some((n) => n.props.accessibilityLabel === 'Message'),
          true,
        );
        assert.equal(f.renderer.root.findAllByType('SettingsSwitch').length, 0);
        assert.ok(
          f.renderer.root
            .findAllByType('Pressable')
            .every((n) => !['Automation', 'Goal'].includes(n.props.accessibilityLabel)),
        );
        assert.ok(f.settingsScreens.has('automation'));
        assert.ok(
          f.renderer.root
            .findAllByType('TextInput')
            .some((n) => n.props.accessibilityLabel === 'Date'),
        );
        assert.ok(
          f.renderer.root
            .findAllByType('TextInput')
            .some((n) => n.props.accessibilityLabel === 'Time'),
        );
      } finally {
        await f.dispose();
      }
      assert.equal(f.pills[0].removed, true);
    }
});

test('simulated queue RPC failure preserves input and retries with the same request ID', async () => {
  const f = await clientFixture();
  try {
    f.setFail(true);
    await act(async () =>
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message')
        .props.onChangeText('keep this message'),
    );
    await f.press('Queue without sending');
    const id = f.request().requestId;
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message').props.value,
      'keep this message',
    );
    f.setFail(false);
    await f.press('Queue without sending');
    assert.equal(f.request().requestId, id);
    assert.equal(f.request().allowDelivery, false);
    await f.press('Send later');
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message').props.value,
      '',
    );
  } finally {
    await f.dispose();
  }
});

test('unconfigured UI shows connection controls and no automation switches', async () => {
  const f = await clientFixture({ connected: false });
  try {
    assert.equal(f.renderer.root.findAllByType('SettingsSwitch').length, 0);
    assert.ok(
      f.renderer.root
        .findAllByType('TextInput')
        .some((n) => n.props.accessibilityLabel === 'Paseo home'),
    );
  } finally {
    await f.dispose();
  }
});

test('empty queue is hidden; pending and uncertain messages remain reachable across refresh failures', async () => {
  const f = await clientFixture();
  const entry = f.pills.find((p) => p.id === 'queue');
  try {
    assert.equal(entry.button.visible, false);
    f.state.jobs.push(
      { id: 'one', agentId: 'a', status: 'queued' },
      { id: 'two', agentId: 'a', status: 'unknown' },
      { id: 'three', agentId: 'other-agent', status: 'queued' },
      { id: 'four', agentId: 'a', status: 'sent' },
    );
    await f.refresh();
    assert.equal(entry.button.visible, true);
    assert.equal(f.resolveText(entry.button.label), 'Queue · 2');
    assert.equal(f.pills.length, 2, 'Directory refresh preserves the open popup registration');
    assert.ok(f.pills.every((p) => !p.removed));
    f.state.jobs.length = 0;
    await f.refresh(true);
    assert.equal(entry.button.visible, true, 'Connection failure does not imply an empty queue');
    await f.refresh();
    assert.equal(entry.button.visible, false);
    assert.equal(f.pills.find((p) => p.id === 'schedule').button.visible, undefined);
  } finally {
    await f.dispose();
  }
});

test('queue counts use the actual host translation runtime and update in both app languages', async () => {
  const f = await clientFixture();
  try {
    const entry = f.pills.find((p) => p.id === 'queue');
    f.state.jobs.push({ id: 'one', agentId: 'a', status: 'queued' });
    await f.refresh();
    assert.equal(f.resolveText(entry.button.label), 'Queue · 1');
    await f.setLocale('zh-CN');
    assert.equal(f.resolveText(entry.button.label), '队列 · 1');
    f.state.jobs.push({ id: 'two', agentId: 'a', status: 'queued' });
    await f.refresh();
    assert.equal(f.resolveText(entry.button.label), '队列 · 2');
    f.state.jobs.length = 0;
    await f.refresh();
    assert.equal(entry.button.visible, false);
  } finally {
    await f.dispose();
  }
});

test('composer popover schedules quota recovery without a slash command or workspace tab', async () => {
  const f = await clientFixture();
  try {
    await act(async () => {
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message')
        .props.onChangeText('resume this conversation');
      f.renderer.root
        .findAllByType('Pressable')
        .find((n) => n.props.accessibilityLabel === 'After quota')
        .props.onPress();
    });
    await f.press('Schedule message');
    assert.deepEqual(f.request().trigger, { kind: 'quota', delay: { min: 2, max: 5 } });
    assert.equal(f.request().allowDelivery, true);
    assert.equal(f.request().agentId, 'a');
    assert.equal(f.request().text, 'resume this conversation');
    assert.equal(f.openCount(), 0);
    assert.equal(f.pills.find((p) => p.id === 'queue').button.visible, true);
    await f.invokeSlash('evo-retry');
    await f.reopen('settings');
    assert.ok(
      f.renderer.root.findAllByType('SettingsSwitch').every((n) => n.props.value === false),
    );
  } finally {
    await f.dispose();
  }
});

test('closing and reopening a failed schedule keeps its draft and request ID within the same conversation', async () => {
  const f = await clientFixture();
  try {
    await act(async () =>
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message')
        .props.onChangeText('retain me'),
    );
    f.setFail(true);
    await f.press('Schedule message');
    const id = f.request().requestId;
    await f.reopen('schedule', 'other-agent');
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message').props.value,
      '',
    );
    await f.reopen();
    const input = f.renderer.root
      .findAllByType('TextInput')
      .find((n) => n.props.accessibilityLabel === 'Message');
    assert.equal(input.props.value, 'retain me');
    assert.equal(
      input.props.editable,
      false,
      'Unconfirmed payload cannot be changed into a second request',
    );
    f.setFail(false);
    await f.press('Schedule message');
    assert.equal(f.request().requestId, id);
    assert.equal(f.state.jobs.length, 1);
    await f.reopen();
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message').props.value,
      '',
    );
  } finally {
    await f.dispose();
  }
});

test('a past time is rejected before submission and leaves the form editable', async () => {
  const f = await clientFixture();
  try {
    await act(async () => {
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message')
        .props.onChangeText('later');
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Date')
        .props.onChangeText('2000-01-01');
    });
    await f.press('Schedule message');
    assert.equal(f.request(), undefined);
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message').props.editable,
      true,
    );
    await f.press('In 10 min');
    await f.press('Schedule message');
    assert.equal(f.request().text, 'later');
  } finally {
    await f.dispose();
  }
});

test('a definite server rejection unlocks correction, while a lost reply is reconciled from the queue', async () => {
  const f = await clientFixture();
  try {
    await act(async () =>
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message')
        .props.onChangeText('retained'),
    );
    f.setRejected('Session unavailable');
    await f.press('Schedule message');
    const rejectedId = f.request().requestId;
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message').props.editable,
      true,
    );
    f.setRejected(null);
    f.setFail('after-write');
    await f.press('Schedule message');
    assert.notEqual(f.request().requestId, rejectedId);
    assert.equal(f.state.jobs.length, 1);
    await f.refresh();
    await f.press('Send later');
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message').props.value,
      '',
    );
    assert.equal(f.state.jobs.length, 1);
  } finally {
    await f.dispose();
  }
});

test('retargeting a mounted popup cannot carry a draft into another conversation', async () => {
  const f = await clientFixture();
  try {
    await act(async () =>
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message')
        .props.onChangeText('conversation a only'),
    );
    await f.retarget('b');
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message').props.value,
      '',
    );
    await f.retarget('a');
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Message').props.value,
      'conversation a only',
    );
    await f.press('Schedule message');
    assert.equal(f.request().agentId, 'a');
  } finally {
    await f.dispose();
  }
});

test('continuation is configured only in plugin settings; evo-goal opens its own guarded form', async () => {
  const f = await clientFixture();
  try {
    assert.equal(f.renderer.root.findAllByType('SettingsSwitch').length, 0);
    await f.reopen('settings');
    assert.equal(
      f.renderer.root.findAllByType('SettingsSwitch').length,
      0,
      'No conversation is selected implicitly',
    );
    await f.invokeSlash('evo-retry');
    assert.deepEqual(f.openedSettings, ['automation']);
    await f.reopen('settings');
    assert.equal(f.renderer.root.findAllByType('SettingsSwitch').length, 4);
    assert.ok(
      f.renderer.root.findAllByType('SettingsSwitch').every((n) => n.props.value === false),
    );
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .some((n) => n.props.accessibilityLabel === 'Message'),
      false,
    );
    await f.invokeSlash('evo-goal', 'finish the reviewed task');
    await f.reopen('goal');
    assert.equal(f.renderer.root.findAllByType('SettingsSwitch').length, 1);
    assert.equal(
      f.renderer.root
        .findAllByType('TextInput')
        .find((n) => n.props.accessibilityLabel === 'Objective').props.value,
      'finish the reviewed task',
    );
    assert.equal(
      f.renderer.root
        .findAllByType('Pressable')
        .find((n) => n.props.accessibilityLabel === 'Create goal').props.disabled,
      true,
    );
    assert.equal(f.state.jobs.length, 0, 'Opening settings or a goal form never creates work');
  } finally {
    await f.dispose();
  }
});

const messageInput = (f) =>
  f.renderer.root.findAllByType('TextInput').find((n) => n.props.accessibilityLabel === 'Message');
const enterMessage = (f, text) => act(async () => messageInput(f).props.onChangeText(text));
const buttons = (f) =>
  f.renderer.root.findAllByType('Pressable').map((n) => n.props.accessibilityLabel);

test('queue editing pauses before opening, keeps a separate draft and restores it across popup and conversation changes', async () => {
  const f = await clientFixture();
  try {
    await enterMessage(f, 'scheduled original');
    await f.press('After quota');
    await f.press('Schedule message');
    const job = f.state.jobs[0];
    const originalId = job.id;
    await f.press('Send later');
    await enterMessage(f, 'unrelated new draft');
    await f.press('Queue 1');
    await f.press('Edit');
    assert.equal(f.mutations[0].action, 'begin-edit');
    assert.equal(job.paused, true);
    assert.equal(job.manual, false);
    assert.equal(messageInput(f).props.value, 'scheduled original');
    await enterMessage(f, 'revised content');
    await f.retarget('another-agent');
    assert.equal(messageInput(f).props.value, '');
    await f.retarget('a');
    assert.equal(messageInput(f).props.value, 'revised content');
    await f.reopen('queue');
    assert.equal(
      messageInput(f),
      undefined,
      'The queue entry always opens its list, including while an edit is saved',
    );
    await f.press('Continue editing');
    assert.equal(messageInput(f).props.value, 'revised content');
    await f.press('Save and schedule');
    assert.equal(f.state.jobs.length, 1);
    assert.equal(job.id, originalId);
    assert.equal(job.text, 'revised content');
    assert.deepEqual(job.trigger, { kind: 'quota', delay: { min: 2, max: 5 } });
    assert.equal(job.manual, true);
    assert.equal(job.paused, false);
    await f.press('Send later');
    assert.equal(messageInput(f).props.value, 'unrelated new draft');
  } finally {
    await f.dispose();
  }
});

test('discarding an edit leaves the original paused; withdrawing removes it and keeps its history', async () => {
  const f = await clientFixture();
  try {
    await enterMessage(f, 'original');
    await f.press('Schedule message');
    await f.press('Edit');
    await enterMessage(f, 'unsaved');
    await f.press('Discard edit');
    assert.equal(f.state.jobs[0].text, 'original');
    assert.equal(f.state.jobs[0].paused, true);
    await f.press('Withdraw');
    assert.equal(f.state.jobs[0].status, 'canceled');
    assert.equal(f.pills.find((p) => p.id === 'queue').button.visible, false);
    assert.ok(!buttons(f).includes('Withdraw'));
    await f.press('Delivery history');
    assert.ok(JSON.stringify(f.renderer.toJSON()).includes('Withdrawn'));
    assert.ok(buttons(f).includes('Copy full message'));
  } finally {
    await f.dispose();
  }
});

test('a failed edit hold never opens an unsafe editor and a lost save acknowledgement reconciles', async () => {
  const f = await clientFixture();
  try {
    await enterMessage(f, 'original');
    await f.press('Schedule message');
    f.setFail(true);
    await f.press('Edit');
    assert.equal(messageInput(f), undefined);
    assert.equal(f.state.jobs[0].paused, false);
    f.setFail(false);
    await f.press('Edit');
    await enterMessage(f, 'saved once');
    f.setFail('after-write');
    await f.press('Save paused');
    await f.refresh();
    assert.equal(messageInput(f), undefined);
    assert.equal(f.state.jobs.length, 1);
    assert.equal(f.state.jobs[0].text, 'saved once');
    assert.equal(f.state.jobs[0].paused, true);
    assert.equal(f.mutations.filter((m) => m.action === 'edit').length, 1);
  } finally {
    await f.dispose();
  }
});

test('unconfirmed edit locks its payload and reuses its receipt after reopening', async () => {
  const f = await clientFixture();
  try {
    await enterMessage(f, 'original');
    await f.press('Schedule message');
    await f.press('Edit');
    await enterMessage(f, 'retry safely');
    f.setFail(true);
    await f.press('Save paused');
    const attempted = f.mutations.at(-1);
    await f.reopen();
    assert.equal(messageInput(f).props.value, 'retry safely');
    assert.equal(messageInput(f).props.editable, false);
    f.setFail(false);
    await f.press('Save paused');
    assert.equal(f.mutations.at(-1).requestId, attempted.requestId);
    assert.equal(f.state.jobs.length, 1);
    assert.equal(f.state.jobs[0].paused, true);
  } finally {
    await f.dispose();
  }
});

test('dispatching and uncertain outcomes do not offer edit or withdrawal', async () => {
  const f = await clientFixture();
  try {
    await enterMessage(f, 'original');
    await f.press('Schedule message');
    for (const status of ['dispatching', 'unknown']) {
      f.state.jobs[0].status = status;
      await f.refresh();
      assert.ok(!buttons(f).includes('Edit'));
      assert.ok(!buttons(f).includes('Withdraw'));
      assert.equal(buttons(f).includes('Dismiss after review'), status === 'unknown');
    }
  } finally {
    await f.dispose();
  }
});

test('secondary queue actions stay reachable and preserve scheduling intent', async () => {
  const f = await clientFixture();
  try {
    await enterMessage(
      f,
      'The entire queued message stays available even when its preview is shortened.',
    );
    await f.press('Schedule message');
    assert.ok(buttons(f).includes('Edit'));
    assert.ok(buttons(f).includes('Withdraw'));
    assert.ok(!buttons(f).includes('Copy full message'));
    assert.ok(!buttons(f).includes('Delivery history'), 'No empty history action');
    await f.press('More actions');
    await f.press('Copy full message');
    assert.deepEqual(f.copied, [f.state.jobs[0].text]);
    await f.press('More actions');
    await f.press('Pause');
    assert.equal(f.state.jobs[0].paused, true);
    await f.press('More actions');
    await f.press('Allow scheduled delivery');
    assert.equal(f.state.jobs[0].paused, false);
    assert.equal(f.state.jobs[0].manual, true);
    assert.equal(f.state.jobs[0].trigger.kind, 'at');
    await f.press('More actions');
    await f.press('Show full message');
    assert.ok(
      f.renderer.root
        .findAllByType('Text')
        .some(
          (n) => n.props.children === f.state.jobs[0].text && n.props.numberOfLines === undefined,
        ),
    );
  } finally {
    await f.dispose();
  }
});

test('a concurrent queue change disables stale saves and reopening an edit pauses the latest revision', async () => {
  const f = await clientFixture();
  try {
    await enterMessage(f, 'original');
    await f.press('Schedule message');
    await f.press('Edit');
    await enterMessage(f, 'local changes');
    f.state.jobs[0].revision++;
    f.state.jobs[0].paused = false;
    await f.refresh();
    const save = f.renderer.root
      .findAllByType('Pressable')
      .find((n) => n.props.accessibilityLabel === 'Save and schedule');
    assert.equal(save.props.disabled, true);
    await f.press('Update edit version');
    assert.equal(f.state.jobs[0].paused, true);
    assert.equal(messageInput(f).props.value, 'local changes');
    await f.press('Save paused');
    assert.equal(f.state.jobs[0].text, 'local changes');
    assert.equal(f.state.jobs[0].paused, true);
  } finally {
    await f.dispose();
  }
});
