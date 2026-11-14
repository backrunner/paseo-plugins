import type { PluginFile, PluginFilePanelProps } from '@getpaseo/plugin/client';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { formatBytes, MAX_PREVIEW_BYTES, mediaFormat } from '../shared/media';
import { observeFile, type FileState } from './load';
import { useCopy } from './messages';
import { WebPlayer, type MediaHandle } from './web';

export function MediaPanel(props: PluginFilePanelProps) {
  // A different file gets an entirely new player, controls and read lifecycle.
  return <FilePreview key={props.file.path} {...props} />;
}
function FilePreview({ file, theme, layout }: PluginFilePanelProps) {
  const t = useCopy(),
    colors = theme.colors;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<{ file: PluginFile; attempt: number; state: FileState }>();
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    return observeFile(file, (state) => setLoaded({ file, attempt, state }));
  }, [file, attempt]);
  const state =
    loaded?.file === file && loaded.attempt === attempt
      ? loaded.state
      : ({ status: 'loading' } as const);
  const format = mediaFormat(file.extension);
  let heading: string | undefined, detail: string | undefined;
  if (Platform.OS !== 'web') {
    heading = t('mobile');
    detail = t('mobileDetail');
  } else if (state.status === 'error') {
    heading = t('readingError');
    detail = state.message;
  } else if (state.status === 'blocked') {
    heading =
      state.reason === 'large'
        ? t('large', { limit: formatBytes(MAX_PREVIEW_BYTES) })
        : t(state.reason);
    if (state.reason === 'large') detail = t('largeDetail');
  }
  return (
    <View
      style={{
        flex: 1,
        minHeight: 0,
        backgroundColor: colors.surface0,
        padding: layout.compact ? 8 : 12,
        gap: 8,
      }}
    >
      {heading ? (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 }}>
          <Text accessibilityRole="alert" style={{ color: colors.foreground, textAlign: 'center' }}>
            {heading}
          </Text>
          {detail && (
            <Text style={{ color: colors.foregroundMuted, textAlign: 'center', maxWidth: 540 }}>
              {detail}
            </Text>
          )}
          {Platform.OS === 'web' && (
            <Action title={t('retry')} colors={colors} onPress={() => setAttempt((n) => n + 1)} />
          )}
        </View>
      ) : state.status === 'ready' && format ? (
        <Playback
          key={`${attempt}:${state.url}`}
          url={state.url}
          format={format}
          name={file.name}
          size={file.size}
          theme={theme}
        />
      ) : (
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ color: colors.foregroundMuted }}>{t('loading')}</Text>
        </View>
      )}
    </View>
  );
}
type Colors = PluginFilePanelProps['theme']['colors'];
function Action({
  title,
  label = title,
  colors,
  onPress,
  selected,
  disabled,
}: {
  title: string;
  label?: string;
  colors: Colors;
  onPress(): void;
  selected?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        paddingVertical: 7,
        paddingHorizontal: 10,
        borderRadius: 4,
        backgroundColor: selected || pressed ? colors.surface2 : 'transparent',
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Text style={{ color: selected ? colors.accent : colors.foreground, fontSize: 13 }}>
        {label}
      </Text>
    </Pressable>
  );
}
function Playback({
  url,
  format,
  name,
  size,
  theme,
}: {
  url: string;
  format: readonly ['video' | 'audio', string];
  name: string;
  size: number;
  theme: PluginFilePanelProps['theme'];
}) {
  const t = useCopy(),
    colors = theme.colors;
  const [loop, setLoop] = useState(false),
    [rate, setRate] = useState(1),
    [failed, setFailed] = useState(false);
  const [info, setInfo] = useState<{ duration: number; width: number; height: number }>();
  const controlsRef = useRef<MediaHandle | null>(null);
  const speeds = [0.5, 0.75, 1, 1.25, 1.5, 2];
  return (
    <View style={{ flex: 1, minHeight: 0, gap: 8 }}>
      <View style={{ flex: 1, minHeight: 90, justifyContent: 'center', gap: 12 }}>
        {failed ? (
          <View style={{ gap: 12, alignItems: 'center' }}>
            <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
              {t('decodeError')}
            </Text>
            <Text style={{ color: colors.foregroundMuted, textAlign: 'center', maxWidth: 540 }}>
              {t('decodeDetail')}
            </Text>
            <Action
              title={t('retry')}
              colors={colors}
              onPress={() => {
                setFailed(false);
                setInfo(undefined);
              }}
            />
          </View>
        ) : (
          <WebPlayer
            url={url}
            kind={format[0]}
            mimeType={format[1]}
            label={name}
            loop={loop}
            rate={rate}
            colorScheme={
              parseInt(colors.surface0.replace('#', '').slice(0, 2), 16) < 128 ? 'dark' : 'light'
            }
            controlsRef={controlsRef}
            onReady={setInfo}
            onError={() => setFailed(true)}
          />
        )}
      </View>
      <ScrollView
        style={{ flexGrow: 0 }}
        contentContainerStyle={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
          <Action
            title={t('back')}
            label="−10 s"
            colors={colors}
            disabled={!info || failed}
            onPress={() => controlsRef.current?.seek(-10)}
          />
          <Action
            title={t('forward')}
            label="+10 s"
            colors={colors}
            disabled={!info || failed}
            onPress={() => controlsRef.current?.seek(10)}
          />
          <Action
            title={t('loop')}
            colors={colors}
            selected={loop}
            onPress={() => setLoop((v) => !v)}
          />
          <Action
            title={`${t('speed')} ${rate}×`}
            label={`${rate}×`}
            colors={colors}
            onPress={() => setRate(speeds[(speeds.indexOf(rate) + 1) % speeds.length])}
          />
        </View>
        <View
          style={{
            flexDirection: 'row',
            gap: 16,
            alignItems: 'center',
            paddingHorizontal: 10,
            paddingVertical: 7,
          }}
        >
          {!info && !failed && (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
              {t('loadingPlayer')}
            </Text>
          )}
          {!!info?.width && (
            <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
              {info.width} × {info.height}
            </Text>
          )}
          <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{formatBytes(size)}</Text>
        </View>
      </ScrollView>
    </View>
  );
}
