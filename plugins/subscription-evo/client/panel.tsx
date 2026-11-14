import {
  Component,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { Pressable, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import {
  useAgent,
  usePaseo,
  useRpc,
  useSettings,
  type PluginAgentPanelProps,
  type PluginButtonContentProps,
  type PluginSurfaceProps,
} from '@getpaseo/plugin/client';
import {
  ScrollView,
  TextInput,
  SettingsSection,
  SettingsSwitch,
  SettingsInput,
  SettingsSelect,
  copyText,
} from '@getpaseo/plugin/client/ui';
import * as api from '../shared/contracts';
import { freshPolicy, Policy, type Job, type Trigger } from '../shared/model';
import { parseSend } from '../shared/commands';
import {
  drafts,
  requestId,
  getFocus,
  subscribeFocus,
  queueChanged,
  editorDrafts,
  editingDrafts,
  keepEditorDraft,
  keepEditingDraft,
  type EditorDraft,
  type Section,
} from './drafts';
import { localTime, parseLocalTime } from '../shared/time';
import { reasons, useCopy } from './messages';
import { SendMode } from './send-mode';
import { QueueHeader, QueueList, QueueAction } from './queue';

class Boundary extends Component<{ children: ReactNode; color: string }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <Text style={{ color: this.props.color, padding: 16 }}>
        SubscriptionEvo could not display this view. Close and reopen it. / 请关闭后重新打开。
      </Text>
    ) : (
      this.props.children
    );
  }
}
function Button({
  theme,
  compact,
  busy,
  title,
  action,
  selected = false,
  disabled = false,
  primary = false,
  quiet = false,
  dense = false,
  displayTitle,
}: {
  theme: PluginAgentPanelProps['theme'];
  compact: boolean;
  busy: boolean;
  title: string;
  action: () => void;
  selected?: boolean;
  disabled?: boolean;
  primary?: boolean;
  quiet?: boolean;
  dense?: boolean;
  displayTitle?: string;
}) {
  const fg = theme.colors.foreground;
  const label = { color: fg, fontSize: 14, lineHeight: 20 };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled: disabled || busy, selected }}
      disabled={disabled || busy}
      onPress={action}
      style={{
        paddingHorizontal: 10,
        paddingVertical: compact ? 10 : dense ? 4 : 7,
        borderRadius: 6,
        backgroundColor: primary
          ? theme.colors.accent
          : quiet
            ? 'transparent'
            : selected
              ? theme.colors.surface2
              : theme.colors.surface1,
        minHeight: compact ? 40 : dense ? 28 : 36,
        justifyContent: 'center',
        ...(primary ? { minWidth: 112 } : {}),
        ...(dense
          ? {
              borderWidth: 1,
              borderColor: selected ? theme.colors.foregroundMuted : theme.colors.border,
            }
          : {}),
        opacity: disabled || busy ? 0.5 : 1,
      }}
    >
      <Text
        style={{
          ...label,
          color: primary ? theme.colors.accentForeground : fg,
          textAlign: 'center',
          ...(dense ? { fontSize: 12, lineHeight: 16 } : {}),
        }}
      >
        {displayTitle ?? title}
      </Text>
    </Pressable>
  );
}

export function QueuePanel(props: PluginAgentPanelProps) {
  return (
    <Boundary
      key={`${props.host.id}:${props.params.agentId}`}
      color={props.theme.colors.foreground}
    >
      <Panel {...props} agentId={props.params.agentId} />
    </Boundary>
  );
}
export function GoalPanel(props: PluginAgentPanelProps) {
  return (
    <Boundary
      key={`${props.host.id}:${props.params.agentId}`}
      color={props.theme.colors.foreground}
    >
      <Panel {...props} agentId={props.params.agentId} initialSection="goal" fixedSection="goal" />
    </Boundary>
  );
}
export function AutomationEditor(props: PluginSurfaceProps & { agentId: string }) {
  return (
    <Boundary key={`${props.host.id}:${props.agentId}`} color={props.theme.colors.foreground}>
      <Panel {...props} embedded initialSection="rules" fixedSection="rules" />
    </Boundary>
  );
}
type PanelProps = Pick<PluginAgentPanelProps, 'theme' | 'layout' | 'host'> & {
  agentId: string;
  embedded?: boolean;
  initialSection?: Section;
  fixedSection?: 'rules' | 'goal';
};
function Popover(props: PluginButtonContentProps & { initialSection: Section }) {
  if (props.context !== 'agent') return null;
  return (
    <Boundary key={`${props.host.id}:${props.agentId}`} color={props.theme.colors.foreground}>
      <Panel {...props} agentId={props.agentId} embedded />
    </Boundary>
  );
}
export function SchedulePopover(props: PluginButtonContentProps) {
  return <Popover {...props} initialSection="compose" />;
}
export function QueuePopover(props: PluginButtonContentProps) {
  return <Popover {...props} initialSection="queue" />;
}
function Panel({
  theme,
  layout,
  host,
  agentId,
  embedded = false,
  initialSection = 'queue',
  fixedSection,
}: PanelProps) {
  const c = useCopy();
  const provider = useAgent(agentId, (a) => a.provider);
  const paseo = usePaseo();
  const draftKey = `${paseo.agents.ref(agentId).address.serverId}:${agentId}`;
  const settings = useSettings(api.connection);
  const read = useRpc(api.view),
    add = useRpc(api.submit),
    edit = useRpc(api.edit),
    revise = useRpc(api.revise),
    save = useRpc(api.policy),
    changeGoal = useRpc(api.goal),
    inspect = useRpc(api.inspectConnection);
  const pause = useRpc(api.pause);
  const query = useQuery({
    queryKey: ['evo-queue', host.id, agentId],
    queryFn: () => read({ agentId }),
    refetchInterval: 3000,
    retry: false,
  });
  const [savedEdit] = useState(() => (fixedSection ? undefined : editingDrafts.get(draftKey)));
  const [section, setSection] = useState<Section>(initialSection);
  const [savedDraft] = useState(() => savedEdit?.draft ?? editorDrafts.get(draftKey));
  const [home, setHome] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [text, setText] = useState(savedDraft?.text ?? '');
  const [mode, setMode] = useState<Trigger['kind']>(savedDraft?.mode ?? 'at');
  const [at, setAt] = useState(savedDraft?.at ?? localTime(Date.now() + 30 * 60_000));
  const [preset, setPreset] = useState<number | null>(savedDraft ? null : 30);
  const [min, setMin] = useState(savedDraft?.min ?? '2'),
    [max, setMax] = useState(savedDraft?.max ?? '5');
  const [editing, setEditing] = useState<Job | null>(savedEdit?.job ?? null);
  const [rules, setRules] = useState<Policy | null>(null);
  const [rulesRevision, setRulesRevision] = useState(0);
  const [rulesReload, setRulesReload] = useState(0);
  const [objective, setObjective] = useState(''),
    [turns, setTurns] = useState('10'),
    [hours, setHours] = useState('24');
  const [nativeOff, setNativeOff] = useState(false);
  const focused = useSyncExternalStore(
    subscribeFocus,
    () => getFocus(draftKey),
    () => getFocus(draftKey),
  );
  useEffect(() => {
    if (focused && !embedded) {
      if (!fixedSection) setSection(focused.section);
      if (focused.objective) setObjective(focused.objective);
    }
  }, [focused, embedded, fixedSection]);
  const pendingRequest = useRef<{ payload: string; id: string } | null>(
    savedDraft?.request ?? null,
  );
  useEffect(() => {
    if (section === 'compose') {
      try {
        retainEditor();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unable to retain draft');
      }
    }
  }, [draftKey, text, mode, at, min, max, editing, section]);
  const state = query.data?.state;
  const policy = state?.policies[agentId] ?? freshPolicy();
  const currentRules = rules ?? policy;
  const jobs = state?.jobs ?? [];
  function loadDraft(draft?: EditorDraft) {
    setText(draft?.text ?? '');
    setMode(draft?.mode ?? 'at');
    setAt(draft?.at ?? localTime(Date.now() + 30 * 60_000));
    setMin(draft?.min ?? '2');
    setMax(draft?.max ?? '5');
    setPreset(null);
    pendingRequest.current = draft?.request ?? null;
  }
  function retainEditor() {
    const draft = { text, mode, at, min, max, request: pendingRequest.current };
    if (editing) keepEditingDraft(draftKey, editing, draft);
    else keepEditorDraft(draftKey, draft);
  }
  function finishEditor() {
    if (editing) {
      editingDrafts.delete(draftKey);
      setEditing(null);
      loadDraft(editorDrafts.get(draftKey));
    } else {
      editorDrafts.delete(draftKey);
      loadDraft();
    }
    setError('');
    setSection('queue');
  }
  useEffect(() => {
    const request = pendingRequest.current;
    if (
      !fixedSection &&
      !busy &&
      request &&
      jobs.some((j) =>
        editing ? j.id === editing.id && j.lastEdit?.id === request.id : j.requestId === request.id,
      )
    )
      finishEditor();
  }, [state, busy, fixedSection, draftKey]);
  const pending = jobs.filter((j) => ['queued', 'dispatching', 'unknown'].includes(j.status));
  const editChanged = Boolean(
    editing && jobs.find((j) => j.id === editing.id)?.revision !== editing.revision,
  );
  const g = policy.goal;
  const fg = theme.colors.foreground,
    muted = theme.colors.foregroundMuted;
  const row = {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    gap: 8,
    alignItems: 'center' as const,
  };
  const label = { color: fg, fontSize: 14, lineHeight: 20 };
  const hint = { color: muted, fontSize: 12, lineHeight: 18 };
  const input = {
    color: fg,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 6,
    padding: 10,
    fontSize: 14,
    minHeight: 40,
  };
  const reason = (key: string) => (reasons[key] ? c(...reasons[key]) : key);
  async function run(fn: () => Promise<unknown>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
      await query.refetch();
      queueChanged();
    } catch (e) {
      setError(
        e && typeof e === 'object' && 'issues' in e
          ? c(
              '输入格式或范围不正确，请检查后重试',
              'Check the input format and range, then try again',
            )
          : e instanceof Error
            ? e.message
            : c('操作失败，内容已保留', 'Action failed; input was retained'),
      );
      // A failed acknowledgement may still have changed the durable queue.
      await query.refetch();
      queueChanged();
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  const buttonProps = { theme, compact: layout.compact, busy };
  function trigger(): Trigger {
    if (mode === 'idle') return { kind: 'idle' };
    if (mode === 'at') {
      // Preserve seconds from a slash-scheduled message when only its text changes.
      if (editing?.trigger.kind === 'at' && at === localTime(editing.trigger.at))
        return editing.trigger;
      return { kind: 'at', at: parseLocalTime(at) };
    }
    return parseSend(`after-quota ${min}-${max}m -- x`).trigger;
  }
  function rule<K extends keyof Policy>(key: K, value: Policy[K]) {
    if (!rules) setRulesRevision(state?.revision ?? 0);
    setRules({ ...currentRules, [key]: value });
  }
  function submit(allowDelivery: boolean) {
    return run(async () => {
      const value = { text: text.trim(), trigger: trigger() };
      api.submit.input.parse({ agentId, requestId: 'validate', allowDelivery, ...value });
      if (
        !pendingRequest.current &&
        (!editing || JSON.stringify(value.trigger) !== JSON.stringify(editing.trigger)) &&
        value.trigger.kind === 'at' &&
        (value.trigger.at <= Date.now() || value.trigger.at > Date.now() + 365 * 86_400_000)
      )
        throw new Error(c('请选择一年内的未来时间', 'Choose a future time within one year'));
      {
        const payload = JSON.stringify({ ...value, allowDelivery });
        if (pendingRequest.current && pendingRequest.current.payload !== payload)
          throw new Error(
            c(
              '上次入队尚未确认，请重试原来的操作',
              'The previous submission is unconfirmed. Retry the same action.',
            ),
          );
        if (!pendingRequest.current) pendingRequest.current = { payload, id: requestId() };
        retainEditor();
        const common = {
          agentId,
          requestId: pendingRequest.current.id,
          allowDelivery,
          ...value,
        };
        const result = editing
          ? await revise({
              ...common,
              id: editing.id,
              revision: editing.revision,
              action: 'edit',
            })
          : await add(common);
        if ('rejected' in result) {
          pendingRequest.current = null;
          retainEditor();
          throw new Error(result.rejected);
        }
      }
      finishEditor();
    });
  }
  function beginEdit(j: Job, preserveInput = false) {
    return run(async () => {
      if (pendingRequest.current)
        throw new Error(c('请先确认上次操作的结果', 'Resolve the previous operation first'));
      const result = await edit({ agentId, id: j.id, revision: j.revision, action: 'begin-edit' });
      if (!result.job)
        throw new Error(
          c('无法确认消息已暂停，请刷新', 'Could not confirm the pause; refresh the queue'),
        );
      const draft: EditorDraft = preserveInput
        ? { text, mode, at, min, max, request: null }
        : {
            text: result.job.text,
            mode: result.job.trigger.kind,
            at:
              result.job.trigger.kind === 'at'
                ? localTime(result.job.trigger.at)
                : localTime(Date.now() + 30 * 60_000),
            min: result.job.trigger.kind === 'quota' ? String(result.job.trigger.delay.min) : '2',
            max: result.job.trigger.kind === 'quota' ? String(result.job.trigger.delay.max) : '5',
            request: null,
          };
      keepEditingDraft(draftKey, result.job, draft);
      setEditing(result.job);
      loadDraft(draft);
      setSection('compose');
    });
  }
  const action = (j: Job, name: 'cancel' | 'withdraw' | 'pause' | 'resume' | 'release' | 'up') =>
    run(() => edit({ agentId, id: j.id, revision: j.revision, action: name }));
  const goalAction = (action: 'pause' | 'resume' | 'clear') =>
    run(() => changeGoal({ agentId, revision: state!.revision, action }));
  const content = (
    <>
      {!fixedSection && (section === 'queue' || section === 'compose') ? (
        <QueueHeader
          theme={theme}
          compact={layout.compact}
          section={section}
          count={pending.length}
          editing={Boolean(editing)}
          busy={busy}
          onNavigate={() => setSection(section === 'queue' ? 'compose' : 'queue')}
        />
      ) : null}
      {query.isPending ? <Text style={hint}>{c('正在读取队列…', 'Loading queue…')}</Text> : null}
      {query.error || query.data?.error || error ? (
        <View style={{ gap: 8 }}>
          <Text selectable style={{ ...hint, color: theme.colors.statusDanger }}>
            {error ||
              query.data?.error ||
              c('无法读取队列，请重试', 'Queue unavailable; try again')}
          </Text>
          <Button
            {...buttonProps}
            title={c('刷新', 'Refresh')}
            action={() => {
              void query.refetch();
            }}
          />
        </View>
      ) : null}
      {!query.data?.connected ? (
        <SettingsSection title={c('连接当前主机', 'Connect this host')}>
          <Text style={hint}>
            {c(
              '填写当前主机的 Paseo home。连接后仍需按会话开启自动发送。',
              'Enter this host’s Paseo home. Automatic delivery stays off until enabled per session.',
            )}
          </Text>
          <TextInput
            accessibilityLabel="Paseo home"
            value={home}
            onChangeText={setHome}
            placeholder="~/.paseo"
            placeholderTextColor={muted}
            style={input}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Button
            {...buttonProps}
            title={c('连接', 'Connect')}
            disabled={settings.status !== 'ready'}
            action={() => {
              void run(async () => {
                if (settings.status !== 'ready') return;
                const binding = await inspect({ home, agentId });
                if (!(await settings.save(binding, settings.revision)))
                  throw new Error(c('连接设置保存失败', 'Connection settings were not saved'));
              });
            }}
          />
        </SettingsSection>
      ) : (
        <>
          {policy.notice ? <Text style={hint}>{reason(policy.notice)}</Text> : null}
          {policy.paused ? (
            <View style={row}>
              <Text style={hint}>{c('本会话已暂停发送', 'Delivery paused for this session')}</Text>
              <QueueAction
                theme={theme}
                compact={layout.compact}
                disabled={busy}
                icon="Play"
                title={c('检查后恢复', 'Resume after review')}
                label={c('检查后恢复', 'Resume after review')}
                onPress={() => {
                  void run(() =>
                    save({
                      agentId,
                      revision: state!.revision,
                      values: { ...policy, paused: false },
                    }),
                  );
                }}
              />
            </View>
          ) : null}
          {section === 'compose' ? (
            <View style={{ gap: 10 }}>
              {editing ? (
                <View style={{ gap: 4 }}>
                  <View style={{ ...row, justifyContent: 'flex-end' }}>
                    <QueueAction
                      theme={theme}
                      compact={layout.compact}
                      title={c('放弃编辑', 'Discard edit')}
                      label={c('放弃编辑', 'Discard edit')}
                      disabled={busy || Boolean(pendingRequest.current)}
                      onPress={finishEditor}
                    />
                  </View>
                  {!editChanged ? (
                    <Text style={hint}>
                      {c(
                        '已暂停这条消息，关闭窗口也不会发送',
                        'This message is paused, even if you close this view.',
                      )}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              {editing && editChanged && !pendingRequest.current ? (
                <View style={{ gap: 8 }}>
                  <Text style={hint}>
                    {c(
                      '这条消息的状态已变化，请检查队列后更新编辑版本。输入内容会保留。',
                      'This message changed. Review the queue before updating your edit version. Your text is retained.',
                    )}
                  </Text>
                  <Button
                    {...buttonProps}
                    title={c('更新编辑版本', 'Update edit version')}
                    action={() => {
                      const current = jobs.find((j) => j.id === editing.id);
                      if (current?.status === 'queued') void beginEdit(current, true);
                      else
                        setError(
                          c(
                            '消息已不在待发送队列中，请保留输入并放弃本次编辑',
                            'The message is no longer queued. Keep your text and discard this edit.',
                          ),
                        );
                    }}
                  />
                </View>
              ) : null}
              <TextInput
                accessibilityLabel={c('消息内容', 'Message')}
                value={text}
                onChangeText={setText}
                editable={!busy && !pendingRequest.current}
                multiline
                maxLength={16000}
                placeholder={c('输入要发送的消息', 'Message to send')}
                placeholderTextColor={muted}
                style={{ ...input, minHeight: 80, maxHeight: 160, textAlignVertical: 'top' }}
              />
              <SendMode
                theme={theme}
                compact={layout.compact}
                value={mode}
                onChange={setMode}
                disabled={busy || Boolean(pendingRequest.current)}
              />
              {mode === 'at' ? (
                <View style={{ gap: 8 }}>
                  <View style={{ ...row, gap: 6 }}>
                    {[10, 30, 60].map((minutes) => (
                      <Button
                        {...buttonProps}
                        key={minutes}
                        dense
                        selected={preset === minutes}
                        title={c(`${minutes} 分钟后`, `In ${minutes} min`)}
                        displayTitle={minutes === 60 ? c('1 小时后', 'In 1 hour') : undefined}
                        disabled={Boolean(pendingRequest.current)}
                        action={() => {
                          setAt(localTime(Date.now() + minutes * 60_000));
                          setPreset(minutes);
                        }}
                      />
                    ))}
                  </View>
                  <View style={{ ...row, alignItems: 'flex-end' }}>
                    <View style={{ flex: 1, minWidth: 128, gap: 4 }}>
                      <Text style={hint}>{c('日期', 'Date')}</Text>
                      <TextInput
                        accessibilityLabel={c('日期', 'Date')}
                        value={at.split(' ')[0] ?? ''}
                        onChangeText={(date) => {
                          setAt(`${date} ${at.split(' ')[1] ?? '09:00'}`);
                          setPreset(null);
                        }}
                        editable={!busy && !pendingRequest.current}
                        placeholder="YYYY-MM-DD"
                        placeholderTextColor={muted}
                        style={input}
                        autoCapitalize="none"
                      />
                    </View>
                    <View style={{ width: 100, gap: 4 }}>
                      <Text style={hint}>{c('时间（本地）', 'Time (local)')}</Text>
                      <TextInput
                        accessibilityLabel={c('时间', 'Time')}
                        value={at.split(' ')[1] ?? ''}
                        onChangeText={(time) => {
                          setAt(`${at.split(' ')[0] ?? ''} ${time}`);
                          setPreset(null);
                        }}
                        editable={!busy && !pendingRequest.current}
                        placeholder="HH:mm"
                        placeholderTextColor={muted}
                        style={input}
                        autoCapitalize="none"
                      />
                    </View>
                  </View>
                </View>
              ) : null}
              {mode === 'quota' ? (
                <View style={{ gap: 8 }}>
                  <Text style={hint}>
                    {c(
                      '额度恢复后等待；两个数值相同表示固定延迟。',
                      'Wait after recovery. Equal values give a fixed delay.',
                    )}
                  </Text>
                  <View style={row}>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={hint}>{c('至少（分钟）', 'At least (min)')}</Text>
                      <TextInput
                        accessibilityLabel={c('最少分钟', 'Minimum minutes')}
                        value={min}
                        onChangeText={setMin}
                        editable={!busy && !pendingRequest.current}
                        keyboardType="numeric"
                        style={input}
                      />
                    </View>

                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={hint}>{c('最多（分钟）', 'At most (min)')}</Text>
                      <TextInput
                        accessibilityLabel={c('最多分钟', 'Maximum minutes')}
                        value={max}
                        onChangeText={setMax}
                        editable={!busy && !pendingRequest.current}
                        keyboardType="numeric"
                        style={input}
                      />
                    </View>
                  </View>
                </View>
              ) : null}
              <Text style={hint}>
                {c(
                  '仅发送这一条，忙时等待空闲',
                  'Sends only this message, once the conversation is idle.',
                )}
              </Text>
              <View
                style={{
                  ...row,
                  justifyContent: 'flex-end',
                  paddingTop: 10,
                  borderTopWidth: 1,
                  borderTopColor: theme.colors.border,
                }}
              >
                <Button
                  {...buttonProps}
                  quiet
                  displayTitle={
                    editing ? c('保存并暂停', 'Save paused') : c('仅排队', 'Queue only')
                  }
                  title={
                    editing
                      ? c('保存并暂停', 'Save paused')
                      : c('仅加入队列', 'Queue without sending')
                  }
                  disabled={
                    !text.trim() ||
                    (editChanged && !pendingRequest.current) ||
                    Boolean(
                      pendingRequest.current &&
                        JSON.parse(pendingRequest.current.payload).allowDelivery,
                    )
                  }
                  action={() => {
                    void submit(false);
                  }}
                />
                <Button
                  {...buttonProps}
                  primary
                  displayTitle={
                    editing ? c('保存并安排', 'Save & schedule') : c('安排发送', 'Schedule')
                  }
                  title={
                    editing
                      ? c('保存并安排', 'Save and schedule')
                      : c('安排发送', 'Schedule message')
                  }
                  disabled={
                    !text.trim() ||
                    (editChanged && !pendingRequest.current) ||
                    Boolean(
                      pendingRequest.current &&
                        !JSON.parse(pendingRequest.current.payload).allowDelivery,
                    )
                  }
                  action={() => {
                    void submit(true);
                  }}
                />
              </View>
              {pendingRequest.current ? (
                <Text style={hint}>
                  {c(
                    '保存结果尚未确认，请重试原操作',
                    'Save is unconfirmed. Retry the same action.',
                  )}
                </Text>
              ) : null}
            </View>
          ) : null}
          {section === 'queue' ? (
            <>
              {drafts.has(draftKey) ? (
                <View style={{ gap: 8 }}>
                  <Text style={hint}>
                    {c(
                      '上次命令未成功入队，原文保留如下',
                      'The command was not confirmed. Its text is retained below.',
                    )}
                  </Text>
                  <Text selectable style={label}>
                    {drafts.get(draftKey)}
                  </Text>
                  <View style={row}>
                    <Button
                      {...buttonProps}
                      title={c('复制原文', 'Copy text')}
                      action={() => {
                        void run(() => copyText(drafts.get(draftKey)!));
                      }}
                    />
                    <Button
                      {...buttonProps}
                      title={c('已处理', 'Dismiss')}
                      action={() => {
                        drafts.delete(draftKey);
                        void query.refetch();
                      }}
                    />
                  </View>
                </View>
              ) : null}
              <QueueList
                theme={theme}
                compact={layout.compact}
                busy={busy}
                jobs={jobs}
                now={query.data?.now ?? Date.now()}
                automatic={policy.automatic}
                paused={policy.paused}
                editingId={editing?.id}
                editDisabled={Boolean(pendingRequest.current)}
                goalObjective={g?.objective}
                onEdit={(j) => {
                  if (editing?.id === j.id) setSection('compose');
                  else void beginEdit(j);
                }}
                onAction={(j, name) => {
                  void action(j, name);
                }}
                onCopy={(value) => {
                  void run(() => copyText(value));
                }}
                onPauseAll={() => {
                  void run(() => pause({ agentId }));
                }}
              />
            </>
          ) : null}
          {section === 'rules' ? (
            <SettingsSection
              key={`${rulesReload}:${rules ? rulesRevision : state?.revision}`}
              title={c('自动续跑', 'Automatic continuation')}
            >
              <SettingsSwitch
                label={c('自动发送', 'Automatic delivery')}
                hint={c(
                  '仅在空闲时发送。Paseo 0.15.4 无法彻底排除其他客户端同时发送的竞争。',
                  'Sends only after idle checks. Paseo 0.15.4 cannot eliminate races with other clients.',
                )}
                value={currentRules.automatic}
                onValueChange={(v) => rule('automatic', v)}
              />
              {provider === 'codex' ? (
                <SettingsSwitch
                  label={c('已关闭本会话的原生 /goal', 'Native /goal is off in this session')}
                  value={currentRules.nativeGoalOff}
                  onValueChange={(v) => rule('nativeGoalOff', v)}
                />
              ) : null}
              <SettingsSwitch
                label={c('临时错误后重试', 'Retry temporary errors')}
                value={currentRules.retry}
                onValueChange={(v) => rule('retry', v)}
              />
              <SettingsSwitch
                label={c('额度恢复后继续', 'Continue after quota recovery')}
                value={currentRules.quotaResume}
                onValueChange={(v) => rule('quotaResume', v)}
              />
              <SettingsInput
                label={c('继续文案', 'Continuation message')}
                initialValue={currentRules.continueText}
                onChangeText={(v) => rule('continueText', v)}
              />
              <SettingsInput
                label={c('最多连续恢复次数', 'Maximum consecutive recovery attempts')}
                initialValue={String(currentRules.maxRetries)}
                onChangeText={(v) => rule('maxRetries', Number(v))}
              />
              <SettingsInput
                label={c('恢复后至少等待（分钟）', 'Minimum recovery delay (minutes)')}
                initialValue={String(currentRules.delay.min)}
                onChangeText={(v) => rule('delay', { ...currentRules.delay, min: Number(v) })}
              />
              <SettingsInput
                label={c('恢复后最多等待（分钟）', 'Maximum recovery delay (minutes)')}
                initialValue={String(currentRules.delay.max)}
                onChangeText={(v) => rule('delay', { ...currentRules.delay, max: Number(v) })}
              />
              <Button
                {...buttonProps}
                title={c('保存设置', 'Save settings')}
                disabled={!rules}
                action={() => {
                  void run(async () => {
                    const values = Policy.parse(currentRules);
                    await save({ agentId, revision: rulesRevision, values });
                    setRules(null);
                  });
                }}
              />
              {rules ? (
                <Button
                  {...buttonProps}
                  title={c('重新载入设置', 'Reload settings')}
                  action={() => {
                    void run(async () => {
                      await query.refetch();
                      setRules(null);
                      setRulesReload((n) => n + 1);
                    });
                  }}
                />
              ) : null}
              <Text style={hint}>
                {c(
                  '未知错误、登录错误和上下文超限会暂停；权限请求仍由你处理。普通输入会暂停自动续跑。',
                  'Unknown, authentication and context errors pause delivery. You handle permissions. New ordinary input pauses automation.',
                )}
              </Text>
            </SettingsSection>
          ) : null}
          {section === 'goal' ? (
            <SettingsSection title={c('目标', 'Goal')}>
              {g ? (
                <View style={{ gap: 8 }}>
                  <Text style={label}>{g.objective}</Text>
                  <Text style={hint}>
                    {
                      {
                        active: c('进行中', 'Active'),
                        paused: c('已暂停', 'Paused'),
                        blocked: c('需要处理', 'Needs attention'),
                        completed: c('模型报告已完成', 'Model reported completion'),
                        budget: c('已达到预算或期限', 'Budget or deadline reached'),
                      }[g.status]
                    }{' '}
                    · {g.turns}/{g.maxTurns}
                  </Text>
                  {g.progress ? (
                    <Text selectable style={label}>
                      {g.progress}
                    </Text>
                  ) : null}
                  {g.evidence.map((e, i) => (
                    <Text key={i} selectable style={hint}>
                      {e}
                    </Text>
                  ))}
                  <View style={row}>
                    {g.status === 'active' ? (
                      <Button
                        {...buttonProps}
                        title={c('暂停目标', 'Pause goal')}
                        action={() => {
                          void goalAction('pause');
                        }}
                      />
                    ) : !['completed', 'budget'].includes(g.status) ? (
                      <Button
                        {...buttonProps}
                        title={c('恢复目标', 'Resume goal')}
                        action={() => {
                          void goalAction('resume');
                        }}
                      />
                    ) : null}
                    <Button
                      {...buttonProps}
                      title={c('清除目标', 'Clear goal')}
                      action={() => {
                        void goalAction('clear');
                      }}
                    />
                  </View>
                </View>
              ) : (
                <>
                  <TextInput
                    accessibilityLabel={c('目标描述', 'Objective')}
                    value={objective}
                    onChangeText={setObjective}
                    maxLength={8000}
                    multiline
                    placeholder={c(
                      '描述目标与完成条件',
                      'Describe the objective and completion criteria',
                    )}
                    placeholderTextColor={muted}
                    style={{ ...input, minHeight: 88 }}
                  />
                  <SettingsInput
                    label={c('最多回合', 'Maximum turns')}
                    initialValue={turns}
                    onChangeText={setTurns}
                  />
                  <SettingsInput
                    label={c('有效小时数', 'Expires after hours')}
                    initialValue={hours}
                    onChangeText={setHours}
                  />
                  {provider === 'codex' ? (
                    <SettingsSwitch
                      label={c('已关闭本会话的原生 /goal', 'Native /goal is off in this session')}
                      value={nativeOff}
                      onValueChange={setNativeOff}
                    />
                  ) : null}
                  <Button
                    {...buttonProps}
                    title={c('建立目标', 'Create goal')}
                    disabled={!objective.trim() || (provider === 'codex' && !nativeOff)}
                    action={() => {
                      void run(async () => {
                        await changeGoal({
                          agentId,
                          revision: state!.revision,
                          action: 'create',
                          objective,
                          maxTurns: Number(turns),
                          hours: Number(hours),
                          nativeGoalOff: nativeOff,
                        });
                        setObjective('');
                      });
                    }}
                  />
                </>
              )}
              <Text style={hint}>
                {c(
                  '目标会生成排队消息。完成状态来自模型报告；缺少有效报告、没有进展或需要你处理时停止。',
                  'Goals produce queued messages. Completion is reported by the model. Missing reports, lack of progress or requests for input stop the loop.',
                )}
              </Text>
            </SettingsSection>
          ) : null}
        </>
      )}
    </>
  );
  if (embedded) return <View style={{ gap: 12, width: '100%' }}>{content}</View>;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{
        padding: layout.compact ? 12 : 16,
        gap: 16,
        maxWidth: 780,
        width: '100%',
        alignSelf: 'center',
      }}
      keyboardShouldPersistTaps="handled"
    >
      {content}
    </ScrollView>
  );
}
