import { defineTranslations, useTranslation } from '@getpaseo/plugin/client';

export const messages = defineTranslations({
  resources: {
    en: {
      title: 'Media preview',
      retry: 'Reload',
      loading: 'Loading media…',
      readingError: 'Could not read this file',
      deleted: 'This file was deleted',
      empty: 'This file is empty',
      large: 'Preview supports files up to {{limit}}',
      largeDetail: 'This preview loads the entire file. Open larger files in a local media player.',
      mobile: 'Media playback is available in Paseo desktop and web',
      mobileDetail:
        'This version of the mobile plugin interface does not provide an inline media player.',
      unsupported: 'This file type is not supported',
      decodeError: 'This media could not be played',
      decodeDetail:
        'The file may be damaged, or its codec may not be supported by this client. Try MP4 with H.264/AAC, MP3, or PCM WAV.',
      loadingPlayer: 'Preparing playback…',
      loop: 'Loop',
      speed: 'Speed',
      back: 'Back 10 seconds',
      forward: 'Forward 10 seconds',
    },
    'zh-CN': {
      title: '媒体预览',
      retry: '重新加载',
      loading: '正在加载媒体…',
      readingError: '无法读取这个文件',
      deleted: '文件已被删除',
      empty: '这是一个空文件',
      large: '支持预览不超过 {{limit}} 的文件',
      largeDetail: '预览需要读取完整文件，更大的文件请使用本地播放器打开',
      mobile: '请在 Paseo 桌面端或网页版播放',
      mobileDetail: '当前版本的手机端插件接口尚未提供内嵌媒体播放器',
      unsupported: '暂不支持这个文件类型',
      decodeError: '无法播放这个媒体文件',
      decodeDetail:
        '文件可能已损坏，或当前客户端不支持它的编码，可尝试 H.264/AAC 编码的 MP4、MP3 或 PCM WAV',
      loadingPlayer: '正在准备播放…',
      loop: '循环',
      speed: '速度',
      back: '后退 10 秒',
      forward: '前进 10 秒',
    },
  },
});
export const useCopy = () => useTranslation(messages).t;
