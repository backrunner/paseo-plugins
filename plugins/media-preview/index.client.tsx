import type { PluginClientContext } from '@getpaseo/plugin/client';
import { MediaPanel } from './client/panel';
import { messages } from './client/messages';
import { formats } from './shared/media';

export default function contribute(client: PluginClientContext) {
  return client.addFilePanel({
    id: 'media',
    title: messages.message('title'),
    icon: 'Play',
    files: { extensions: Object.keys(formats) },
    Component: MediaPanel,
  });
}
