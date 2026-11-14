import { defineTranslations } from '@getpaseo/plugin/client';

export const messages = defineTranslations({
  resources: {
    en: {
      title: 'Conversation',
      picker: 'Reference conversation',
      search: 'Search conversations',
    },
    'zh-CN': {
      title: '引用会话',
      picker: '引用已有会话',
      search: '搜索会话',
    },
  },
});
