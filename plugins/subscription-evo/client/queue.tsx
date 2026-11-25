import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon } from '@getpaseo/plugin/client/ui';
import { useTranslation, type PluginAgentPanelProps } from '@getpaseo/plugin/client';
import type { Job } from '../shared/model';
import { messages, reasons, useCopy } from './messages';

type Theme = PluginAgentPanelProps['theme'];
type ActionName = 'withdraw' | 'cancel' | 'pause' | 'resume' | 'release' | 'up';

/** Small native-style actions. The host owns the surrounding popover and its scrolling. */
export function QueueAction({
  theme,
  compact,
  title,
  icon,
  label,
  disabled = false,
  expanded,
  onPress,
}: {
  theme: Theme;
  compact: boolean;
  title: string;
  icon?: string;
  label?: string;
  disabled?: boolean;
  expanded?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ disabled, ...(expanded === undefined ? {} : { expanded }) }}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        gap: 5,
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'flex-start',
        minHeight: compact ? 40 : 28,
        minWidth: compact ? 40 : 28,
        paddingHorizontal: 7,
        borderRadius: 5,
        opacity: disabled ? 0.45 : 1,
        backgroundColor: pressed || hovered || expanded ? theme.colors.surface2 : 'transparent',
      })}
    >
      {icon ? <Icon name={icon} size={14} color={theme.colors.foregroundMuted} /> : null}
      {label ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
          {label}
        </Text>
      ) : null}
    </Pressable>
  );
}

export function QueueHeader({
  theme,
  compact,
  section,
  count,
  editing,
  busy,
  onNavigate,
}: {
  theme: Theme;
  compact: boolean;
  section: 'compose' | 'queue';
  count: number;
  editing: boolean;
  busy: boolean;
  onNavigate(): void;
}) {
  const c = useCopy();
  const [hovered, setHovered] = useState(false);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        minHeight: compact ? 40 : 28,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 }}>
        <Icon
          name={section === 'queue' ? 'ListOrdered' : editing ? 'Pencil' : 'Clock'}
          size={15}
          color={theme.colors.foregroundMuted}
        />
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: 13,
            lineHeight: 18,
            fontWeight: '500',
          }}
        >
          {section === 'queue'
            ? c('队列', 'Queue')
            : editing
              ? c('编辑消息', 'Edit message')
              : c('稍后发送', 'Send later')}
        </Text>
        {section === 'queue' ? <Count theme={theme} value={count} /> : null}
      </View>
      {section === 'queue' ? (
        <QueueAction
          theme={theme}
          compact={compact}
          title={c('稍后发送', 'Send later')}
          icon={editing ? 'Pencil' : 'Plus'}
          label={editing ? c('继续编辑', 'Continue editing') : c('新消息', 'New message')}
          disabled={busy}
          onPress={onNavigate}
        />
      ) : count > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={c(`队列 ${count}`, `Queue ${count}`)}
          disabled={busy}
          accessibilityState={{ disabled: busy }}
          onPress={onNavigate}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            paddingHorizontal: 8,
            minHeight: compact ? 40 : 28,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: pressed || hovered ? theme.colors.surface2 : theme.colors.surface1,
            opacity: busy ? 0.45 : 1,
          })}
        >
          <Icon name="ListOrdered" size={14} color={theme.colors.foregroundMuted} />
          <Text style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 18 }}>
            {c('队列', 'Queue')}
          </Text>
          <Count theme={theme} value={count} />
        </Pressable>
      ) : null}
    </View>
  );
}
function Count({ theme, value }: { theme: Theme; value: number }) {
  return (
    <Text
      style={{
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 16,
        minWidth: 18,
        paddingHorizontal: 4,
        borderRadius: 4,
        textAlign: 'center',
        backgroundColor: theme.colors.surface2,
      }}
    >
      {value}
    </Text>
  );
}

function localDate(at: number, locale: string, now: number) {
  const date = new Date(at),
    today = new Date(now),
    tomorrow = new Date(now);
  tomorrow.setDate(today.getDate() + 1);
  const zh = locale.startsWith('zh');
  const day =
    date.toDateString() === today.toDateString()
      ? zh
        ? '今天'
        : 'Today'
      : date.toDateString() === tomorrow.toDateString()
        ? zh
          ? '明天'
          : 'Tomorrow'
        : date.toLocaleDateString(locale, {
            month: 'short',
            day: 'numeric',
            ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' as const } : {}),
          });
  return `${day} ${date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}

type QueueProps = {
  theme: Theme;
  compact: boolean;
  busy: boolean;
  jobs: Job[];
  now: number;
  automatic: boolean;
  paused: boolean;
  editingId?: string;
  editDisabled: boolean;
  goalObjective?: string;
  onEdit(job: Job): void;
  onAction(job: Job, action: ActionName): void;
  onCopy(text: string): void;
  onPauseAll(): void;
};
export function QueueList(props: QueueProps) {
  const { theme, compact, busy, jobs, onCopy } = props;
  const c = useCopy();
  const [history, setHistory] = useState(false);
  const pending = jobs.filter((j) => ['queued', 'dispatching', 'unknown'].includes(j.status));
  const past = jobs
    .filter((j) => !['queued', 'dispatching', 'unknown'].includes(j.status))
    .slice(-30)
    .reverse();
  const row = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 };
  return (
    <View style={{ gap: 10 }}>
      {pending.length ? (
        pending.map((job, index) => <QueueItem {...props} key={job.id} job={job} index={index} />)
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, paddingVertical: 14 }}>
          {c('没有排队消息', 'No queued messages')}
        </Text>
      )}
      {past.length || (!props.paused && (pending.length > 1 || props.automatic)) ? (
        <View
          style={{
            ...row,
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            borderTopWidth: 1,
            borderTopColor: theme.colors.border,
            paddingTop: 6,
          }}
        >
          {past.length ? (
            <QueueAction
              theme={theme}
              compact={compact}
              title={history ? c('收起历史', 'Hide history') : c('发送历史', 'Delivery history')}
              icon={history ? 'ChevronUp' : 'History'}
              label={c('历史', 'History')}
              expanded={history}
              disabled={busy}
              onPress={() => setHistory(!history)}
            />
          ) : (
            <View />
          )}
          {!props.paused && (pending.length > 1 || props.automatic) ? (
            <QueueAction
              theme={theme}
              compact={compact}
              title={c('暂停全部发送', 'Pause all delivery')}
              icon="Pause"
              label={c('全部暂停', 'Pause all')}
              disabled={busy}
              onPress={props.onPauseAll}
            />
          ) : null}
        </View>
      ) : null}
      {history
        ? past.map((job) => (
            <View key={job.id} style={{ gap: 4, paddingVertical: 6 }}>
              <View style={{ ...row, justifyContent: 'space-between' }}>
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
                  {c(
                    ...(reasons[job.wait === 'withdrawn' ? 'withdrawn' : job.status] ?? [
                      job.status,
                      job.status,
                    ]),
                  )}
                </Text>
                <QueueAction
                  theme={theme}
                  compact={compact}
                  title={c('复制完整内容', 'Copy full message')}
                  icon="Copy"
                  disabled={busy}
                  onPress={() => onCopy(job.frozenText ?? job.text)}
                />
              </View>
              <Text
                selectable
                numberOfLines={3}
                style={{ color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 }}
              >
                {job.text}
              </Text>
            </View>
          ))
        : null}
    </View>
  );
}
function QueueItem({ job, index, ...props }: QueueProps & { job: Job; index: number }) {
  const { theme, compact, busy, now } = props;
  const c = useCopy(),
    { locale } = useTranslation(messages);
  const [more, setMore] = useState(false),
    [full, setFull] = useState(false);
  const queued = job.status === 'queued';
  const state = queued && job.paused && !job.wait.startsWith('quota-') ? 'paused' : job.wait;
  const status = !['time', 'queued'].includes(state)
    ? c(...(reasons[state] ?? [state, state]))
    : '';
  const delay = job.trigger.kind === 'quota' ? job.trigger.delay : null;
  const minutes = delay
    ? delay.min === delay.max
      ? String(delay.min)
      : `${delay.min}–${delay.max}`
    : '';
  const timing =
    job.dueAt !== null && job.trigger.kind !== 'idle'
      ? localDate(job.dueAt, locale, now)
      : delay
        ? c(`额度恢复后 ${minutes} 分钟`, `${minutes} min after quota recovers`)
        : job.trigger.kind === 'at'
          ? localDate(job.trigger.at, locale, now)
          : c('会话空闲时', 'When the conversation is idle');
  const action = (name: ActionName) => {
    setMore(false);
    props.onAction(job, name);
  };
  const base = { theme, compact, disabled: busy };
  return (
    <View
      style={{
        gap: 8,
        padding: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon
          name={
            job.trigger.kind === 'quota'
              ? 'Hourglass'
              : job.trigger.kind === 'idle'
                ? 'MessageSquare'
                : 'Clock'
          }
          size={13}
          color={theme.colors.foregroundMuted}
        />
        <Text
          style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18, flex: 1 }}
        >
          {timing}
        </Text>
      </View>
      <Text
        selectable
        numberOfLines={full ? undefined : 3}
        style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 21 }}
      >
        {job.source === 'goal'
          ? c(
              `继续目标：${props.goalObjective ?? ''}`,
              `Continue goal: ${props.goalObjective ?? ''}`,
            )
          : job.text}
      </Text>
      {status ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
          {status}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        {queued && job.source === 'user' ? (
          <QueueAction
            {...base}
            icon="Pencil"
            label={c('编辑', 'Edit')}
            title={
              props.editingId === job.id ? c('继续编辑', 'Continue editing') : c('编辑', 'Edit')
            }
            disabled={
              busy || props.editDisabled || Boolean(props.editingId && props.editingId !== job.id)
            }
            onPress={() => props.onEdit(job)}
          />
        ) : null}
        {queued ? (
          <QueueAction
            {...base}
            title={c('撤回', 'Withdraw')}
            icon="Undo2"
            label={c('撤回', 'Withdraw')}
            onPress={() => action('withdraw')}
          />
        ) : null}
        {job.status === 'unknown' ? (
          <QueueAction
            {...base}
            title={c('检查后移出队列', 'Dismiss after review')}
            label={c('检查后移出队列', 'Dismiss after review')}
            onPress={() => action('cancel')}
          />
        ) : null}
        <View style={{ flex: 1 }} />
        <QueueAction
          {...base}
          title={c('更多操作', 'More actions')}
          icon="Ellipsis"
          expanded={more}
          onPress={() => setMore(!more)}
        />
      </View>
      {more ? (
        <View
          style={{ gap: 2, borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 5 }}
        >
          <QueueAction
            {...base}
            title={full ? c('收起正文', 'Collapse message') : c('查看全文', 'Show full message')}
            icon={full ? 'ChevronUp' : 'AlignLeft'}
            label={full ? c('收起正文', 'Collapse message') : c('查看全文', 'Show full message')}
            onPress={() => {
              setFull(!full);
              setMore(false);
            }}
          />
          <QueueAction
            {...base}
            title={c('复制完整内容', 'Copy full message')}
            icon="Copy"
            label={c('复制', 'Copy')}
            onPress={() => {
              setMore(false);
              props.onCopy(job.frozenText ?? job.text);
            }}
          />
          {queued ? (
            <QueueAction
              {...base}
              title={
                job.paused || (!props.automatic && !job.manual)
                  ? c('允许按条件发送', 'Allow scheduled delivery')
                  : c('暂停', 'Pause')
              }
              icon={job.paused || (!props.automatic && !job.manual) ? 'Play' : 'Pause'}
              label={
                job.paused || (!props.automatic && !job.manual)
                  ? c('按条件发送', 'Allow delivery')
                  : c('暂停', 'Pause')
              }
              disabled={busy || props.editingId === job.id}
              onPress={() =>
                action(job.paused || (!props.automatic && !job.manual) ? 'release' : 'pause')
              }
            />
          ) : null}
          {queued && index > 0 ? (
            <QueueAction
              {...base}
              title={c('上移', 'Move up')}
              icon="ArrowUp"
              label={c('上移', 'Move up')}
              onPress={() => action('up')}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
