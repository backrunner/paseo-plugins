// The browser adapter is the only module that uses DOM elements. Native clients
// never mount it; there are no browser globals evaluated at module load time.
import { createElement, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { MediaKind } from '../shared/media';

interface MediaElement {
  currentTime: number;
  duration: number;
  playbackRate: number;
  videoWidth?: number;
  videoHeight?: number;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
}
declare const document: {
  hidden: boolean;
  addEventListener(event: string, listener: () => void): void;
  removeEventListener(event: string, listener: () => void): void;
};
export interface MediaHandle {
  seek(delta: number): void;
}
export interface WebPlayerProps {
  url: string;
  kind: MediaKind;
  mimeType: string;
  label: string;
  loop: boolean;
  rate: number;
  colorScheme: 'light' | 'dark';
  controlsRef: { current: MediaHandle | null };
  onReady(info: { duration: number; width: number; height: number }): void;
  onError(): void;
}

export function WebPlayer(props: WebPlayerProps) {
  if (Platform.OS !== 'web') return null;
  return createElement(BrowserPlayer, props);
}
function BrowserPlayer({
  url,
  kind,
  mimeType,
  label,
  loop,
  rate,
  colorScheme,
  controlsRef,
  onReady,
  onError,
}: WebPlayerProps) {
  const ref = useRef<MediaElement | null>(null);
  useEffect(() => {
    const media = ref.current;
    if (!media) return;
    controlsRef.current = {
      seek(delta) {
        if (Number.isFinite(media.duration))
          media.currentTime = Math.max(0, Math.min(media.duration, media.currentTime + delta));
      },
    };
    const hide = () => {
      if (document.hidden) media.pause();
    };
    document.addEventListener('visibilitychange', hide);
    return () => {
      controlsRef.current = null;
      document.removeEventListener('visibilitychange', hide);
      media.pause();
      // React removes the source together with this element. Do not load() here:
      // doing so can restart a pending resource fetch during teardown.
      media.removeAttribute('src');
    };
  }, [controlsRef]);
  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);
  return createElement(
    kind,
    {
      ref,
      controls: true,
      autoPlay: false,
      playsInline: true,
      preload: 'metadata',
      loop,
      'aria-label': label,
      'data-testid': 'media-player',
      style: {
        width: '100%',
        maxHeight: '100%',
        minHeight: kind === 'audio' ? 54 : 0,
        objectFit: 'contain',
        colorScheme,
        borderRadius: 6,
      },
      onError,
      onLoadedMetadata: () => {
        const media = ref.current;
        if (media)
          onReady({
            duration: media.duration,
            width: media.videoWidth ?? 0,
            height: media.videoHeight ?? 0,
          });
      },
    },
    createElement('source', { src: url, type: mimeType, onError }),
  );
}
