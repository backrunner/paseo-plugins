import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { usePaseo, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { SettingsSection, SettingsSelect } from '@getpaseo/plugin/client/ui';
import { AutomationEditor } from './panel';
import { settingsTargets } from './drafts';
import { useCopy } from './messages';

type Choice = {
  id: string;
  title: string | null;
  provider: string;
  archivedAt?: string | null;
  internal?: boolean;
};
export function AutomationSettings(props: PluginSurfaceProps) {
  return <Settings key={props.host.id} {...props} />;
}
function Settings(props: PluginSurfaceProps) {
  const c = useCopy(),
    paseo = usePaseo();
  const [agents, setAgents] = useState<Choice[]>([]);
  const [selected, select] = useState('');
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const lifetime = new AbortController();
    const directory = new Map<string, Choice>();
    const publish = () => {
      if (lifetime.signal.aborted) return;
      const available = [...directory.values()].filter((a) => !a.archivedAt && !a.internal);
      setAgents(available);
      setLoading(false);
      select((current) => {
        const serverId = available[0] ? paseo.agents.ref(available[0].id).address.serverId : '';
        const candidate = current || settingsTargets.get(serverId) || '';
        return available.some((a) => a.id === candidate) ? candidate : '';
      });
    };
    void paseo.agents
      .list({ subscribe: {}, signal: lifetime.signal })
      .then(({ subscription }) => {
        if (lifetime.signal.aborted) return;
        subscription.subscribe({
          snapshot: ({ entries }) => {
            directory.clear();
            entries.forEach(({ agent }) => directory.set(agent.id, agent));
            publish();
          },
          update: (event) => {
            if (event.type !== 'agent_update') return;
            if (event.payload.kind === 'upsert')
              directory.set(event.payload.agent.id, event.payload.agent);
            else directory.delete(event.payload.agentId);
            publish();
          },
        });
      })
      .catch(() => {
        if (!lifetime.signal.aborted) {
          setError(true);
          setLoading(false);
        }
      });
    return () => lifetime.abort();
  }, [paseo]);
  return (
    <View style={{ gap: 20 }}>
      <SettingsSection title={c('应用到会话', 'Apply to conversation')}>
        <SettingsSelect
          label={c('会话', 'Conversation')}
          value={selected}
          disabled={loading || error}
          options={[
            { value: '', label: c('选择会话', 'Choose a conversation') },
            ...agents.map((a) => ({
              value: a.id,
              label: `${a.title || a.provider || c('会话', 'Conversation')} · ${a.id.slice(0, 8)}`,
            })),
          ]}
          onValueChange={(value) => {
            select(value);
            if (value) settingsTargets.set(paseo.agents.ref(value).address.serverId, value);
          }}
        />
        <Text style={{ color: props.theme.colors.foregroundMuted, fontSize: 12, lineHeight: 18 }}>
          {error
            ? c(
                '无法读取会话，请关闭设置后重试',
                'Could not load conversations. Close settings and try again.',
              )
            : loading
              ? c('正在读取会话…', 'Loading conversations…')
              : c(
                  '仅修改所选会话。新会话的自动续跑默认关闭。',
                  'Changes apply only to this conversation. Automatic continuation starts off for new conversations.',
                )}
        </Text>
      </SettingsSection>
      {selected ? (
        <AutomationEditor key={`${props.host.id}:${selected}`} {...props} agentId={selected} />
      ) : null}
    </View>
  );
}
