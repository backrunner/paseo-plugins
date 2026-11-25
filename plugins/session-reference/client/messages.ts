import { defineTranslations } from '@getpaseo/plugin/client';

export const messages = defineTranslations({
  resources: {
    en: {
      title: 'Conversation',
      picker: 'Reference conversation',
      search: 'Search conversations',
      historyUnavailable: 'Could not read conversations. Try again shortly.',
    },
    'zh-CN': {
      title: '引用会话',
      picker: '引用已有会话',
      search: '搜索会话',
      historyUnavailable: '暂时无法读取会话，请稍后重试',
    },
  },
});
