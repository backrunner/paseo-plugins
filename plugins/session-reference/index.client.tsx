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
        input: searchSessions.input.transform((input) => ({
          ...input,
          locale: client.i18n.locale,
        })),
        output: searchSessions.output.transform((payload) => ({
          items: payload.items.map((item) => presentSession(item, client.i18n.locale)),
        })),
      },
    }),
  );
}
