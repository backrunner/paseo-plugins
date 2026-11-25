import { defineAttachmentSource } from '@getpaseo/plugin';
import type { PluginClientContext } from '@getpaseo/plugin/client';
import { messages } from './client/messages';
import { searchSessions } from './shared/contracts';
import { presentSession } from './client/presentation';

export default function contribute(client: PluginClientContext) {
  return client.addAttachmentSource(
    defineAttachmentSource({
      id: 'sessions',
      title: messages.message('title'),
      pickerTitle: messages.message('picker'),
      searchPlaceholder: messages.message('search'),
      icon: 'MessagesSquare',
      search: {
        ...searchSessions,
        output: searchSessions.output.transform(({ items, error }) => {
          if (error === 'history-unavailable') {
            throw new Error(client.i18n.t(messages, 'historyUnavailable'));
          }
          const locale = client.i18n.locale;
          return { items: items.map((item) => presentSession(item, locale)) };
        }),
      },
    }),
  );
}
