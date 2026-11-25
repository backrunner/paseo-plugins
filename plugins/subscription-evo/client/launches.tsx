import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import {
  useComposer,
  usePaseo,
  useRpc,
  useSettings,
  useTranslation,
  type PluginClientContext,
  type PluginComposerItemProps,
  type PluginScreenProps,
} from '@getpaseo/plugin/client';
import { Action, FlatList, Modal, SettingsSelect, TextInput } from '@getpaseo/plugin/client/ui';
import type { z } from 'zod';
import * as rpc from '../shared/contracts';
import { LaunchConfig, LaunchInput, type Launch, type LaunchSummary } from '../shared/model';
import { localTime, parseLocalTime } from '../shared/time';
import { requestId } from './drafts';
import { messages, useCopy } from './messages';
import { Button } from './panel';
import { QueueAction } from './queue';

const screenId = 'launches';
type Input = z.output<typeof LaunchInput>;
type Draft = Pick<Input, 'requestId' | 'config' | 'text'> & { pending?: Input };
type EditAction = z.output<typeof rpc.launchEdit.input>['action'];
type Appearance = Pick<PluginScreenProps, 'theme' | 'layout'>;

export function registerLaunches(client: PluginClientContext) {
  // Only the opaque review ID goes into the route. Keep prompts and settings in this installation.
  let draft: Draft | undefined;
  const remove = [
    client.addComposerItem({
      id: 'schedule-launch',
      Component: function ScheduleLaunch({ host }: PluginComposerItemProps) {
        const composer = useComposer();
        const { t } = useTranslation(messages);
        if (composer.context !== 'draft') return null;
        const text = composer.prompt.trim();
        return (
          <Action
            icon="Clock"
            title={t('launch')}
            disabled={!text || !composer.agent.provider}
            onPress={() => {
              const config = LaunchConfig.parse(composer.agent);
              draft = { requestId: requestId(), text, config };
              client.openScreen({ screenId, params: { draft: draft.requestId, hostId: host.id } });
            }}
          />
        );
      },
    }),
    client.addScreen({
      id: screenId,
      title: messages.message('launches'),
      Component: function ScheduledConversations(props) {
        const selected =
          props.params.draft === draft?.requestId && props.params.hostId === props.host.id
            ? draft
            : undefined;
        return (
          <LaunchScreen
            key={`${props.host.id}:${props.params.draft ?? ''}`}
            {...props}
            draft={selected}
          />
        );
      },
    }),
    client.addCommandCenterItem({
      id: screenId,
      icon: 'CalendarClock',
      title: messages.message('launches'),
      context: 'global',
      onSelect: ({ openScreen }) => openScreen({ screenId }),
    }),
  ];
  return () => {
    draft = undefined;
    remove.forEach((off) => off());
  };
}

function useLaunchStyles({ theme }: Appearance) {
  return {
    body: { color: theme.colors.foreground, fontSize: 14, lineHeight: 21 },
    hint: { color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 },
    error: { color: theme.colors.statusDanger, fontSize: 13 },
    row: {
      flexDirection: 'row' as const,
      flexWrap: 'wrap' as const,
      gap: 8,
      alignItems: 'center' as const,
    },
    card: {
      gap: 8,
      padding: 12,
      borderRadius: 8,
      backgroundColor: theme.colors.surface1,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
    field: {
      color: theme.colors.foreground,
      padding: 9,
      minHeight: 40,
      borderRadius: 6,
      borderWidth: 1,
      borderColor: theme.colors.border,
    },
  };
}

function TimeField({
  appearance,
  value,
  onChange,
  disabled,
}: {
  appearance: Appearance;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
}) {
  const c = useCopy();
  const styles = useLaunchStyles(appearance);
  const label = c('开始时间', 'Start time');
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <View style={{ gap: 5 }}>
      <Text style={styles.hint}>{`${label} · ${zone} · YYYY-MM-DD HH:mm`}</Text>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={!disabled}
        autoCorrect={false}
        autoCapitalize="none"
        style={styles.field}
      />
    </View>
  );
}

function LaunchForm({
  appearance,
  draft,
  onSaved,
}: {
  appearance: Appearance;
  draft: Draft;
  onSaved(): void;
}) {
  const c = useCopy();
  const styles = useLaunchStyles(appearance);
  const paseo = usePaseo();
  const submit = useRpc(rpc.launchSubmit);
  const [workspaceId, setWorkspaceId] = useState(draft.pending?.workspaceId ?? '');
  const [time, setTime] = useState(localTime(draft.pending?.at ?? Date.now() + 30 * 60_000));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const query = useQuery({
    queryKey: ['evo-launch-workspaces', draft.requestId],
    queryFn: async () => {
      const workspaces = [];
      const visited = new Set<string>();
      let cursor: string | undefined;
      do {
        const { entries, pageInfo } = await paseo.workspaces.list({
          page: { limit: 200, ...(cursor ? { cursor } : {}) },
        });
        for (const item of entries) {
          if (!item.workspaceDirectory || item.archivingAt || item.background || item.internal)
            continue;
          workspaces.push({
            value: item.id,
            label: `${item.projectDisplayName} / ${item.name}`,
            directory: item.workspaceDirectory,
          });
        }
        cursor = pageInfo.nextCursor ?? undefined;
        if (cursor && visited.has(cursor))
          throw new Error('Workspace listing did not make progress');
        if (cursor) visited.add(cursor);
      } while (cursor);
      return workspaces;
    },
    retry: false,
  });
  const workspace = query.data?.find(({ value }) => value === workspaceId);
  const locked = busy || Boolean(draft.pending);
  const { provider, model, mode, thinking, options } = draft.config;
  async function save() {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      if (!draft.pending) {
        if (!workspace) throw new Error(c('请选择目标工作区', 'Select a target workspace'));
        draft.pending = LaunchInput.parse({
          requestId: draft.requestId,
          text: draft.text,
          config: draft.config,
          workspaceId: workspace.value,
          directory: workspace.directory,
          at: parseLocalTime(time),
        });
      }
      const result = await submit(draft.pending);
      if ('rejected' in result) {
        draft.pending = undefined;
        throw new Error(result.rejected);
      }
      onSaved();
    } catch (cause) {
      setError(
        draft.pending
          ? c(
              '保存结果待确认。重试会核对同一条任务。',
              'Save unconfirmed. Retry checks the same schedule.',
            )
          : cause instanceof Error
            ? cause.message
            : c('无法保存定时任务', 'Could not save the schedule'),
      );
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <View style={styles.card}>
      <Text accessibilityRole="header" style={styles.body}>
        {c('定时开始', 'Schedule start')}
      </Text>
      <SettingsSelect
        label={c('目标工作区', 'Target workspace')}
        options={query.data ?? []}
        value={workspaceId}
        onValueChange={setWorkspaceId}
        disabled={locked || !query.data?.length}
      />
      {workspace || draft.pending ? (
        <Text selectable style={styles.hint}>
          {draft.pending?.directory ?? workspace?.directory}
        </Text>
      ) : null}
      {query.isError ? (
        <QueueAction
          {...appearance}
          compact={appearance.layout.compact}
          title={c('重试加载工作区', 'Retry loading workspaces')}
          label={c('重试加载工作区', 'Retry loading workspaces')}
          onPress={() => void query.refetch()}
        />
      ) : query.isPending || !query.data?.length ? (
        <Text style={styles.hint}>
          {query.isPending
            ? c('正在加载工作区', 'Loading workspaces')
            : c('此主机没有可用的工作区', 'No workspaces are available on this host')}
        </Text>
      ) : null}
      <TimeField appearance={appearance} value={time} onChange={setTime} disabled={locked} />
      <Text style={styles.hint}>
        {[provider, model, mode, thinking].filter(Boolean).join(' · ')}
      </Text>
      {Object.keys(options).length ? (
        <Text selectable style={styles.hint}>
          {JSON.stringify(options)}
        </Text>
      ) : null}
      <Text selectable style={styles.body}>
        {draft.text}
      </Text>
      <Text style={styles.hint}>
        {c(
          '只安排以上纯文本。原草稿和附件仍留在原输入框。',
          'Only the text above will be scheduled. The original draft and attachments stay in the composer.',
        )}
      </Text>
      {error ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <Button
        {...appearance}
        compact={appearance.layout.compact}
        busy={busy}
        primary
        disabled={!workspace && !draft.pending}
        title={draft.pending ? c('重试保存', 'Retry save') : c('确认定时开始', 'Confirm schedule')}
        action={() => void save()}
      />
    </View>
  );
}

function LaunchCard({
  appearance,
  launch,
  onChange,
  onOpen,
}: {
  appearance: Appearance;
  launch: LaunchSummary;
  onChange(action: EditAction, details?: { text: string; at: number }): Promise<Launch>;
  onOpen?: () => void;
}) {
  const c = useCopy();
  const styles = useLaunchStyles(appearance);
  const [editor, setEditor] = useState<Launch>();
  const [text, setText] = useState('');
  const [time, setTime] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  async function change(action: EditAction) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      if (action === 'begin-edit') {
        const paused = await onChange('begin-edit');
        setText(paused.text);
        setTime(localTime(paused.at));
        setEditor(paused);
      } else if (action === 'update') {
        if (editor?.revision !== launch.revision)
          throw new Error(
            c('任务已更改，请重新打开编辑', 'The schedule changed. Reopen the editor.'),
          );
        await onChange('update', { text: text.trim(), at: parseLocalTime(time) });
        setEditor(undefined);
      } else {
        const result = await onChange(action);
        if (action === 'check' && result.status === 'unknown')
          setError(c('仍无法确认首条消息已发送', 'The first message could not be confirmed'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : c('操作失败', 'Action failed'));
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const labels = {
    scheduled: c('已安排', 'Scheduled'),
    paused: c('已暂停', 'Paused'),
    starting: c('正在启动', 'Starting'),
    started: c('已启动', 'Started'),
    unknown: c('启动待确认', 'Start unconfirmed'),
    canceled: c('已撤回', 'Withdrawn'),
  };
  const problem =
    launch.problem &&
    {
      workspace: c('目标工作区已变更或不可用', 'The target workspace changed or is unavailable'),
      connection: c('未能连接主机以启动对话', 'Could not connect to the host to start'),
      unconfirmed: c('请核对会话及首条消息', 'Check the conversation and first message'),
    }[launch.problem];
  const actionProps = {
    theme: appearance.theme,
    compact: appearance.layout.compact,
    disabled: busy,
  };
  const editable = launch.status === 'scheduled' || launch.status === 'paused';
  return (
    <View style={styles.card}>
      <Text style={styles.body}>{launch.workspaceName}</Text>
      <Text style={styles.hint}>
        {`${new Date(launch.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · ${labels[launch.status]}`}
      </Text>
      <Text selectable numberOfLines={3} style={styles.body}>
        {launch.preview}
      </Text>
      {problem ? <Text style={styles.hint}>{problem}</Text> : null}
      {error && !editor ? (
        <Text accessibilityLiveRegion="polite" style={styles.error}>
          {error}
        </Text>
      ) : null}
      <View style={styles.row}>
        {editable ? (
          <>
            <QueueAction
              {...actionProps}
              icon="Pencil"
              title={c('编辑', 'Edit')}
              label={c('编辑', 'Edit')}
              onPress={() => void change('begin-edit')}
            />
            {launch.status === 'scheduled' || launch.at > Date.now() ? (
              <QueueAction
                {...actionProps}
                icon={launch.status === 'scheduled' ? 'Pause' : 'Play'}
                title={
                  launch.status === 'scheduled'
                    ? c('暂停', 'Pause')
                    : c('重新安排', 'Resume schedule')
                }
                label={
                  launch.status === 'scheduled'
                    ? c('暂停', 'Pause')
                    : c('重新安排', 'Resume schedule')
                }
                onPress={() => void change(launch.status === 'scheduled' ? 'pause' : 'resume')}
              />
            ) : null}
            <QueueAction
              {...actionProps}
              icon="X"
              title={c('撤回', 'Withdraw')}
              label={c('撤回', 'Withdraw')}
              onPress={() => void change('cancel')}
            />
          </>
        ) : null}
        {launch.status === 'unknown' ? (
          <QueueAction
            {...actionProps}
            icon="RefreshCw"
            title={c('核对结果', 'Check result')}
            label={c('核对结果', 'Check result')}
            onPress={() => void change('check')}
          />
        ) : null}
        {launch.status === 'started' && onOpen ? (
          <QueueAction
            {...actionProps}
            icon="MessageCircle"
            title={c('打开对话', 'Open conversation')}
            label={c('打开对话', 'Open conversation')}
            onPress={onOpen}
          />
        ) : null}
      </View>
      {editor ? (
        <Modal
          title={c('编辑定时对话', 'Edit scheduled conversation')}
          open
          onOpenChange={(open) => {
            if (!open && !busy) setEditor(undefined);
          }}
        >
          <Modal.Content>
            <Text style={styles.hint}>
              {c(
                '此任务已暂停，保存后可重新安排。',
                'This schedule is paused. Resume it after saving.',
              )}
            </Text>
            <TextInput
              accessibilityLabel={c('首条消息', 'First message')}
              value={text}
              onChangeText={setText}
              editable={!busy}
              multiline
              maxLength={16000}
              style={styles.field}
            />
            <TimeField appearance={appearance} value={time} onChange={setTime} disabled={busy} />
            {error ? (
              <Text accessibilityLiveRegion="polite" style={styles.error}>
                {error}
              </Text>
            ) : null}
            <Button
              {...actionProps}
              busy={busy}
              primary
              disabled={!text.trim()}
              title={c('保存并保持暂停', 'Save paused')}
              action={() => void change('update')}
            />
          </Modal.Content>
        </Modal>
      ) : null}
    </View>
  );
}

function LaunchScreen({ draft, ...props }: PluginScreenProps & { draft?: Draft }) {
  const c = useCopy();
  const styles = useLaunchStyles(props);
  const list = useRpc(rpc.launchList),
    edit = useRpc(rpc.launchEdit),
    connect = useRpc(rpc.launchConnect);
  const settings = useSettings(rpc.connection);
  const [home, setHome] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [saved, setSaved] = useState(false);
  const query = useQuery({
    queryKey: ['evo-launches', props.host.id],
    queryFn: () => list({}),
    refetchInterval: 3000,
    retry: false,
  });
  const launches = (query.data?.launches ?? []).slice().reverse();
  const draftSaved = saved || launches.some(({ requestId }) => requestId === draft?.requestId);
  return (
    <FlatList
      data={launches}
      keyExtractor={(launch) => launch.id}
      contentContainerStyle={{
        padding: props.layout.compact ? 12 : 24,
        gap: 10,
        width: '100%',
        maxWidth: 720,
        alignSelf: 'center',
      }}
      ListHeaderComponent={
        <View style={{ gap: 10 }}>
          {query.isError ? (
            <QueueAction
              theme={props.theme}
              compact={props.layout.compact}
              title={c('重新加载任务', 'Reload schedules')}
              label={c('重新加载任务', 'Reload schedules')}
              onPress={() => void query.refetch()}
            />
          ) : query.isPending ? (
            <Text style={styles.hint}>{c('正在加载任务', 'Loading schedules')}</Text>
          ) : !query.data.connected ? (
            <View style={styles.card}>
              <Text style={styles.body}>
                {c('连接到此主机的 Paseo home', 'Connect to the Paseo home on this host')}
              </Text>
              <TextInput
                accessibilityLabel="Paseo home"
                value={home}
                onChangeText={setHome}
                editable={!connecting}
                autoCorrect={false}
                autoCapitalize="none"
                placeholder="~/.paseo"
                placeholderTextColor={props.theme.colors.foregroundMuted}
                style={styles.field}
              />
              {connectionError || query.data.error ? (
                <Text style={styles.error}>{connectionError || query.data.error}</Text>
              ) : null}
              <Button
                theme={props.theme}
                compact={props.layout.compact}
                busy={connecting}
                disabled={settings.status !== 'ready' || settings.saving}
                title={c('连接', 'Connect')}
                action={() => {
                  if (settings.status !== 'ready') return;
                  setConnecting(true);
                  setConnectionError('');
                  void connect({ home })
                    .then((binding) => settings.save(binding, settings.revision))
                    .then((ok) => {
                      if (!ok)
                        throw new Error(c('无法保存连接设置', 'Could not save the connection'));
                      return query.refetch();
                    })
                    .catch((error: unknown) =>
                      setConnectionError(
                        error instanceof Error ? error.message : c('连接失败', 'Connection failed'),
                      ),
                    )
                    .finally(() => setConnecting(false));
                }}
              />
            </View>
          ) : draft && !draftSaved ? (
            <LaunchForm
              appearance={props}
              draft={draft}
              onSaved={() => {
                setSaved(true);
                void query.refetch();
              }}
            />
          ) : draftSaved ? (
            <Text accessibilityLiveRegion="polite" style={styles.body}>
              {c('已保存定时任务', 'Schedule saved')}
            </Text>
          ) : props.params.draft ? (
            <Text style={styles.hint}>
              {c(
                '请返回原新对话重新打开定时确认',
                'Return to the original draft to review a schedule',
              )}
            </Text>
          ) : !launches.length ? (
            <Text style={styles.hint}>{c('没有定时新对话', 'No conversations scheduled')}</Text>
          ) : null}
        </View>
      }
      renderItem={({ item }) => (
        <LaunchCard
          appearance={props}
          launch={item}
          onOpen={
            props.navigation && item.serverId === props.host.id
              ? () =>
                  props.navigation?.openAgent({ agentId: item.agentId, serverId: props.host.id })
              : undefined
          }
          onChange={async (action, details) => {
            try {
              const { launch } = await edit({
                id: item.id,
                revision: item.revision,
                action,
                details,
              });
              return launch;
            } finally {
              await query.refetch();
            }
          }}
        />
      )}
    />
  );
}
