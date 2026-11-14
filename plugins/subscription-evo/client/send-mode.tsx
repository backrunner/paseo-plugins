import { Pressable, Text, View } from 'react-native';
import type { PluginAgentPanelProps } from '@getpaseo/plugin/client';
import type { Trigger } from '../shared/model';
import { useCopy } from './messages';

/** Compact composer control; full SettingsSelect rows belong on the settings page. */
export function SendMode({
  theme,
  compact,
  value,
  disabled,
  onChange,
}: {
  theme: PluginAgentPanelProps['theme'];
  compact: boolean;
  value: Trigger['kind'];
  disabled: boolean;
  onChange(value: Trigger['kind']): void;
}) {
  const c = useCopy();
  return (
    <View
      accessibilityLabel={c('发送条件', 'Send when')}
      style={{
        flexDirection: 'row',
        padding: 3,
        gap: 3,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      {(
        [
          ['at', c('定时', 'At a time')],
          ['quota', c('额度恢复', 'After quota')],
          ['idle', c('空闲时', 'When idle')],
        ] as const
      ).map(([mode, title]) => (
        <Pressable
          key={mode}
          accessibilityRole="button"
          accessibilityLabel={title}
          accessibilityState={{ selected: value === mode, disabled }}
          disabled={disabled}
          onPress={() => onChange(mode)}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: compact ? 38 : 30,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: 4,
            paddingVertical: 6,
            borderRadius: 5,
            opacity: disabled ? 0.5 : 1,
            backgroundColor: value === mode ? theme.colors.surface2 : 'transparent',
          }}
        >
          <Text
            style={{
              fontSize: 13,
              lineHeight: 18,
              textAlign: 'center',
              color: value === mode ? theme.colors.foreground : theme.colors.foregroundMuted,
              fontWeight: value === mode ? '500' : '400',
            }}
          >
            {title}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
